"""Labels: who may read a fact ("Labels" in the master plan's reply-check table).

A fact's label lists its readers: `"public"`, `"owner"`, `"person:<id>"` or `"session:<id>"`. A
session reads a fact when the two share a reader (`can_read`): every session reads public facts
and its own session's, a verified one also its person's, and the owner reads the business's. A
fact an adapter writes in a session is labelled for the owner and that session, and for the
verified person when there is one (`new_fact_label`); when the session verifies, the facts it
already holds gain that person too (`relabel_on_verify`). A fact with no label is the owner's
alone.

Data put together from several labelled parts is readable only by the readers every part has
(`combine`).

`fact_row` and `fact_of` map between the `Fact` contract and its `facts` row, which also keeps
the session and action that wrote it.

Every document's body ends with its canary, a random marker (`cdk-` and 16 hex digits) that no
other text holds. Text that carries one is carrying the document out, so canaries are looked for
(`find_canaries`) wherever text could leave for someone the document isn't for: Claude's replies,
the owner's say, what a tool shows Claude and knowledge the owner adds (`store_knowledge`). They
are matched on two readings of the text (`canary_keys`), each keeping only ASCII letters and digits
after case folding, and a canary in either one counts: in NFKD an accented letter keeps its base
letter, so accents on a canary's letters don't hide it, and in NFKC an accented letter isn't an
ASCII one, so accented letters put between its characters don't either. Spaces, punctuation,
capitals and full-width forms hide one in neither.
"""

import unicodedata
from collections.abc import Iterable, Iterator, Mapping, Sequence
from datetime import datetime
from types import MappingProxyType

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from desk.contracts import Fact, KnowledgeItem, Label, LedgerEvent
from desk.db.models import ActorSession, Document
from desk.db.models import Fact as FactRow
from desk.db.models import KnowledgeItem as KnowledgeRow
from desk.kernel_service import ledger
from desk.kernel_service.repo import REF, KernelCtx, KernelFailure, storable
from desk.kernel_service.sessions import verified

OWNER_ONLY = ("owner",)
NO_CANARIES: Mapping[str, str] = MappingProxyType({})


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


async def relabel_on_verify(ctx: KernelCtx, session_row: ActorSession, person_id: str) -> None:
    """The session has just verified as `person_id`: the facts adapters wrote in it before, labelled
    for the session, become the person's too (`person:<id>` joins their readers, and the person is
    their record owner if they had none), so the person reads them from any session they verify
    in. Later facts get the same from `new_fact_label`. Runs in the verification's transaction."""
    session_reader, person_reader = f"session:{session_row.session_id}", f"person:{person_id}"
    rows = await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == session_row.desk_id, FactRow.session_id == session_row.session_id,
        FactRow.source == "kernel").with_for_update()))
    for row in rows:
        readers = list(row.readers or OWNER_ONLY)
        if session_reader not in readers:
            continue
        if person_reader not in readers:
            row.readers = [*readers, person_reader]
        if row.record_owner is None:
            row.record_owner = person_id
    await ctx.db.flush()


def label_of(readers: Sequence[str] | None, record_owner: str | None = None) -> Label:
    """The label a stored row's readers give it: a missing or empty list is the owner's alone."""
    return Label(readers=list(readers or OWNER_ONLY), record_owner=record_owner)


def combine(parts: Iterable[Label | Sequence[str]]) -> Label:
    """The label of data put together from `parts` (each a `Label` or its readers): readable only
    by the readers every part has. A `public` part restricts nothing; a part with no readers is the
    owner's alone, like any unlabelled row. The owner is always a reader, so two people's data
    together is the owner's alone, and nothing to combine is too. All parts public stays public. A
    record owner survives only when every part names the same one."""
    given = [parts] if isinstance(parts, str) else list(parts)
    if any(isinstance(part, str) for part in given):
        raise TypeError("each part is a Label or a list of readers, not one string")
    combined = [part if isinstance(part, Label) else Label(readers=list(part)) for part in given]
    restricting = [list(part.readers or OWNER_ONLY) for part in combined if "public" not in part.readers]
    if combined and not restricting:
        readers = ["public"]
    elif not restricting:
        readers = list(OWNER_ONLY)
    else:
        shared = set.intersection(*(set(each) for each in restricting))
        readers = ["owner", *(reader for reader in dict.fromkeys(restricting[0])
                              if reader in shared and reader != "owner")]
    owners = {part.record_owner for part in combined}
    return Label(readers=readers, record_owner=owners.pop() if len(owners) == 1 else None)


def can_read(label: Label | Sequence[str] | None, readers: Iterable[str]) -> bool:
    """Whether a session reading as `readers` (`session_readers`) may read a fact with `label` (a
    `Label` or its readers): any reader in common. A missing or empty label reads as `["owner"]`."""
    if isinstance(label, str):
        raise TypeError("a label is a Label or a list of readers, not one string")
    listed = label.readers if isinstance(label, Label) else label
    return not set(listed or OWNER_ONLY).isdisjoint(readers)


# ---- Canaries -------------------------------------------------------------------------------------

async def copy_canaries(ctx: KernelCtx) -> dict[str, str]:
    """The canary of each of the copy's documents, by document ID, in ID order."""
    rows = await ctx.db.execute(ctx.repo.scoped(
        select(Document.document_id, Document.canary).order_by(Document.document_id)))
    return {document_id: canary for document_id, canary in rows if canary}


# The forms `canary_keys` reads text in: NFKD first (`canary_key`), then NFKC. Neither alone is
# enough: NFKD turns an accented letter put between a canary's characters into a letter that
# breaks it, and NFKC keeps an accented letter of the canary itself as a non-ASCII character.
KEY_FORMS = ("NFKD", "NFKC")


def _keyed(text: str, form: str) -> tuple[str, list[int]]:
    """`text` read in `form` (one of `KEY_FORMS`): each character in that form and case-folded,
    keeping only ASCII letters and digits; and the index in `text` each of them came from."""
    chars: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        for part in unicodedata.normalize(form, ch).casefold():
            if part.isascii() and part.isalnum():
                chars.append(part)
                origin.append(i)
    return "".join(chars), origin


def canary_keys(text: str) -> tuple[str, ...]:
    """The readings of `text` canaries are matched in, one per `KEY_FORMS` form: each character in
    that form and case-folded, keeping only ASCII letters and digits, so spaces, punctuation,
    capitals and full-width forms hide a canary in neither. In NFKD an accented letter keeps its
    base letter, precomposed or with a combining mark ("çďķ-0123" reads as "cdk0123"); in NFKC it
    is dropped like any other non-ASCII letter ("cdk-01é23" reads as "cdk0123")."""
    return tuple(_keyed(text, form)[0] for form in KEY_FORMS)


def canary_key(text: str) -> str:
    """`text` in its first reading (`canary_keys`), NFKD: "Ｃdk-0123 4567" reads as "cdk01234567",
    and so does "çďķ-0123 4567"."""
    return _keyed(text, KEY_FORMS[0])[0]


def canary_spans(text: str, canaries: Mapping[str, str]) -> list[tuple[str, int, int]]:
    """Each place a canary of `canaries` (document ID → canary) occurs in either reading of `text`
    (`canary_keys`): the document's ID, and the start and end of the characters it takes up in
    `text`, from its first letter or digit to its last, whatever lies between. A place both
    readings find is listed once; each document's places are in the order they start."""
    readings = [(form, *_keyed(text, form)) for form in KEY_FORMS]
    spans = []
    for document_id, canary in canaries.items():
        places = set()
        for form, key, origin in readings:
            wanted = _keyed(canary, form)[0]
            start = key.find(wanted) if wanted else -1
            while start >= 0:
                places.add((origin[start], origin[start + len(wanted) - 1] + 1))
                start = key.find(wanted, start + 1)
        spans.extend((document_id, start, end) for start, end in sorted(places))
    return spans


def find_canaries(text: str, canaries: Mapping[str, str]) -> list[str]:
    """The IDs of the documents whose canary occurs in either reading of `text` (`canary_spans`),
    in the order `canaries` lists them."""
    found = {document_id for document_id, _, _ in canary_spans(text, canaries)}
    return [document_id for document_id in canaries if document_id in found]


def _texts(value: object, keys: list[str]) -> Iterator[str]:
    """The values in `value` as text, at any depth of mappings and lists, in order; the mappings'
    keys go to `keys`."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for key, item in value.items():
            keys.extend(_texts(key, keys))
            yield from _texts(item, keys)
    elif isinstance(value, (list, tuple, set, frozenset)):
        for item in value:
            yield from _texts(item, keys)
    elif value is not None:
        yield str(value)


def find_canaries_in(value: object, canaries: Mapping[str, str]) -> list[str]:
    """`find_canaries` over a text, or over every value at any depth of a mapping or a list (anything
    else as its text) read one after another, so a canary split between neighbouring values is
    found too, and over the mappings' keys likewise."""
    keys: list[str] = []
    values = " ".join(_texts(value, keys))
    found = {*find_canaries(values, canaries), *find_canaries(" ".join(keys), canaries)}
    return [document_id for document_id in canaries if document_id in found]


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
                claims=row.claims, label=label_of(row.readers, row.record_owner),
                expires_at=row.expires_at)


# ---- Knowledge ------------------------------------------------------------------------------------

KNOWLEDGE_READERS = (["owner"], ["public"])
MAX_KNOWLEDGE_BYTES = 100 * 1024
MAX_KNOWLEDGE_TITLE = 200
KNOWLEDGE_ID = REF                                     # as `desk_data` entries carry refs


def _check_knowledge(item: KnowledgeItem) -> None:
    if item.label.readers not in KNOWLEDGE_READERS or item.label.record_owner is not None:
        raise KernelFailure(422, "invalid", "knowledge_label")
    if not (storable(item.text) and storable(item.title)) or len(item.text.encode()) > MAX_KNOWLEDGE_BYTES \
            or len(item.title) > MAX_KNOWLEDGE_TITLE:
        raise KernelFailure(422, "invalid", "knowledge_text")
    if not KNOWLEDGE_ID.fullmatch(item.item_id):
        raise KernelFailure(422, "invalid", "ref")


async def store_knowledge(ctx: KernelCtx, desk_id: str, item: KnowledgeItem) -> KnowledgeItem:
    """The owner's knowledge item on the Desk, in the caller's transaction: added, or replacing the
    item with its ID (it keeps when it was first added), and ledgered `desk_data` `{part:
    "knowledge", item_id, owner_only_forced}`. Returns the item as stored.

    Knowledge is untrusted text, and one holding a document's canary in its title or text, even
    split or disguised (`find_canaries_in`), is stored the owner's alone, whatever label it came
    with (`owner_only_forced`), so private document text never reaches a visitor as knowledge.
    The API's view of the item (`kernel_ro.knowledge_items`) reads that ledgered flag and shows
    such an item's title and text as NULL, so no document text reaches the API either.

    Checked before anything is written, else 422 `invalid`: the label is the owner's alone or
    everyone's (`["owner"]` or `["public"]`, with no record owner), the text at most 100 KiB and
    the title at most 200 characters, both text Postgres can hold, and the ID one the ledger can
    name (`^[A-Za-z0-9_-]{1,64}$`) holding no canary, since the ledger and every reader of the
    item see its ID as it is."""
    _check_knowledge(item)
    canaries = await copy_canaries(ctx)
    if find_canaries(item.item_id, canaries):
        raise KernelFailure(422, "invalid", "knowledge_id_canary")
    forced = bool(find_canaries_in([item.title, item.text], canaries))
    readers = list(OWNER_ONLY) if forced else list(item.label.readers)
    insert = pg_insert(KnowledgeRow).values(desk_id=desk_id, item_id=item.item_id, copy_id=ctx.copy_id,
                                            source=item.source, title=item.title, text=item.text, readers=readers,
                                            created_at=ctx.clock.now())
    await ctx.db.execute(insert.on_conflict_do_update(
        index_elements=[KnowledgeRow.desk_id, KnowledgeRow.item_id],
        set_={"source": insert.excluded.source, "title": insert.excluded.title, "text": insert.excluded.text,
              "readers": insert.excluded.readers}))
    await ledger.append(ctx, copy_id=ctx.copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="desk_data", origin="kernel",
        summary={"part": "knowledge", "item_id": item.item_id, "owner_only_forced": forced}))
    return item.model_copy(update={"label": Label(readers=readers)})
