"""Ed25519 checks over the master plan's signing definitions, with Python `cryptography`.

Every kernel signature is Ed25519 over `domain + digest`, where the domain names what is signed
(`b"desk-ledger-v1\\0"`, `b"desk-decision-v1\\0"`, `b"desk-verdict-v1\\0"`) and the digest is the
32-byte sha256 of the canonical JSON the contract lists. Keys and signatures are lowercase hex:
public keys 32 bytes, signatures 64 bytes ("Rust module surface"). A signature that is malformed,
covers other bytes or was made under another domain or key fails; nothing here raises on a bad
signature, only on a bad key, which the caller supplied.
"""

import hashlib
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pydantic import BaseModel

from evals.oracles.canonical import canonical

LEDGER_DOMAIN = b"desk-ledger-v1\0"
DECISION_DOMAIN = b"desk-decision-v1\0"
VERDICT_DOMAIN = b"desk-verdict-v1\0"

_PUBLIC_KEY = re.compile(r"[0-9a-f]{64}")
_SIGNATURE = re.compile(r"[0-9a-f]{128}")


def public_key(public_key_hex: str) -> Ed25519PublicKey:
    """The key from 64 lowercase hex characters; anything else raises ValueError."""
    if not isinstance(public_key_hex, str) or not _PUBLIC_KEY.fullmatch(public_key_hex):
        raise ValueError("a public key is 64 lowercase hex characters")
    return Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex))


def key_id_of(public_key_hex: str) -> str:
    """The first 16 hex characters of the public key's sha256, as the kernel names its key."""
    public_key(public_key_hex)
    return hashlib.sha256(bytes.fromhex(public_key_hex)).hexdigest()[:16]


def signed(public_key_hex: str, domain: bytes, digest: bytes, signature_hex: object) -> bool:
    """True when `signature_hex` is 128 lowercase hex characters signing `domain + digest`."""
    key = public_key(public_key_hex)
    if not isinstance(signature_hex, str) or not _SIGNATURE.fullmatch(signature_hex) or len(digest) != 32:
        return False
    try:
        key.verify(bytes.fromhex(signature_hex), domain + digest)
    except InvalidSignature:
        return False
    return True


def verify_decision_sig(session_id: str, payload: BaseModel | dict, key: str) -> bool:
    """`Decision.signature`, also carried by `EvReceipt`, `EvHeld` and `EvResolved`: Ed25519 over
    `b"desk-decision-v1\\0"` + sha256(canonical {decision_id, session_id, state, visitor_plain,
    ledger_seq}). The session comes from the caller (the stream or the request), not the payload."""
    data = _as_dict(payload)
    try:
        fields = {"decision_id": data["decision_id"], "session_id": session_id, "state": data["state"],
                  "visitor_plain": data["visitor_plain"], "ledger_seq": data["ledger_seq"]}
        digest = hashlib.sha256(canonical(fields)).digest()
    except (KeyError, ValueError):
        return False
    return signed(key, DECISION_DOMAIN, digest, data.get("signature"))


def verify_verdict_sig(session_id: str, payload: BaseModel | dict, key: str) -> bool:
    """`ReplyVerdict.signature`, also carried by `EvMessage`: Ed25519 over `b"desk-verdict-v1\\0"` +
    sha256(canonical {session_id, generation, message_id, blocks_sha256, visitor_plain, ledger_seq}),
    where blocks_sha256 is the hex sha256 of the canonical blocks exactly as the payload carries
    them, so a block edited, dropped, reordered or missing a field fails."""
    data = _as_dict(payload)
    try:
        fields = {"session_id": session_id, "generation": data["generation"], "message_id": data["message_id"],
                  "blocks_sha256": hashlib.sha256(canonical(data["blocks"])).hexdigest(),
                  "visitor_plain": data["visitor_plain"], "ledger_seq": data["ledger_seq"]}
        digest = hashlib.sha256(canonical(fields)).digest()
    except (KeyError, ValueError):
        return False
    return signed(key, VERDICT_DOMAIN, digest, data.get("signature"))


def _as_dict(payload: BaseModel | dict) -> dict[str, Any]:
    """A payload as JSON: a model as it serializes, a dict exactly as received."""
    return payload.model_dump(mode="json") if isinstance(payload, BaseModel) else payload
