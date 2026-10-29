//! The kernel's own Ed25519 key, ledger hashing and chain verification.
//!
//! `Signer` holds only the kernel's key; agent, mandate and demo-wallet keys
//! are checked with Python `cryptography` in the kernel service. Every key and
//! signature is lowercase hex: public keys 32 bytes, signatures 64 bytes.
use anyhow::{Context as _, Result, anyhow, bail};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// The domain every ledger entry's signature is made under.
pub const LEDGER_DOMAIN: &[u8] = b"desk-ledger-v1\0";

/// The `prev_hash` of a Desk's first ledger entry.
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// The fields a ledger entry's hash covers, nulls explicit.
const ENVELOPE: [&str; 6] = [
    "copy_id",
    "desk_id",
    "seq",
    "prev_hash",
    "created_at",
    "event",
];

const SEED_VAR: &str = "DESK_SIGNING_SEED";
const ENV_VAR: &str = "DESK_ENV";

/// The `DESK_ENV` values that name a development environment, where a missing
/// seed falls back to the dev key; unset counts as `""`. A value matches after
/// trimming ASCII whitespace, ignoring ASCII case. The backend's `desk.env`
/// holds the same list (a Python test compares them). Since unset counts as
/// development, a deploy must set `DESK_ENV=production`.
pub const DEVELOPMENT_ENVS: [&str; 6] = ["", "dev", "development", "test", "ci", "local"];

/// True when `DESK_ENV` (as `value`) names a development environment.
pub fn is_development_env(value: &str) -> bool {
    let value = value.trim_ascii();
    DEVELOPMENT_ENVS
        .iter()
        .any(|dev| value.eq_ignore_ascii_case(dev))
}

/// The dev key's seed. It is public on purpose: anything it signs is labelled
/// as dev-signed (`/health`, the Safety ledger) and is never trusted.
const DEV_SEED: [u8; 32] = [7; 32];

pub struct Signer {
    key: SigningKey,
    dev_key: bool,
}

impl Signer {
    /// Reads `DESK_SIGNING_SEED` (64 hex characters) from the process environment.
    pub fn from_env() -> Result<Self> {
        let mut vars = HashMap::new();
        for name in [SEED_VAR, ENV_VAR] {
            match std::env::var(name) {
                Ok(value) => {
                    vars.insert(name.to_string(), value);
                }
                Err(std::env::VarError::NotPresent) => {}
                Err(e) => bail!("{name}: {e}"),
            }
        }
        Self::from_env_with(&vars)
    }

    /// `from_env` over an explicit map, so tests never touch the process
    /// environment. A missing seed gives the dev key only in a development
    /// environment (`DESK_ENV` unset or in [`DEVELOPMENT_ENVS`]); anywhere
    /// else, `production` and any misspelling of it included, it is an error and
    /// the kernel refuses to start. A malformed seed is always an error.
    pub fn from_env_with(vars: &HashMap<String, String>) -> Result<Self> {
        let seed = vars
            .get(SEED_VAR)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        let development = is_development_env(vars.get(ENV_VAR).map_or("", String::as_str));
        match seed {
            Some(seed) => {
                let bytes: [u8; 32] = hex::decode(seed)
                    .ok()
                    .and_then(|b| b.try_into().ok())
                    .with_context(|| format!("{SEED_VAR} must be 64 hex characters"))?;
                Ok(Self {
                    key: SigningKey::from_bytes(&bytes),
                    dev_key: false,
                })
            }
            None if !development => {
                bail!(
                    "{SEED_VAR} is required unless {ENV_VAR} is unset or one of dev, development, test, ci, local"
                )
            }
            None => Ok(Self {
                key: SigningKey::from_bytes(&DEV_SEED),
                dev_key: true,
            }),
        }
    }

    /// True when signing with the public dev key.
    pub fn dev_key(&self) -> bool {
        self.dev_key
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.key.verifying_key().to_bytes())
    }

    /// The first 16 hex characters of the public key's sha256.
    pub fn key_id(&self) -> String {
        key_id_of(&self.key.verifying_key().to_bytes())
    }

    /// Signs `domain + digest` and returns the 64-byte signature as hex. The
    /// domain (`b"desk-ledger-v1\0"`, `b"desk-decision-v1\0"`, ...) keeps a
    /// signature from one context valid in no other, so its framing is checked:
    /// `desk-` and printable ASCII ending in a single NUL, then a 32-byte digest.
    pub fn sign(&self, domain: &[u8], digest: &[u8]) -> Result<String> {
        check_framing(domain, digest)?;
        Ok(hex::encode(
            self.key.sign(&[domain, digest].concat()).to_bytes(),
        ))
    }
}

fn check_framing(domain: &[u8], digest: &[u8]) -> Result<()> {
    let label = domain.strip_suffix(b"\0").unwrap_or(&[]);
    if !label.starts_with(b"desk-") || !label.iter().all(|b| b.is_ascii_graphic()) {
        bail!("a signing domain is b\"desk-<name>-v<n>\\0\"");
    }
    if digest.len() != 32 {
        bail!("a signed digest is 32 bytes, not {}", digest.len());
    }
    Ok(())
}

fn key_id_of(public_key: &[u8; 32]) -> String {
    hex::encode(Sha256::digest(public_key))[..16].to_string()
}

/// The sha256 (hex) of a ledger envelope's canonical text, which the kernel
/// stores as `envelope_jcs`. Text that isn't already canonical is refused, so
/// a hash always covers exactly the bytes `canonical_json` gives.
pub fn ledger_hash(envelope_jcs: &str) -> Result<String> {
    let canonical = crate::canonical_json(envelope_jcs).map_err(|e| anyhow!("envelope: {e}"))?;
    if canonical != envelope_jcs {
        bail!("envelope_jcs must be canonical JSON, as canonical_json returns it");
    }
    Ok(hex::encode(Sha256::digest(envelope_jcs.as_bytes())))
}

/// Verifies a Desk's ledger from its genesis entry: each entry's hash over its
/// envelope, its link to the previous hash (64 zeros first), consecutive
/// sequence numbers, the key id and the signature over `LEDGER_DOMAIN` + hash.
/// Returns `{"ok", "first_bad_seq"}`; input that isn't a list of entries, or a
/// malformed public key, is an error.
pub fn verify_chain(entries_json: &str, public_key_hex: &str) -> Result<String> {
    let key = verifying_key(public_key_hex)?;
    let key_id = key_id_of(&key.to_bytes());
    let entries =
        crate::jcs::parse_strict(entries_json).map_err(|e| anyhow!("entries_json: {e}"))?;
    let entries = entries
        .as_array()
        .context("entries_json must be a list of ledger entries")?;
    let (mut prev_hash, mut prev_seq) = (GENESIS.to_string(), None);
    for entry in entries {
        let seq = entry.get("seq").and_then(Value::as_i64);
        match entry_hash(entry, &prev_hash, prev_seq, &key, &key_id) {
            Some(hash) => (prev_hash, prev_seq) = (hash, seq),
            None => return Ok(json!({"ok": false, "first_bad_seq": seq}).to_string()),
        }
    }
    Ok(json!({"ok": true, "first_bad_seq": null}).to_string())
}

/// The entry's hash if every check passes.
fn entry_hash(
    entry: &Value,
    prev_hash: &str,
    prev_seq: Option<i64>,
    key: &VerifyingKey,
    key_id: &str,
) -> Option<String> {
    let fields = entry.as_object()?;
    let envelope: Map<String, Value> = ENVELOPE
        .iter()
        .map(|&f| Some((f.to_string(), fields.get(f)?.clone())))
        .collect::<Option<_>>()?;
    let hash: [u8; 32] = Sha256::digest(
        crate::canonical_json(&Value::Object(envelope).to_string())
            .ok()?
            .as_bytes(),
    )
    .into();
    let seq = fields.get("seq")?.as_i64()?;
    let text = |f: &str| fields.get(f).and_then(Value::as_str);
    let signature: [u8; 64] = hex::decode(text("signature")?).ok()?.try_into().ok()?;
    let signed = key
        .verify_strict(
            &[LEDGER_DOMAIN, &hash].concat(),
            &Signature::from_bytes(&signature),
        )
        .is_ok();
    let hash = hex::encode(hash);
    (text("hash")? == hash
        && text("prev_hash")? == prev_hash
        && prev_seq.is_none_or(|prev| prev.checked_add(1) == Some(seq))
        && text("key_id")? == key_id
        && signed)
        .then_some(hash)
}

fn verifying_key(public_key_hex: &str) -> Result<VerifyingKey> {
    let bytes: [u8; 32] = hex::decode(public_key_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .context("a public key is 64 hex characters")?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| anyhow!("public key: {e}"))
}
