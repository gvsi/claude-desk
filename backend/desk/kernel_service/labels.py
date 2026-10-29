"""Labels: who may read a fact ("Labels" in the master plan's reply-check table).

A fact's label lists its readers: `"public"`, `"owner"`, `"person:<id>"` or `"session:<id>"`. A
session reads a fact when the two share a reader (`can_read`): every session reads public facts
and its own session's, a verified one also its person's, and the owner reads the business's. A
fact an adapter writes in a session is labelled for the owner and that session, and for the
verified person when there is one (`new_fact_label`). A fact with no label is the owner's alone.

`fact_row` and `fact_of` map between the `Fact` contract and its `facts` row, which also keeps
the session and action that wrote it.
"""

from collections.abc import Iterable, Sequence
from datetime import datetime

from desk.contracts import Fact, Label
from desk.db.models import ActorSession
from desk.db.models import Fact as FactRow
from desk.kernel_service.sessions import verified

OWNER_ONLY = ("owner",)


def _person(session_row: ActorSession) -> str | None:
    """The person a session is verified as, if any (an owner session is no person)."""
    if session_row.person_id is not None and verified(session_row.kind, session_row.assurance, session_row.person_id):
        return session_row.person_id
    return None


def session_readers(session_row: ActorSession) -> set[str]:
    """The readers a session reads as: `public` and its own session, plus its person when
    verified; the owner reads as `owner` and `public`."""
    if session_row.kind == "owner":
        return {"owner", "public"}
    readers = {"public", f"session:{session_row.session_id}"}
    person = _person(session_row)
    if person is not None:
        readers.add(f"person:{person}")
    return readers


def new_fact_label(session_row: ActorSession) -> Label:
    """The label of a fact an adapter writes in this session: the owner and the session, plus the
    verified person, who is then its record owner."""
    readers = ["owner", f"session:{session_row.session_id}"]
    person = _person(session_row)
    if person is not None:
        readers.append(f"person:{person}")
    return Label(readers=readers, record_owner=person)


def can_read(label: Label | Sequence[str] | None, readers: Iterable[str]) -> bool:
    """Whether a session reading as `readers` (`session_readers`) may read a fact with `label` (a
    `Label` or its readers): any reader in common. A missing or empty label reads as `["owner"]`."""
    if isinstance(label, str):
        raise TypeError("a label is a Label or a list of readers, not one string")
    listed = label.readers if isinstance(label, Label) else label
    return not set(listed or OWNER_ONLY).isdisjoint(readers)


def fact_row(copy_id: str, desk_id: str, fact: Fact, created_at: datetime, *, session_id: str | None = None,
             action_id: str | None = None) -> FactRow:
    """The `facts` row for `fact`; an adapter's fact also names the session and action behind it."""
    return FactRow(desk_id=desk_id, fact_id=fact.fact_id, copy_id=copy_id, kind=fact.kind, status=fact.status,
                   claims=fact.claims, readers=fact.label.readers, record_owner=fact.label.record_owner,
                   expires_at=fact.expires_at, source=fact.source, session_id=session_id, action_id=action_id,
                   created_at=created_at)


def fact_of(row: FactRow) -> Fact:
    """The `Fact` a `facts` row holds. A row without a source fails validation: a fact is never
    taken for the kernel's without saying so."""
    return Fact(fact_id=row.fact_id, kind=row.kind, status=row.status, source=row.source,
                claims=row.claims, label=Label(readers=row.readers or list(OWNER_ONLY), record_owner=row.record_owner),
                expires_at=row.expires_at)
