//! RA-TLS to an SEV-SNP guest over any byte stream (relay-button#169, step 2).
//!
//! The guest's `aleph-attest-agent` serves TLS with a certificate that carries
//! its SNP report in an X.509 extension, the report's `report_data` binding
//! the certificate's public key. A browser cannot open that TLS connection
//! itself, so [`RaTlsClient`] is sans-IO: rustls (RustCrypto provider, builds
//! for wasm32) runs here, and the caller moves the TLS records over whatever
//! carries them (a WebSocket to a TCP relay). Whoever relays the bytes sees
//! only ciphertext.
//!
//! The certificate check, the domain tags and the two `report_data`
//! constructions follow aleph-rs `crates/aleph-sdk/src/attest/ratls.rs`
//! (v0.22.0, MIT; see LICENSE-aleph-rs), which follows aleph-vm's emitter.
//! The handshake only binds the report to the TLS key and checks the pins;
//! the AMD chain is verified afterwards (`crate::verify`), and nothing but a
//! nonce is sent before that, exactly as aleph-rs does it.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use sev::firmware::guest::AttestationReport as SnpReport;
use sev::parser::ByteParser;
use sha2::{Digest, Sha256, Sha384};
use subtle::ConstantTimeEq;

use crate::attest::TeeType;
use crate::attest::x509::extract_attestation_from_cert;

/// `report_data = SHA-384(KEY_BINDING_DOMAIN || public_key) || zeros` in the
/// report the certificate carries (aleph-vm `aleph_tee::report_data::DOMAIN_KEY`).
pub const KEY_BINDING_DOMAIN: &[u8] = b"aleph-attest-tls-key-v1\x00";
/// `report_data = SHA-384(FRESH_DOMAIN || public_key || nonce) || zeros` in a
/// fresh report (aleph-vm `aleph_tee::report_data::DOMAIN_FRESH`).
pub const FRESH_DOMAIN: &[u8] = b"aleph-attest-fresh-v1\x00";
/// Domain of the owner-signed secret injection (aleph-rs `owner_auth`).
pub const INJECT_SECRET_DOMAIN: &str = "aleph-snp-inject-secret-v1";

fn padded(hash: &[u8]) -> [u8; 64] {
    let mut report_data = [0u8; 64];
    report_data[..48].copy_from_slice(hash);
    report_data
}

/// The `report_data` a certificate's report must carry for `public_key`.
pub fn key_bound_report_data(public_key: &[u8]) -> [u8; 64] {
    let mut hasher = Sha384::new();
    hasher.update(KEY_BINDING_DOMAIN);
    hasher.update(public_key);
    padded(&hasher.finalize())
}

/// The `report_data` a fresh report must carry for the served key and nonce.
pub fn fresh_bound_report_data(public_key: &[u8], nonce: &[u8]) -> [u8; 64] {
    let mut hasher = Sha384::new();
    hasher.update(FRESH_DOMAIN);
    hasher.update(public_key);
    hasher.update(nonce);
    padded(&hasher.finalize())
}

/// Check that a fresh report's signed `report_data` binds both the key the
/// TLS session was attested with and the caller's nonce.
pub fn verify_fresh_binding(report: &[u8], served_public_key: &[u8], nonce: &[u8]) -> Result<(), String> {
    let signed = SnpReport::from_bytes(report).map_err(|e| format!("not an SEV-SNP report: {e}"))?;
    let expected = fresh_bound_report_data(served_public_key, nonce);
    if signed.report_data.ct_eq(&expected).unwrap_u8() == 0 {
        return Err("the fresh report does not bind this TLS key and nonce".to_string());
    }
    Ok(())
}

/// The message the instance owner signs (EIP-191 `personal_sign`) to inject
/// secrets: `domain|hex(SHA-384(server key))|hex(SHA-256(canonical secrets JSON))`.
pub fn inject_secret_payload(server_public_key: &[u8], canonical_secrets_json: &str) -> String {
    let key_hash = hex::encode(Sha384::digest(server_public_key));
    let body_hash = hex::encode(Sha256::digest(canonical_secrets_json.as_bytes()));
    format!("{INJECT_SECRET_DOMAIN}|{key_hash}|{body_hash}")
}

/// What the handshake learned: the report from the certificate and the key it
/// is bound to.
#[derive(Debug, Clone)]
pub struct Captured {
    pub report: Vec<u8>,
    pub public_key: Vec<u8>,
}

#[derive(Debug)]
struct AttestedCertVerifier {
    expected_measurements: Vec<[u8; 48]>,
    expected_policy: Option<u64>,
    captured: Mutex<Option<Captured>>,
    rejection: Mutex<Option<String>>,
    provider: Arc<CryptoProvider>,
}

impl AttestedCertVerifier {
    fn check(&self, end_entity: &CertificateDer<'_>) -> Result<Captured, String> {
        let report = extract_attestation_from_cert(end_entity.as_ref())
            .map_err(|e| format!("failed to extract attestation from certificate: {e}"))?
            .ok_or("certificate does not contain an attestation extension")?;
        if report.tee_type != TeeType::SevSnp {
            return Err(format!("unsupported TEE type {:?}: only SEV-SNP is supported", report.tee_type));
        }
        let signed = SnpReport::from_bytes(&report.data).map_err(|e| format!("not an SEV-SNP report: {e}"))?;
        let (_, cert) = x509_parser::parse_x509_certificate(end_entity.as_ref())
            .map_err(|e| format!("failed to parse certificate for key binding: {e}"))?;
        let public_key = cert.tbs_certificate.subject_pki.subject_public_key.data.to_vec();

        if signed.report_data.ct_eq(&key_bound_report_data(&public_key)).unwrap_u8() == 0 {
            return Err("key binding failed: report_data does not match SHA-384(domain || public key)".to_string());
        }
        // An empty pin list rejects everything: there is no "don't check".
        if !self.expected_measurements.iter().any(|pin| bool::from(pin.ct_eq(&signed.measurement))) {
            return Err(format!(
                "measurement {} is not one the INSTANCE message pinned",
                hex::encode(signed.measurement)
            ));
        }
        if let Some(expected) = self.expected_policy {
            let got = u64::from(signed.policy);
            if got != expected {
                return Err(format!("guest policy {got:#x} differs from the pinned {expected:#x}"));
            }
        }
        Ok(Captured { report: report.data, public_key })
    }
}

impl ServerCertVerifier for AttestedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        match self.check(end_entity) {
            Ok(captured) => {
                *self.captured.lock().unwrap() = Some(captured);
                Ok(ServerCertVerified::assertion())
            }
            Err(reason) => {
                *self.rejection.lock().unwrap() = Some(reason.clone());
                Err(RustlsError::General(reason))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// A TLS client to an attestation agent that runs on bytes the caller moves.
pub struct RaTlsClient {
    connection: ClientConnection,
    verifier: Arc<AttestedCertVerifier>,
}

impl RaTlsClient {
    /// `expected_measurements`: the launch digests the INSTANCE message pins
    /// (48 bytes each); `expected_policy`: its guest policy, if pinned.
    pub fn new(expected_measurements: Vec<[u8; 48]>, expected_policy: Option<u64>) -> Result<Self, String> {
        let provider = Arc::new(rustls_rustcrypto::provider());
        let verifier = Arc::new(AttestedCertVerifier {
            expected_measurements,
            expected_policy,
            captured: Mutex::new(None),
            rejection: Mutex::new(None),
            provider: provider.clone(),
        });
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(verifier.clone())
            .with_no_client_auth();
        // The guest's certificate names no host; the name only fills SNI.
        let name = ServerName::try_from("attestation.aleph.invalid").map_err(|e| e.to_string())?;
        let connection = ClientConnection::new(Arc::new(config), name).map_err(|e| e.to_string())?;
        Ok(RaTlsClient { connection, verifier })
    }

    /// TLS records to send to the guest (empty when there is nothing to send).
    pub fn take_outgoing(&mut self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        while self.connection.wants_write() {
            self.connection.write_tls(&mut out).map_err(|e| e.to_string())?;
        }
        Ok(out)
    }

    /// Feed TLS records that arrived from the guest. A failed certificate
    /// check surfaces here with its reason.
    pub fn push_incoming(&mut self, mut bytes: &[u8]) -> Result<(), String> {
        while !bytes.is_empty() {
            let read = self.connection.read_tls(&mut bytes).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            if let Err(error) = self.connection.process_new_packets() {
                return Err(match self.verifier.rejection.lock().unwrap().clone() {
                    Some(reason) => format!("attestation rejected during the RA-TLS handshake: {reason}"),
                    None => format!("TLS error: {error}"),
                });
            }
        }
        Ok(())
    }

    pub fn is_handshaking(&self) -> bool {
        self.connection.is_handshaking()
    }

    /// The report and key the handshake verified the binding of.
    pub fn captured(&self) -> Option<Captured> {
        if self.connection.is_handshaking() {
            return None;
        }
        self.verifier.captured.lock().unwrap().clone()
    }

    /// Queue application data; refused until the handshake has verified.
    pub fn write_plaintext(&mut self, data: &[u8]) -> Result<(), String> {
        if self.captured().is_none() {
            return Err("no data before the attested handshake has completed".to_string());
        }
        self.connection.writer().write_all(data).map_err(|e| e.to_string())
    }

    /// Application data received so far.
    pub fn take_plaintext(&mut self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        match self.connection.reader().read_to_end(&mut out) {
            Ok(_) => Ok(out),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(out),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn close(&mut self) {
        self.connection.send_close_notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attest::AttestationReport;
    use crate::attest::x509::encode_attestation_extension;
    use rustls::ServerConfig;
    use rustls::server::ServerConnection;

    const REPORT_HEX: &[u8] = include_bytes!("../testdata/report_milan.hex");
    // Byte offsets in the SNP report (ABI spec, table "ATTESTATION_REPORT").
    const POLICY: usize = 0x08;
    const REPORT_DATA: usize = 0x50;
    const MEASUREMENT: usize = 0x90;

    fn fixture() -> Vec<u8> {
        hex::decode(std::str::from_utf8(REPORT_HEX).unwrap().trim()).unwrap()
    }

    /// A server certificate whose extension carries `report`, with
    /// `report_data` bound to the certificate key unless `bind` is false.
    /// The AMD signature no longer matches once report_data changes; the
    /// handshake does not check it (the chain is verified afterwards).
    fn server(bind: bool) -> (ServerConfig, Vec<u8>) {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let spki = key.public_key_raw().to_vec();
        let mut report = fixture();
        if bind {
            report[REPORT_DATA..REPORT_DATA + 64].copy_from_slice(&key_bound_report_data(&spki));
        }
        let extension = encode_attestation_extension(&AttestationReport { tee_type: TeeType::SevSnp, data: report.clone() }).unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["guest.invalid".to_string()]).unwrap();
        params.custom_extensions.push(rcgen::CustomExtension::from_oid_content(crate::attest::x509::ATTESTATION_OID, extension));
        let cert = params.self_signed(&key).unwrap();
        let config = ServerConfig::builder_with_provider(Arc::new(rustls_rustcrypto::provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::try_from(key.serialize_der()).unwrap(),
            )
            .unwrap();
        (config, report)
    }

    fn measurement_of(report: &[u8]) -> [u8; 48] {
        report[MEASUREMENT..MEASUREMENT + 48].try_into().unwrap()
    }

    /// Move records between client and server until neither has anything to say.
    fn pump(client: &mut RaTlsClient, server: &mut ServerConnection) -> Result<(), String> {
        for _ in 0..20 {
            let out = client.take_outgoing()?;
            let mut moved = !out.is_empty();
            if !out.is_empty() {
                server.read_tls(&mut &out[..]).unwrap();
                server.process_new_packets().map_err(|e| e.to_string())?;
            }
            let mut back = Vec::new();
            while server.wants_write() {
                server.write_tls(&mut back).unwrap();
            }
            if !back.is_empty() {
                moved = true;
                client.push_incoming(&back)?;
            }
            if !moved {
                break;
            }
        }
        Ok(())
    }

    #[test]
    fn handshake_binds_the_report_to_the_tls_key_and_carries_data() {
        let (config, report) = server(true);
        let mut server = ServerConnection::new(Arc::new(config)).unwrap();
        let mut client = RaTlsClient::new(vec![measurement_of(&report)], Some(u64::from_le_bytes(report[POLICY..POLICY + 8].try_into().unwrap()))).unwrap();
        assert!(client.write_plaintext(b"too early").is_err());
        pump(&mut client, &mut server).unwrap();
        assert!(!client.is_handshaking());
        let captured = client.captured().expect("captured after the handshake");
        assert_eq!(captured.report, report);
        assert_eq!(key_bound_report_data(&captured.public_key)[..], report[REPORT_DATA..REPORT_DATA + 64]);

        client.write_plaintext(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        pump(&mut client, &mut server).unwrap();
        let mut got = Vec::new();
        server.reader().read_to_end(&mut got).ok();
        assert_eq!(got, b"GET / HTTP/1.1\r\n\r\n");
        server.writer().write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
        pump(&mut client, &mut server).unwrap();
        assert_eq!(client.take_plaintext().unwrap(), b"HTTP/1.1 200 OK\r\n\r\n");
    }

    #[test]
    fn refuses_a_report_not_bound_to_the_tls_key() {
        let (config, report) = server(false);
        let mut server = ServerConnection::new(Arc::new(config)).unwrap();
        let mut client = RaTlsClient::new(vec![measurement_of(&report)], None).unwrap();
        let err = pump(&mut client, &mut server).unwrap_err();
        assert!(err.contains("key binding failed"), "{err}");
        assert!(client.captured().is_none());
    }

    #[test]
    fn refuses_an_unpinned_measurement_and_an_empty_pin_list() {
        for pins in [vec![[0x11u8; 48]], vec![]] {
            let (config, _) = server(true);
            let mut server = ServerConnection::new(Arc::new(config)).unwrap();
            let mut client = RaTlsClient::new(pins, None).unwrap();
            let err = pump(&mut client, &mut server).unwrap_err();
            assert!(err.contains("is not one the INSTANCE message pinned"), "{err}");
        }
    }

    #[test]
    fn refuses_another_policy() {
        let (config, report) = server(true);
        let mut server = ServerConnection::new(Arc::new(config)).unwrap();
        let mut client = RaTlsClient::new(vec![measurement_of(&report)], Some(0x3_0000 | 1 << 19)).unwrap();
        let err = pump(&mut client, &mut server).unwrap_err();
        assert!(err.contains("guest policy"), "{err}");
    }

    #[test]
    fn fresh_binding_needs_both_key_and_nonce() {
        let key = [7u8; 65];
        let nonce = [9u8; 32];
        let mut report = fixture();
        report[REPORT_DATA..REPORT_DATA + 64].copy_from_slice(&fresh_bound_report_data(&key, &nonce));
        assert!(verify_fresh_binding(&report, &key, &nonce).is_ok());
        assert!(verify_fresh_binding(&report, &key, &[8u8; 32]).is_err());
        assert!(verify_fresh_binding(&report, &[6u8; 65], &nonce).is_err());
        // A key-bound report is never a fresh one (distinct domains).
        report[REPORT_DATA..REPORT_DATA + 64].copy_from_slice(&key_bound_report_data(&key));
        assert!(verify_fresh_binding(&report, &key, &[]).is_err());
    }

    /// Writes testdata/ratls/: a server certificate with a key-bound report
    /// (the aleph-rs fixture with report_data rewritten, so its AMD signature
    /// no longer holds) and its key, for the Node test of the JS layer.
    /// Run with `cargo test write_ratls_fixture -- --ignored`.
    #[test]
    #[ignore]
    fn write_ratls_fixture() {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let spki = key.public_key_raw().to_vec();
        let mut report = fixture();
        report[REPORT_DATA..REPORT_DATA + 64].copy_from_slice(&key_bound_report_data(&spki));
        let extension = encode_attestation_extension(&AttestationReport { tee_type: TeeType::SevSnp, data: report.clone() }).unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["guest.invalid".to_string()]).unwrap();
        params.custom_extensions.push(rcgen::CustomExtension::from_oid_content(crate::attest::x509::ATTESTATION_OID, extension));
        let cert = params.self_signed(&key).unwrap();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/ratls");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cert.pem"), cert.pem()).unwrap();
        std::fs::write(dir.join("key.pem"), key.serialize_pem()).unwrap();
        std::fs::write(dir.join("report.hex"), hex::encode(&report)).unwrap();
    }

    #[test]
    fn inject_payload_matches_aleph_rs() {
        // aleph-rs owner_auth: domain|hex(SHA-384(key))|hex(SHA-256(json)).
        let payload = inject_secret_payload(b"key", r#"{"luks_passphrase":"hunter2"}"#);
        let parts: Vec<&str> = payload.split('|').collect();
        assert_eq!(parts[0], "aleph-snp-inject-secret-v1");
        assert_eq!(parts[1], hex::encode(Sha384::digest(b"key")));
        assert_eq!(parts[2], hex::encode(Sha256::digest(br#"{"luks_passphrase":"hunter2"}"#)));
    }
}
