//! `desk_kernel`: the Python module the kernel service imports (and nothing
//! else does). It wraps desk-kernel-core one to one; proofs are not here but
//! in the separate `desk-prove` binary.
use desk_kernel_core as kernel;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use std::collections::HashMap;

fn value_error(e: impl std::fmt::Display) -> PyErr {
    PyValueError::new_err(e.to_string())
}

/// Cedar decisions over a Desk's policy versions, which are loaded as text at
/// runtime and cached by key (`"<desk_id>:<version>"`).
#[pyclass(frozen)]
struct PolicyEngine {
    inner: kernel::PolicyEngine,
}

#[pymethods]
impl PolicyEngine {
    /// `baseline` is the Cedar text of the always-on forbids; raises
    /// ValueError if it doesn't parse or holds a permit.
    #[new]
    fn new(baseline: &str) -> PyResult<Self> {
        kernel::PolicyEngine::new(baseline)
            .map(|inner| Self { inner })
            .map_err(|e| value_error(format!("{e:#}")))
    }

    /// Lints and validates `sets_json` (`{"F", "A", "H"}`) and the baseline
    /// against the Desk's schema. Returns the errors; empty means loaded.
    fn load(&self, py: Python<'_>, key: &str, schema_json: &str, sets_json: &str) -> Vec<String> {
        py.detach(|| self.inner.load(key, schema_json, sets_json))
    }

    /// `{"outcome", "policy_ids", "pending_policy_ids", "errors"}` as JSON.
    /// Never raises: any problem is a refusal.
    fn decide(&self, py: Python<'_>, key: &str, request_json: &str, phase: &str) -> String {
        py.detach(|| self.inner.decide(key, request_json, phase))
    }
}

/// The kernel's own Ed25519 key; agent and wallet keys are checked with
/// Python `cryptography` instead.
#[pyclass(frozen)]
struct Signer {
    inner: kernel::Signer,
}

#[pymethods]
impl Signer {
    /// Reads `DESK_SIGNING_SEED` (64 hex). Raises ValueError when it is missing
    /// with `DESK_ENV=production` (the kernel then refuses to start) or malformed.
    #[staticmethod]
    fn from_env() -> PyResult<Self> {
        kernel::Signer::from_env()
            .map(|inner| Self { inner })
            .map_err(|e| value_error(format!("{e:#}")))
    }

    /// `from_env` over an explicit mapping instead of the process environment.
    #[staticmethod]
    fn from_env_with(vars: HashMap<String, String>) -> PyResult<Self> {
        kernel::Signer::from_env_with(&vars)
            .map(|inner| Self { inner })
            .map_err(|e| value_error(format!("{e:#}")))
    }

    /// True when signing with the public dev key (no seed outside production).
    #[getter]
    fn dev_key(&self) -> bool {
        self.inner.dev_key()
    }

    fn key_id(&self) -> String {
        self.inner.key_id()
    }

    fn public_key_hex(&self) -> String {
        self.inner.public_key_hex()
    }

    /// Signs `domain + digest` (a `b"desk-<name>-v<n>\0"` domain and a 32-byte
    /// digest) and returns the signature as hex.
    fn sign(&self, domain: &[u8], digest: &[u8]) -> PyResult<String> {
        self.inner.sign(domain, digest).map_err(value_error)
    }
}

/// The lint errors in `sets_json` (`{"F", "A", "H"}`); empty means it passes.
#[pyfunction]
fn lint_policies(sets_json: &str) -> Vec<String> {
    kernel::lint_policies(sets_json)
}

/// RFC 8785 canonical JSON; raises ValueError on floats.
#[pyfunction]
fn canonical_json(s: &str) -> PyResult<String> {
    kernel::canonical_json(s).map_err(value_error)
}

/// RFC 8785 canonical JSON with floats in ECMAScript form (MCP pins and the
/// `/decide` call hash only).
#[pyfunction]
fn canonical_json_any(s: &str) -> PyResult<String> {
    kernel::canonical_json_any(s).map_err(value_error)
}

/// The sha256 (hex) of a ledger envelope's canonical text.
#[pyfunction]
fn ledger_hash(envelope_jcs: &str) -> PyResult<String> {
    kernel::ledger_hash(envelope_jcs).map_err(value_error)
}

/// `{"ok", "first_bad_seq"}` as JSON for a Desk's ledger entries from genesis.
#[pyfunction]
fn verify_chain(entries_json: &str, public_key_hex: &str) -> PyResult<String> {
    kernel::verify_chain(entries_json, public_key_hex).map_err(value_error)
}

/// The kernel module's version.
#[pyfunction]
fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[pymodule]
fn desk_kernel(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PolicyEngine>()?;
    m.add_class::<Signer>()?;
    m.add_function(wrap_pyfunction!(lint_policies, m)?)?;
    m.add_function(wrap_pyfunction!(canonical_json, m)?)?;
    m.add_function(wrap_pyfunction!(canonical_json_any, m)?)?;
    m.add_function(wrap_pyfunction!(ledger_hash, m)?)?;
    m.add_function(wrap_pyfunction!(verify_chain, m)?)?;
    m.add_function(wrap_pyfunction!(version, m)?)?;
    Ok(())
}
