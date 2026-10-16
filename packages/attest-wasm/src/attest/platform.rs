// Vendored from aleph-rs v0.22.0, crates/aleph-sdk/src/attest/platform.rs
// (https://github.com/aleph-im/aleph-rs, MIT, see LICENSE-aleph-rs).
// Changes for relay-button: none.
//! PLATFORM_INFO posture: decode and (opt-in) gate the host-configuration
//! bits of a SEV-SNP attestation report.
//!
//! PLATFORM_INFO (report offset 0x40) is the one channel where the verifier
//! gets AMD-signed facts about the HOST's configuration: SMT, TSME, RAPL,
//! ciphertext hiding, memory-alias check. The G5 audit ruling moved these
//! checks verifier-side: users must not have to trust CRN configuration.
//!
//! Two deliberate asymmetries:
//! - Posture is ALWAYS decoded and surfaced ([`PlatformPosture`] rides every
//!   [`VerificationResult`](super::verify::VerificationResult)); gating is
//!   opt-in via [`PlatformPolicy`], because the current fleet reports the
//!   worst possible posture (plat_info 0x1) and a default-on floor would
//!   reject every host.
//! - A zero bit means "feature off OR firmware too old to report it"; both
//!   warrant rejection when the bit is required, so no distinction is made
//!   (requiring a bit is implicitly a firmware/hardware floor: ciphertext
//!   hiding needs Genoa+ silicon).

use sev::firmware::guest::PlatformInfo;

use super::AttestError;

/// Decoded view of a report's PLATFORM_INFO field: the six meaningful bits
/// plus the raw value. Purely descriptive; [`PlatformPolicy::check`] is what
/// gates. ECC and SEV-TIO are surfaced but never gated (reliability signal /
/// future feature respectively).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlatformPosture {
    /// Bit 0: a sibling hyperthread can share this core (side-channel
    /// surface). Normally governed by the pinned guest policy's SMT_ALLOWED
    /// bit, which the PSP enforces at launch; surfaced here for visibility.
    pub smt_enabled: bool,
    /// Bit 1: transparent SME encrypts all DRAM with a platform key
    /// (physical-attack hardening for non-guest-owned memory).
    pub tsme_enabled: bool,
    /// Bit 2: ECC memory in use. Informational only.
    pub ecc_enabled: bool,
    /// Bit 3: RAPL energy telemetry is disabled (Platypus-class power
    /// side-channel hardening).
    pub rapl_disabled: bool,
    /// Bit 4: guest ciphertext is unreadable from the host
    /// (CipherLeaks-class hardening; Genoa+ silicon only).
    pub ciphertext_hiding_enabled: bool,
    /// Bit 5: the firmware memory-alias scan ran since last reset and found
    /// no aliased addresses (BadRAM hardening). Resets to 0 on reset.
    pub alias_check_complete: bool,
    /// The raw PLATFORM_INFO value, for rendering and diagnostics.
    pub raw: u64,
}

impl From<PlatformInfo> for PlatformPosture {
    fn from(info: PlatformInfo) -> Self {
        PlatformPosture {
            smt_enabled: info.smt_enabled(),
            tsme_enabled: info.tsme_enabled(),
            ecc_enabled: info.ecc_enabled(),
            rapl_disabled: info.rapl_disabled(),
            ciphertext_hiding_enabled: info.ciphertext_hiding_enabled(),
            alias_check_complete: info.alias_check_complete(),
            raw: info.into(),
        }
    }
}

/// Opt-in requirements over [`PlatformPosture`]. Every field defaults to
/// "not required"; [`PlatformPolicy::NONE`] requires nothing and is the
/// v1 default (see module docs for why).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlatformPolicy {
    pub require_smt_disabled: bool,
    pub require_tsme: bool,
    pub require_rapl_disabled: bool,
    pub require_ciphertext_hiding: bool,
    pub require_alias_check: bool,
}

impl PlatformPolicy {
    /// The require-nothing policy: posture is surfaced, never gated.
    pub const NONE: PlatformPolicy = PlatformPolicy {
        require_smt_disabled: false,
        require_tsme: false,
        require_rapl_disabled: false,
        require_ciphertext_hiding: false,
        require_alias_check: false,
    };

    /// Check a posture against this policy. On failure the error names ALL
    /// unmet requirements (by their CLI spelling), not just the first, so an
    /// operator sees the full gap in one message.
    pub fn check(&self, posture: &PlatformPosture) -> Result<(), AttestError> {
        let mut unmet = Vec::new();
        if self.require_smt_disabled && posture.smt_enabled {
            unmet.push("smt-off");
        }
        if self.require_tsme && !posture.tsme_enabled {
            unmet.push("tsme");
        }
        if self.require_rapl_disabled && !posture.rapl_disabled {
            unmet.push("rapl-off");
        }
        if self.require_ciphertext_hiding && !posture.ciphertext_hiding_enabled {
            unmet.push("ciphertext-hiding");
        }
        if self.require_alias_check && !posture.alias_check_complete {
            unmet.push("alias-check");
        }
        if unmet.is_empty() {
            Ok(())
        } else {
            Err(AttestError::PlatformPosture {
                unmet,
                plat_info: posture.raw,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the real Milan testnet host reports today: SMT on, nothing else.
    const WORST_POSTURE_RAW: u64 = 0x1;
    /// SMT off, TSME + RAPL_DIS + ciphertext hiding + alias check all set.
    const FULL_POSTURE_RAW: u64 = 0x3A;

    fn posture(raw: u64) -> PlatformPosture {
        PlatformPosture::from(PlatformInfo::from(raw))
    }

    fn strict() -> PlatformPolicy {
        PlatformPolicy {
            require_smt_disabled: true,
            require_tsme: true,
            require_rapl_disabled: true,
            require_ciphertext_hiding: true,
            require_alias_check: true,
        }
    }

    #[test]
    fn posture_decodes_the_current_fleet_value() {
        let p = posture(WORST_POSTURE_RAW);
        assert!(p.smt_enabled);
        assert!(!p.tsme_enabled);
        assert!(!p.ecc_enabled);
        assert!(!p.rapl_disabled);
        assert!(!p.ciphertext_hiding_enabled);
        assert!(!p.alias_check_complete);
        assert_eq!(p.raw, WORST_POSTURE_RAW);
    }

    #[test]
    fn posture_decodes_a_fully_hardened_host() {
        let p = posture(FULL_POSTURE_RAW);
        assert!(!p.smt_enabled);
        assert!(p.tsme_enabled);
        assert!(!p.ecc_enabled);
        assert!(p.rapl_disabled);
        assert!(p.ciphertext_hiding_enabled);
        assert!(p.alias_check_complete);
        assert_eq!(p.raw, FULL_POSTURE_RAW);
    }

    #[test]
    fn policy_none_accepts_the_worst_posture() {
        PlatformPolicy::NONE
            .check(&posture(WORST_POSTURE_RAW))
            .expect("the default policy must never gate");
    }

    #[test]
    fn strict_policy_accepts_a_fully_hardened_host() {
        strict()
            .check(&posture(FULL_POSTURE_RAW))
            .expect("a posture satisfying every requirement must pass");
    }

    #[test]
    fn strict_policy_names_every_unmet_requirement() {
        let err = strict()
            .check(&posture(WORST_POSTURE_RAW))
            .expect_err("the worst posture must fail a strict policy");
        match err {
            AttestError::PlatformPosture { unmet, plat_info } => {
                assert_eq!(
                    unmet,
                    vec![
                        "smt-off",
                        "tsme",
                        "rapl-off",
                        "ciphertext-hiding",
                        "alias-check"
                    ]
                );
                assert_eq!(plat_info, WORST_POSTURE_RAW);
            }
            other => panic!("expected PlatformPosture, got: {other:?}"),
        }
    }

    #[test]
    fn single_requirement_failure_names_only_that_requirement() {
        let policy = PlatformPolicy {
            require_rapl_disabled: true,
            ..PlatformPolicy::NONE
        };
        let err = policy
            .check(&posture(WORST_POSTURE_RAW))
            .expect_err("RAPL is not disabled on the worst posture");
        match err {
            AttestError::PlatformPosture { unmet, .. } => {
                assert_eq!(unmet, vec!["rapl-off"]);
            }
            other => panic!("expected PlatformPosture, got: {other:?}"),
        }
    }
}
