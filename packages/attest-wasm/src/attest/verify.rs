// Vendored from aleph-rs v0.22.0, crates/aleph-sdk/src/attest/verify.rs
// (https://github.com/aleph-im/aleph-rs, MIT, see LICENSE-aleph-rs).
// Changes for relay-button: the network fetch (verify_sev_snp_report) is gone, the caller passes the VCEK and CRL bytes; the CRL signature uses the pure-Rust rsa crate instead of ring; SevSnpRegisters is local.
//! SEV-SNP attestation report verification: AMD certificate chain (ARK/ASK/
//! VCEK) plus the report's own ECDSA P-384/SHA-384 signature.
//!
//! This module owns exactly: parsing the raw report, the AMD chain +
//! signature check (delegated to the `sev` crate's pure-Rust `crypto_nossl`
//! backend, no OpenSSL), the VMPL policy check, and the ARK subject-identity
//! check (both of which `sev` does *not* perform). It does **not** check the
//! launch measurement or bind `report_data` to a TLS key - those live in the
//! RA-TLS handshake (a later task) which has the expected measurement and
//! public key to compare against.
//!
//! Fails closed: any parse, chain, signature, VMPL, ARK-identity,
//! validity-window, or CRL/revocation failure returns `Err`; an
//! `Ok(VerificationResult)` always means a fully verified report.

use sha2::{Digest, Sha384};
use x509_parser::certificate::X509Certificate;
use x509_parser::revocation_list::CertificateRevocationList;

use sev::certs::snp::{Certificate, Chain, Verifiable, builtin, ca};
use sev::firmware::guest::AttestationReport as SnpReport;
use sev::firmware::host::TcbVersion;
use sev::parser::ByteParser;

use super::AttestError;
use super::platform::{PlatformPolicy, PlatformPosture};
use super::tcb::{TcbFloor, TcbFloorPolicy};
use super::SevSnpRegisters;

/// AMD ARK certificates use CN = "ARK-{product}" (e.g. "ARK-Milan").
const AMD_ARK_CN_PREFIX: &str = "ARK-";
/// AMD ARK certificates' Organization is always this exact string.
const AMD_ORG_NAME: &str = "Advanced Micro Devices";

/// Expected SHA-384 hash of the ARK's full SubjectPublicKeyInfo DER (the
/// complete RFC 5280 structure: algorithm identifier including any
/// parameters, plus the subject public key bit-string) per AMD product.
///
/// These are pinned independently of the `sev` crate's bundled ARK PEMs.
/// `verify_ark_identity` checks the cert's CN/O strings (forgeable metadata);
/// this pin checks the actual public key bytes. Together they guard against a
/// supply-chain attack where the `sev` crate's bundled ARK PEM is replaced
/// with a forged cert carrying the right CN/O but a different key: the chain
/// math would still "verify" (a self-signed cert always verifies against
/// itself), the identity strings would match, but the SPKI hash would not.
///
/// Extracted from the `sev` crate 8.0.0 builtin ARKs (Milan, Genoa, Turin).
/// If the `sev` crate is ever upgraded and AMD rotates an ARK, these pins
/// must be updated to match, and the upgrade should be reviewed.
const MILAN_ARK_SPKI_SHA384: [u8; 48] = [
    0x12, 0x49, 0xf6, 0x7f, 0x15, 0xcf, 0x22, 0x9a, 0x40, 0x69, 0x19, 0x5e, 0x1a, 0x9c, 0xe5, 0x37,
    0xd1, 0x76, 0x5e, 0xf7, 0x06, 0xa1, 0xf4, 0xa1, 0x23, 0xc3, 0x6b, 0xe9, 0x51, 0x87, 0x86, 0x51,
    0x5d, 0x25, 0xec, 0xc0, 0x07, 0xf3, 0x66, 0xb5, 0x64, 0xd2, 0xb3, 0xf3, 0x1c, 0x48, 0x08, 0x2e,
];
const GENOA_ARK_SPKI_SHA384: [u8; 48] = [
    0x32, 0xab, 0x53, 0xa6, 0xce, 0x5e, 0xc1, 0x49, 0x26, 0x20, 0x73, 0x96, 0xe5, 0xc4, 0x75, 0xae,
    0x76, 0x8a, 0x6a, 0x98, 0x31, 0xb7, 0xe8, 0x60, 0xb5, 0xac, 0xf2, 0xe1, 0xc1, 0xdf, 0xf2, 0x22,
    0xbc, 0x5a, 0x8b, 0xfc, 0x43, 0xeb, 0x5e, 0x06, 0x39, 0x31, 0x89, 0xc1, 0xf2, 0x46, 0xd8, 0x80,
];
const TURIN_ARK_SPKI_SHA384: [u8; 48] = [
    0x34, 0x75, 0xf0, 0x8a, 0x97, 0x27, 0xf8, 0xac, 0x9a, 0x1d, 0xea, 0xea, 0x5f, 0x2a, 0x20, 0x97,
    0xaa, 0x59, 0xd6, 0x4d, 0x05, 0xc2, 0xa6, 0x78, 0xc2, 0x29, 0xc8, 0x73, 0xe6, 0x35, 0x9d, 0x3a,
    0x69, 0x26, 0x28, 0x7a, 0x2a, 0x22, 0xcd, 0x5f, 0x88, 0xa3, 0x85, 0xe3, 0x33, 0xa2, 0xfc, 0xc5,
];

/// AMD EPYC product line a SEV-SNP report/VCEK was issued for.
///
/// This selects which builtin ARK/ASK pair (bundled with the `sev` crate, no
/// network needed) to verify against, and which AMD KDS URL segment to use
/// when fetching the per-chip VCEK.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AmdProduct {
    Milan,
    #[default]
    Genoa,
    Turin,
}

impl AmdProduct {
    /// The product name AMD's KDS expects in VCEK URLs, e.g.
    /// `https://kdsintf.amd.com/vcek/v1/Genoa/{chip_id}?...`.
    pub fn kds_name(self) -> &'static str {
        match self {
            AmdProduct::Milan => "Milan",
            AmdProduct::Genoa => "Genoa",
            AmdProduct::Turin => "Turin",
        }
    }

    /// The builtin (bundled, no-network) ARK + ASK certificates for this
    /// product line.
    fn builtin_ca(self) -> Result<(Certificate, Certificate), AttestError> {
        Ok(match self {
            AmdProduct::Milan => (builtin::milan::ark()?, builtin::milan::ask()?),
            AmdProduct::Genoa => (builtin::genoa::ark()?, builtin::genoa::ask()?),
            AmdProduct::Turin => (builtin::turin::ark()?, builtin::turin::ask()?),
        })
    }
}

impl std::fmt::Display for AmdProduct {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.kds_name())
    }
}

impl std::str::FromStr for AmdProduct {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "milan" => Ok(AmdProduct::Milan),
            "genoa" => Ok(AmdProduct::Genoa),
            "turin" => Ok(AmdProduct::Turin),
            other => Err(format!(
                "unknown AMD product '{other}' (expected milan, genoa, or turin)"
            )),
        }
    }
}

/// Outcome of verifying a SEV-SNP attestation report against AMD's identity
/// chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationResult {
    /// Launch measurement registers from the signed report, in the same
    /// shape a V-PROGRAM message pins them (`LaunchMeasurement.registers`),
    /// so a pin check is structural equality on one type. SEV-SNP pins
    /// `launch` only; a second platform turns this into an enum.
    pub registers: SevSnpRegisters,
    /// SEV-SNP guest policy the VM was actually launched with, from the
    /// signed report. Callers comparing against an expected policy (e.g. the
    /// one pinned on a V-PROGRAM message) must use this value: a host that
    /// launches the same measured stack with a weaker policy (e.g. debug
    /// allowed) changes this field but not the measurement.
    pub policy: u64,
    /// TCB the VM was launched under (Option A gates on this).
    pub launch_tcb: TcbVersion,
    /// TCB the VCEK is keyed to (from the signed report).
    pub reported_tcb: TcbVersion,
    /// CPUID family/model/stepping of the attesting chip, from the signed
    /// report (version 3+, SNP firmware 1.55; `None` on older reports).
    /// Evidence of which silicon family the TCB floor was selected for.
    pub cpuid_family: Option<u8>,
    pub cpuid_model: Option<u8>,
    pub cpuid_stepping: Option<u8>,
    /// Decoded PLATFORM_INFO posture of the attesting host (always
    /// surfaced; gated only by the caller's opt-in platform policy).
    pub platform: PlatformPosture,
    /// Human-readable summary of what was checked.
    pub summary: String,
}

/// Highest VMPL accepted for an attestation report.
///
/// VMPL 0 = firmware (OVMF), VMPL 1 = kernel/attestation agent. Both are part
/// of the measured platform stack and trusted. VMPL 2-3 are less privileged
/// and could be driven by untrusted guest code, so reports from them are
/// rejected.
const MAX_ACCEPTED_VMPL: u32 = 1;

/// Enforce the privileged-VMPL gate: reject reports from unprivileged levels.
///
/// Only VMPL 0-1 (firmware/kernel, the trusted measured stack) are accepted;
/// `sev` does not enforce this. VMPL 2-3 could be driven by untrusted guest
/// code, so a report from those levels must not be trusted as evidence of
/// the measured platform's state.
fn check_vmpl(vmpl: u32) -> Result<(), AttestError> {
    if vmpl > MAX_ACCEPTED_VMPL {
        return Err(AttestError::Vmpl(vmpl));
    }
    Ok(())
}

/// The verification core (aleph-rs: the synchronous core of `verify_sev_snp_report`): everything after the VCEK
/// bytes are in hand. Split out so tests can inject a fixture VCEK and never
/// touch the network.
///
/// Verifies, in order:
/// 1. The AMD certificate chain (ARK self-signed, ARK signs ASK, ASK signs
///    VCEK) and the report's ECDSA P-384/SHA-384 signature under the VCEK -
///    all in one `sev` crate call.
/// 2. VMPL: only 0-1 (firmware/kernel, the trusted measured stack) are
///    accepted; `sev` does not enforce this.
/// 3. ARK subject identity (CN prefix + Organization + self-issued): guards
///    against a poisoned/substituted "builtin" ARK; `sev` does not check
///    this either, it only checks the signature math.
/// 4. ARK SPKI pin: the ARK's SubjectPublicKeyInfo hash must match the
///    hardcoded expected hash for this product. This is the second line
///    beyond `verify_ark_identity`: a forged ARK carrying the right CN/O
///    strings but a different key passes the identity check but fails the
///    SPKI pin.
pub fn verify_report_with_vcek(
    report: &SnpReport,
    product: AmdProduct,
    vcek_der: &[u8],
    crl_der: &[u8],
    now: i64,
    min_tcb: &TcbFloorPolicy,
    platform: &PlatformPolicy,
) -> Result<VerificationResult, AttestError> {
    let (ark, ask) = product.builtin_ca()?;
    let vek = Certificate::from_der(vcek_der)?;
    let chain = Chain {
        ca: ca::Chain { ark, ask },
        vek,
    };

    // ONE call: ARK self-signed, ARK -> ASK, ASK -> VCEK, AND the report's
    // ECDSA P-384/SHA-384 signature under the VCEK public key.
    (&chain, report).verify().map_err(AttestError::Chain)?;

    // Policy checks the `sev` crate does not perform:
    check_vmpl(report.vmpl)?;
    verify_ark(&chain.ca.ark, product)?;
    check_chain_validity_and_revocation(now, &chain, vcek_der, crl_der)?;

    // TCB floor: the report is now chain- and signature-verified, so its TCB
    // views AND its CPUID family/model/stepping fields are trustworthy.
    // Select the floor for the silicon line the report attests to (classic,
    // cache-stacked X, and Zen4c parts each follow their own microcode patch
    // sequence), then gate before returning success.
    let floor = min_tcb.for_silicon(report.cpuid_fam_id, report.cpuid_mod_id, report.cpuid_step);
    check_tcb_floor(
        &report.launch_tcb,
        &report.reported_tcb,
        &report.current_tcb,
        &report.committed_tcb,
        floor,
    )?;

    // PLATFORM_INFO posture: decoded from the now-verified report, always
    // surfaced on the result, gated only by the caller's opt-in policy.
    let posture = PlatformPosture::from(report.plat_info);
    platform.check(&posture)?;

    Ok(VerificationResult {
        registers: SevSnpRegisters {
            launch: hex::encode(report.measurement),
        },
        policy: u64::from(report.policy),
        launch_tcb: report.launch_tcb,
        reported_tcb: report.reported_tcb,
        cpuid_family: report.cpuid_fam_id,
        cpuid_model: report.cpuid_mod_id,
        cpuid_stepping: report.cpuid_step,
        platform: posture,
        summary: format!(
            "SEV-SNP verified against AMD {product} chain (VMPL {}, policy {:#x})",
            report.vmpl,
            u64::from(report.policy),
        ),
    })
}

/// Enforce validity windows across the whole AMD chain (ARK, ASK, VCEK) at
/// verification time `now`, then the product CRL's verdict on it: the CRL
/// must carry a valid ARK signature and a validity window containing `now`,
/// and must not list the ASK or VCEK serial.
fn check_chain_validity_and_revocation(
    now: i64,
    chain: &Chain,
    vcek_der: &[u8],
    crl_der: &[u8],
) -> Result<(), AttestError> {
    // A closure cannot name the borrow between its input and output, so
    // this small parser is a fn.
    fn parse<'a>(name: &'static str, der: &'a [u8]) -> Result<X509Certificate<'a>, AttestError> {
        x509_parser::parse_x509_certificate(der)
            .map(|(_, cert)| cert)
            .map_err(|e| {
                AttestError::CertParse(format!(
                    "failed to parse {name} certificate for the validity check: {e}"
                ))
            })
    }
    let ark_der = chain.ca.ark.to_der().map_err(AttestError::CertDecode)?;
    let ask_der = chain.ca.ask.to_der().map_err(AttestError::CertDecode)?;
    let ark = parse("ARK", &ark_der)?;
    let ask = parse("ASK", &ask_der)?;
    let vcek = parse("VCEK", vcek_der)?;

    check_cert_validity(now, "ARK", &ark)?;
    check_cert_validity(now, "ASK", &ask)?;
    check_cert_validity(now, "VCEK", &vcek)?;

    // An unparseable CRL is treated like an unverifiable one: fail closed.
    let (_, crl) =
        x509_parser::parse_x509_crl(crl_der).map_err(|e| AttestError::CrlParse(e.to_string()))?;
    verify_crl_signature(&crl, &ark)?;
    check_crl_window(now, &crl)?;
    // The ARK is deliberately not checked against the CRL: the ARK signs the
    // CRL, so self-revocation could never fire against a real adversary (a
    // compromised ARK just omits itself). Distrusting an ARK is the pinned
    // SPKI hashes' job.
    check_not_revoked(&crl, "ASK", &ask)?;
    check_not_revoked(&crl, "VCEK", &vcek)?;
    Ok(())
}

/// Verify the CRL's signature against the ARK public key.
///
/// AMD's KDS CRLs are issued and signed by the product ARK with
/// RSASSA-PSS/SHA-384 (MGF1-SHA384, salt length 48), which is exactly
/// ring's `RSA_PSS_2048_8192_SHA384` profile. The ARK handed in here has
/// already passed the identity check and SPKI pin, so this anchors the CRL
/// to the same pinned key as the chain itself.
fn verify_crl_signature(
    crl: &CertificateRevocationList<'_>,
    ark: &X509Certificate<'_>,
) -> Result<(), AttestError> {
    // Name an algorithm rotation explicitly instead of letting it surface
    // as a generic signature failure: a wrong-scheme CRL fails closed
    // either way, but a clear error saves debugging time if AMD ever
    // changes the CRL signing scheme.
    const RSASSA_PSS_OID: &str = "1.2.840.113549.1.1.10";
    let algorithm = crl.signature_algorithm.algorithm.to_id_string();
    if algorithm != RSASSA_PSS_OID {
        return Err(AttestError::CrlSignature(format!(
            "unexpected CRL signature algorithm {algorithm} (expected RSASSA-PSS {RSASSA_PSS_OID})"
        )));
    }

    // For an RSA key, the SPKI bit-string content is the PKCS#1
    // RSAPublicKey DER. Pure-Rust `rsa` instead of `ring`, so this builds for
    // wasm32 without a C toolchain; same scheme (RSASSA-PSS, SHA-384).
    use rsa::pkcs1::DecodeRsaPublicKey;
    use rsa::signature::Verifier;
    let fail = || {
        AttestError::CrlSignature(
            "CRL signature does not verify under the pinned ARK public key".to_string(),
        )
    };
    let ark_public_key = &ark.tbs_certificate.subject_pki.subject_public_key.data;
    let key = rsa::RsaPublicKey::from_pkcs1_der(ark_public_key.as_ref()).map_err(|_| fail())?;
    let verifier = rsa::pss::VerifyingKey::<sha2::Sha384>::new(key);
    let signature =
        rsa::pss::Signature::try_from(crl.signature_value.data.as_ref()).map_err(|_| fail())?;
    verifier
        .verify(crl.tbs_cert_list.as_ref(), &signature)
        .map_err(|_| fail())
}

/// Reject a CRL whose own validity window does not contain `now`. A CRL past
/// its next_update carries no information about revocations issued since, so
/// it must not be treated as proof of non-revocation.
fn check_crl_window(now: i64, crl: &CertificateRevocationList<'_>) -> Result<(), AttestError> {
    let this_update = &crl.tbs_cert_list.this_update;
    if now < this_update.timestamp() {
        return Err(AttestError::CrlStale(format!(
            "this_update {this_update} is after verification time {now}"
        )));
    }
    match &crl.tbs_cert_list.next_update {
        Some(next_update) if now <= next_update.timestamp() => Ok(()),
        Some(next_update) => Err(AttestError::CrlStale(format!(
            "next_update {next_update} is before verification time {now}"
        ))),
        None => Err(AttestError::CrlStale(
            "CRL carries no next_update".to_string(),
        )),
    }
}

/// Reject a certificate whose serial number appears in the CRL.
///
/// Note on AMD's cert profile: KDS-issued VCEKs carry serial 0, so AMD
/// cannot single out one VCEK here (per-chip remediation rides TCB bumps and
/// the TCB floor instead); the practical bite of this check is ASK-level
/// revocation, where serials are real. Checking the VCEK serial anyway is
/// free and strictly fail-closed.
fn check_not_revoked(
    crl: &CertificateRevocationList<'_>,
    name: &'static str,
    cert: &X509Certificate<'_>,
) -> Result<(), AttestError> {
    for revoked in crl.iter_revoked_certificates() {
        if revoked.raw_serial() == cert.raw_serial() {
            return Err(AttestError::CertRevoked {
                name,
                serial: hex::encode(cert.raw_serial()),
            });
        }
    }
    Ok(())
}

/// Reject a certificate whose validity window does not contain `now`
/// (seconds since the Unix epoch). `sev`'s chain verification checks
/// signature math only; without this, an expired (retired) AMD key
/// verifies forever.
fn check_cert_validity(
    now: i64,
    name: &'static str,
    cert: &X509Certificate<'_>,
) -> Result<(), AttestError> {
    let validity = cert.validity();
    if now < validity.not_before.timestamp() {
        return Err(AttestError::CertNotYetValid {
            name,
            not_before: validity.not_before.to_string(),
            now,
        });
    }
    if now > validity.not_after.timestamp() {
        return Err(AttestError::CertExpired {
            name,
            not_after: validity.not_after.to_string(),
            now,
        });
    }
    Ok(())
}

/// Run both ARK checks (subject identity + SPKI pin) on a certificate,
/// parsing it once and handing the parsed form to each check.
fn verify_ark(ark: &Certificate, product: AmdProduct) -> Result<(), AttestError> {
    let der = ark.to_der().map_err(AttestError::CertDecode)?;
    let (_, cert) = x509_parser::parse_x509_certificate(&der)
        .map_err(|e| AttestError::ArkIdentity(format!("failed to parse ARK certificate: {e}")))?;
    verify_ark_identity(&cert)?;
    verify_ark_spki_pin(&cert, product)
}

/// Gate all four report TCB views against the floor (Option A: a VM passes
/// only if it was *launched* under a satisfying TCB, and no view is below).
fn check_tcb_floor(
    launch: &TcbVersion,
    reported: &TcbVersion,
    current: &TcbVersion,
    committed: &TcbVersion,
    floor: &TcbFloor,
) -> Result<(), AttestError> {
    for (view, tcb) in [
        ("launch", launch),
        ("reported", reported),
        ("current", current),
        ("committed", committed),
    ] {
        if let Err(defs) = floor.satisfied_by(tcb) {
            let detail = defs
                .iter()
                .map(|d| format!("{:?} {}<{}", d.component, d.actual, d.required))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(AttestError::TcbBelowFloor(format!(
                "{view} TCB below floor ({detail})"
            )));
        }
    }
    Ok(())
}

/// Verify that an ARK certificate has AMD's expected subject identity.
///
/// Checks:
/// - Subject CN starts with "ARK-" (e.g. "ARK-Milan", "ARK-Genoa").
/// - Subject O is "Advanced Micro Devices".
/// - Issuer matches subject (self-issued).
///
/// This guards against a cache-poisoning or supply-chain attack where an
/// attacker substitutes a self-signed certificate from a different issuer
/// for the (supposedly AMD-bundled) ARK - the chain math alone can't catch
/// that, since a self-signed cert always "verifies" against itself.
fn verify_ark_identity(cert: &X509Certificate<'_>) -> Result<(), AttestError> {
    let subject = &cert.tbs_certificate.subject;
    let issuer = &cert.tbs_certificate.issuer;

    let cn = subject
        .iter_common_name()
        .next()
        .and_then(|attr| attr.as_str().ok())
        .ok_or_else(|| {
            AttestError::ArkIdentity("ARK certificate has no Common Name in subject".to_string())
        })?;
    if !cn.starts_with(AMD_ARK_CN_PREFIX) {
        return Err(AttestError::ArkIdentity(format!(
            "ARK certificate CN '{cn}' does not start with expected prefix '{AMD_ARK_CN_PREFIX}'"
        )));
    }

    let org = subject
        .iter_organization()
        .next()
        .and_then(|attr| attr.as_str().ok())
        .ok_or_else(|| {
            AttestError::ArkIdentity("ARK certificate has no Organization in subject".to_string())
        })?;
    if org != AMD_ORG_NAME {
        return Err(AttestError::ArkIdentity(format!(
            "ARK certificate Organization '{org}' does not match expected '{AMD_ORG_NAME}'"
        )));
    }

    if subject.as_raw() != issuer.as_raw() {
        return Err(AttestError::ArkIdentity(
            "ARK certificate issuer does not match subject (not self-issued)".to_string(),
        ));
    }

    Ok(())
}

/// Verify that the ARK's SubjectPublicKeyInfo matches the pinned expected
/// hash for this AMD product.
///
/// `verify_ark_identity` checks the cert's CN/O strings, which are forgeable
/// metadata. This pin checks the actual public key bytes, so a forged ARK
/// carrying the right CN/O but a different key is rejected. The hash covers
/// the full SubjectPublicKeyInfo DER (algorithm identifier including any
/// parameters such as a named-curve OID, plus the subject public key
/// bit-string), matching the SPKI-pinning convention used by e.g. HPKP.
///
/// The pins are extracted from the `sev` crate 8.0.0 builtin ARK PEMs. If the
/// `sev` crate is upgraded and AMD rotates an ARK, these must be updated
/// (`openssl x509 -in ark.pem -pubkey -noout | openssl pkey -pubin
/// -outform DER | openssl dgst -sha384` reproduces them independently).
fn verify_ark_spki_pin(cert: &X509Certificate<'_>, product: AmdProduct) -> Result<(), AttestError> {
    let expected = match product {
        AmdProduct::Milan => &MILAN_ARK_SPKI_SHA384,
        AmdProduct::Genoa => &GENOA_ARK_SPKI_SHA384,
        AmdProduct::Turin => &TURIN_ARK_SPKI_SHA384,
    };

    let actual = Sha384::digest(cert.tbs_certificate.subject_pki.raw);

    if actual.as_slice() != expected.as_slice() {
        return Err(AttestError::ArkIdentity(format!(
            "ARK SubjectPublicKeyInfo hash does not match the pinned expected hash for {product} \
             (possible forged or supply-chain-substituted ARK)"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_MILAN_VCEK_DER: &[u8] = include_bytes!("../../testdata/vcek_milan.der");
    const TEST_MILAN_REPORT_HEX: &[u8] = include_bytes!("../../testdata/report_milan.hex");

    /// The real, captured Milan report from the `sev` crate's own test
    /// fixtures (`tests/certs_data/report_milan.hex`), hex-decoded.
    fn milan_report_bytes() -> Vec<u8> {
        let hex_str = std::str::from_utf8(TEST_MILAN_REPORT_HEX)
            .expect("fixture is ASCII hex")
            .trim();
        hex::decode(hex_str).expect("fixture is valid hex")
    }

    /// Fixed verification time for chain tests: 2026-08-18, inside every
    /// fixture validity window (VCEK 2023..2030, ARK/ASK through 2045+).
    /// Injected so tests stay green regardless of the wall clock.
    const TEST_NOW: i64 = 1787011200;

    #[test]
    fn rejects_a_chain_whose_certificates_have_expired() {
        let report_bytes = milan_report_bytes();
        let report = SnpReport::from_bytes(&report_bytes).expect("fixture report should parse");

        // 2200-01-01: every certificate in the fixture chain is long expired.
        let err = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            7258118400,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        )
        .expect_err("an expired AMD chain must be rejected");
        assert!(
            matches!(err, AttestError::CertExpired { .. }),
            "expected CertExpired, got: {err:?}"
        );
    }

    /// The real Milan CRL captured from AMD KDS
    /// (`https://kdsintf.amd.com/vcek/v1/Milan/crl`, fetched 2026-08-18:
    /// CRL number 10, window 2026-07-28..2026-09-10, no revoked entries,
    /// RSASSA-PSS/SHA-384 signed by ARK-Milan).
    const TEST_MILAN_CRL_DER: &[u8] = include_bytes!("../../testdata/crl_milan.der");

    fn parsed_milan_ark_der() -> Vec<u8> {
        let (ark, _) = AmdProduct::Milan
            .builtin_ca()
            .expect("builtin CA should load");
        ark.to_der().expect("ARK should encode to DER")
    }

    #[test]
    fn rejects_a_stale_crl_end_to_end() {
        let report_bytes = milan_report_bytes();
        let report = SnpReport::from_bytes(&report_bytes).expect("fixture report should parse");

        // 2026-12-01: every chain cert is still valid, but the fixture CRL's
        // next_update (2026-09-10) has passed, so its revocation verdict is
        // no longer evidence.
        let err = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            1796083200,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        )
        .expect_err("a stale CRL must fail verification closed");
        assert!(
            matches!(err, AttestError::CrlStale(_)),
            "expected CrlStale, got: {err:?}"
        );
    }

    #[test]
    fn rejects_a_tampered_crl_end_to_end() {
        let report_bytes = milan_report_bytes();
        let report = SnpReport::from_bytes(&report_bytes).expect("fixture report should parse");

        let mut crl_der = TEST_MILAN_CRL_DER.to_vec();
        let pos = crl_der
            .windows(5)
            .position(|w| w == b"Milan")
            .expect("issuer string should be present in the fixture");
        crl_der[pos] ^= 0x01;

        let err = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            &crl_der,
            TEST_NOW,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        )
        .expect_err("a tampered CRL must fail verification closed");
        assert!(
            matches!(err, AttestError::CrlSignature(_)),
            "expected CrlSignature, got: {err:?}"
        );
    }

    #[test]
    fn rejects_an_unparseable_crl_end_to_end() {
        let report_bytes = milan_report_bytes();
        let report = SnpReport::from_bytes(&report_bytes).expect("fixture report should parse");

        let err = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            b"not a crl",
            TEST_NOW,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        )
        .expect_err("an unparseable CRL must fail verification closed");
        assert!(
            matches!(err, AttestError::CrlParse(_)),
            "expected CrlParse, got: {err:?}"
        );
    }

    #[test]
    fn rejects_a_bad_platform_posture_end_to_end() {
        let report_bytes = milan_report_bytes();
        let report = SnpReport::from_bytes(&report_bytes).expect("fixture report should parse");

        // The genuine fixture host reports PLATFORM_INFO 0x1 (SMT on,
        // nothing hardened), so requiring RAPL-off must fail closed.
        let policy = PlatformPolicy {
            require_rapl_disabled: true,
            ..PlatformPolicy::NONE
        };
        let err = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &TcbFloorPolicy::UNRESTRICTED,
            &policy,
        )
        .expect_err("the fixture host does not disable RAPL");
        match err {
            AttestError::PlatformPosture { unmet, plat_info } => {
                assert_eq!(unmet, vec!["rapl-off"]);
                assert_eq!(plat_info, 0x1);
            }
            other => panic!("expected PlatformPosture, got: {other:?}"),
        }
    }

    #[test]
    fn verification_result_carries_the_platform_posture() {
        let report_bytes = milan_report_bytes();
        let report = SnpReport::from_bytes(&report_bytes).expect("fixture report should parse");

        let result = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        )
        .expect("the genuine report must verify under the default policy");
        assert!(result.platform.smt_enabled);
        assert!(!result.platform.rapl_disabled);
        assert_eq!(result.platform.raw, 0x1);
    }

    #[test]
    fn crl_signature_verifies_against_the_builtin_milan_ark() {
        let ark_der = parsed_milan_ark_der();
        let (_, ark) = x509_parser::parse_x509_certificate(&ark_der).expect("ARK should parse");
        let (_, crl) = x509_parser::parse_x509_crl(TEST_MILAN_CRL_DER).expect("CRL should parse");

        verify_crl_signature(&crl, &ark)
            .expect("the genuine AMD Milan CRL must verify under the builtin ARK");
    }

    #[test]
    fn crl_signature_names_an_unexpected_algorithm() {
        // The rcgen test CRL is ECDSA-signed; AMD KDS CRLs are RSASSA-PSS.
        // The rejection must name the algorithm mismatch, not report a
        // generic signature failure (that distinction is what saves
        // debugging time if AMD ever rotates the CRL signing scheme).
        let (_, crl_der) = test_ca_leaf_and_crl(&[0x01], &[]);
        let (_, crl) = x509_parser::parse_x509_crl(&crl_der).expect("CRL should parse");
        let ark_der = parsed_milan_ark_der();
        let (_, ark) = x509_parser::parse_x509_certificate(&ark_der).expect("ARK should parse");

        let err = verify_crl_signature(&crl, &ark)
            .expect_err("a CRL signed under a different algorithm must be rejected");
        match err {
            AttestError::CrlSignature(msg) => {
                assert!(
                    msg.contains("algorithm"),
                    "message should name the algorithm mismatch, got: {msg}"
                )
            }
            other => panic!("expected CrlSignature, got: {other:?}"),
        }
    }

    #[test]
    fn crl_signature_rejects_tampered_tbs_bytes() {
        // Flip one bit inside the issuer CN ("ARK-Milan"), which lives in the
        // signed TBS portion: the CRL still parses (same DER structure, one
        // changed string byte) but the ARK signature no longer covers it.
        let mut der = TEST_MILAN_CRL_DER.to_vec();
        let pos = der
            .windows(5)
            .position(|w| w == b"Milan")
            .expect("issuer string should be present in the fixture");
        der[pos] ^= 0x01;

        let ark_der = parsed_milan_ark_der();
        let (_, ark) = x509_parser::parse_x509_certificate(&ark_der).expect("ARK should parse");
        let (_, crl) = x509_parser::parse_x509_crl(&der).expect("tampered CRL should still parse");

        let err = verify_crl_signature(&crl, &ark).expect_err(
            "a tampered CRL must be rejected: block-and-substitute must not beat block",
        );
        assert!(
            matches!(err, AttestError::CrlSignature(_)),
            "expected CrlSignature, got: {err:?}"
        );
    }

    /// Build a test CA (with CRL-signing usage), a leaf cert carrying
    /// `serial`, and a CRL from that CA revoking `revoked_serials`, valid
    /// 2026-01-01 through 2026-12-31. Returns `(leaf_der, crl_der)`. Used to
    /// probe the serial-matching and window logic; the CRL *signature* path
    /// is probed separately against the real AMD fixture (this CA signs with
    /// ECDSA, not AMD's RSASSA-PSS).
    fn test_ca_leaf_and_crl(serial: &[u8], revoked_serials: &[&[u8]]) -> (Vec<u8>, Vec<u8>) {
        use rcgen::{
            BasicConstraints, CertificateRevocationListParams, IsCa, KeyIdMethod, KeyUsagePurpose,
            RevokedCertParams, SerialNumber,
        };

        let ca_key = rcgen::KeyPair::generate().expect("CA key generation should succeed");
        let mut ca_params =
            rcgen::CertificateParams::new(vec![]).expect("CA params should be valid");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let ca = rcgen::Issuer::new(ca_params, ca_key);

        let leaf_key = rcgen::KeyPair::generate().expect("leaf key generation should succeed");
        let mut leaf_params =
            rcgen::CertificateParams::new(vec![]).expect("leaf params should be valid");
        leaf_params.serial_number = Some(SerialNumber::from(serial.to_vec()));
        let leaf_der = leaf_params
            .signed_by(&leaf_key, &ca)
            .expect("leaf signing should succeed")
            .der()
            .to_vec();

        let crl_params = CertificateRevocationListParams {
            this_update: rcgen::date_time_ymd(2026, 1, 1),
            next_update: rcgen::date_time_ymd(2026, 12, 31),
            crl_number: SerialNumber::from(vec![1u8]),
            issuing_distribution_point: None,
            revoked_certs: revoked_serials
                .iter()
                .map(|s| RevokedCertParams {
                    serial_number: SerialNumber::from(s.to_vec()),
                    revocation_time: rcgen::date_time_ymd(2026, 1, 1),
                    reason_code: None,
                    invalidity_date: None,
                })
                .collect(),
            key_identifier_method: KeyIdMethod::Sha256,
        };
        let crl_der = crl_params
            .signed_by(&ca)
            .expect("CRL signing should succeed")
            .der()
            .to_vec();
        (leaf_der, crl_der)
    }

    #[test]
    fn crl_rejects_a_revoked_serial() {
        let (leaf_der, crl_der) = test_ca_leaf_and_crl(&[0xAB, 0xCD], &[&[0xAB, 0xCD]]);
        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("leaf should parse");
        let (_, crl) = x509_parser::parse_x509_crl(&crl_der).expect("CRL should parse");

        let err = check_not_revoked(&crl, "VCEK", &leaf)
            .expect_err("a serial listed in the CRL must be rejected");
        assert!(
            matches!(err, AttestError::CertRevoked { name: "VCEK", .. }),
            "expected CertRevoked, got: {err:?}"
        );
    }

    #[test]
    fn crl_accepts_an_unlisted_serial() {
        let (leaf_der, crl_der) = test_ca_leaf_and_crl(&[0xAB, 0xCD], &[&[0x01, 0x02]]);
        let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der).expect("leaf should parse");
        let (_, crl) = x509_parser::parse_x509_crl(&crl_der).expect("CRL should parse");

        check_not_revoked(&crl, "VCEK", &leaf)
            .expect("a serial not listed in the CRL must be accepted");
    }

    #[test]
    fn crl_window_accepts_a_time_inside() {
        let (_, crl_der) = test_ca_leaf_and_crl(&[0x01], &[]);
        let (_, crl) = x509_parser::parse_x509_crl(&crl_der).expect("CRL should parse");
        // 2026-08-18, inside 2026-01-01..2026-12-31.
        check_crl_window(1787011200, &crl).expect("a time inside the CRL window must be accepted");
    }

    #[test]
    fn crl_window_rejects_a_time_past_next_update() {
        let (_, crl_der) = test_ca_leaf_and_crl(&[0x01], &[]);
        let (_, crl) = x509_parser::parse_x509_crl(&crl_der).expect("CRL should parse");
        // 2035-01-01, past the 2026-12-31 next_update.
        let err = check_crl_window(2051222400, &crl)
            .expect_err("a stale CRL must be rejected: revocations after next_update are unknown");
        assert!(
            matches!(err, AttestError::CrlStale(_)),
            "expected CrlStale, got: {err:?}"
        );
    }

    #[test]
    fn crl_window_rejects_a_time_before_this_update() {
        let (_, crl_der) = test_ca_leaf_and_crl(&[0x01], &[]);
        let (_, crl) = x509_parser::parse_x509_crl(&crl_der).expect("CRL should parse");
        // 2025-12-01, before the 2026-01-01 this_update.
        let err = check_crl_window(1764547200, &crl)
            .expect_err("a CRL from the future must be rejected: the clock or CRL is wrong");
        assert!(
            matches!(err, AttestError::CrlStale(_)),
            "expected CrlStale, got: {err:?}"
        );
    }

    /// A self-signed cert valid 2023-01-01 through 2030-01-01, as DER, for
    /// probing `check_cert_validity`'s window boundaries.
    fn cert_valid_2023_to_2030() -> Vec<u8> {
        let key = rcgen::KeyPair::generate().expect("key generation should succeed");
        let mut params =
            rcgen::CertificateParams::new(vec![]).expect("CertificateParams should be valid");
        params.not_before = rcgen::date_time_ymd(2023, 1, 1);
        params.not_after = rcgen::date_time_ymd(2030, 1, 1);
        params
            .self_signed(&key)
            .expect("self-signing should succeed")
            .der()
            .to_vec()
    }

    fn run_cert_validity(now: i64, der: &[u8]) -> Result<(), AttestError> {
        let (_, cert) =
            x509_parser::parse_x509_certificate(der).expect("cert should parse as X.509");
        check_cert_validity(now, "VCEK", &cert)
    }

    #[test]
    fn cert_validity_accepts_a_time_inside_the_window() {
        // 2026-08-18, inside 2023..2030.
        run_cert_validity(1787011200, &cert_valid_2023_to_2030())
            .expect("a time inside the validity window must be accepted");
    }

    #[test]
    fn cert_validity_rejects_a_time_before_not_before() {
        // 2020-01-01, before the 2023 not_before.
        let err = run_cert_validity(1577836800, &cert_valid_2023_to_2030())
            .expect_err("a time before not_before must be rejected");
        assert!(
            matches!(err, AttestError::CertNotYetValid { name: "VCEK", .. }),
            "expected CertNotYetValid, got: {err:?}"
        );
    }

    #[test]
    fn cert_validity_rejects_a_time_after_not_after() {
        // 2035-01-01, after the 2030 not_after.
        let err = run_cert_validity(2051222400, &cert_valid_2023_to_2030())
            .expect_err("a time after not_after must be rejected");
        assert!(
            matches!(err, AttestError::CertExpired { name: "VCEK", .. }),
            "expected CertExpired, got: {err:?}"
        );
    }

    /// Build a `sev` [`Certificate`] with the given subject CN and O,
    /// either self-signed or signed by an unrelated issuer, to probe
    /// `verify_ark_identity`'s rejection branches.
    fn ark_like_cert(cn: &str, org: &str, self_issued: bool) -> Certificate {
        use rcgen::DnType;

        let key = rcgen::KeyPair::generate().expect("key generation should succeed");
        let mut params =
            rcgen::CertificateParams::new(vec![]).expect("CertificateParams should be valid");
        params.distinguished_name = rcgen::DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, cn);
        params
            .distinguished_name
            .push(DnType::OrganizationName, org);

        let der = if self_issued {
            params
                .self_signed(&key)
                .expect("self-signing should succeed")
                .der()
                .to_vec()
        } else {
            let issuer_key = rcgen::KeyPair::generate().expect("issuer key generation");
            let mut issuer_params = rcgen::CertificateParams::new(vec![])
                .expect("issuer CertificateParams should be valid");
            issuer_params.distinguished_name = rcgen::DistinguishedName::new();
            issuer_params
                .distinguished_name
                .push(DnType::CommonName, "Definitely Not AMD");
            let issuer = rcgen::Issuer::new(issuer_params, issuer_key);
            params
                .signed_by(&key, &issuer)
                .expect("cross-signing should succeed")
                .der()
                .to_vec()
        };
        Certificate::from_der(&der).expect("generated cert should decode as a sev Certificate")
    }

    /// Run `verify_ark_identity` on a `sev` [`Certificate`], handling the
    /// DER round-trip the production caller (`verify_ark`) performs.
    fn run_ark_identity(cert: &Certificate) -> Result<(), AttestError> {
        let der = cert.to_der().expect("cert should encode to DER");
        let (_, parsed) =
            x509_parser::parse_x509_certificate(&der).expect("cert should parse as X.509");
        verify_ark_identity(&parsed)
    }

    /// Run `verify_ark_spki_pin` on a `sev` [`Certificate`], handling the
    /// DER round-trip the production caller (`verify_ark`) performs.
    fn run_ark_spki_pin(cert: &Certificate, product: AmdProduct) -> Result<(), AttestError> {
        let der = cert.to_der().expect("cert should encode to DER");
        let (_, parsed) =
            x509_parser::parse_x509_certificate(&der).expect("cert should parse as X.509");
        verify_ark_spki_pin(&parsed, product)
    }

    fn ark_identity_error(cert: &Certificate) -> String {
        match run_ark_identity(cert) {
            Err(AttestError::ArkIdentity(msg)) => msg,
            other => panic!("expected ArkIdentity error, got: {other:?}"),
        }
    }

    #[test]
    fn ark_identity_accepts_the_builtin_milan_ark() {
        let ark = builtin::milan::ark().expect("builtin ARK should decode");
        run_ark_identity(&ark).expect("the genuine builtin ARK must pass");
    }

    #[test]
    fn ark_identity_rejects_wrong_cn_prefix() {
        let cert = ark_like_cert("NOT-Milan", AMD_ORG_NAME, true);
        let msg = ark_identity_error(&cert);
        assert!(
            msg.contains("does not start with expected prefix"),
            "unexpected message: {msg}"
        );
    }

    #[test]
    fn ark_identity_rejects_wrong_organization() {
        let cert = ark_like_cert("ARK-Milan", "Evil Corp", true);
        let msg = ark_identity_error(&cert);
        assert!(msg.contains("Organization"), "unexpected message: {msg}");
    }

    #[test]
    fn ark_identity_rejects_a_cert_that_is_not_self_issued() {
        let cert = ark_like_cert("ARK-Milan", AMD_ORG_NAME, false);
        let msg = ark_identity_error(&cert);
        assert!(msg.contains("not self-issued"), "unexpected message: {msg}");
    }

    #[test]
    fn amd_product_from_str_is_case_insensitive_and_rejects_unknown() {
        assert_eq!("milan".parse(), Ok(AmdProduct::Milan));
        assert_eq!("MILAN".parse(), Ok(AmdProduct::Milan));
        assert_eq!("Genoa".parse(), Ok(AmdProduct::Genoa));
        assert_eq!("turin".parse(), Ok(AmdProduct::Turin));
        assert!("naples".parse::<AmdProduct>().is_err());
    }

    #[test]
    fn amd_product_defaults_to_genoa() {
        assert_eq!(AmdProduct::default(), AmdProduct::Genoa);
    }

    #[test]
    fn verifies_real_milan_report_against_builtin_ark_ask_and_fixture_vcek() {
        let report_bytes = milan_report_bytes();
        let report = SnpReport::from_bytes(&report_bytes).expect("fixture report should parse");

        let result = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        )
        .expect("verification of a genuine, untampered Milan report must succeed");

        // Pinned to the fixture's real launch measurement (also cross-checked
        // against the `sev` crate's own parsed `report.measurement` below),
        // so a regression that silently accepts a *different* measurement
        // doesn't slip through unnoticed.
        assert_eq!(
            result.registers.launch,
            "7a1e5c266c0108dbc9bb94fa926951320940915d0aafb42464bd88b579ea158d3e1a0dc39b2c60bd95b9c480cd81841f"
        );
        assert_eq!(result.registers.launch, hex::encode(report.measurement));

        // The policy must be surfaced from the SIGNED report so callers can
        // compare it against the expected (message-pinned) policy. Cross-check
        // against the parsed report; a stub value here would let a debug-
        // enabled launch masquerade as the pinned policy.
        assert_eq!(result.policy, u64::from(report.policy));
        // Pinned to the fixture's real policy (0x30000: reserved bit 17 +
        // SMT allowed), mirroring the pinned measurement above.
        assert_eq!(result.policy, 0x30000);
    }

    #[test]
    fn rejects_report_with_flipped_signed_byte() {
        let mut report_bytes = milan_report_bytes();
        // Flip a byte inside the signed region (offset 21, within the
        // `policy` field), mirroring the `sev` crate's own
        // `milan_report_invalid` test - this must break the report's
        // signature over that region.
        report_bytes[21] ^= 0x80;
        let report = SnpReport::from_bytes(&report_bytes)
            .expect("bit-flipped bytes still decode structurally");

        let result = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        );
        assert!(
            result.is_err(),
            "a tampered report must fail closed, never verify successfully"
        );
    }

    // ---- VMPL gate ----

    #[test]
    fn vmpl_gate_accepts_privileged_levels() {
        assert!(check_vmpl(0).is_ok(), "VMPL 0 (firmware) must be accepted");
        assert!(check_vmpl(1).is_ok(), "VMPL 1 (kernel) must be accepted");
    }

    #[test]
    fn vmpl_gate_rejects_unprivileged_levels() {
        for vmpl in [2u32, 3] {
            let err = check_vmpl(vmpl).expect_err(&format!("VMPL {vmpl} must be rejected"));
            assert!(
                matches!(err, AttestError::Vmpl(v) if v == vmpl),
                "expected AttestError::Vmpl({vmpl}), got: {err:?}"
            );
        }
    }

    // ---- ARK SPKI pinning ----

    #[test]
    fn ark_spki_pin_accepts_all_builtin_arks() {
        for (product, ark_fn) in [
            (
                AmdProduct::Milan,
                builtin::milan::ark as fn() -> Result<_, _>,
            ),
            (
                AmdProduct::Genoa,
                builtin::genoa::ark as fn() -> Result<_, _>,
            ),
            (
                AmdProduct::Turin,
                builtin::turin::ark as fn() -> Result<_, _>,
            ),
        ] {
            let ark = ark_fn().expect("builtin ARK should decode");
            run_ark_spki_pin(&ark, product)
                .unwrap_or_else(|e| panic!("builtin {product} ARK must pass the SPKI pin: {e}"));
        }
    }

    /// A freshly generated self-signed cert with AMD's CN/O strings (matching
    /// `verify_ark_identity`) but a different key must be REJECTED by the SPKI
    /// pin. This is the core defense: identity strings alone are not enough.
    #[test]
    fn ark_spki_pin_rejects_forged_ark_with_correct_identity_but_wrong_key() {
        let forged = ark_like_cert("ARK-Milan", AMD_ORG_NAME, true);
        let err = run_ark_spki_pin(&forged, AmdProduct::Milan)
            .expect_err("forged ARK must be rejected by the SPKI pin");
        let msg = err.to_string();
        assert!(
            msg.contains("SubjectPublicKeyInfo hash does not match"),
            "expected SPKI pin mismatch, got: {msg}"
        );
    }

    /// The SPKI pin must use the product's own expected hash, not a different
    /// product's. Verifying the builtin Milan ARK against the Genoa pin must
    /// fail.
    #[test]
    fn ark_spki_pin_rejects_cross_product_mismatch() {
        let milan_ark = builtin::milan::ark().expect("Milan ARK should decode");
        let err = run_ark_spki_pin(&milan_ark, AmdProduct::Genoa)
            .expect_err("Milan ARK must not match the Genoa SPKI pin");
        assert!(
            err.to_string()
                .contains("SubjectPublicKeyInfo hash does not match"),
            "expected SPKI pin mismatch, got: {err}"
        );
    }

    // ---- TCB floor gate ----

    #[test]
    fn accepts_a_report_meeting_an_unrestricted_floor() {
        let report = SnpReport::from_bytes(&milan_report_bytes()).unwrap();
        verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &TcbFloorPolicy::UNRESTRICTED,
            &PlatformPolicy::NONE,
        )
        .expect("UNRESTRICTED floor accepts the genuine fixture");
    }

    #[test]
    fn rejects_a_report_below_the_tcb_floor() {
        let report = SnpReport::from_bytes(&milan_report_bytes()).unwrap();
        // One above the fixture's real snp SVN: the genuine, correctly-signed
        // report must now be rejected on the TCB gate (not the signature).
        let floor = TcbFloor {
            fmc: None,
            bootloader: report.reported_tcb.bootloader,
            tee: report.reported_tcb.tee,
            snp: report.reported_tcb.snp.saturating_add(1),
            microcode: report.reported_tcb.microcode,
        };
        let err = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &TcbFloorPolicy::uniform(floor),
            &PlatformPolicy::NONE,
        )
        .unwrap_err();
        assert!(matches!(err, AttestError::TcbBelowFloor(_)), "got {err:?}");
    }

    #[test]
    fn zen4c_floor_is_never_selected_for_a_non_zen4c_report() {
        // The Milan fixture is not a Zen4c part (and pre-v3 reports carry no
        // CPUID fields at all), so the gate must use the default floor: an
        // impossible zen4c floor must not affect the outcome...
        let report = SnpReport::from_bytes(&milan_report_bytes()).unwrap();
        let policy = TcbFloorPolicy {
            default: TcbFloor::UNRESTRICTED,
            x_variant: None,
            zen4c: Some(TcbFloor {
                fmc: None,
                bootloader: u8::MAX,
                tee: u8::MAX,
                snp: u8::MAX,
                microcode: u8::MAX,
            }),
        };
        verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &policy,
            &PlatformPolicy::NONE,
        )
        .expect("default floor governs a non-Zen4c report");

        // ...and an impossible default floor must reject it.
        let policy = TcbFloorPolicy {
            default: TcbFloor {
                fmc: None,
                bootloader: u8::MAX,
                tee: u8::MAX,
                snp: u8::MAX,
                microcode: u8::MAX,
            },
            x_variant: None,
            zen4c: Some(TcbFloor::UNRESTRICTED),
        };
        let err = verify_report_with_vcek(
            &report,
            AmdProduct::Milan,
            TEST_MILAN_VCEK_DER,
            TEST_MILAN_CRL_DER,
            TEST_NOW,
            &policy,
            &PlatformPolicy::NONE,
        )
        .unwrap_err();
        assert!(matches!(err, AttestError::TcbBelowFloor(_)), "got {err:?}");
    }

    // Option A, tested on the pure multi-view gate with synthetic TCBs so we can
    // make launch_tcb lag the others: a VM launched under a below-floor TCB is
    // rejected even when the platform's current/committed TCB is above the floor.
    #[test]
    fn gate_rejects_when_only_launch_tcb_is_below_floor() {
        let floor = TcbFloor {
            fmc: None,
            bootloader: 0,
            tee: 0,
            snp: 21,
            microcode: 0,
        };
        let good = TcbVersion {
            snp: 25,
            ..Default::default()
        };
        let old_launch = TcbVersion {
            snp: 20,
            ..Default::default()
        };
        // reported/current/committed all fine, launch below -> reject, naming launch.
        let err = check_tcb_floor(&old_launch, &good, &good, &good, &floor).unwrap_err();
        match err {
            AttestError::TcbBelowFloor(msg) => assert!(msg.contains("launch"), "msg: {msg}"),
            other => panic!("expected TcbBelowFloor, got {other:?}"),
        }
        // All four above -> ok.
        assert!(check_tcb_floor(&good, &good, &good, &good, &floor).is_ok());
    }
}
