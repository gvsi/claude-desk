//! desk-kernel-core: the Rust half of the Claude Desk safety kernel.
//!
//! - [`policy`]: [`PolicyEngine`] loads a Desk's schema and compiled policy sets
//!   at runtime and decides allow, hold, refuse or needs_review.
//! - [`lint`]: [`lint_policies`], the shape rules a compiled draft must meet.
//! - [`jcs`]: [`canonical_json`] and `canonical_json_any` (RFC 8785).
//! - [`sign`]: [`Signer`], the kernel's Ed25519 key; [`ledger_hash`] and [`verify_chain`].
pub mod jcs;
pub mod lint;
pub mod policy;
pub mod sign;

pub use jcs::{canonical_json, canonical_json_any};
pub use lint::lint_policies;
pub use policy::{Outcome, PolicyEngine, Verdict};
pub use sign::{DEVELOPMENT_ENVS, Signer, is_development_env, ledger_hash, verify_chain};
