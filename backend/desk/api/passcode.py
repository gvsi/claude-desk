"""The demo passcode: only creating a copy needs it, and the API holds only its scrypt hash (`PASSCODE_HASH`).

The hash reads `scrypt$16384$8$1$<salt b64>$<hash b64>`; `scripts/hash_passcode.py` makes one without echoing
the passcode. Neither the passcode nor the hash is ever logged, and errors never quote them.
"""

import base64
import hashlib
import hmac
import secrets

SCRYPT_N, SCRYPT_R, SCRYPT_P = 16384, 8, 1
SALT_BYTES, HASH_BYTES = 16, 32
MAX_SCRYPT_BYTES = 32 * 1024 * 1024      # 128 * N * r: a stored hash may not ask a check for more memory than this


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _derive(passcode: str, salt: bytes, n: int, r: int, p: int, length: int) -> bytes:
    return hashlib.scrypt(passcode.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=length,
                          maxmem=2 * MAX_SCRYPT_BYTES)


def hash_passcode(passcode: str) -> str:
    """A new `PASSCODE_HASH` for `passcode`, with a fresh random salt."""
    if not passcode:
        raise ValueError("the passcode is empty")
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _derive(passcode, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, HASH_BYTES)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def _parse(stored: str) -> tuple[int, int, int, bytes, bytes]:
    """The parameters, salt and hash of a stored `PASSCODE_HASH`; ValueError (quoting nothing) when it isn't one,
    or asks for more work than a passcode check should."""
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt" or not all(part.isascii() and part.isdigit() for part in (n, r, p)):
            raise ValueError
        params = int(n), int(r), int(p)
        raw = base64.b64decode(salt, validate=True), base64.b64decode(digest, validate=True)
    except ValueError:
        raise ValueError("PASSCODE_HASH must read scrypt$N$r$p$<salt b64>$<hash b64>") from None
    n_, r_, p_ = params
    if not (2 ** 10 <= n_ and n_ & (n_ - 1) == 0 and 1 <= r_ and 128 * n_ * r_ <= MAX_SCRYPT_BYTES and 1 <= p_ <= 4):
        raise ValueError("PASSCODE_HASH's scrypt parameters are out of range")
    if len(raw[0]) < SALT_BYTES or not 16 <= len(raw[1]) <= 64:
        raise ValueError("PASSCODE_HASH's salt or hash has the wrong length")
    return *params, *raw


def check_passcode_hash(stored: str) -> None:
    """Raise ValueError unless `stored` is a usable `PASSCODE_HASH` (checked at startup)."""
    _parse(stored)


def check_passcode(passcode: str, stored: str | None) -> bool:
    """True only when `passcode` matches the stored hash, compared in constant time; False with no hash set."""
    if stored is None:
        return False
    n, r, p, salt, expected = _parse(stored)
    try:
        derived = _derive(passcode, salt, n, r, p, len(expected))
    except UnicodeEncodeError:                  # text no browser would type (a lone surrogate) matches nothing
        return False
    return hmac.compare_digest(derived, expected)
