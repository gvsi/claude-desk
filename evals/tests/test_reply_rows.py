"""The reply table's rows, checked without a kernel: the plan's counts, the loader's refusals, and
agreement with the evals' own scanner."""

import unicodedata
from collections import Counter

import pytest

from desk.contracts import RenderedBlock, ReplyVerdict, Violation
from evals.oracles import denies_ai, scan_visible
from evals.tier1.golden_desk import GOLDEN_DIR
from evals.tier1.harness import match_expect
from evals.tier1.test_reply_golden import ReplyRow, load_rows


def test_rows_load_with_the_plans_counts():
    rows = load_rows()
    assert len(rows) == len({row.id for row in rows}) == 48
    assert Counter(tuple(row.requires) for row in rows) == {("01a",): 47, ("01b",): 1}
    assert [row.id for row in rows if row.requires == ["01b"]] == ["c-owner-only-fact"]


def test_rows_show_the_blocks_the_table_states():
    """A failed check of Claude's draft shows only the handoff clause; a passing one its prose (when
    not empty), then a card per clause."""
    rows = {row.id: row for row in load_rows()}
    assert rows["r-en-clean"].blocks == ["prose"]
    assert rows["c-own-quote"].blocks == ["prose", "quote"]
    assert rows["c-empty-prose-falls-back"].blocks == ["quote"]
    assert rows["c-hours"].blocks == ["prose", "hours"]
    assert rows["c-other-session-quote"].blocks == ["handoff"]
    assert rows["r-en-dollar"].blocks == ["handoff"]


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
    the English and the Spanish twin are present, each a lone `soft_promise` handoff."""
    rows = {row.id: row for row in load_rows()}
    denies = [row for row in rows.values() if row.soft_promise == "denies_ai"]
    assert {row.id for row in denies} == {"r-soft-promise-denies-ai", "r-soft-promise-denies-ai-es"}
    for row in denies:
        assert denies_ai(row.prose), f"{row.id}'s prose doesn't deny being an AI: {row.prose!r}"
        assert row.expect.violations == ["soft_promise"] and row.blocks == ["handoff"], row.id


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
    {"expect": {"ok": False, "violations": ["promise_word"], "blocks": ["prose"]}},   # only the handoff shows
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


def verdict(kinds: list[str], blocks: list[RenderedBlock], *, ok: bool | None = None) -> ReplyVerdict:
    return ReplyVerdict(
        ok=not kinds if ok is None else ok, language="en", blocks=blocks, message_id="m-1", generation=0,
        visitor_plain="Reply checked", ledger_seq=7, signature="00" * 64,
        violations=[Violation(kind=kind, span="x", rule_id="r") for kind in kinds],
    )


PROSE = RenderedBlock(kind="prose", text="Here is your quote.")
QUOTE_CARD = RenderedBlock(kind="card", template="quote", text="$180.00\nDrain clearing", fact_id="quote:Q-1",
                           title="$180.00", lines=["Drain clearing"])
HANDOFF = RenderedBlock(kind="card", template="handoff", text="Let me check with Maria Rivera.",
                        title="Let me check with Maria Rivera.")


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
