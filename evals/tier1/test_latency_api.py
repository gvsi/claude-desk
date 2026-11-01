"""The latency run on the in-process API target, with every model scripted.

`measure_local` drives visitor turns of each kind through the API over the real kernel and reads the
API's and the kernel's records after them. With the soft-promise check answering after 0.3 s, every
reply's reveal delay (Plan 02a's `RevealMetric`, from the model's finish to the reply on the stream)
holds that wait and stays within 2 s. It waits for `02` in `landed.toml`, since the
API's chat routes and records come with Plan 02.
"""

import pytest

from evals.fakes import Json, Sleep, ToolUse
from evals.latency import KINDS, errored_turns, measure_local, reveals
from evals.tier1.golden_desk import REVIEW_PASS, REVIEWER_MODEL
from evals.tier1.targets import SOFT_PROMISE_MODEL, SOFT_PROMISE_PASS

OPUS = "claude-opus-5-5"   # the Desk's conversation model (Plan 02a)
TURNS = 2


@pytest.mark.requires("01a", "02")
async def test_latency_run_against_the_api_target(k, fake, api):
    fake.default(SOFT_PROMISE_MODEL, Sleep(0.3, Json(SOFT_PROMISE_PASS)), schema="SoftPromiseVerdict")
    fake.default(OPUS, ToolUse("send_reply", {"prose": "Thanks for asking. Maria can help with that.", "clauses": []}))
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))

    measured = await measure_local(api, turns=TURNS)

    assert len(measured.samples) == TURNS * len(KINDS)
    assert errored_turns(measured.samples) == 0, [s.error for s in measured.samples if s.error]
    found = reveals(measured.samples, measured.run_events)
    assert len(found) == len(measured.samples), "every turn's reply has its reveal metric"
    delays = [metric.model_finish_to_reveal_ms for metric in found]
    assert all(300 <= ms <= 2_000 for ms in delays), delays
