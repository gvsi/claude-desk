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
the owner's say, what a tool shows Claude and knowledge the owner adds (`store_knowledge`).

A canary is matched on the text's letters and digits (`canary_key`): each character in NFKD and
case-folded, each character drawn like an ASCII letter or digit read as it (`LOOKALIKES` and
`DIGIT_LOOKALIKES`, from `lexicon/lookalikes.txt`, the table the reply check reads letters and
numerals with too), keeping only ASCII letters and digits, so an accented letter gives its base
letter, a Cyrillic а gives a and a Cyrillic З gives 3. It is found where its own letters and
digits occur in order with nothing between them but what that drops (spaces, punctuation,
symbols, other scripts' letters, combining marks), accented letters, precomposed or with a
combining mark, and characters the table reads. In the same reading an accented or lookalike
character may be one of the canary's own or a separator between them, so capitals, full-width
forms, accents on its letters, lookalikes in place of its letters or digits and accented or
lookalike characters between its characters hide it neither alone nor all together
("Çdk-0123é4567 89áb cdef", "сdk-0123456789аbсdеf" with a Cyrillic с, а and е, and
"cdk-012З4567б89abcdef" with a Cyrillic З and б, hold "cdk-0123456789abcdef"). A plain ASCII
letter or digit between its characters does hide it, as do a character the table holds no row for
in place of one of its own (a Cyrillic к), and a letter shaped like 0 or 1 in place of that digit
(an O for a 0, an l for a 1), which the table reads only as the letter it is drawn as.
"""

import functools
import re
import unicodedata
from collections.abc import Iterable, Iterator, Mapping, Sequence
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from typing import NamedTuple

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

LOOKALIKES_TXT = Path(__file__).resolve().parent / "lexicon" / "lookalikes.txt"


def _load_lookalikes() -> tuple[dict[str, str], dict[str, str]]:
    """`lexicon/lookalikes.txt` (made by `scripts/lookalikes.py` from Unicode's confusables.txt):
    the letters of other scripts, and the rarer Latin ones, that look like one ASCII letter, and
    the characters drawn as one ASCII digit, one `<code point>\\t<letter or digit>` per line: the
    letters and the digit lookalikes apart, each with what it looks like. A malformed line, or a
    second line for a character, stops the kernel from starting."""
    letters, digits = {}, {}
    for number, line in enumerate(LOOKALIKES_TXT.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or line.startswith("#"):
            continue
        code, tab, rest = line.partition("\t")
        looks_like = rest.split("#", 1)[0].strip()
        if (not tab or not re.fullmatch(r"[0-9A-F]{4,6}", code) or int(code, 16) < 0x80
                or not re.fullmatch(r"[A-Za-z0-9]", looks_like)):
            raise ValueError(f"{LOOKALIKES_TXT.name}:{number} is not a <code point>\\t<letter or digit> line")
        ch = chr(int(code, 16))
        if ch in letters or ch in digits:
            raise ValueError(f"{LOOKALIKES_TXT.name}:{number} lists {code} a second time")
        (digits if looks_like.isdigit() else letters)[ch] = looks_like
    return letters, digits


_LETTERS, _DIGITS = _load_lookalikes()
# Each letter drawn like one ASCII letter, read as it: by the canary reading here, and by the reply
# check's lexicons (`reply_check.LOOKALIKES`).
LOOKALIKES: Mapping[str, str] = MappingProxyType(_LETTERS)
# Each character drawn as one ASCII digit: read as that digit by the canary reading here, and as a
# numeral by the reply check (`reply_check.DIGIT_LOOKALIKES`).
DIGIT_LOOKALIKES: Mapping[str, str] = MappingProxyType(_DIGITS)
# The whole table, each character as the letter or digit it is drawn as, which the canary reading
# reads (the two parts share no character: a second line for one stops the kernel from starting).
_DRAWN_AS: Mapping[str, str] = MappingProxyType({**_LETTERS, **_DIGITS})


async def copy_canaries(ctx: KernelCtx) -> dict[str, str]:
    """The canary of each of the copy's documents, by document ID, in ID order."""
    rows = await ctx.db.execute(ctx.repo.scoped(
        select(Document.document_id, Document.canary).order_by(Document.document_id)))
    return {document_id: canary for document_id, canary in rows if canary}


class _Reading(NamedTuple):
    """Text as canaries are matched in it (`_reading`)."""

    key: str                              # its letters and digits (`canary_key`)
    skippable: list[bool]                 # for each, whether it came from an accented or lookalike character
    origin: list[int]                     # for each, the index in the text of the character it came from


def _letters(text: str) -> str:
    """The ASCII letters and digits of `text`, case-folded."""
    return "".join(part for part in text.casefold() if part.isascii() and part.isalnum())


def _is_mark(ch: str) -> bool:
    return unicodedata.category(ch)[0] == "M"


@functools.lru_cache(maxsize=4096)        # bounded: text may hold any of Unicode's characters
def _read(ch: str) -> tuple[str, bool, bool]:
    """One character as `_reading` takes it: its letters and digits (`_letters` of its NFKD form,
    each part of it drawn like an ASCII letter or digit read as it through the lookalike table, so
    an accented letter gives its base letter, a Cyrillic а gives a and a Cyrillic З gives 3); whether
    those may also be passed over between a canary's own, as an accented or lookalike character's
    may (its NFKD form holds a combining mark, its NFKC form keeps fewer of them, or a part was read
    through the table); and whether it is a combining mark itself, which accents the character
    before it. A mark gives nothing of its own unless the table draws it as a digit (an Oriya
    visarga as 8), when it gives that digit, skippable, and still accents the character before it."""
    if _is_mark(ch):
        drawn = _letters(_DRAWN_AS.get(ch, ""))
        return drawn, bool(drawn), True
    decomposed = unicodedata.normalize("NFKD", ch)
    plain = _letters(decomposed)
    letters = _letters("".join(_DRAWN_AS.get(part, part) for part in decomposed))
    skippable = bool(letters) and (letters != plain or any(_is_mark(part) for part in decomposed)
                                   or plain != _letters(unicodedata.normalize("NFKC", ch)))
    return letters, skippable, False


def _reading(text: str) -> _Reading:
    """`text` as canaries are matched in it: each character's letters (`_read`) in order, each
    marked skippable when its character is an accented or lookalike one or is followed by a
    combining mark, and the index of the character it came from."""
    letters: list[str] = []
    skippable: list[bool] = []
    origin: list[int] = []
    base = 0                              # where the letters of the last character that isn't a mark start
    for i, ch in enumerate(text):
        read, is_skippable, is_mark = _read(ch)
        if is_mark:                       # it accents the character before it
            skippable[base:] = [True] * (len(skippable) - base)
        else:
            base = len(letters)
        letters.extend(read)
        skippable.extend([is_skippable] * len(read))
        origin.extend([i] * len(read))
    return _Reading("".join(letters), skippable, origin)


def canary_key(text: str) -> str:
    """The letters and digits of `text` as canaries are matched on: each character in NFKD and
    case-folded, each character drawn like an ASCII letter or digit read as it (`LOOKALIKES`,
    `DIGIT_LOOKALIKES`), keeping only ASCII letters and digits, so "Ｃdk-0123 4567" reads as
    "cdk01234567", and so do "çďķ-0123 4567" and "сdk-012З 4567" with a Cyrillic с and З."""
    return _reading(text).key


class _Keys(NamedTuple):
    """The canaries of one scan, as one pass over a reading looks for all of them (`_keys`)."""

    ends: Mapping[str, tuple[str, ...]]   # each canary's `canary_key` -> the documents whose canary reads as it
    going_on: frozenset[str]              # the first letters, one to all but the last, of every key
    first: re.Pattern[str]                # a letter some key starts with


@functools.lru_cache(maxsize=256)         # bounded: one entry per set of canaries scanned for
def _keys(canaries: tuple[tuple[str, str], ...]) -> _Keys:
    """`canaries` (document ID, canary pairs) as `_places` looks for them: each canary's
    `canary_key` once, with every document whose canary reads as it, and every key's beginnings. A
    canary with no letters or digits has no key and is never found."""
    ends: dict[str, list[str]] = {}
    for document_id, canary in canaries:
        if wanted := canary_key(canary):
            ends.setdefault(wanted, []).append(document_id)
    going_on = frozenset(key[:count] for key in ends for count in range(1, len(key)))
    first = re.compile(f"[{''.join(sorted({key[0] for key in ends}))}]" if ends else "(?!)")   # (?!): none
    return _Keys(MappingProxyType({key: tuple(ids) for key, ids in ends.items()}), going_on, first)


def _places(reading: _Reading, keys: _Keys) -> dict[str, list[tuple[int, int]]]:
    """Where each key of `keys` occurs in `reading`, each place as the start and end of the
    characters it takes up in the text: the key's letters in order, with only skippable ones (from
    accented or lookalike characters) passed over between them. One pass over the letters for every
    key at once, keeping for each beginning of a key matched so far the earliest start that reached
    it (a place that starts later and ends at the same letter lies inside it). Keys that begin alike
    share those beginnings, so a hundred canaries, which all begin "cdk", cost about what one does;
    each key is still matched as it would be alone, ending only on one of its own letters."""
    key, skippable, origin = reading
    ends, going_on, first = keys
    places: dict[str, list[tuple[int, int]]] = {}
    matched: dict[str, int] = {}          # a key's beginning matched so far -> the earliest start that did
    i = 0
    while i < len(key):
        if not matched:                   # nothing under way: on to where a key could start
            found = first.search(key, i)
            if found is None:
                break
            i = found.start()
        letter, moved, ended = key[i], {}, {}
        for begun, start in matched.items():
            then = begun + letter         # the letter is the next of a key that begins so
            if then in ends and ended.get(then, start) >= start:
                ended[then] = start
            if then in going_on and moved.get(then, start) >= start:
                moved[then] = start
            if skippable[i] and moved.get(begun, start) >= start:
                moved[begun] = start      # or an accented or lookalike character between two of its own
        if letter in ends and letter not in ended:
            ended[letter] = origin[i]
        if letter in going_on and letter not in moved:
            moved[letter] = origin[i]
        for whole, start in ended.items():
            places.setdefault(whole, []).append((start, origin[i] + 1))
        matched = moved
        i += 1
    return places


def canary_spans(text: str, canaries: Mapping[str, str]) -> list[tuple[str, int, int]]:
    """Each place a canary of `canaries` (document ID → canary) occurs in `text`: the document's
    ID, and the start and end of the characters it takes up in `text`, from its first letter or
    digit to its last, whatever lies between (see the module docstring for what may). Places of one
    canary that overlap are listed once, as the characters they take up together; each document's
    places are in the order they start, and the documents in the order `canaries` lists them. The
    text is read once for all the canaries (`_places`), and not at all with none to look for."""
    if not canaries:
        return []
    keys = _keys(tuple(canaries.items()))
    if not keys.ends:
        return []
    found: dict[str, list[tuple[int, int]]] = {}
    for whole, places in _places(_reading(text), keys).items():
        for document_id in keys.ends[whole]:
            found[document_id] = places
    spans = []
    for document_id in canaries:
        merged: list[tuple[int, int]] = []
        for start, end in sorted(found.get(document_id, [])):
            if merged and start < merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        spans.extend((document_id, start, end) for start, end in merged)
    return spans


def find_canaries(text: str, canaries: Mapping[str, str]) -> list[str]:
    """The IDs of the documents whose canary occurs in `text` (`canary_spans`), in the order
    `canaries` lists them."""
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


def canary_fields(values: Mapping[str, object], canaries: Mapping[str, str]) -> list[str]:
    """The fields of `values` (field name → value) that hold a canary of `canaries`, each read on
    its own (`find_canaries_in`), in the order `values` lists them; or every field, when the
    others hold one only read together, one after another (a canary split between neighbouring
    fields)."""
    if not canaries:
        return []
    held = [field for field, value in values.items() if find_canaries_in(value, canaries)]
    rest = [value for field, value in values.items() if field not in held]
    return list(values) if find_canaries_in(rest, canaries) else held


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
