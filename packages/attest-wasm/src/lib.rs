//! SEV-SNP attestation verification for the browser (relay-button#169).
//!
//! The verification core is aleph-rs's (see `attest`), trimmed to run without
//! network or file access. The browser fetches the VCEK and the CRL from AMD's
//! KDS itself (it answers with `Access-Control-Allow-Origin: *`) and hands the
//! bytes in; this crate checks the AMD certificate chain, the report
//! signature, revocation, the TCB floor, and the launch measurement and guest
//! policy against what the INSTANCE message pinned.

pub mod attest;

use serde::Serialize;
use sev::firmware::guest::AttestationReport as SnpReport;
use sev::parser::ByteParser;
use wasm_bindgen::prelude::*;

use attest::tcb::{TcbFloor, TcbFloorPolicy, builtin_baseline_policy};
use attest::{AmdProduct, PlatformPolicy, VerificationResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tcb {
    pub fmc: Option<u8>,
    pub bootloader: u8,
    pub tee: u8,
    pub snp: u8,
    pub microcode: u8,
}

impl From<&sev::firmware::host::TcbVersion> for Tcb {
    fn from(tcb: &sev::firmware::host::TcbVersion) -> Self {
        Tcb {
            fmc: tcb.fmc,
            bootloader: tcb.bootloader,
            tee: tcb.tee,
            snp: tcb.snp,
            microcode: tcb.microcode,
        }
    }
}

/// What the browser needs before it can verify: where to fetch the VCEK and
/// CRL, and the claims it will be checking.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportInfo {
    pub chip_id: String,
    pub reported_tcb: Tcb,
    pub measurement: String,
    pub policy: String,
    pub report_data: String,
    pub vcek_url: String,
    pub crl_url: String,
}

/// The outcome of a successful verification. Every field comes from the
/// signed report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub verified: bool,
    pub measurement: String,
    pub policy: String,
    pub launch_tcb: Tcb,
    pub reported_tcb: Tcb,
    pub report_data: String,
    pub smt_enabled: bool,
    pub tsme_enabled: bool,
    pub summary: String,
}

/// Errors the browser can show and branch on.
#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("unknown AMD product {0:?} (expected Milan, Genoa or Turin)")]
    Product(String),
    #[error("not an SEV-SNP report: {0}")]
    Parse(String),
    #[error(transparent)]
    Attest(#[from] attest::AttestError),
    #[error("launch measurement {actual} is not one the INSTANCE message pinned")]
    Measurement { actual: String },
    #[error("guest policy {actual} differs from the pinned policy {expected}")]
    Policy { actual: String, expected: String },
}

pub fn parse_product(name: &str) -> Result<AmdProduct, VerifyError> {
    match name.to_ascii_lowercase().as_str() {
        "milan" => Ok(AmdProduct::Milan),
        "genoa" => Ok(AmdProduct::Genoa),
        "turin" => Ok(AmdProduct::Turin),
        _ => Err(VerifyError::Product(name.to_string())),
    }
}

fn parse_report(report: &[u8]) -> Result<SnpReport, VerifyError> {
    SnpReport::from_bytes(report).map_err(|e| VerifyError::Parse(e.to_string()))
}

pub fn report_info(report: &[u8], product: AmdProduct) -> Result<ReportInfo, VerifyError> {
    let parsed = parse_report(report)?;
    Ok(ReportInfo {
        chip_id: hex::encode(parsed.chip_id),
        reported_tcb: Tcb::from(&parsed.reported_tcb),
        measurement: hex::encode(parsed.measurement),
        policy: format!("{:#x}", u64::from(parsed.policy)),
        report_data: hex::encode(parsed.report_data),
        vcek_url: attest::certs::vcek_url(product, &parsed.chip_id, &parsed.reported_tcb),
        crl_url: attest::certs::crl_url(product),
    })
}

/// Verify `report` against AMD's chain (`vcek_der`, `crl_der` from KDS) at
/// `now` (unix seconds), then require its launch measurement to be one of
/// `expected_measurements` (hex, as the INSTANCE message pins them) and, if
/// given, its guest policy to equal `expected_policy`.
///
/// `min_tcb` raises AMD's published SB-3019 baseline (aleph-rs
/// `builtin_baseline_policy`) to a network floor, e.g. the `snp_min_tcb` the
/// CLI enforces; `None` keeps the baseline.
#[allow(clippy::too_many_arguments)]
pub fn verify(
    report: &[u8],
    product: AmdProduct,
    vcek_der: &[u8],
    crl_der: &[u8],
    now: i64,
    expected_measurements: &[String],
    expected_policy: Option<u64>,
    min_tcb: Option<TcbFloor>,
) -> Result<Verified, VerifyError> {
    let baseline = builtin_baseline_policy(product);
    let floor: TcbFloorPolicy = match min_tcb {
        Some(network) => baseline.raise_to(&network),
        None => baseline,
    };
    verify_with_floor(report, product, vcek_der, crl_der, now, expected_measurements, expected_policy, &floor)
}

/// [`verify`] with an explicit TCB floor policy (tests use the unrestricted
/// one for the aleph-rs fixture, whose firmware predates AMD's SB-3019 floor).
#[allow(clippy::too_many_arguments)]
fn verify_with_floor(
    report: &[u8],
    product: AmdProduct,
    vcek_der: &[u8],
    crl_der: &[u8],
    now: i64,
    expected_measurements: &[String],
    expected_policy: Option<u64>,
    floor: &TcbFloorPolicy,
) -> Result<Verified, VerifyError> {
    let parsed = parse_report(report)?;
    let result: VerificationResult = attest::verify_report_with_vcek(
        &parsed,
        product,
        vcek_der,
        crl_der,
        now,
        floor,
        &PlatformPolicy::NONE,
    )?;

    let measurement = result.registers.launch.to_ascii_lowercase();
    if !expected_measurements
        .iter()
        .any(|expected| expected.trim().to_ascii_lowercase() == measurement)
    {
        return Err(VerifyError::Measurement { actual: measurement });
    }
    if let Some(expected) = expected_policy {
        if result.policy != expected {
            return Err(VerifyError::Policy {
                actual: format!("{:#x}", result.policy),
                expected: format!("{expected:#x}"),
            });
        }
    }

    Ok(Verified {
        verified: true,
        measurement,
        policy: format!("{:#x}", result.policy),
        launch_tcb: Tcb::from(&result.launch_tcb),
        reported_tcb: Tcb::from(&result.reported_tcb),
        report_data: hex::encode(parsed.report_data),
        smt_enabled: result.platform.smt_enabled,
        tsme_enabled: result.platform.tsme_enabled,
        summary: result.summary,
    })
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    let json = serde_json::to_string(value).map_err(|e| JsError::new(&e.to_string()))?;
    js_sys::JSON::parse(&json).map_err(|_| JsError::new("could not hand the result to JavaScript"))
}

/// `reportInfo(report, product)`: chip, TCB, claims and the KDS URLs to fetch.
#[wasm_bindgen(js_name = reportInfo)]
pub fn report_info_js(report: &[u8], product: &str) -> Result<JsValue, JsError> {
    let product = parse_product(product).map_err(|e| JsError::new(&e.to_string()))?;
    to_js(&report_info(report, product).map_err(|e| JsError::new(&e.to_string()))?)
}

/// `verifyReport(report, product, vcek, crl, nowSeconds, expectedMeasurements,
/// expectedPolicy?, minTcb?)`. `expectedPolicy` is a decimal or `0x` hex
/// string; `minTcb` is `[bootloader, tee, snp, microcode]`. Throws with the
/// reason when anything does not hold.
#[wasm_bindgen(js_name = verifyReport)]
#[allow(clippy::too_many_arguments)]
pub fn verify_report_js(
    report: &[u8],
    product: &str,
    vcek: &[u8],
    crl: &[u8],
    now_seconds: f64,
    expected_measurements: Vec<String>,
    expected_policy: Option<String>,
    min_tcb: Option<Vec<u8>>,
) -> Result<JsValue, JsError> {
    let product = parse_product(product).map_err(|e| JsError::new(&e.to_string()))?;
    let expected_policy = match expected_policy.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(text) => Some(
            match text.strip_prefix("0x") {
                Some(hex) => u64::from_str_radix(hex, 16),
                None => text.parse::<u64>(),
            }
            .map_err(|_| JsError::new(&format!("expectedPolicy {text:?} is not a number")))?,
        ),
    };
    let min_tcb = match min_tcb.as_deref() {
        None => None,
        Some([bootloader, tee, snp, microcode]) => Some(TcbFloor {
            fmc: None,
            bootloader: *bootloader,
            tee: *tee,
            snp: *snp,
            microcode: *microcode,
        }),
        Some(_) => return Err(JsError::new("minTcb must be [bootloader, tee, snp, microcode]")),
    };
    let verified = verify(
        report,
        product,
        vcek,
        crl,
        now_seconds as i64,
        &expected_measurements,
        expected_policy,
        min_tcb,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    to_js(&verified)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT_HEX: &[u8] = include_bytes!("../testdata/report_milan.hex");
    const VCEK: &[u8] = include_bytes!("../testdata/vcek_milan.der");
    const CRL: &[u8] = include_bytes!("../testdata/crl_milan.der");
    // Inside the fixture CRL's window (aleph-rs TEST_NOW).
    const NOW: i64 = 1787011200;

    fn report() -> Vec<u8> {
        hex::decode(std::str::from_utf8(REPORT_HEX).unwrap().trim()).unwrap()
    }

    fn info() -> ReportInfo {
        report_info(&report(), AmdProduct::Milan).unwrap()
    }

    #[test]
    fn report_info_names_the_kds_urls_and_claims() {
        let info = info();
        assert!(info.vcek_url.starts_with("https://kdsintf.amd.com/vcek/v1/Milan/"));
        assert!(info.vcek_url.contains(&info.chip_id));
        assert_eq!(info.crl_url, "https://kdsintf.amd.com/vcek/v1/Milan/crl");
        assert_eq!(info.measurement.len(), 96);
    }

    #[test]
    fn verifies_the_real_report_when_its_measurement_is_pinned() {
        let info = info();
        let pinned = vec!["0".repeat(96), info.measurement.to_uppercase()];
        let verified = verify_with_floor(&report(), AmdProduct::Milan, VCEK, CRL, NOW, &pinned, None, &TcbFloorPolicy::UNRESTRICTED).unwrap();
        assert!(verified.verified);
        assert_eq!(verified.measurement, info.measurement);
        assert_eq!(verified.policy, info.policy);
    }

    #[test]
    fn refuses_a_measurement_the_message_did_not_pin() {
        let err = verify_with_floor(&report(), AmdProduct::Milan, VCEK, CRL, NOW, &["ab".repeat(48)], None, &TcbFloorPolicy::UNRESTRICTED)
            .unwrap_err();
        assert!(matches!(err, VerifyError::Measurement { .. }), "{err}");
    }

    #[test]
    fn refuses_a_different_policy() {
        let info = info();
        let err = verify_with_floor(&report(), AmdProduct::Milan, VCEK, CRL, NOW, &[info.measurement], Some(0x3_0000 | 1 << 19), &TcbFloorPolicy::UNRESTRICTED)
            .unwrap_err();
        assert!(matches!(err, VerifyError::Policy { .. }), "{err}");
    }

    #[test]
    fn refuses_a_report_signed_by_another_chip() {
        let mut tampered = report();
        tampered[0x90] ^= 0xff; // inside the measurement, covered by the signature
        let info = info();
        let err = verify_with_floor(&tampered, AmdProduct::Milan, VCEK, CRL, NOW, &[info.measurement], None, &TcbFloorPolicy::UNRESTRICTED)
            .unwrap_err();
        assert!(matches!(err, VerifyError::Attest(_)), "{err}");
    }

    #[test]
    fn refuses_a_tcb_below_a_network_floor() {
        let info = info();
        let floor = TcbFloor { fmc: None, bootloader: 255, tee: 0, snp: 0, microcode: 0 };
        let err = verify(&report(), AmdProduct::Milan, VCEK, CRL, NOW, &[info.measurement], None, Some(floor)).unwrap_err();
        assert!(matches!(err, VerifyError::Attest(_)), "{err}");
    }

    #[test]
    fn refuses_firmware_below_amds_published_floor_by_default() {
        // The fixture predates AMD's SB-3019 mitigations; verify() applies
        // that floor unless told otherwise.
        let info = info();
        let err = verify(&report(), AmdProduct::Milan, VCEK, CRL, NOW, &[info.measurement], None, None).unwrap_err();
        assert!(err.to_string().contains("below floor"), "{err}");
    }

    #[test]
    fn rejects_an_unknown_product() {
        assert!(parse_product("Naples").is_err());
        assert_eq!(parse_product("genoa").unwrap(), AmdProduct::Genoa);
    }
}
