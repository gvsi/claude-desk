"""Rules versions as the kernel keeps them (`kernel_ro.policy_versions`), as setup and the Rules page both use them
(Plan 02b, Tasks 7 and 9): the Desk's active version, a draft posted to the kernel and checked, what the owner reads
of a draft, a version's money cap, and the Desk's tools each with the cards that cover it.

A draft is compiled and proved by the kernel (`POST /policy/draft`): the API sends cards, never Cedar.
"""

from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import BaseModel

from desk.api.deps import ApiProblem, OwnerCtx
from desk.api.kernel_client import KernelUnavailable
from desk.api.schemas import CardDiff, CoveringCard, RulesDraft, RulesSummary, ToolRow
from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, PolicyVersion, RuleCard, ToolProfile
from desk.kernel_api import PolicyDraftRequest, ToolsConnectRequest

TOOL_ROW_FIELDS = tuple(name for name in ToolRow.model_fields if name != "cards")


def version_from_row(row: Mapping[str, Any]) -> PolicyVersion:
    """A rules version from its `kernel_ro.policy_versions` row."""
    return PolicyVersion.model_validate({name: row[name] for name in PolicyVersion.model_fields if name in row})


async def active_row(owner: OwnerCtx, desk_id: str) -> dict[str, Any]:
    """The Desk's active rules version's row; a Desk always has one, so none is 409 `conflict`."""
    row = await owner.ro.one("policy_versions", desk_id=desk_id, status="active")
    if row is None:
        raise ApiProblem(409, "conflict")
    return row


def version_cap(version: Mapping[str, Any] | BaseModel) -> int:
    """A rules version's money cap: the most an auto card may take or pay out in one action. Until the kernel's money
    cap contract (Plan 01b) puts `auto_money_cap_cents` on the version, every version is held to the platform's cap,
    `AUTO_MONEY_HARD_CAP_CENTS` (master "Money cap", sequencing); from then on, it is the version's own."""
    if "auto_money_cap_cents" not in PolicyVersion.model_fields:
        return AUTO_MONEY_HARD_CAP_CENTS
    fields = version.model_dump() if isinstance(version, BaseModel) else version
    return fields["auto_money_cap_cents"]


async def post_draft(owner: OwnerCtx, desk_id: str, cards: list[RuleCard], expected_parent: int) -> PolicyVersion:
    """The kernel's draft of `cards` on `expected_parent`, compiled and proved. A kernel that doesn't answer in time
    is 409 `rules_cannot_be_checked`, as a proof that timed out or ran bounded is (`checkable`)."""
    request = PolicyDraftRequest(desk_id=desk_id, cards=cards, expected_parent=expected_parent)
    try:
        return await owner.kernel.call("POST /policy/draft", request)
    except KernelUnavailable as unavailable:
        if unavailable.status is None:                   # no answer in time: the proof may still be running
            raise ApiProblem(409, "rules_cannot_be_checked") from None
        raise


def checkable(version: PolicyVersion) -> PolicyVersion:
    """`version`, unless its proof timed out or ran bounded: then 409 `rules_cannot_be_checked`, since no such draft
    can be confirmed ("Rules can't be checked right now")."""
    proof = version.proof
    if proof is None or proof.timed_out or proof.method == "bounded":
        raise ApiProblem(409, "rules_cannot_be_checked")
    return version


def _reasons(cards: list[RuleCard], mode: str) -> list[str]:
    return list(dict.fromkeys(card.reason for card in cards if card.mode == mode))


def rules_draft(version: PolicyVersion, auto_money_cap_cents: int, diff: CardDiff | None = None) -> RulesDraft:
    """What the owner reads of a draft: its owner cards, how they differ from the active rules (None in setup), the
    money cap it is at, the summary of every card (default asks included, each reason once) and the kernel's proof."""
    summary = RulesSummary(on_its_own=_reasons(version.cards, "auto"), asks_you=_reasons(version.cards, "ask"),
                           never=_reasons(version.cards, "never"))
    return RulesDraft(version=version.version, cards=[card for card in version.cards if not card.is_default],
                      diff=diff, auto_money_cap_cents=auto_money_cap_cents, proof=version.proof, summary=summary)


def covering_cards(cards: Iterable[RuleCard], tool: str, effects: Iterable[str]) -> list[CoveringCard]:
    """The cards that cover `tool`, in card order: its own, and those on one of its `effects` (shared)."""
    groups = {f"effect:{effect}" for effect in effects}
    return [CoveringCard(card_id=card.card_id, mode=card.mode, reason=card.reason, shared=card.applies_to in groups)
            for card in cards if card.applies_to == tool or card.applies_to in groups]


def tool_row(row: Mapping[str, Any] | ToolProfile, cards: Iterable[RuleCard]) -> ToolRow:
    """A tool as the kernel lists it (a `kernel_ro.tools` row or a profile), with the `cards` that cover it."""
    values = row.model_dump() if isinstance(row, ToolProfile) else row
    return ToolRow(**{name: values[name] for name in TOOL_ROW_FIELDS},
                   cards=covering_cards(cards, values["tool"], values["effects"]))


async def tool_rows(owner: OwnerCtx, desk_id: str, cards: Iterable[RuleCard]) -> list[ToolRow]:
    """The Desk's tools as the kernel lists them, by name, each with the `cards` that cover it."""
    cards = list(cards)
    return [tool_row(row, cards) for row in await owner.ro.rows("tools", desk_id=desk_id, order_by=("tool",))]


async def connect_payments(owner: OwnerCtx, desk_id: str) -> list[ToolRow]:
    """Connect the mock payments server to the Desk: its tools as the kernel pinned them (`needs_review` until the
    owner confirms them), each with the active rules' cards that cover it."""
    profiles = await owner.kernel.call("POST /tools/connect", ToolsConnectRequest(desk_id=desk_id,
                                                                                  server="mock_payments"))
    cards = version_from_row(await active_row(owner, desk_id)).cards
    return [tool_row(profile, cards) for profile in profiles]
