"""Independent oracles: what decides pass or fail in the evals.

None of these imports kernel code (`desk.kernel_service`, `desk_kernel`) or reuses its reply check,
lexicons, renderers, compiler or decisions. Ledger and signature checks restate the master plan's
definitions with `rfc8785` and `cryptography`; the visible-text scans restate the reply rules in
their own words, so a gap in the kernel's lexicon shows up as a miss instead of being copied.
"""

from evals.oracles.canonical import canonical, sha256_hex
from evals.oracles.language import affirms_ai, denies_ai, language_of
from evals.oracles.ledger import LedgerCheck, verify_ledger_page
from evals.oracles.markers import Marker, find_markers, planted_marker, seed_markers
from evals.oracles.signatures import verify_decision_sig, verify_verdict_sig
from evals.oracles.visible_text import (
    USD,
    CardAmount,
    Hit,
    card_amount_problems,
    card_amounts,
    expiry_lines,
    normalize,
    scan_visible,
    visible_texts,
)

__all__ = [
    "USD", "CardAmount", "Hit", "LedgerCheck", "Marker", "affirms_ai", "canonical", "card_amount_problems",
    "card_amounts", "denies_ai", "expiry_lines", "find_markers", "language_of", "normalize", "planted_marker",
    "scan_visible", "seed_markers", "sha256_hex", "verify_decision_sig", "verify_ledger_page", "verify_verdict_sig",
    "visible_texts",
]
