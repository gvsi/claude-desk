"""The owner's Desk list names each Desk whose setup interview isn't finished (#233), so the owner app can lead the
owner back into it: `DeskSummary.setup` is the interview's ID and the step it is at until the interview goes live
(step `live`), and null after that, as it is for a Desk made outside setup. A Desk whose rules are confirmed but that
isn't live yet (step `preview`) is still unfinished, since going live is setup's last step. `GET /api/owner/desks` and
the copy's own answer (`me`) list the same, and a copy never sees another copy's interview.

The app runs on FakeKernel with a scripted model.
"""

from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector

from desk.api.main import create_app
from tests.api.fakes import ScriptedModel
from tests.api.test_owner_desks import new_desk
from tests.api.test_setup_questions import Owner, begin, new_owner
from tests.api.test_setup_rules import drafted_rules, policy, ready
from tests.kernel_contract.fake_kernel import fake_kernel_app


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
async def app(db, fake, api_settings, clock, model) -> AsyncIterator[FastAPI]:
    app = create_app(api_settings, kernel_transport=httpx.ASGITransport(app=fake_kernel_app(fake)), model=model,
                     clock=clock, jobs_connector=InMemoryConnector())
    async with app.router.lifespan_context(app):
        yield app


async def setups(owner: Owner) -> dict[str, dict | None]:
    """Each of the copy's Desks' `setup`, by Desk ID, as the Desk list answers it; the copy's own answer (`me`) lists
    the same."""
    listed = await owner.browser.get("/api/owner/desks")
    assert listed.status_code == 200, listed.text
    found = {desk["desk_id"]: desk["setup"] for business in listed.json() for desk in business["desks"]}
    me = await owner.browser.get("/api/owner/me")
    assert me.status_code == 200, me.text
    assert {desk["desk_id"]: desk["setup"] for desk in me.json()["desks"]} == found
    return found


async def test_an_unfinished_setups_desk_lists_its_interview(app, browser, kernel_http, model):
    owner = await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    assert list(seeded.values()) == [None]                 # the seeded Desk was made outside setup

    state = await begin(owner, model)

    # The Desk setup made lists its interview and the step it is at, beside the seeded Desk's null.
    assert await setups(owner) == {**seeded, state["desk_id"]: {"interview_id": state["interview_id"],
                                                                "step": "questions"}}


async def test_a_setup_is_listed_until_its_desk_goes_live(app, browser, kernel_http, model):
    owner, state = await ready(app, browser, kernel_http, model)
    desk_id, interview = state["desk_id"], {"interview_id": state["interview_id"]}
    assert (await setups(owner))[desk_id] == {**interview, "step": "tools"}
    await drafted_rules(owner, model, state)
    assert (await setups(owner))[desk_id] == {**interview, "step": "rules"}

    # Confirmed, with Answering still off, the setup isn't finished: going live is its last step.
    confirmed = await owner.browser.post(policy(state, "confirm"))
    assert confirmed.status_code == 200, confirmed.text
    assert (await setups(owner))[desk_id] == {**interview, "step": "preview"}

    # Live, the setup is finished: the Desk lists null, as the seeded Desk does.
    went_live = await owner.browser.post(policy(state, "go_live"))
    assert went_live.status_code == 200, went_live.text
    listed = await setups(owner)
    assert desk_id in listed and list(listed.values()) == [None, None]


async def test_a_desk_made_outside_setup_lists_no_setup(app, browser, kernel_http):
    owner = await new_owner(app, browser, kernel_http)
    made = await owner.browser.post("/api/owner/desks", json=new_desk())
    assert made.status_code == 201, made.text

    listed = await setups(owner)
    assert made.json()["desk_id"] in listed and list(listed.values()) == [None, None]


async def test_another_copys_interview_never_shows(app, browser, kernel_http, model, db):
    owner, other = await new_owner(app, browser, kernel_http), await new_owner(app, browser, kernel_http)
    seeded = await setups(owner)
    elsewhere = await begin(other, model)

    # The other copy's setup is listed in that copy alone.
    assert (await setups(other))[elsewhere["desk_id"]] == {"interview_id": elsewhere["interview_id"],
                                                           "step": "questions"}
    assert await setups(owner) == seeded
    assert elsewhere["interview_id"] not in (await owner.browser.get("/api/owner/desks")).text

    # An interview row of the other copy that names this copy's Desk is still the other copy's: it never shows here.
    (desk_id,) = seeded
    db.execute("INSERT INTO app.setup_interviews (interview_id, copy_id, desk_id, step)"
               " VALUES ('setup-elsewhere', %s, %s, 'questions')", (other.copy_id, desk_id))
    assert await setups(owner) == seeded
