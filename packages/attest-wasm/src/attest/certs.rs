// Vendored from aleph-rs v0.22.0, crates/aleph-sdk/src/attest/certs.rs
// (https://github.com/aleph-im/aleph-rs, MIT, see LICENSE-aleph-rs).
// Changes for relay-button: only the KDS URL builders are kept; fetching and the on-disk cache are left to the caller (the browser fetches).
//! AMD Key Distribution Service (KDS) client for fetching VCEK certificates.
//!
//! Ported from aleph-cvm `crates/aleph-tee/src/sev_snp/certs.rs::fetch_vcek`,
//! adapted to return [`AttestError`] instead of `anyhow::Error` and to key the
//! on-disk cache off [`AmdProduct`] instead of a raw product string.
//!
//! ARK/ASK are *not* fetched here: they come from the `sev` crate's builtin,
//! bundled copies (see [`AmdProduct::builtin_ca`](super::verify::AmdProduct)),
//! so only the per-chip VCEK ever needs a network round trip.

use sev::firmware::host::TcbVersion;

use super::verify::AmdProduct;

/// Base URL for AMD's Key Distribution Service VCEK endpoint.
const KDS_BASE_URL: &str = "https://kdsintf.amd.com/vcek/v1";

/// AMD KDS URL of the VCEK for this chip and reported TCB. AMD answers with
/// `Access-Control-Allow-Origin: *`, so a browser can fetch it directly.
pub fn vcek_url(product: AmdProduct, chip_id: &[u8; 64], reported_tcb: &TcbVersion) -> String {
    format!(
        "{KDS_BASE_URL}/{}/{}?blSPL={}&teeSPL={}&snpSPL={}&ucodeSPL={}",
        product.kds_name(),
        hex::encode(chip_id),
        reported_tcb.bootloader,
        reported_tcb.tee,
        reported_tcb.snp,
        reported_tcb.microcode
    )
}

/// AMD KDS URL of the product CRL.
pub fn crl_url(product: AmdProduct) -> String {
    format!("{KDS_BASE_URL}/{}/crl", product.kds_name())
}
