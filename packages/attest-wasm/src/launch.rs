//! The launch measurements an SEV-SNP INSTANCE message pins, computed where
//! the owner is (relay-button#169, step 4): a helper that computed them could
//! pin a measurement of its choosing, and the browser would then attest to it.
//!
//! The recipe is aleph-rs `vprogram::measure::compute_measurements` (QEMU
//! direct boot, kernel hashes in the OVMF SEV metadata table, default guest
//! features, one VMSA per vCPU) over the runtime bundle's OVMF, kernel and
//! initrd, with the boot cmdline instantiated for the owner as aleph-rs
//! `instance_runtime::cmdline` does.

use sev::measurement::vcpu_types::CpuType;
use sev::measurement::vmsa::{GuestFeatures, VMMType};

use crate::measure::snp::{SnpMeasurementArgs, snp_calc_launch_digest};

/// `0x` and 40 hex digits, lowercased (aleph-rs `normalize_evm_owner`).
pub fn normalize_evm_owner(owner: &str) -> Result<String, String> {
    let lower = owner.to_lowercase();
    let valid = lower.len() == 42 && lower.starts_with("0x") && lower[2..].chars().all(|c| c.is_ascii_hexdigit());
    if valid { Ok(lower) } else { Err(format!("{owner:?} is not an EVM address")) }
}

/// The boot cmdline of a GPU-less instance runtime for `owner`: the
/// template's `{owner}` slot filled with the lowercased address.
pub fn instance_cmdline(template: &str, owner: &str) -> Result<String, String> {
    if !template.contains("{owner}") {
        return Err("the runtime's cmdline template has no {owner} slot".to_string());
    }
    if ["{gpu_arch}", "{gpu_count}", "{gpu_models}"].iter().any(|slot| template.contains(slot)) {
        return Err("a confidential GPU runtime is not supported here".to_string());
    }
    Ok(template.replace("{owner}", &normalize_evm_owner(owner)?))
}

/// One launch digest (lowercase hex) per CPU model the runtime declares.
pub fn launch_measurements(
    ovmf: &[u8],
    kernel: &[u8],
    initrd: &[u8],
    cmdline: &str,
    vcpus: u32,
    cpu_models: &[String],
) -> Result<Vec<(String, String)>, String> {
    cpu_models
        .iter()
        .map(|model| {
            let vcpu_type = CpuType::try_from(model.as_str()).map_err(|_| format!("{model:?} is not a known SNP vCPU type"))?;
            let digest = snp_calc_launch_digest(SnpMeasurementArgs {
                vcpus,
                vcpu_type,
                ovmf,
                guest_features: GuestFeatures::default(),
                kernel: Some(kernel),
                initrd: Some(initrd),
                append: Some(cmdline),
                ovmf_hash_str: None,
                vmm_type: Some(VMMType::QEMU),
            })
            .map_err(|e| format!("SNP launch digest computation failed: {e}"))?;
            let bytes: Vec<u8> = digest.try_into().map_err(|e| format!("{e:?}"))?;
            Ok((model.clone(), hex::encode(bytes)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "0x28129bdDa64310221480d4eF903446b0cdFD4BEb";

    #[test]
    fn instantiates_the_snp_1_2_template_for_the_owner() {
        assert_eq!(
            instance_cmdline("console=ttyS0 luks=1 owner={owner}", OWNER).unwrap(),
            "console=ttyS0 luks=1 owner=0x28129bdda64310221480d4ef903446b0cdfd4beb"
        );
        assert!(instance_cmdline("console=ttyS0", OWNER).is_err());
        assert!(instance_cmdline("owner={owner} gpu={gpu_arch}", OWNER).is_err());
        assert!(instance_cmdline("owner={owner}", "0x1234").is_err());
    }

    /// Against what Aleph's CLI pinned (and AMD then attested) for this owner
    /// on runtime snp-1.2 (aleph-snp-instance 2.1.2). Needs the extracted
    /// bundle: RUNTIME_BUNDLE_DIR=<dir with image/OVMF.fd, bzImage, initrd>
    /// cargo test launch_measurements_match -- --ignored
    #[test]
    #[ignore]
    fn launch_measurements_match_the_cli_for_snp_1_2() {
        let dir = std::path::PathBuf::from(std::env::var("RUNTIME_BUNDLE_DIR").expect("RUNTIME_BUNDLE_DIR"));
        let read = |name: &str| std::fs::read(dir.join("image").join(name)).unwrap();
        let (ovmf, kernel, initrd) = (read("OVMF.fd"), read("bzImage"), read("initrd"));
        let cmdline = instance_cmdline("console=ttyS0 luks=1 owner={owner}", OWNER).unwrap();
        let models = vec!["EPYC-Genoa".to_string(), "EPYC-v4".to_string()];
        let one = launch_measurements(&ovmf, &kernel, &initrd, &cmdline, 1, &models).unwrap();
        assert_eq!(one[0], ("EPYC-Genoa".into(), "ef01e41042b1333a3cd96a925c82d90c8381b131185dee8ec3022c1a1b05ba581d85f9a08b9578e885704e6ecff29de8".into()));
        assert_eq!(one[1], ("EPYC-v4".into(), "32683e52cb6cc93dbf37e86f7891546d75ec0c64e5e96ed718e2e62ebc4d0d9f5353d97aa41ef8daf1909a3dc4e20361".into()));
        let two = launch_measurements(&ovmf, &kernel, &initrd, &cmdline, 2, &models[..1]).unwrap();
        assert_eq!(two[0].1, "a1005adfdf588ee058159e3e49485b9a08aa08ca285bcedd8303bfeb0766ea18c1748fa56c2d05d908ea08d31f59d949");
    }
}
