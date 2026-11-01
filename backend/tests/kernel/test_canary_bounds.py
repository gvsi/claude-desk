"""Canary scans are bounded.

Every document's canary is looked for wherever text could carry the document out, so the cost of a
scan grows with the text and with the canaries it looks for. A scan with no canaries returns before
it reads the text; one with many reads the text once for all of them, however many there are. A
Desk holds at most 50 documents and 200 knowledge items, and a knowledge item found clean isn't
read again for a visitor's context until the copy's canaries change, so a full copy still gives a
visitor their context within half a second on a laptop; a slower machine's budget is scaled by a
calibration the run takes of its own speed, at most three times, and a run slower than that fails
as too slow to judge. Tests run on Turner Plumbing copies as `POST /copies`
seeds them (Friday 10:04 in Oakland).
"""

import random
import re
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Mapping

import pytest
from fastapi import FastAPI
from sqlalchemy import select, text

from desk.contracts import Label, SeedDocument
from desk.db.models import Document
from desk.db.models import KnowledgeItem as KnowledgeRow
from desk.kernel_api import DeskCreated
from desk.kernel_service import desks, labels, reply_check

from .helpers import kernel_ctx, rows_of
from .test_adapters import Rivera, rivera, visitor_of
from .test_context import SEEDED_PUBLIC_KNOWLEDGE, context_of
from .test_desk_writes import LOPEZ_DESK, desks_of, entries_of, new_desk, post_desk, upload
from .test_labels_hardening import (SEEDED_KNOWLEDGE_ENTRIES, disguises, documents, knowledge,
                                    knowledge_entries, post_knowledge, stored)


def test_a_scan_with_no_canaries_reads_nothing(monkeypatch):
    """With no canary to look for, or only canaries with no letters or digits to match, a scan
    returns at once, before it reads the text, so a long reply on a Desk with no documents costs the
    reply check nothing here."""
    read, reading = [], labels._reading
    monkeypatch.setattr(labels, "_reading", lambda text: read.append(text) or reading(text))
    long = "si ya está confirmada " * 4_000
    for canaries in ({}, labels.NO_CANARIES, {"doc-1": "--"}):
        assert labels.canary_spans(long, canaries) == []
        assert labels.find_canaries(long, canaries) == []
        assert labels.find_canaries_in({"reply": long}, canaries) == []
    assert [v.kind for v in reply_check.scan_prose(long)] == []
    assert not any(long in text for text in read)


def one_canary_at_a_time(text: str, canaries: Mapping[str, str]) -> list[tuple[str, int, int]]:
    """The reference the one-pass scan is held to: each canary looked for on its own, in its own
    pass over the reading, as the kernel did before it read the text once for all of them."""
    key, skippable, origin = labels._reading(text)

    def places(wanted: str) -> list[tuple[int, int]]:
        found: list[tuple[int, int]] = []
        matched: dict[int, int] = {}      # letters of `wanted` matched -> the earliest start that did
        for i, letter in enumerate(key):
            moved: dict[int, int] = {}
            for count, start in matched.items():
                if letter == wanted[count] and moved.get(count + 1, start) >= start:
                    moved[count + 1] = start
                if skippable[i] and moved.get(count, start) >= start:
                    moved[count] = start
            if letter == wanted[0] and 1 not in moved:
                moved[1] = origin[i]
            if len(wanted) in moved:
                found.append((moved.pop(len(wanted)), origin[i] + 1))
            matched = moved
        return found

    spans = []
    for document_id, canary in canaries.items():
        wanted = labels.canary_key(canary)
        merged: list[tuple[int, int]] = []
        for start, end in sorted(places(wanted) if wanted else []):
            if merged and start < merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        spans.extend((document_id, start, end) for start, end in merged)
    return spans


# Canaries that share most of their characters, the same canary on two documents, and canaries whose
# letters and digits begin another's, so one pass must keep every canary's places apart.
NEIGHBOURS = {"doc-a": "cdk-0123456789abcdef", "doc-b": "cdk-0123456789abcdee", "doc-c": "cdk-0123456700000000",
              "doc-d": "cdk-fedcba9876543210", "doc-e": "cdk-0123456789abcdef", "doc-f": "cdk-01",
              "doc-g": "cdk-0123456789abcdef0", "doc-h": "CDK-0123-4567", "doc-i": "--", "doc-j": "dk-01"}


def pieces(rng: random.Random) -> str:
    """A piece of text for `test_one_pass_finds_what_each_canary_finds_alone`: a canary as written,
    disguised or cut short, or the letters, digits, separators, accented and lookalike characters
    and combining marks that may lie between a canary's characters or break it."""
    canary = rng.choice(list(NEIGHBOURS.values()))
    choices = [
        lambda: canary, lambda: canary[:rng.randrange(1, len(canary) + 1)],
        lambda: rng.choice(disguises(canary)) if canary.startswith("cdk-") and len(canary) == 20 else canary.upper(),
        lambda: rng.choice(" -. –/"), lambda: rng.choice("éñÇáḃасеЗбȢ"),
        lambda: rng.choice("̧́ଃ"), lambda: rng.choice("0123456789abcdefkx"),
        lambda: "".join(rng.choice("0123456789abcdef") for _ in range(rng.randrange(1, 6))),
    ]
    return rng.choice(choices)()


def test_one_pass_finds_what_each_canary_finds_alone():
    """Reading the text once for every canary finds, for each document, the same places mapped onto
    the same characters as looking for its canary alone, whatever lies between a canary's
    characters, however many canaries share their first characters, and when the letters and
    digits of one canary begin another's."""
    rng = random.Random(7)
    for _ in range(400):
        text = "".join(pieces(rng) for _ in range(rng.randrange(1, 40)))
        canaries = dict(rng.sample(list(NEIGHBOURS.items()), rng.randrange(1, len(NEIGHBOURS) + 1)))
        assert labels.canary_spans(text, canaries) == one_canary_at_a_time(text, canaries), (text, canaries)
    # every disguise of every canary is still found, each in its one place
    for document_id, canary in NEIGHBOURS.items():
        if canary.startswith("cdk-") and len(canary) == 20:
            for disguised in disguises(canary):
                text = f"Reference: {disguised}."
                found = labels.canary_spans(text, NEIGHBOURS)
                assert found == one_canary_at_a_time(text, NEIGHBOURS), disguised
                [(start, end)] = [(start, end) for found_id, start, end in found if found_id == document_id]
                assert (text[:start], labels.canary_key(text[end:])) == ("Reference: ", ""), disguised


def fastest(scan, runs: int = 3) -> float:
    """The fastest of `runs` timings of `scan()`, in seconds, so a busy machine doesn't count."""
    timings = []
    for _ in range(runs):
        started = time.perf_counter()
        scan()
        timings.append(time.perf_counter() - started)
    return min(timings)


def test_a_hundred_canaries_cost_about_what_one_does():
    """A text is read once for all the canaries it is scanned for: 100 KiB of text that holds every
    one of a hundred canaries cut one digit short costs at most a few times what it costs for one of
    them, where a pass per canary would cost a hundred."""
    rng = random.Random(11)
    canaries = {f"doc-{n:03d}": "cdk-" + "".join(rng.choice("0123456789abcdef") for _ in range(16)) for n in range(100)}
    near = " ".join(f"ref {canary[:-1]}x, then" for canary in canaries.values()) + " "
    text = (near * (100 * 1024 // len(near) + 1))[:100 * 1024]
    one = dict(list(canaries.items())[:1])
    assert labels.canary_spans(text, canaries) == []
    assert fastest(lambda: labels.canary_spans(text, canaries)) < 3 * fastest(lambda: labels.canary_spans(text, one))


async def add_documents(app: FastAPI, copy: Rivera, count: int) -> None:
    """Test only: `count` more documents on the Desk, written as an upload writes them."""
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        for number in range(count):
            desks.write_document(ctx, copy.copy_id, copy.desk_id, SeedDocument(
                ref=f"note-{number}", title="Job note", body="Checked the shutoff valve."), None, ctx.clock.now())


async def test_a_desk_holds_at_most_fifty_documents(app, client):
    """Each document's canary is looked for in every scan, so a Desk holds at most 50 documents: the
    51st is refused (422 `invalid`), written nowhere and ledgered `desk_data` `{part: "documents",
    refused: "cap"}`. Another Desk of the copy has its own 50, and a new Desk's seed is held to the
    same number."""
    copy = await rivera(app, client)                                  # with Dana's invoice and Bob's warranty
    await add_documents(app, copy, desks.MAX_DOCUMENTS - 3)
    response = await upload(client, copy, {"ref": "price-sheet", "title": "Price sheet", "body": "Rates."})
    assert response.status_code == 200, response.text                 # the 50th
    before = len(await entries_of(app, copy))
    response = await upload(client, copy, {"ref": "one-more", "title": "One more", "body": "Rates."})
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert len(await rows_of(app, copy.copy_id, select(Document))) == desks.MAX_DOCUMENTS == 50
    [entry] = (await entries_of(app, copy))[before:]
    assert (entry.event.kind, entry.event.summary) == ("desk_data", {"part": "documents", "refused": "cap"})

    # another Desk of the copy starts with its own, and a new Desk brings at most 50
    seeded = [SeedDocument(ref=f"estimate-{n}", title="Estimate", body="Panel upgrade.") for n in range(50)]
    response = await post_desk(client, copy, new_desk(desk=LOPEZ_DESK.model_copy(update={"documents": seeded})))
    assert response.status_code == 200, response.text
    lopez = DeskCreated.model_validate(response.json()).desk_id
    assert len(await rows_of(app, copy.copy_id, select(Document).where(Document.desk_id == lopez))) == 50
    many = [*seeded, SeedDocument(ref="estimate-50", title="Estimate", body="Panel upgrade.")]
    response = await post_desk(client, copy, new_desk(desk=LOPEZ_DESK.model_copy(update={"documents": many})))
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert len(await desks_of(app, copy)) == 2


async def test_a_desk_holds_at_most_two_hundred_knowledge_items(app, client):
    """A visitor's context scans each knowledge item, so a Desk holds at most 200: a new item past
    them is refused (422 `invalid`), written nowhere and ledgered `desk_data` `{part: "knowledge",
    refused: "cap"}`, while an item already there may still be replaced."""
    copy = await rivera(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        ctx.db.add_all(KnowledgeRow(desk_id=copy.desk_id, item_id=f"kb-{number}", copy_id=copy.copy_id, source="upload",
                                    title="Note", text="Street parking is fine.", readers=["owner"])
                       for number in range(labels.MAX_KNOWLEDGE_ITEMS - len(SEEDED_PUBLIC_KNOWLEDGE) - 1))
    await stored(client, copy, knowledge("kb-tools", "Tools", "Mike brings a drain camera.", ["public"]))   # the 200th
    before = len(await entries_of(app, copy))
    response = await post_knowledge(client, copy, knowledge("kb-one-more", "One more", "A note.", ["public"]))
    assert (response.status_code, response.json()) == (422, {"code": "invalid"})
    assert len(await rows_of(app, copy.copy_id, select(KnowledgeRow))) == labels.MAX_KNOWLEDGE_ITEMS == 200
    [entry] = (await entries_of(app, copy))[before:]
    assert (entry.event.kind, entry.event.summary) == ("desk_data", {"part": "knowledge", "refused": "cap"})
    # replacing one already there adds none
    replaced = await stored(client, copy, knowledge("kb-tools", "Tools", "Mike brings a drain camera and a jetter.",
                                                    ["public"]))
    assert replaced.text.endswith("a jetter.")
    assert len(await rows_of(app, copy.copy_id, select(KnowledgeRow))) == 200


async def test_knowledge_found_clean_is_not_read_again_until_a_document_is_added(app, client, monkeypatch):
    """A knowledge item scanned clean when the owner stored it isn't scanned again for a visitor's
    context while the copy's canaries stay the same. Once a document is added, its canary is looked
    for in the item again, and an item holding it is kept from the visitor."""
    copy, visitor = await visitor_of(app, client)
    planted = "cdk-0123456789abcdef"                                   # no document's canary, yet
    text = f"Mike brings a drain camera to every call. Old reference {planted}."
    await stored(client, copy, knowledge("kb-tools", "Tools", text, ["public"]))
    scanned: list[str] = []
    spans = labels.canary_spans
    monkeypatch.setattr(labels, "canary_spans", lambda text, canaries: scanned.append(text) or spans(text, canaries))
    for _ in range(2):
        assert [(item.item_id, item.label.readers) for item in (await context_of(
            client, visitor.session_id, visitor.headers)).knowledge] == [("kb-tools", ["public"]),
                                                                      *SEEDED_PUBLIC_KNOWLEDGE]
    assert not any(planted in each for each in scanned)

    # a document whose canary the item holds: the item is read again and kept from the visitor
    monkeypatch.setattr(desks, "new_canary", lambda: planted)
    response = await upload(client, copy, {"ref": "old-invoice", "title": "Old invoice", "body": "Paid in full."})
    assert response.status_code == 200, response.text
    assert [(item.item_id, item.label.readers) for item in (await context_of(
        client, visitor.session_id, visitor.headers)).knowledge] == SEEDED_PUBLIC_KNOWLEDGE
    assert any(planted in each for each in scanned)



async def test_a_canary_split_between_a_knowledge_items_id_and_title_keeps_it_the_owners(app, client):
    """The owner's write scans a knowledge item as a visitor's context reads it, its ID, title and
    text one after another, so a canary begun in the ID and ended in the title is found there too:
    the item is stored the owner's alone, and the API's view shows none of its text."""
    copy, visitor = await visitor_of(app, client)
    dana = (await documents(app, copy))["dana-invoice"]
    split = knowledge(f"kb-{dana.canary[:10]}", f"{dana.canary[10:]} invoice", "Paid in full.", ["public"])
    assert (await stored(client, copy, split)).label == Label(readers=["owner"])
    assert await knowledge_entries(app, copy) == SEEDED_KNOWLEDGE_ENTRIES + [
        {"part": "knowledge", "item_id": split["item_id"], "owner_only_forced": True}]
    assert [(item.item_id, item.label.readers) for item in (await context_of(
        client, visitor.session_id, visitor.headers)).knowledge] == SEEDED_PUBLIC_KNOWLEDGE


CONTEXT_BUDGET = 0.5                      # seconds for one `/context` call, on a laptop
# The run's own speed against the laptop's: a fixed share of the work a `/context` call does, round trips to the
# kernel's database and a scan of text in plain Python, none of it kernel code, so a slower kernel can't widen its
# own budget. Its quickest of five took CALIBRATION_ON_A_LAPTOP on the laptop the budget was set on; a run that
# takes longer (a busy CI runner) has the budget scaled by as much, and a quicker one keeps it as it is.
CALIBRATION_ON_A_LAPTOP = 0.030
# The most the budget is scaled: three times, as much as a loaded laptop's round trips were seen to slow (a cold read
# took 0.59 s while they ran three times slower than when quiet). A run slower than that fails as too slow to judge:
# past it, a budget wide enough to pass would also pass a `/context` call several times slower than it should be.
MAX_CALIBRATION_SCALE = 3.0
CALIBRATION_TEXT = "lorem ipsum dolor sit amet, consectetur 0177 " * 9_600
CALIBRATION_NEEDLES = [re.compile(re.escape(f"amet{n:02d}x")) for n in range(16)]


async def calibrated_budget(app: FastAPI) -> float:
    """`CONTEXT_BUDGET`, scaled by how much longer than on the laptop this run takes, at its quickest
    of five, to make 20 round trips on one of the kernel engine's connections, then fold
    `CALIBRATION_TEXT`, turn its words around and look for 16 needles it doesn't hold; never less
    than the budget itself, nor more than `MAX_CALIBRATION_SCALE` times it: a run slower than that
    fails as too slow to judge."""
    async def once() -> float:
        started = time.perf_counter()
        async with app.state.kernel.engine.connect() as conn:
            for _ in range(20):
                await conn.execute(text("SELECT 1"))
        folded = unicodedata.normalize("NFKD", CALIBRATION_TEXT).casefold()
        words = " ".join(word[::-1] for word in re.findall(r"\w+", folded))
        assert not any(needle.search(words) for needle in CALIBRATION_NEEDLES)
        return time.perf_counter() - started

    quickest = min([await once() for _ in range(5)])
    scale = quickest / CALIBRATION_ON_A_LAPTOP
    if scale > MAX_CALIBRATION_SCALE:
        pytest.fail(f"calibration too slow to judge: {quickest:.3f} s, {scale:.1f} times the laptop's"
                    f" {CALIBRATION_ON_A_LAPTOP} s, past the {MAX_CALIBRATION_SCALE:.0f} times the budget may scale")
    return CONTEXT_BUDGET * max(1.0, scale)


async def test_a_full_copy_reads_its_context_within_budget(app, client, monkeypatch):
    """A copy with 100 documents (two Desks of 50) and a public 100 KiB knowledge item, written to
    near-miss every one of their canaries, gives a visitor their context within half a second (on a
    laptop, and within the run's calibrated budget elsewhere): the first time the item is read, as
    after a restart, and every time after, when it isn't."""
    copy, visitor = await visitor_of(app, client)
    await add_documents(app, copy, desks.MAX_DOCUMENTS - 2)
    seeded = [SeedDocument(ref=f"estimate-{n}", title="Estimate", body="Panel upgrade.") for n in range(50)]
    response = await post_desk(client, copy, new_desk(desk=LOPEZ_DESK.model_copy(update={"documents": seeded})))
    assert response.status_code == 200, response.text
    canaries = [row.canary for row in await rows_of(app, copy.copy_id, select(Document))]
    assert len(canaries) == 100
    near = " ".join(f"ref {canary[:-1]}x" for canary in canaries) + " "
    text = (near * (100 * 1024 // len(near) + 1))[:100 * 1024]
    await stored(client, copy, knowledge("kb-references", "Old references", text, ["public"]))

    async def timed(*, restarted: bool) -> float:
        if restarted:
            monkeypatch.setattr(labels, "_CLEAN_SCANS", OrderedDict())
        started = time.perf_counter()
        given = await context_of(client, visitor.session_id, visitor.headers)
        elapsed = time.perf_counter() - started
        assert [(item.item_id, item.label.readers) for item in given.knowledge] == [
            ("kb-references", ["public"]), *SEEDED_PUBLIC_KNOWLEDGE]
        return elapsed

    budget = await calibrated_budget(app)
    assert min([await timed(restarted=True) for _ in range(3)]) < budget
    assert min([await timed(restarted=False) for _ in range(3)]) < budget


@pytest.mark.parametrize(("each_run", "budget"), [
    (0.020, CONTEXT_BUDGET),                  # quicker than the laptop: the budget as it is
    (0.060, 2 * CONTEXT_BUDGET),              # twice as slow: twice the budget
    (0.087, 2.9 * CONTEXT_BUDGET),            # just under three times as slow, near the most it scales
    (0.091, None),                            # past three times as slow: too slow to judge
    (3.000, None),                            # a hundred times slower would have allowed a 50 s budget
])
async def test_the_calibration_scales_the_budget_at_most_three_times(app, monkeypatch, each_run, budget):
    """The calibration widens the budget with the run's own speed, up to three times; a run slower
    than that fails as too slow to judge, rather than letting a slow `/context` pass under a budget
    wide enough to hide it."""
    clock = [0.0]

    def ticking() -> float:                   # each calibration run takes `each_run` seconds
        clock[0] += each_run
        return clock[0]

    monkeypatch.setattr(time, "perf_counter", ticking)
    if budget is None:
        with pytest.raises(pytest.fail.Exception, match="calibration too slow to judge"):
            await calibrated_budget(app)
    else:
        assert await calibrated_budget(app) == pytest.approx(budget)
