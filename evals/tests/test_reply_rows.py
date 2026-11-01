"""The reply table's rows, checked without a kernel: the plan's counts, the loader's refusals, and
agreement with the evals' own scanner."""

import hashlib
import unicodedata
from collections import Counter
from types import SimpleNamespace

import desk_kernel
import pytest
import rfc8785

from desk.contracts import RenderedBlock, ReplyVerdict, Violation
from evals.fakes import FakeAnthropic
from evals.oracles import denies_ai, scan_visible
from evals.tier1 import test_reply_golden as reply_golden
from evals.tier1.golden_desk import GOLDEN_DIR, START, P
from evals.tier1.harness import TravelClock, match_expect
from evals.tier1.test_reply_golden import ReplyRow, load_rows


def test_timeout_reply_waits_past_the_production_soft_check_deadline():
    from desk.kernel_service.decisions import SOFT_PROMISE_TIMEOUT_S

    assert reply_golden.SOFT_PROMISE_REPLIES["timeout"].seconds > SOFT_PROMISE_TIMEOUT_S


def test_rows_load_with_the_plans_counts():
    rows = load_rows()
    assert len(rows) == len({row.id for row in rows}) == 68
    assert Counter(tuple(row.requires) for row in rows) == {("01a",): 62, ("01b",): 1, ("01c",): 5}
    assert [row.id for row in rows if row.requires == ["01b"]] == ["c-owner-only-fact"]


def test_rows_show_the_blocks_the_table_states():
    """Prose-only failures keep checked cards, or with none to keep show the call-back offer as
    prose; other failures show the handoff. Passing drafts show their prose (when not empty), then a
    card per clause."""
    rows = {row.id: row for row in load_rows()}
    assert rows["r-en-clean"].blocks == ["prose"]
    assert rows["c-own-quote"].blocks == ["prose", "quote"]
    assert rows["c-empty-prose-falls-back"].blocks == ["quote"]
    assert rows["c-hours"].blocks == ["prose", "hours"]
    assert rows["c-other-session-quote"].blocks == ["handoff"]
    assert rows["r-en-dollar"].blocks == ["prose"]                  # the call-back offer
    assert rows["c-final-prose-quote"].blocks == ["quote"]
    assert rows["c-digit-quote-payment"].blocks == ["quote", "payment_link"]


def test_rows_hold_the_amended_table_expectations():
    """Where the plan's table was amended to the master plan: Claude can't draft `owner_said`, so a
    drafted one is `unknown_fact` before entitlement is read; and a mixed-language number is
    `number_in_prose` and nothing else."""
    rows = {row.id: row for row in load_rows()}
    owner_only = rows["c-owner-only-fact"]
    assert [(clause.template, clause.fact) for clause in owner_only.clauses] == [
        ("owner_said", "other-session-owner-statement")]
    assert owner_only.expect.violations == ["unknown_fact"] and owner_only.expect.violations_any is None
    for row_id in ("r-mixed", "r-es-with-en-number"):
        assert rows[row_id].expect.violations == ["number_in_prose"], row_id
        assert rows[row_id].expect.violations_any is None, row_id


def test_rows_pin_the_owners_decision_on_restating_a_card():
    """The owner's decision of 2026-10-30 at the boundaries it moved: a booking claim, in English or
    Spanish, is shown beside this session's booking card and blocked with no card, and beside
    another session's booking the card checks refuse the card and the claim is blocked with it;
    the bare "right away" is no time word."""
    rows = {row.id: row for row in load_rows()}
    shown = {"c-booking-claim-beside-its-card": ("You're booked.", "en"),
             "c-booking-claim-beside-its-card-es": ("Tu cita está confirmada.", "es")}
    for row_id, (prose, language) in shown.items():
        row = rows[row_id]
        assert (row.prose, row.expect.ok, row.expect.language) == (prose, True, language), row_id
        assert [(clause.template, clause.fact) for clause in row.clauses] == [("booking_confirmed", "own-booking")]
        assert row.blocks == ["prose", "booking_confirmed"], row_id
    for row_id, prose in {"r-booking-claim-without-a-card": "You're booked.",
                          "r-booking-claim-without-a-card-es": "Tu cita está confirmada."}.items():
        row = rows[row_id]
        assert (row.prose, row.clauses, row.expect.violations) == (prose, [], ["promise_word"]), row_id
    other = rows["c-booking-claim-beside-another-sessions-card"]
    assert other.prose == "You're booked."
    assert [(clause.template, clause.fact) for clause in other.clauses] == [("booking_confirmed",
                                                                              "other-session-booking")]
    assert other.expect.violations == ["promise_word", "unentitled_fact"] and other.blocks == ["handoff"]
    adverb = rows["r-en-right-away"]
    assert (adverb.prose, adverb.expect.ok, adverb.blocks) == ("Turn off the water main right away.", True, ["prose"])


def test_rows_agree_with_the_scanner():
    """Prose the table expects to fail for an amount or a date is flagged by the evals' own scanner
    too, and every other row's prose is clean by it, so the kind a row expects is the only reason
    it can fail and a passing row's prose is clean by a reading other than the kernel's."""
    for row in load_rows():
        hits = scan_visible(row.prose)
        assert bool(hits) == ("number_in_prose" in row.expect.kinds), (row.id, hits)


def test_denies_ai_rows_really_deny_being_an_ai():
    """Each `denies_ai` row's prose denies being an AI by the evals' own oracle, independent of the
    kernel, so the row tests the soft-promise check's AI-denial flag and not an empty reply; both
    the English and the Spanish twin are present, each a lone `soft_promise`, shown as the call-back
    offer."""
    rows = {row.id: row for row in load_rows()}
    denies = [row for row in rows.values() if row.soft_promise == "denies_ai"]
    assert {row.id for row in denies} == {"r-soft-promise-denies-ai", "r-soft-promise-denies-ai-es"}
    for row in denies:
        assert denies_ai(row.prose), f"{row.id}'s prose doesn't deny being an AI: {row.prose!r}"
        assert row.expect.violations == ["soft_promise"] and row.blocks == ["prose"], row.id


def test_invisible_and_non_ascii_digits_are_written_as_escapes():
    """The bypass rows hold their characters as YAML escapes, so an editor or a paste can't strip
    or normalize them away and leave a row that passes without testing the bypass."""
    raw = (GOLDEN_DIR / "replies.yaml").read_text()
    literal = sorted({f"U+{ord(c):04X}" for c in raw
                      if unicodedata.category(c) == "Cf" or (c.isdigit() and not c.isascii())})
    assert literal == [], f"write these as escapes in replies.yaml: {literal}"
    rows = {row.id: row for row in load_rows()}
    assert rows["r-fullwidth"].prose == "It's ８９."
    assert rows["r-arabic-indic"].prose == "It's ٨٩."
    assert rows["r-zero-width"].prose == "It's 8​9."


GOOD_ROW = {"id": "a-row", "requires": ["01a"], "prose": "How can I help?", "expect": {"ok": True}}
QUOTE_CLAUSE = {"template": "quote", "fact": "own-quote"}


@pytest.mark.parametrize("change", [
    {"requires": ["master"]},                                                   # the reply check is 01a's
    {"requires": ["01d"]},
    {"clauses": [{"template": "owner_said", "fact": "other-session-owner-statement"}]},   # an owner say is 01b's
    {"colour": "teal"},                                                         # an unknown key
    {"prose": 89},
    {"expect": {"ok": "yes"}},
    {"expect": {"ok": True, "language": "fr"}},
    {"expect": {"ok": True, "violations": ["number_in_prose"]}},                # passing, with a violation
    {"expect": {"ok": False}},                                                  # failed, naming no kind
    {"expect": {"ok": False, "violations": []}},
    {"expect": {"ok": False, "violations": ["promise_word", "promise_word"]}},
    {"expect": {"ok": False, "violations": ["promise_word"], "violations_any": ["promise_word"]}},
    {"expect": {"ok": False, "violations": ["typo_in_prose"]}},
    {"expect": {"ok": False, "violations": ["promise_word"], "blocks": ["handoff"]}},   # the call-back offer shows
    {"expect": {"ok": True, "blocks": ["prose", "quote"]}},                     # a card no clause cites
    {"clauses": [QUOTE_CLAUSE], "expect": {"ok": True, "blocks": ["quote", "prose"]}},   # prose comes first
    {"expect": {"ok": True, "blocks": ["banner"]}},
    {"clauses": [{"template": "quote", "fact": "own-quote", "fact_id": "quote:Q-1"}]},
    {"clauses": [{"template": "quote", "fact": "my-quote"}]},
    {"clauses": [{"template": "receipt", "fact_id": "receipt:R-1"}]},
    {"setup": "travel_past_expiry"},                                            # nothing cited to expire
    {"setup": "sunrise"},
    {"soft_promise": "flag"},                                                   # a flag can't pass
    {"soft_promise": "error", "expect": {"ok": False, "violations": ["soft_promise", "promise_word"]}},
    {"soft_promise": "maybe"},
    {"soft_promise": "timeout", "expect": {"ok": False, "violations": ["soft_promise"]}},   # no verdict
    {"soft_promise": ["pass"]},                                                # one reply, not a list of tries
    {"soft_promise": ["timeout", "pass"]},                                     # no recheck can pass a draft
])
def test_rows_refuse_mistakes(change):
    ReplyRow.model_validate(GOOD_ROW)
    with pytest.raises(ValueError):
        ReplyRow.model_validate({**GOOD_ROW, **change})


def test_rows_with_one_id_twice_are_refused(tmp_path):
    path = tmp_path / "replies.yaml"
    path.write_text('- {id: a, requires: [01a], prose: "Hello there.", expect: {ok: true}}\n' * 2)
    with pytest.raises(ValueError, match="repeats the row ids"):
        load_rows(path)


def verdict(kinds: list[str], blocks: list[RenderedBlock], *, ok: bool | None = None,
            language: str = "en") -> ReplyVerdict:
    return ReplyVerdict(
        ok=not kinds if ok is None else ok, language=language, blocks=blocks, message_id="m-1", generation=0,
        visitor_plain="Reply checked", ledger_seq=7, signature="00" * 64,
        violations=[Violation(kind=kind, span="x", rule_id="r") for kind in kinds],
    )


PROSE = RenderedBlock(kind="prose", text="Here is your quote.")
QUOTE_CARD = RenderedBlock(kind="card", template="quote", text="$180.00\nDrain clearing", fact_id="quote:Q-1",
                           title="$180.00", lines=["Drain clearing"])
HANDOFF = RenderedBlock(kind="card", template="handoff", text="Let me check with Maria Rivera.",
                        title="Let me check with Maria Rivera.")
OFFER = RenderedBlock(kind="prose", text="Would you like me to arrange a callback?")


def test_verdict_expect_states_each_block_and_its_fact():
    rows = {row.id: row for row in load_rows()}
    expect = rows["c-own-quote"].verdict_expect(0, {"own-quote": "quote:Q-1"})
    passing = verdict([], [PROSE, QUOTE_CARD]).model_dump(mode="json")
    assert match_expect(200, passing, expect) == []
    for change in ({"blocks": [QUOTE_CARD, PROSE]}, {"blocks": [PROSE]}, {"language": "es"}, {"generation": 1}):
        assert match_expect(200, verdict([], [PROSE, QUOTE_CARD]).model_copy(update=change).model_dump(mode="json"),
                            expect), change
    for card in ({"fact_id": "quote:Q-2"}, {"title": None}, {"lines": []}, {"template": "charges"}, {"kind": "prose"}):
        shown = verdict([], [PROSE, QUOTE_CARD.model_copy(update=card)]).model_dump(mode="json")
        assert match_expect(200, shown, expect), card

    failed = rows["c-unknown-fact"].verdict_expect(0, {})
    assert match_expect(200, verdict(["unknown_fact"], [HANDOFF]).model_dump(mode="json"), failed) == []
    for shown in (verdict(["stale_fact"], [HANDOFF]), verdict(["unknown_fact"], [PROSE, HANDOFF]),
                  verdict(["unknown_fact"], [HANDOFF], ok=True)):
        assert match_expect(200, shown.model_dump(mode="json"), failed), shown


@pytest.mark.parametrize("kind", ["number_in_prose", "promise_word", "soft_promise", "uncertain_language",
                                  "check_unavailable"])
def test_prose_failure_expects_checked_cards_then_the_drafted_handoff(kind):
    """A failure only of the prose keeps the checked cards, then a handoff clause Claude drafted
    (the owner's ruling of 2026-11-01); without a drafted one, the cards alone. With no card to
    keep, the call-back offer the golden Desk has, in place of any drafted handoff (the owner's
    decision of 2026-11-01)."""
    alone = ReplyRow.model_validate({**GOOD_ROW, "clauses": [QUOTE_CLAUSE],
                                    "expect": {"ok": False, "violations": [kind], "blocks": ["quote"]}})
    assert alone.blocks == ["quote"]
    with pytest.raises(ValueError):
        ReplyRow.model_validate({**GOOD_ROW, "clauses": [{"template": "handoff"}, QUOTE_CLAUSE],
                                 "expect": {"ok": False, "violations": [kind], "blocks": ["quote"]}})
    row = ReplyRow.model_validate({**GOOD_ROW, "clauses": [{"template": "handoff"}, QUOTE_CLAUSE],
                                  "expect": {"ok": False, "violations": [kind], "blocks": ["quote", "handoff"]}})
    expect = row.verdict_expect(0, {"own-quote": "quote:Q-1"})
    assert match_expect(200, verdict([kind], [QUOTE_CARD, HANDOFF]).model_dump(mode="json"), expect) == []
    for blocks in ([PROSE, QUOTE_CARD, HANDOFF], [QUOTE_CARD], [HANDOFF, QUOTE_CARD], [HANDOFF], [],
                   [QUOTE_CARD.model_copy(update={"fact_id": "quote:wrong"}), HANDOFF],
                   [QUOTE_CARD.model_copy(update={"title": None}), HANDOFF],
                   [QUOTE_CARD.model_copy(update={"lines": []}), HANDOFF]):
        assert match_expect(200, verdict([kind], blocks).model_dump(mode="json"), expect)
    for clauses in ([], [{"template": "handoff"}]):
        no_cards = ReplyRow.model_validate({**GOOD_ROW, "clauses": clauses, "expect": {"ok": False,
                                                                                       "violations": [kind]}})
        assert no_cards.blocks == ["prose"]
        offered = no_cards.verdict_expect(0, {})
        assert match_expect(200, verdict([kind], [OFFER]).model_dump(mode="json"), offered) == []
        spanish = OFFER.model_copy(update={"text": "¿Quiere que solicite una llamada?"})
        assert match_expect(200, verdict([kind], [spanish], language="es").model_dump(mode="json"), offered) == []
        for blocks in ([HANDOFF], [PROSE], [OFFER, HANDOFF], []):
            assert match_expect(200, verdict([kind], blocks).model_dump(mode="json"), offered), blocks


@pytest.mark.parametrize("kind", ["canary", "unknown_fact", "stale_fact", "unentitled_fact", "unsupported_language",
                                  "session_paused"])
def test_non_prose_failure_cannot_expect_kept_cards(kind):
    raw = {**GOOD_ROW, "clauses": [QUOTE_CLAUSE], "expect": {"ok": False, "violations": [kind]}}
    assert ReplyRow.model_validate(raw).blocks == ["handoff"]
    with pytest.raises(ValueError):
        ReplyRow.model_validate({**raw, "expect": {**raw["expect"], "blocks": ["quote"]}})


def test_violation_kinds_compare_as_sets():
    rows = {row.id: row for row in load_rows()}
    # r-en-dollar: violations [number_in_prose]; r-en-time: violations_any [number_in_prose, promise_word]
    exact, any_of = rows["r-en-dollar"], rows["r-en-time"]
    assert exact.kind_mismatches(verdict(["number_in_prose", "number_in_prose"], [HANDOFF])) == []
    assert exact.kind_mismatches(verdict(["number_in_prose", "promise_word"], [HANDOFF]))
    assert exact.kind_mismatches(verdict(["unsupported_language"], [HANDOFF]))
    assert exact.kind_mismatches(verdict([], [HANDOFF], ok=False))
    assert any_of.kind_mismatches(verdict(["promise_word"], [HANDOFF])) == []
    assert any_of.kind_mismatches(verdict(["promise_word", "number_in_prose"], [HANDOFF])) == []
    assert any_of.kind_mismatches(verdict(["number_in_prose", "soft_promise"], [HANDOFF]))
    assert any_of.kind_mismatches(verdict([], [HANDOFF], ok=False))
    assert rows["r-en-clean"].kind_mismatches(verdict([], [PROSE])) == []
    assert rows["r-en-clean"].kind_mismatches(verdict(["soft_promise"], [PROSE], ok=True))


# A quote row run whole against a signed stand-in verdict

ROW_SIGNER = desk_kernel.Signer.from_env_with({"DESK_SIGNING_SEED": "0b" * 32})   # a test key only
ROW_SESSION, ROW_QUOTE = "s-row-1", "quote:Q-row-1"


def signed_verdict(blocks: list[RenderedBlock], language: str = "en") -> ReplyVerdict:
    """A passing verdict at generation 0, signed as the kernel signs one, so the row's signature
    check holds and only what the card shows can fail it."""
    unsigned = verdict([], blocks, language=language).model_copy(update={"message_id": "m-row-1", "ledger_seq": 3})
    data = unsigned.model_dump(mode="json")
    fields = {"session_id": ROW_SESSION, "generation": data["generation"], "message_id": data["message_id"],
              "blocks_sha256": hashlib.sha256(rfc8785.dumps(data["blocks"])).hexdigest(),
              "visitor_plain": data["visitor_plain"], "ledger_seq": data["ledger_seq"]}
    signature = ROW_SIGNER.sign(b"desk-verdict-v1\0", hashlib.sha256(rfc8785.dumps(fields)).digest())
    return unsigned.model_copy(update={"signature": signature})


async def run_quote_row(monkeypatch: pytest.MonkeyPatch, card: RenderedBlock, row_id: str = "c-own-quote") -> None:
    """`test_reply_row` for `c-own-quote` (or `row_id`) on a real-kernel stand-in whose
    `/check_reply` answers with the prose and `card` in the row's language, signed under the key
    `/health` gives: the answer must meet the row's expectation, as the target's own check of it
    would require. The row's quote is made at START on the case's clock, as on a golden Desk."""
    row = {row.id: row for row in load_rows()}[row_id]
    shown = signed_verdict([PROSE, card], row.expect.language or "en")
    caller = SimpleNamespace(state=SimpleNamespace(session_id=ROW_SESSION, generation=0))

    async def check_reply(k, who, prose, clauses=None, *, expect, generation=None, final=True):
        calls.append({"model": reply_golden.SOFT_PROMISE_MODEL})
        assert match_expect(200, shown.model_dump(mode="json"), expect) == []
        return shown

    fake = FakeAnthropic()
    calls = []
    monkeypatch.setattr(fake, "calls", lambda model=None, schema=None: calls)   # the soft check's calls alone

    async def returns(value):
        return value

    monkeypatch.setattr(reply_golden, "golden_desk", lambda *args, **kwargs: returns(SimpleNamespace()))
    monkeypatch.setattr(reply_golden, "open_caller", lambda *args, **kwargs: returns(caller))
    monkeypatch.setattr(reply_golden, "cite_facts", lambda *args, **kwargs: returns({"own-quote": ROW_QUOTE}))
    monkeypatch.setattr(reply_golden, "check_reply", check_reply)
    monkeypatch.setattr(reply_golden, "signing_key", lambda *args: returns(ROW_SIGNER.public_key_hex()))
    await reply_golden.test_reply_row(SimpleNamespace(is_real=True, clock=TravelClock(START)), fake, None,
                                      row)


# The quote made at START (Tuesday 10:00) is good for 72 hours, until Friday 10:00 business time.
ROW_EXPIRY = "Good until Friday, November 6, 10:00 am"
ROW_EXPIRY_ES = "Válido hasta viernes 6 de noviembre, 10:00"
ROW_CARD = RenderedBlock(kind="card", template="quote", text=f"${P // 100}.00\nDrain clearing\n{ROW_EXPIRY}",
                         fact_id=ROW_QUOTE, title=f"${P // 100}.00", lines=["Drain clearing", ROW_EXPIRY])


async def test_quote_row_passes_a_signed_card_showing_the_price(monkeypatch: pytest.MonkeyPatch):
    await run_quote_row(monkeypatch, ROW_CARD)


@pytest.mark.parametrize("change", [
    {"title": "$1.00"},                                                 # the headline a visitor reads
    {"lines": ["Drain clearing", "Includes 99% off $1.00", ROW_EXPIRY]},   # a detail line
    {"text": f"$1.00\nDrain clearing\n{ROW_EXPIRY}"},                  # the plain text, if title and lines are dropped
], ids=["title", "line", "text"])
async def test_quote_row_fails_a_signed_card_misstating_the_price(monkeypatch: pytest.MonkeyPatch, change):
    """A correctly signed card whose plain text holds the drain's price but whose title or a
    line shows another fails the row; so does one whose text disagrees with its title and lines.
    The signature authenticates what the kernel rendered, not that it agrees with the fact."""
    with pytest.raises(AssertionError, match="quote card"):
        await run_quote_row(monkeypatch, ROW_CARD.model_copy(update=change))


def shown_as(title: str, *lines: str) -> dict:
    """A change to `ROW_CARD` showing `title` and `lines`, with the text Plan 01a renders from them."""
    return {"title": title, "lines": list(lines), "text": "\n".join([title, *lines])}


@pytest.mark.parametrize("change", [
    shown_as("€180.00", "Drain clearing", ROW_EXPIRY),
    shown_as("£180.00", "Drain clearing", ROW_EXPIRY),
    shown_as("$180.00", "Drain clearing €180.00", ROW_EXPIRY),
    shown_as("MX $180.00", "Drain clearing", ROW_EXPIRY),
    shown_as("CA $180.00", "Drain clearing", ROW_EXPIRY),
], ids=["euros in the title", "pounds in the title", "euros in a line", "MX $ in the title", "CA $ in the title"])
async def test_quote_row_fails_a_signed_card_showing_the_price_in_another_currency(
    monkeypatch: pytest.MonkeyPatch, change,
):
    """The drain's price is $180: a correctly signed card showing 180.00 in euros or pounds, or in
    another dollar with its letters spaced from the sign ("MX $180.00", "CA $180.00"), in its title
    or a line, with a text that agrees, misstates it and fails the row."""
    with pytest.raises(AssertionError, match="US dollars"):
        await run_quote_row(monkeypatch, ROW_CARD.model_copy(update=change))


async def test_quote_row_passes_the_spanish_expiry_on_the_spanish_row(monkeypatch: pytest.MonkeyPatch):
    """The expiry is checked in the row's language: c-own-quote-es shows Plan 01a's Spanish date."""
    card = ROW_CARD.model_copy(update=shown_as("$180.00", "Drain clearing", ROW_EXPIRY_ES))
    await run_quote_row(monkeypatch, card, row_id="c-own-quote-es")
    with pytest.raises(AssertionError, match="quote card"):
        await run_quote_row(monkeypatch, ROW_CARD, row_id="c-own-quote-es")   # the English date on a Spanish row


@pytest.mark.parametrize("change", [
    shown_as("$180.00", "Drain clearing", "Good until Monday, January 1, 1:00 am"),
    shown_as("$180.00", "Drain clearing", "We will come tomorrow.", ROW_EXPIRY),
    shown_as("$180.00", "Drain clearing"),
    {"text": "$180.00\nDrain clearing\nGood until Saturday, November 7, 10:00 am"},
], ids=["a changed expiry", "an appointment", "no expiry", "a changed expiry in the text"])
async def test_quote_row_fails_a_signed_card_with_a_date_its_quote_doesnt_hold(
    monkeypatch: pytest.MonkeyPatch, change,
):
    """A quote card's dates come from its record: the expiry is the quote's creation on the case's
    clock plus its 72 hours, in the business's time zone, and no other detail may carry a date.
    A correctly signed card with another expiry, an appointment the quote doesn't make or no
    expiry at all fails the row; the card's fields are outside the visible prose scan, so only
    this check can catch them."""
    with pytest.raises(AssertionError, match="quote card"):
        await run_quote_row(monkeypatch, ROW_CARD.model_copy(update=change))


@pytest.mark.parametrize(("reply", "ok", "kinds"), [
    ("pass", True, None),
    ("flag", False, ["soft_promise"]),
    ("denies_ai", False, ["soft_promise"]),
    ("timeout", False, ["check_unavailable"]),
    ("error", False, ["check_unavailable"]),
    ("unparsable", False, ["check_unavailable"]),
    ("refusal", False, ["check_unavailable"]),
])
def test_the_one_soft_check_reply_pins_the_verdict(reply, ok, kinds):
    """One try with no recheck (the owner's decision of 2026-10-31): a flag is `soft_promise`,
    and no verdict (a timeout, an error, an unparsable answer or a refusal) is `check_unavailable`."""
    expect = {"ok": ok, **({"violations": kinds} if kinds else {})}
    row = ReplyRow.model_validate({**GOOD_ROW, "soft_promise": reply, "expect": expect})
    assert row.soft_promise == reply
    wrong = {"ok": not ok, **({"violations": ["soft_promise"]} if ok else {})}
    if reply != "pass":  # a passing checker can still follow a lexical rejection in another row
        with pytest.raises(ValueError):
            ReplyRow.model_validate({**GOOD_ROW, "soft_promise": reply, "expect": wrong})
