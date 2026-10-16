// SEV-SNP launch measurement in the browser (relay-button#169, step 4).
// The sev crate computes it from files on disk; these modules are its
// measurement code taking the runtime bundle's bytes instead (see each file).

// Kept close to the sev crate's code, including items the digest does not use.
#![allow(dead_code, unused_imports, unused_variables)]

pub mod gctx;
pub mod ovmf;
pub(crate) mod parser_helper;
pub mod sev_hashes;
pub mod snp;
