"""Decisions: the Cedar request a decision evaluates (Task 1), and later `/decide` itself.

`cedar_request` builds the master plan's `request_json` ("Cedar request shape") from kernel-built
values only: the principal from the session's rows, the action as its adapter normalized it.
Optional attributes appear only when set, since the schema reads them behind `has`.
`owner_approved` is never sent: the engine sets it for each evaluation, over any value sent.
"""

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from desk.contracts import NormalizedAction, Principal, Review

PRINCIPAL_TYPES = {"visitor": "Visitor", "agent": "Agent", "owner": "Owner"}
RESOURCE_TYPES = {"quote": "Quote", "slot": "Slot", "booking": "Booking", "document": "Document",
                  "charge": "Charge", "desk": "Desk"}


def cedar_request(principal: Principal, action: NormalizedAction, *, tz: str, now: datetime,
                  review: Review | None = None, mandate_remaining_cents: int | None = None) -> dict[str, Any]:
    """The request for `PolicyEngine.decide`. `local_dow` (0 = Monday) and `local_minute` are taken in
    the business's time zone `tz` for the action's `starts_at`, else for `now`. `review` is the
    reviewer's whole `Review` (the engine keeps its scores only on an "allow" recommendation);
    `mandate_remaining_cents` is an `Agent` attribute and is ignored for any other principal."""
    if now.tzinfo is None:
        raise ValueError("now must be an aware datetime")
    local = (action.starts_at or now).astimezone(ZoneInfo(tz))

    principal_type = PRINCIPAL_TYPES[principal.kind]
    attrs: dict[str, Any] = {
        # verified: an owner session, or a session /verify/check bound to a person (one per session)
        "verified": principal.assurance != "none" and (principal.kind == "owner" or principal.person_id is not None),
        "assurance": principal.assurance,
        "copy": principal.copy_id,
    }
    if principal.person_id is not None:
        attrs["person_id"] = principal.person_id
    if principal.kind == "agent":
        if not principal.agent_key_id:
            raise ValueError("an agent principal carries its agent_key_id")
        attrs["agent_key_id"] = principal.agent_key_id
        if mandate_remaining_cents is not None:
            attrs["mandate_remaining_cents"] = mandate_remaining_cents

    resource = action.resource
    resource_type = RESOURCE_TYPES[resource.kind]
    resource_attrs: dict[str, Any] = {"copy": action.copy_id}
    if resource.owner_person_id is not None:
        resource_attrs["owner_person_id"] = resource.owner_person_id

    context: dict[str, Any] = {
        "record_owner_match": principal.person_id is not None and resource.owner_person_id == principal.person_id,
        "local_dow": local.weekday(),
        "local_minute": local.hour * 60 + local.minute,
    }
    for name in ("list_cents", "discount_bp", "amount_cents", "recipient"):
        value = getattr(action, name)
        if value is not None:
            context[name] = value
    if review is not None:
        context["review"] = review.model_dump()

    principal_uid = {"type": principal_type, "id": principal.session_id}
    resource_uid = {"type": resource_type, "id": resource.id}
    return {
        "principal": principal_uid,
        "action": action.tool,
        "resource": resource_uid,
        "context": context,
        "entities": [
            {"uid": principal_uid, "attrs": attrs, "parents": []},
            {"uid": resource_uid, "attrs": resource_attrs, "parents": []},
        ],
    }
