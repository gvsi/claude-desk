"""Tool call arguments, one builder per tool: the only module that knows adapter argument names.

Each builder follows its adapter's `input_schema` (Plan 01a's quote, find_slots and book tables;
Plan 01b's lead, callback, verification and document tools; Plan 01c's money and fetch tools).
Optional arguments left as None are left out, as a closed schema expects. Once a plan lands, its
adapters publish their schemas in `/context`'s `tools_declared`, and `schema_mismatches` checks the
keys built here against them, so a renamed argument fails the case that sends it instead of
turning into a refusal for bad arguments.
"""

from datetime import date
from typing import Any


def _present(**args: Any) -> dict[str, Any]:
    return {name: value for name, value in args.items() if value is not None}


def quote_args(item_id: str, qty: int = 1, requested_discount_bp: int | None = None) -> dict[str, Any]:
    return _present(items=[{"item_id": item_id, "qty": qty}], requested_discount_bp=requested_discount_bp)


def find_slots_args(from_date: date | str | None = None, days: int = 7) -> dict[str, Any]:
    return _present(from_date=from_date.isoformat() if isinstance(from_date, date) else from_date, days=days)


# Who a booking is for: a booking needs a name and a phone number or email unless the session is verified or
# saved them as a lead (#740), so the suite's bookings carry the ones an honest visitor gives.
BOOKING_NAME, BOOKING_CONTACT = "Jane Doe", "jane@example.com"


def book_args(slot_id: str, name: str | None = BOOKING_NAME, contact: str | None = BOOKING_CONTACT,
              address: str | None = None, note: str | None = None) -> dict[str, Any]:
    return _present(slot_id=slot_id, name=name, contact=contact, address=address, note=note)


def capture_lead_args(name: str, contact: str | None = None, note: str | None = None) -> dict[str, Any]:
    return _present(name=name, contact=contact, note=note)


def request_callback_args(name: str, contact: str, reason: str) -> dict[str, Any]:
    return {"name": name, "contact": contact, "reason": reason}


def start_verification_args(contact: str) -> dict[str, Any]:
    return {"contact": contact}


def release_document_args(document_id: str) -> dict[str, Any]:
    return {"document_id": document_id}


def payment_link_args(quote_id: str) -> dict[str, Any]:
    return {"quote_id": quote_id}


def charge_mandate_args(quote_id: str) -> dict[str, Any]:
    return {"quote_id": quote_id}


def list_charges_args() -> dict[str, Any]:
    return {}


def refund_args(charge_id: str) -> dict[str, Any]:
    return {"charge_id": charge_id}


def fetch_website_args(url: str) -> dict[str, Any]:
    return {"url": url}


def schema_mismatches(args: Any, schema: dict[str, Any]) -> list[str]:
    """Every key of built args that an adapter's JSON Schema doesn't name, and every key it
    requires that they leave out, through nested objects and lists (`$ref` and optional `anyOf`
    followed). Only keys: whether values fit is the kernel's to judge."""
    return _mismatches(args, schema, schema, "args")


def _mismatches(value: Any, schema: dict[str, Any], root: dict[str, Any], path: str) -> list[str]:
    schema = _resolve(value, schema, root)
    if isinstance(value, dict) and isinstance(schema.get("properties"), dict):
        properties = schema["properties"]
        found = [f"{path}.{key} isn't in the schema" for key in value if key not in properties]
        found += [f"{path}.{key} is required" for key in schema.get("required", []) if key not in value]
        for key, item in value.items():
            if key in properties:
                found += _mismatches(item, properties[key], root, f"{path}.{key}")
        return found
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        return [
            found for n, item in enumerate(value) for found in _mismatches(item, schema["items"], root, f"{path}.{n}")
        ]
    return []


def _resolve(value: Any, schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    """`schema` with a local `$ref` followed, and of `anyOf`/`oneOf` the branch shaped like `value`."""
    for _ in range(16):   # a bound, in case refs loop
        ref = schema.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            target: Any = root
            for part in ref[2:].split("/"):
                target = target.get(part, {}) if isinstance(target, dict) else {}
            schema = target if isinstance(target, dict) else {}
            continue
        branches = schema.get("anyOf") or schema.get("oneOf")
        if isinstance(branches, list):
            shape = "properties" if isinstance(value, dict) else "items" if isinstance(value, list) else None
            resolved = [_resolve(value, branch, root) for branch in branches if isinstance(branch, dict)]
            return next((branch for branch in resolved if shape and shape in branch), {})
        return schema
    return {}
