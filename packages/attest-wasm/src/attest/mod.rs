// The attestation verification core, vendored from aleph-rs v0.22.0
// (crates/aleph-sdk/src/attest, MIT, see LICENSE-aleph-rs) and trimmed to
// what runs in a browser: no network access, no file system, pure-Rust crypto.

pub mod certs;
pub mod platform;
pub mod tcb;
pub mod verify;
pub mod x509;

pub use platform::{PlatformPolicy, PlatformPosture};
pub use tcb::{TcbFloor, TcbFloorPolicy};
pub use verify::{AmdProduct, VerificationResult, verify_report_with_vcek};
pub use x509::AttestError;

use serde::{Deserialize, Serialize};

/// TEE backend that produced an [`AttestationReport`] (aleph-rs `attest::TeeType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TeeType {
    SevSnp,
    Tdx,
    NvidiaCc,
    None,
}

/// A TEE attestation report as the guest's `aleph-attest-agent` embeds it in
/// its RA-TLS certificate (aleph-rs `attest::AttestationReport`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationReport {
    pub tee_type: TeeType,
    #[serde(with = "hex_serde")]
    pub data: Vec<u8>,
}

/// The launch register an SEV-SNP INSTANCE message pins (aleph-types
/// `SevSnpRegisters`): the 48-byte launch digest, lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SevSnpRegisters {
    pub launch: String,
}

mod hex_serde {
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        hex::decode(&s).map_err(serde::de::Error::custom)
    }
}
