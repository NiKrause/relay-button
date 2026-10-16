// Vendored from aleph-rs v0.22.0, crates/aleph-sdk/src/attest/x509.rs
// (https://github.com/aleph-im/aleph-rs, MIT, see LICENSE-aleph-rs).
// Changes for relay-button: the reqwest and url error variants are replaced by a string Http variant.
//! X.509 custom extension encoding/decoding for RA-TLS attestation reports.
//!
//! Ported from aleph-cvm `crates/aleph-tee/src/x509.rs`; kept logically
//! identical (same OID, same DER-wrapped-JSON encoding) since the guest
//! `aleph-attest-agent` on the other side of the RA-TLS handshake is built
//! from that crate. See the `attest` module docs for the wire-compatibility
//! constraint.

use der::Decode;
use der::Encode;
use der::asn1::OctetStringRef;

use crate::attest::AttestationReport;

/// OID for the custom attestation report extension.
///
/// This is a private-use OID: 1.3.6.1.4.1.60000.1.1
pub const ATTESTATION_OID: &[u64] = &[1, 3, 6, 1, 4, 1, 60000, 1, 1];

/// OID string for display/comparison purposes.
pub const ATTESTATION_OID_STR: &str = "1.3.6.1.4.1.60000.1.1";

#[derive(Debug, thiserror::Error)]
pub enum AttestError {
    #[error("failed to serialize/deserialize attestation report JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("failed to DER-encode attestation extension: {0}")]
    DerEncode(String),
    #[error("failed to DER-decode attestation extension: {0}")]
    DerDecode(String),
    #[error("failed to parse X.509 certificate: {0}")]
    CertParse(String),
    #[error("failed to construct attestation OID: {0}")]
    Oid(String),
    /// The raw bytes in [`AttestationReport::data`](crate::attest::AttestationReport::data)
    /// don't decode as a well-formed SEV-SNP attestation report.
    #[error("failed to parse SEV-SNP attestation report: {0}")]
    Parse(std::io::Error),
    /// `sev`'s single combined check failed: either the AMD certificate chain
    /// (ARK self-signed, ARK signs ASK, ASK signs VCEK) or the report's
    /// ECDSA P-384/SHA-384 signature over the VCEK public key did not verify.
    #[error("SEV-SNP certificate chain or report signature verification failed: {0}")]
    Chain(std::io::Error),
    /// Failed to decode an AMD SEV-SNP certificate (ARK, ASK, or VCEK) from
    /// its DER/PEM bytes.
    #[error("failed to decode AMD SEV-SNP certificate: {0}")]
    CertDecode(#[from] std::io::Error),
    /// The attestation DTO declares a TEE type this verifier does not
    /// implement (only SEV-SNP is supported).
    #[error("unsupported TEE type {0:?}: only SEV-SNP attestation is supported")]
    UnsupportedTeeType(crate::attest::TeeType),
    /// The report was generated at a VMPL more privileged callers must not
    /// trust (only VMPL 0-1, the firmware/kernel stack, are accepted).
    #[error("attestation report from VMPL {0} - only VMPL 0-1 are accepted")]
    Vmpl(u32),
    /// The report's TCB is below the required minimum (a component of one of
    /// the report's TCB views is lower than the configured floor).
    #[error("SEV-SNP TCB below the required floor: {0}")]
    TcbBelowFloor(String),
    /// The ARK certificate does not carry AMD's expected subject identity
    /// (this is a policy check `sev` itself does not perform).
    #[error("ARK certificate identity verification failed: {0}")]
    ArkIdentity(String),
    /// Fetching or caching the VCEK certificate from AMD's Key Distribution
    /// Service failed.
    #[error("failed to fetch VCEK certificate from AMD KDS: {0}")]
    Kds(String),
    /// An AMD chain certificate's validity window starts in the future
    /// relative to the verification time.
    #[error(
        "{name} certificate is not yet valid: not_before {not_before}, verification time {now}"
    )]
    CertNotYetValid {
        name: &'static str,
        not_before: String,
        now: i64,
    },
    /// An AMD chain certificate's validity window ended before the
    /// verification time. Expiry is the PKI's dead-man switch: it is what
    /// eventually stops trusting a retired AMD key even for verifiers that
    /// never see a revocation.
    #[error("{name} certificate has expired: not_after {not_after}, verification time {now}")]
    CertExpired {
        name: &'static str,
        not_after: String,
        now: i64,
    },
    /// The AMD CRL's signature does not verify under the pinned ARK public
    /// key. A tampered or substituted CRL fails closed exactly like a
    /// missing one: block-and-substitute must not be easier than blocking.
    #[error("AMD CRL signature verification failed: {0}")]
    CrlSignature(String),
    /// The AMD CRL bytes do not parse as a CRL at all. An unparseable CRL
    /// is as unverifiable as a missing one, so verification fails closed.
    #[error("AMD CRL failed to parse: {0}")]
    CrlParse(String),
    /// The AMD CRL's own validity window does not contain the verification
    /// time. A CRL past its next_update is not evidence of anything:
    /// revocations issued since are unknown, so verification fails closed
    /// rather than treating "no known revocation" as "not revoked".
    #[error("AMD CRL is stale or not yet valid: {0}")]
    CrlStale(String),
    /// An AMD chain certificate's serial number appears in the product CRL:
    /// AMD has revoked it, so nothing it signed can be trusted.
    #[error("{name} certificate (serial {serial}) is revoked by the AMD CRL")]
    CertRevoked { name: &'static str, serial: String },
    /// The host's PLATFORM_INFO posture fails the caller's opt-in
    /// [`PlatformPolicy`](super::platform::PlatformPolicy): every unmet
    /// requirement is listed (by its CLI spelling), with the raw field value.
    #[error("host platform posture fails required {unmet:?} (PLATFORM_INFO={plat_info:#x})")]
    PlatformPosture {
        unmet: Vec<&'static str>,
        plat_info: u64,
    },
    /// The RA-TLS handshake's server certificate verification failed: no
    /// attestation extension, a key-binding mismatch (`report_data` doesn't
    /// hash the TLS public key), or a measurement pin mismatch.
    #[error("RA-TLS server certificate verification failed: {0}")]
    Tls(String),
    /// Sending or reading a request over the RA-TLS channel failed.
    #[error("RA-TLS HTTP request failed: {0}")]
    Http(String),
    /// Our own verifier rejected the peer's attestation during the TLS
    /// handshake (bad report extension, key-binding failure, measurement
    /// mismatch, ...). Split from [`AttestError::Http`] because an HTTP client
    /// reports a mid-handshake rejection as a generic send error, which
    /// reads like a network problem instead of an attestation verdict.
    #[error("attestation rejected during the RA-TLS handshake: {0}")]
    HandshakeRejected(String),
    /// The TLS handshake completed without a `SnpCertVerifier` ever stashing
    /// an attestation report. This should not happen if the handshake
    /// succeeded (the verifier itself fails closed when no extension is
    /// present), but is checked again here so `attested_request` never
    /// silently returns an unattested response instead of erroring.
    #[error("no attestation report was extracted during the TLS handshake")]
    MissingReport,
    /// The fresh report's signed report_data does not match
    /// SHA-384(FRESH_DOMAIN || served_public_key || nonce): the report was
    /// not generated for this challenge and this TLS identity.
    #[error(
        "fresh attestation binding failed: report_data does not match the challenged key and nonce"
    )]
    FreshnessBinding,
    /// The agent's fresh-attestation endpoint returned a non-success status.
    #[error("fresh attestation endpoint returned HTTP {0}")]
    FreshEndpoint(u16),
    #[error("fresh attestation measurement mismatch: expected {expected}, got {got}")]
    FreshMeasurementMismatch { expected: String, got: String },
    #[error("fresh attestation policy mismatch: expected {expected:#x}, got {got:#x}")]
    FreshPolicyMismatch { expected: u64, got: u64 },
    /// The guest agent's `/confidential/inject-secret` endpoint returned a
    /// non-2xx status. The agent's 4xx bodies name the specific rejection
    /// (most notably a stale-key signature after the guest rebooted between
    /// the caller's `fresh_attestation` call and this request), so the body
    /// text is preserved here rather than discarded.
    #[error("secret injection rejected: HTTP {status}: {body}")]
    InjectRejected { status: u16, body: String },
    /// The runtime manifest's `gpu.driver_version` is below the required
    /// NVIDIA driver floor.
    #[error("NVIDIA driver below the required floor: required >= {floor}, got {got}")]
    GpuDriverBelowFloor { floor: String, got: String },
    /// The message's GPU architecture is not one the floor accepts.
    #[error("NVIDIA GPU architecture {0:?} is not accepted")]
    GpuArchNotAccepted(String),
    /// The runtime manifest's `gpu.driver_version` does not parse as a
    /// driver version.
    #[error("NVIDIA driver version {0:?} does not parse")]
    GpuDriverUnparsable(String),
}

/// Encode an AttestationReport as a DER-encoded OctetString.
///
/// The report is first serialized to JSON, then the JSON bytes are wrapped
/// in a DER OctetString. This produces the extension value suitable for
/// embedding in an X.509 certificate extension.
pub fn encode_attestation_extension(report: &AttestationReport) -> Result<Vec<u8>, AttestError> {
    let json_bytes = serde_json::to_vec(report)?;

    let octet_string =
        OctetStringRef::new(&json_bytes).map_err(|e| AttestError::DerEncode(e.to_string()))?;

    let der_bytes = octet_string
        .to_der()
        .map_err(|e| AttestError::DerEncode(e.to_string()))?;

    Ok(der_bytes)
}

/// Decode an AttestationReport from a DER-encoded OctetString.
///
/// This reverses the encoding done by `encode_attestation_extension`:
/// parse the DER OctetString, then deserialize the JSON payload.
pub fn decode_attestation_extension(der_bytes: &[u8]) -> Result<AttestationReport, AttestError> {
    let octet_string =
        OctetStringRef::from_der(der_bytes).map_err(|e| AttestError::DerDecode(e.to_string()))?;

    let json_bytes = octet_string.as_bytes();

    let report: AttestationReport = serde_json::from_slice(json_bytes)?;

    Ok(report)
}

/// Extract an AttestationReport from an X.509 certificate (DER-encoded).
///
/// Parses the certificate, searches for an extension with our custom OID,
/// and decodes the attestation report from the extension value.
///
/// Returns `Ok(None)` if the certificate does not contain the extension.
/// Returns `Ok(Some(report))` if the extension is found and decoded.
/// Returns `Err(...)` if parsing fails.
pub fn extract_attestation_from_cert(
    cert_der: &[u8],
) -> Result<Option<AttestationReport>, AttestError> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| AttestError::CertParse(e.to_string()))?;

    // Build our OID for comparison
    let target_oid = x509_parser::der_parser::oid::Oid::from(ATTESTATION_OID)
        .map_err(|e| AttestError::Oid(format!("{e:?}")))?;

    // Search for our extension in the certificate
    for ext in cert.tbs_certificate.extensions() {
        if ext.oid == target_oid {
            // The extension value is the raw content.
            // In X.509, extension values are OCTET STRING wrapped,
            // but x509-parser already gives us the inner OCTET STRING content.
            // However, since we encoded with DER OctetString, the value
            // stored in the extension IS our DER-encoded OctetString.
            let report = decode_attestation_extension(ext.value)?;
            return Ok(Some(report));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attest::TeeType;

    /// Helper to create a test AttestationReport.
    fn sample_report() -> AttestationReport {
        AttestationReport {
            tee_type: TeeType::SevSnp,
            data: vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04],
        }
    }

    /// Build a self-signed certificate carrying `ext_value` under `oid` as a
    /// custom X.509 extension, returning the DER-encoded certificate.
    fn build_cert_with_ext(oid: &[u64], ext_value: &[u8]) -> Vec<u8> {
        let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()])
            .expect("CertificateParams should be valid");
        params
            .custom_extensions
            .push(rcgen::CustomExtension::from_oid_content(
                oid,
                ext_value.to_vec(),
            ));

        let key_pair = rcgen::KeyPair::generate().expect("key generation should succeed");
        let cert = params
            .self_signed(&key_pair)
            .expect("self-signing should succeed");

        cert.der().to_vec()
    }

    #[test]
    fn extension_round_trips() {
        let report = sample_report();
        let ext = encode_attestation_extension(&report).unwrap();
        let cert_der = build_cert_with_ext(ATTESTATION_OID, &ext);
        let got = extract_attestation_from_cert(&cert_der).unwrap().unwrap();
        assert_eq!(got.tee_type, report.tee_type);
        assert_eq!(got.data, report.data);
    }

    #[test]
    fn test_encode_decode_roundtrip() {
        let original = sample_report();

        let encoded = encode_attestation_extension(&original).expect("encoding should succeed");

        // Verify it looks like DER (starts with OCTET STRING tag 0x04)
        assert!(!encoded.is_empty());
        assert_eq!(encoded[0], 0x04, "DER should start with OCTET STRING tag");

        let decoded = decode_attestation_extension(&encoded).expect("decoding should succeed");

        assert_eq!(decoded.tee_type, original.tee_type);
        assert_eq!(decoded.data, original.data);
    }

    #[test]
    fn test_encode_decode_different_tee_types() {
        for tee_type in [
            TeeType::SevSnp,
            TeeType::Tdx,
            TeeType::NvidiaCc,
            TeeType::None,
        ] {
            let report = AttestationReport {
                tee_type,
                data: vec![0x01],
            };

            let encoded = encode_attestation_extension(&report).expect("encoding should succeed");
            let decoded = decode_attestation_extension(&encoded).expect("decoding should succeed");

            assert_eq!(decoded.tee_type, tee_type);
        }
    }

    #[test]
    fn test_decode_invalid_der() {
        let result = decode_attestation_extension(&[0xFF, 0xFF]);
        assert!(result.is_err(), "invalid DER should fail");
    }

    #[test]
    fn test_decode_invalid_json_in_octet_string() {
        // Valid DER OctetString but containing invalid JSON
        let invalid_json = b"not json";
        let octet_string = OctetStringRef::new(invalid_json).unwrap();
        let der_bytes = octet_string.to_der().unwrap();

        let result = decode_attestation_extension(&der_bytes);
        assert!(result.is_err(), "invalid JSON should fail");
    }

    #[test]
    fn test_extract_from_cert_with_extension() {
        let report = sample_report();
        let extension_value =
            encode_attestation_extension(&report).expect("encoding should succeed");

        let cert_der = build_cert_with_ext(ATTESTATION_OID, &extension_value);

        let extracted =
            extract_attestation_from_cert(&cert_der).expect("extraction should succeed");

        assert!(extracted.is_some(), "extension should be found");
        let extracted = extracted.unwrap();
        assert_eq!(extracted.tee_type, report.tee_type);
        assert_eq!(extracted.data, report.data);
    }

    #[test]
    fn test_extract_from_cert_without_extension() {
        let params = rcgen::CertificateParams::new(vec!["localhost".to_string()])
            .expect("CertificateParams should be valid");

        let key_pair = rcgen::KeyPair::generate().expect("key generation should succeed");
        let cert = params
            .self_signed(&key_pair)
            .expect("self-signing should succeed");

        let cert_der = cert.der().to_vec();

        let extracted =
            extract_attestation_from_cert(&cert_der).expect("extraction should succeed");

        assert!(extracted.is_none(), "no extension should be found");
    }

    #[test]
    fn test_extract_from_invalid_cert() {
        let result = extract_attestation_from_cert(&[0x30, 0x00]);
        assert!(result.is_err(), "invalid cert should fail");
    }
}
