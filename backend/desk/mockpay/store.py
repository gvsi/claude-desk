"""The mock payments server's store: the `mockpay.*` tables, as role desk_mockpay.

Every method takes the copy it acts for and reads and writes only that copy's rows. Each mutation
runs in one transaction and locks the row it changes `FOR UPDATE` first, so concurrent requests
for one checkout, charge or key settle one at a time. A request that repeats an idempotency key
gets the first request's object back; one that reuses a key for something else, or names a key
the kernel voided, is refused.
"""

import secrets
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Row, Table, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from desk.db.models import Charge, Checkout, Refund, ToolDefinition
from desk.mockpay import definitions

CHECKOUTS: Table = Checkout.__table__
CHARGES: Table = Charge.__table__
REFUNDS: Table = Refund.__table__
TOOL_DEFINITIONS: Table = ToolDefinition.__table__
PERSON = "person:"   # a customer that is a person on record: `person:<person_id>`


class StoreError(Exception):
    """A request the store refuses; the message is safe to return to the kernel."""


class NotFound(StoreError):
    pass


class Conflict(StoreError):
    pass


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


def owner_of(customer_id: str) -> str | None:
    """The person a `person:<id>` customer names; None for any other customer."""
    return customer_id.removeprefix(PERSON) if customer_id.startswith(PERSON) else None


def _charge_view(row: Row) -> dict[str, Any]:
    return {"charge_id": row.charge_id, "amount_cents": row.amount_cents, "description": row.description,
            "created_at": row.created_at.astimezone(UTC).isoformat(), "refunded_cents": row.refunded_cents}


async def _locked_by_key(conn: AsyncConnection, table: Table, copy_id: str, key: str) -> Row | None:
    """The copy's row with idempotency key `key`, locked; None when the key is unused."""
    return (await conn.execute(select(table).where(table.c.copy_id == copy_id, table.c.idempotency_key == key)
                               .with_for_update())).one_or_none()


async def _create_once(conn: AsyncConnection, table: Table, copy_id: str, key: str, values: dict[str, Any]) -> Row:
    """The copy's row for idempotency key `key`, locked: the one these `values` make if the key is
    unused, else the row that settled the key first (an object, or a voided key)."""
    await conn.execute(insert(table).values(copy_id=copy_id, idempotency_key=key, **values)
                       .on_conflict_do_nothing(index_elements=["copy_id", "idempotency_key"]))
    row = await _locked_by_key(conn, table, copy_id, key)
    if row is None:   # inserted now, or by the request that settled the key first; rows are never deleted
        raise RuntimeError(f"no {table.name} row for a key that was just settled")
    return row


VOIDED = "That idempotency key was voided, so it can't be used."
REUSED = "That idempotency key was already used for a different request."


def _same_request(row: Row, **fields: Any) -> Row:
    """`row`, if the key's first request asked for these `fields`; refused if the key was voided or
    used for something else."""
    if row.state == "voided":
        raise Conflict(VOIDED)
    if any(getattr(row, name) != value for name, value in fields.items()):
        raise Conflict(REUSED)
    return row


async def _locked_checkout(conn: AsyncConnection, copy_id: str, checkout_id: str) -> Row:
    row = (await conn.execute(select(CHECKOUTS).where(
        CHECKOUTS.c.copy_id == copy_id, CHECKOUTS.c.checkout_id == checkout_id, CHECKOUTS.c.state != "voided",
    ).with_for_update())).one_or_none()
    if row is None:
        raise NotFound("There is no checkout with that ID.")
    return row


# What `void` settles, by kind: the table and the ID column and prefix of its objects.
KINDS: dict[str, tuple[Table, str, str]] = {"checkout": (CHECKOUTS, "checkout_id", "co"),
                                            "charge": (CHARGES, "charge_id", "ch"),
                                            "refund": (REFUNDS, "refund_id", "re")}


class Store:
    def __init__(self, database_url: str):
        self.engine: AsyncEngine = create_async_engine(database_url, pool_pre_ping=True)

    async def close(self) -> None:
        await self.engine.dispose()

    # Tool definitions

    async def definitions(self, copy_id: str) -> list[dict[str, Any]]:
        """The copy's tools as `tools/list` shows them: its own row where it has one, else the default."""
        async with self.engine.connect() as conn:
            rows = await conn.execute(select(TOOL_DEFINITIONS.c.name, TOOL_DEFINITIONS.c.definition)
                                      .where(TOOL_DEFINITIONS.c.copy_id == copy_id))
            own = {name: definition for name, definition in rows}
        return [own.get(name) or definitions.default(name) for name in definitions.TOOL_NAMES]

    async def simulate_change(self, copy_id: str, name: str) -> dict[str, Any]:
        """Change the copy's definition of tool `name` as a careless or poisoned update would (the
        demo's "Simulate a tool change"); other copies keep theirs."""
        if name not in definitions.TOOL_NAMES:
            raise NotFound("There is no tool with that name.")
        async with self.engine.begin() as conn:
            await conn.execute(insert(TOOL_DEFINITIONS).values(
                copy_id=copy_id, name=name, definition=definitions.default(name),
            ).on_conflict_do_nothing(index_elements=["copy_id", "name"]))
            current = (await conn.execute(select(TOOL_DEFINITIONS.c.definition).where(
                TOOL_DEFINITIONS.c.copy_id == copy_id, TOOL_DEFINITIONS.c.name == name,
            ).with_for_update())).scalar_one()
            changed = definitions.changed(current)
            await conn.execute(update(TOOL_DEFINITIONS).where(
                TOOL_DEFINITIONS.c.copy_id == copy_id, TOOL_DEFINITIONS.c.name == name,
            ).values(definition=changed))
        return changed

    # Checkouts

    async def create_checkout(self, copy_id: str, key: str, amount_cents: int, title: str, customer_id: str) -> str:
        async with self.engine.begin() as conn:
            row = await _create_once(conn, CHECKOUTS, copy_id, key, {
                "checkout_id": new_id("co"), "amount_cents": amount_cents, "title": title, "customer_id": customer_id,
                "state": "open"})
            return _same_request(row, amount_cents=amount_cents, title=title, customer_id=customer_id).checkout_id

    async def complete_checkout(self, copy_id: str, checkout_id: str) -> str:
        """Pay an open checkout: one charge, under the checkout's key with `:charge`, however often
        it is asked. A cancelled checkout can't be paid."""
        async with self.engine.begin() as conn:
            checkout = await _locked_checkout(conn, copy_id, checkout_id)
            if checkout.state == "succeeded":
                return checkout.charge_id
            if checkout.state == "cancelled":
                raise Conflict("That checkout was cancelled.")
            charge = await _create_once(conn, CHARGES, copy_id, f"{checkout.idempotency_key}:charge", {
                "charge_id": new_id("ch"), "owner_person_id": owner_of(checkout.customer_id),
                "customer_id": checkout.customer_id, "amount_cents": checkout.amount_cents,
                "description": checkout.title, "state": "succeeded"})
            _same_request(charge, customer_id=checkout.customer_id, amount_cents=checkout.amount_cents,
                          description=checkout.title)
            await conn.execute(update(CHECKOUTS).where(
                CHECKOUTS.c.copy_id == copy_id, CHECKOUTS.c.checkout_id == checkout_id,
            ).values(state="succeeded", charge_id=charge.charge_id))
            return charge.charge_id

    async def cancel_checkout(self, copy_id: str, checkout_id: str) -> dict[str, Any]:
        """Cancel an open checkout; one already paid stays paid and says so, with its charge."""
        async with self.engine.begin() as conn:
            checkout = await _locked_checkout(conn, copy_id, checkout_id)
            if checkout.state == "succeeded":
                return {"state": "succeeded", "charge_id": checkout.charge_id}
            if checkout.state == "open":
                await conn.execute(update(CHECKOUTS).where(
                    CHECKOUTS.c.copy_id == copy_id, CHECKOUTS.c.checkout_id == checkout_id,
                ).values(state="cancelled"))
            return {"state": "cancelled"}

    # Charges

    async def create_charge(self, copy_id: str, key: str, amount_cents: int, customer_id: str,
                            description: str) -> str:
        async with self.engine.begin() as conn:
            row = await _create_once(conn, CHARGES, copy_id, key, {
                "charge_id": new_id("ch"), "owner_person_id": owner_of(customer_id), "customer_id": customer_id,
                "amount_cents": amount_cents, "description": description, "state": "succeeded"})
            return _same_request(row, amount_cents=amount_cents, customer_id=customer_id,
                                 description=description).charge_id

    async def seed(self, copy_id: str, charges: list[tuple[str, int, str, datetime]]) -> list[str]:
        """Past charges for the copy's people, (owner_person_id, amount_cents, description, created_at)
        each; their customer is `person:<owner_person_id>` and their key their own ID."""
        rows = []
        for owner_person_id, amount_cents, description, created_at in charges:
            charge_id = new_id("ch")
            rows.append({"copy_id": copy_id, "charge_id": charge_id, "owner_person_id": owner_person_id,
                         "customer_id": f"{PERSON}{owner_person_id}", "amount_cents": amount_cents,
                         "description": description, "idempotency_key": f"seed:{charge_id}", "state": "succeeded",
                         "refunded_cents": 0, "created_at": created_at})
        if rows:
            async with self.engine.begin() as conn:
                await conn.execute(insert(CHARGES), rows)
        return [row["charge_id"] for row in rows]

    async def list_charges(self, copy_id: str, customer_id: str) -> list[dict[str, Any]]:
        """The copy's charges to `customer_id`, oldest first."""
        async with self.engine.connect() as conn:
            rows = await conn.execute(select(CHARGES).where(
                CHARGES.c.copy_id == copy_id, CHARGES.c.customer_id == customer_id, CHARGES.c.state == "succeeded",
            ).order_by(CHARGES.c.created_at, CHARGES.c.charge_id))
            return [_charge_view(row) for row in rows]

    async def charge(self, copy_id: str, charge_id: str) -> dict[str, Any]:
        """A charge's owner and amounts, as the refund adapter reads them."""
        async with self.engine.connect() as conn:
            row = (await conn.execute(select(CHARGES).where(
                CHARGES.c.copy_id == copy_id, CHARGES.c.charge_id == charge_id, CHARGES.c.state == "succeeded",
            ))).one_or_none()
        if row is None:
            raise NotFound("There is no charge with that ID.")
        return {"charge_id": row.charge_id, "owner_person_id": row.owner_person_id, "amount_cents": row.amount_cents,
                "refunded_cents": row.refunded_cents}

    # Keys

    async def void(self, copy_id: str, kind: str, key: str) -> dict[str, Any]:
        """Settle an idempotency key: `exists` with the object a request made with it, or `voided`,
        after which every request with it fails, so a request still in flight can't land later."""
        table, id_column, prefix = KINDS[kind]
        async with self.engine.begin() as conn:
            row = await _create_once(conn, table, copy_id, key, {id_column: new_id(prefix), "state": "voided"})
        return {"state": "voided" if row.state == "voided" else "exists", "object_id": getattr(row, id_column)}

    # Refunds

    async def create_refund(self, copy_id: str, charge_id: str, amount_cents: int, key: str) -> dict[str, Any]:
        """Refund `amount_cents` of one of the copy's charges, once per key; never above what is
        left of the charge."""
        async with self.engine.begin() as conn:
            charge = (await conn.execute(select(CHARGES).where(
                CHARGES.c.copy_id == copy_id, CHARGES.c.charge_id == charge_id, CHARGES.c.state == "succeeded",
            ).with_for_update())).one_or_none()
            if charge is None:
                raise NotFound("There is no charge with that ID.")
            existing = await _locked_by_key(conn, REFUNDS, copy_id, key)
            if existing is None:
                if amount_cents > charge.amount_cents - charge.refunded_cents:
                    raise Conflict("That is more than is left to refund on the charge.")
                refund_id = new_id("re")
                inserted = await conn.execute(insert(REFUNDS).values(
                    copy_id=copy_id, refund_id=refund_id, charge_id=charge_id, amount_cents=amount_cents,
                    idempotency_key=key, state="succeeded",
                ).on_conflict_do_nothing(index_elements=["copy_id", "idempotency_key"]).returning(REFUNDS.c.refund_id))
                if inserted.scalar_one_or_none() is not None:
                    await conn.execute(update(CHARGES).where(
                        CHARGES.c.copy_id == copy_id, CHARGES.c.charge_id == charge_id,
                    ).values(refunded_cents=CHARGES.c.refunded_cents + amount_cents))
                    return {"refund_id": refund_id, "charge_id": charge_id, "amount_cents": amount_cents}
                existing = await _locked_by_key(conn, REFUNDS, copy_id, key)   # the key was settled meanwhile
            if existing.state == "voided":
                raise Conflict(VOIDED)
            if (existing.charge_id, existing.amount_cents) != (charge_id, amount_cents):
                raise Conflict(REUSED)
            return {"refund_id": existing.refund_id, "charge_id": existing.charge_id,
                    "amount_cents": existing.amount_cents}
