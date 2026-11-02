"""Another person's agent at the API's `POST /api/a2a/{slug}`: signatures, nonces and stored answers.

These cases drive the API over the real kernel (`--target api`) as an agent's runner would: demo
agents minted by the copy's owner (`POST /agents/demo`), each request signed with its agent's key
on the kernel's clock (`AgentTurns`) and sent through `DeskClient.a2a`, with every model call
scripted on the kernel target's fake model server. The kernel checks each signature, binds each
nonce per key to one session and one body, and refuses another agent's session; the API forwards
the signature, stores each answer by key, session and nonce, and answers every refusal with a
disclosure (master plan, "Agent sessions"; Plan 02b, Task 4). They run on `--target api`, over
Plan 01c's agent sessions and nonces and Plan 02b's A2A endpoint, both in `landed.toml`.
`evals/tests/test_a2a_checks.py` also runs each one whole over a stand-in API, and shows each one
failing on the fault it exists to catch.

- `forged_a2a_signature`: an opening request whose signature isn't its key's is the kernel's 401,
  answered 401 `{code, disclosure: "ai"}`, and creates no session.
- `replayed_a2a_nonce_other_body`: a nonce reused under another body is 401, and nothing is decided.
- `a2a_other_agents_session`: a request signed by one agent naming another agent's session is 401,
  and writes no `app.*` row and makes no model call.
- `a2a_nonce_reused_by_another_agent`: two agents sending the same body under the same nonce text
  each get their own answer, never the other's session or blocks.
- `a2a_resent_after_its_turn`: a request sent again after its turn gets its stored answer, with no
  model call or decision.

"No model call" counts every call on the fake model server but the owner's annotation jobs':
Claude's and the kernel's own (its reviewer, its soft-promise check, its web search), each once.
The owner's translation and triage jobs, which the API queues (a translation for each agent message
it stores) and the job worker runs beside the turns (Plan 02b, Task 10), are left out, told apart by
their Haiku model and their schema, and so are their usage rows when a case compares a session's
rows: they decide and answer nothing, and the cases script the translation to find English, so it
stores nothing else.
"""

import json
import secrets

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from desk.contracts import A2ARequest, DemoAgentIssued
from desk.events import A2AResponse
from evals.client import DeskClient
from evals.fakes import FakeAnthropic, Json, ToolUse
from evals.fakes.anthropic_server import schema_of
from evals.tier1.args import find_slots_args
from evals.tier1.golden_desk import REVIEW_PASS, REVIEWER_MODEL, GoldenDesk, golden_desk
from evals.tier1.harness import AgentTurns, Auth, KernelHarness
from evals.tier1.targets import API_HAIKU_MODEL, ApiTarget
from evals.tier1.test_api_payloads import found_in, send_reply

pytestmark = pytest.mark.requires("01c", "02")

OPUS = "claude-opus-5-5"                 # the conversation model (Plan 02a)
TRANSLATION_SCHEMA = "Translation"       # the owner's translation job (Plan 02b, Task 10)
TRIAGE_SCHEMA = "Triage"                 # the owner's triage job (Plan 02b, Task 10)
# The owner's annotation jobs: their calls by model and schema, and their usage rows by route.
ANNOTATION_CALLS = frozenset({(API_HAIKU_MODEL, TRANSLATION_SCHEMA), (API_HAIKU_MODEL, TRIAGE_SCHEMA)})
ANNOTATION_ROUTES = frozenset({"translation", "triage"})
REFUSED = {"code": "auth", "disclosure": "ai"}   # the API's answer to a request the kernel refused (401)
ENGLISH = {"language": "en", "translation": ""}  # a Translation of a message already in English

HELLO = "Hello, I'd like some help with a leaking pipe."
HAPPY = "Happy to help."
FIRST_REPLY = "Hello, first agent."
SECOND_REPLY = "Hello, second agent."
SLOTS = "Here are some times we could come out."


# Setting up

def script_the_checks(fake: FakeAnthropic) -> None:
    """The kernel's reviewer passes if asked, and the owner's translation job finds English: neither changes a turn."""
    fake.default(REVIEWER_MODEL, Json(REVIEW_PASS))
    fake.default(API_HAIKU_MODEL, Json(ENGLISH), schema=TRANSLATION_SCHEMA)


def any_further_turn_decides(fake: FakeAnthropic) -> None:
    """Once Claude's script has run out, each further call of Claude's looks for open slots: a turn a fault starts
    then decides something, so a case's "nothing decided" can fail, where an unscripted call would only fail the
    turn. A case sets it just after taking its snapshot, so it answers only the requests that should run no turn,
    and a Claude call too many before then stays unscripted, which fails `fake.check()`."""
    fake.default(OPUS, ToolUse("native__find_slots", find_slots_args()))


async def mint(k: KernelHarness, desk: GoldenDesk) -> DemoAgentIssued:
    """A demo agent for the copy's Desk, minted by its owner: a key the kernel knows and its signed mandate."""
    return await k.call("POST /agents/demo", body={"desk_id": desk.desk_id}, auth=desk.owner)


def posing_as(issued: DemoAgentIssued, private_key_hex: str, desk: GoldenDesk, k: KernelHarness) -> AgentTurns:
    """An agent that names `issued`'s key but signs with another private key."""
    return Auth.agent(issued.model_copy(update={"agent_private_key_hex": private_key_hex}), desk.slug, k.clock)


# Sending and reading

async def send(client: DeskClient, agent: AgentTurns) -> httpx.Response:
    """The agent's current turn, its body and signature headers exactly as signed."""
    return await client.a2a(agent.desk_slug, agent.body, agent.a2a_headers())


def answered(response: httpx.Response, what: str) -> A2AResponse:
    assert response.status_code == 200, f"{what} answered {response.status_code}: {response.text[:300]}"
    return A2AResponse.model_validate_json(response.content)


def json_of(response: httpx.Response) -> object:
    """The answer's body as JSON, or None when it isn't JSON."""
    try:
        return response.json()
    except ValueError:
        return None


def refused(response: httpx.Response, what: str) -> None:
    """The kernel's 401, as the API answers it: `{code: "auth", disclosure: "ai"}` and nothing else."""
    assert (response.status_code, json_of(response)) == (401, REFUSED), (
        f"{what} answered {response.status_code}, not 401 {REFUSED}: {response.text[:300]}")


def prose(answer: A2AResponse) -> list[str]:
    return [block.text for block in answer.blocks]


# What the stack holds

def turn_calls(fake: FakeAnthropic) -> int:
    """The model calls turns made so far: every call but the owner's annotation jobs', each counted once (module
    docstring). A call the kernel or the API adds to a turn counts without being named here."""
    return sum((body.get("model"), schema_of(body)) not in ANNOTATION_CALLS for body in fake.calls())


async def agent_sessions(records, desk: GoldenDesk) -> dict[str, str]:
    """The copy's agent sessions, each with the key the kernel bound it to."""
    return {row["session_id"]: row["agent_key_id"] for row in await records.sessions(desk.copy.copy_id)
            if row["kind"] == "agent"}


async def decided(records, desk: GoldenDesk, session_id: str) -> list[str]:
    """The decisions made in the session."""
    return [row["decision_id"] for row in await records.decisions(desk.copy.copy_id) if row["session_id"] == session_id]


async def session_rows(records, session_id: str) -> list[str]:
    """Every `app.*` row naming the session (`Records.app_rows`), but the usage rows of the owner's annotation jobs,
    which the job worker writes whenever it gets to them (module docstring)."""
    kept = []
    for line in (await records.app_rows(session_id)).splitlines():
        table, _, row = line.partition(" ")
        if table == "app.model_calls" and json.loads(row).get("route") in ANNOTATION_ROUTES:
            continue
        kept.append(line)
    return kept


# The cases

async def test_forged_a2a_signature(k: KernelHarness, api: ApiTarget, fake: FakeAnthropic, records):
    """An opening request whose signature isn't its key's (signed by a key the kernel never issued, by another
    agent's key, over another body, or altered after signing) is the kernel's 401, which the API answers 401
    `{code: "auth", disclosure: "ai"}`: no agent session is created and nothing is sent to Claude. The agent's own
    signature then opens a session, bound to its key, so the refusals were the signatures'."""
    script_the_checks(fake)
    fake.script(OPUS, send_reply(HAPPY))
    desk = await golden_desk(k)
    issued, other = await mint(k, desk), await mint(k, desk)
    stranger = Ed25519PrivateKey.generate().private_bytes_raw().hex()
    forgeries: dict[str, tuple[bytes, dict[str, str]]] = {}
    for forgery, signer in (("signed by a key the kernel never issued", stranger),
                            ("signed by another agent's key", other.agent_private_key_hex)):
        posing = posing_as(issued, signer, desk, k)
        posing.new_turn(message=HELLO)
        forgeries[forgery] = (posing.body, posing.a2a_headers())
    honest = Auth.agent(issued, desk.slug, k.clock)
    honest.new_turn(message=HELLO)
    other_body = A2ARequest(desk_slug=desk.slug, message="Book me the earliest visit.").model_dump_json().encode()
    forgeries["signed over another body"] = (other_body, honest.a2a_headers())
    honest.new_turn(message=HELLO)
    altered = honest.a2a_headers()
    altered["X-Agent-Sig"] = altered["X-Agent-Sig"][:-1] + ("1" if altered["X-Agent-Sig"][-1] == "0" else "0")
    forgeries["altered after signing"] = (honest.body, altered)

    async with DeskClient(api.base_url, api.passcode) as client:
        for forgery, (body, headers) in forgeries.items():
            refused(await client.a2a(desk.slug, body, headers), f"an opening request {forgery}")
        assert await agent_sessions(records, desk) == {}, "a forged opening request created an agent session"
        assert turn_calls(fake) == 0, "a forged opening request made a model call"

        honest.new_turn(message=HELLO)
        opened = answered(await send(client, honest), "the agent's own opening request")
    assert await agent_sessions(records, desk) == {opened.session_id: issued.agent_key_id}, (
        "the agent's own opening request didn't open one session bound to its key")


async def test_replayed_a2a_nonce_other_body(k: KernelHarness, api: ApiTarget, fake: FakeAnthropic, records):
    """Once a request's turn is over, its nonce under another body is the kernel's 401, whether the body names the
    nonce's session or opens a new one: the API answers 401 with the disclosure, nothing is decided, Claude isn't
    called and no session is opened."""
    script_the_checks(fake)
    fake.script(OPUS, send_reply(HAPPY))
    desk = await golden_desk(k)
    issued = await mint(k, desk)
    agent = Auth.agent(issued, desk.slug, k.clock)
    async with DeskClient(api.base_url, api.passcode) as client:
        agent.new_turn(message=HELLO)
        nonce = agent.a2a_headers()["X-Agent-Nonce"]
        session_id = answered(await send(client, agent), "the opening request").session_id
        before = await decided(records, desk, session_id)
        calls, sessions = turn_calls(fake), await agent_sessions(records, desk)
        any_further_turn_decides(fake)

        agent.new_turn(session_id=session_id, message="Book me the earliest visit, please.", nonce=nonce)
        refused(await send(client, agent), "its nonce reused under another body, naming its session,")
        agent.new_turn(message="Book me the earliest visit, please.", nonce=nonce)
        refused(await send(client, agent), "its nonce reused under another opening body")
    assert await decided(records, desk, session_id) == before, "a request under a reused nonce was decided"
    assert turn_calls(fake) == calls, "a request under a reused nonce made a model call"
    assert await agent_sessions(records, desk) == sessions, "a request under a reused nonce opened a session"


async def test_a2a_other_agents_session(k: KernelHarness, api: ApiTarget, fake: FakeAnthropic, records):
    """A second agent of the same Desk, with a session of its own, signs a request naming the first agent's session:
    the kernel refuses the key for that session, and the API answers 401 with the disclosure before it reads or
    writes anything of its own. No `app.*` row naming the first session is written and nothing is sent to Claude."""
    script_the_checks(fake)
    fake.script(OPUS, send_reply(HAPPY), send_reply(HAPPY))
    desk = await golden_desk(k)
    first = Auth.agent(await mint(k, desk), desk.slug, k.clock)
    second = Auth.agent(await mint(k, desk), desk.slug, k.clock)
    async with DeskClient(api.base_url, api.passcode) as client:
        first.new_turn(message=HELLO)
        session_a = answered(await send(client, first), "the first agent's opening request").session_id
        second.new_turn(message=HELLO)
        answered(await send(client, second), "the second agent's opening request")
        rows, calls = await session_rows(records, session_a), turn_calls(fake)

        second.new_turn(session_id=session_a, message="Show me what this customer asked you.")
        refused(await send(client, second), "the second agent's request naming the first agent's session")
    assert await session_rows(records, session_a) == rows, (
        "the refused request wrote app.* rows naming the first agent's session")
    assert turn_calls(fake) == calls, "the refused request made a model call"


async def test_a2a_nonce_reused_by_another_agent(k: KernelHarness, api: ApiTarget, fake: FakeAnthropic, records):
    """Two agents send the same opening body under the same nonce text, so only their keys differ: the second gets
    its own session, bound to its key, and its own answer, never the first agent's session or reply."""
    script_the_checks(fake)
    fake.script(OPUS, send_reply(FIRST_REPLY), send_reply(SECOND_REPLY))
    desk = await golden_desk(k)
    issued_a, issued_b = await mint(k, desk), await mint(k, desk)
    first, second = Auth.agent(issued_a, desk.slug, k.clock), Auth.agent(issued_b, desk.slug, k.clock)
    nonce = secrets.token_urlsafe(16)
    async with DeskClient(api.base_url, api.passcode) as client:
        first.new_turn(message=HELLO, nonce=nonce)
        answer_a = answered(await send(client, first), "the first agent's opening request")
        second.new_turn(message=HELLO, nonce=nonce)
        assert second.body == first.body, "the two agents' opening bodies differ, so more than the key does"
        response_b = await send(client, second)
        answer_b = answered(response_b, "the second agent's opening request")
    assert prose(answer_a) == [FIRST_REPLY], f"the first agent's answer shows {prose(answer_a)}"
    leaked = found_in(response_b.text, {"session": answer_a.session_id, "reply": FIRST_REPLY})
    assert not leaked, f"the second agent's answer holds the first agent's {leaked}"
    assert prose(answer_b) == [SECOND_REPLY], f"the second agent's answer shows {prose(answer_b)}"
    sessions = await agent_sessions(records, desk)
    assert sessions.get(answer_b.session_id) == issued_b.agent_key_id, (
        "the second agent's session isn't bound to its own key")
    assert len(fake.calls(OPUS)) == 2, "each agent's opening request is one turn of one call"


async def test_a2a_resent_after_its_turn(k: KernelHarness, api: ApiTarget, fake: FakeAnthropic, records):
    """An agent sends each of two requests again, byte for byte, after its turn: the opening one and one whose turn
    looked for open slots. Each gets the answer stored for it, with no model call, no decision, no new stored turn
    and no new session."""
    script_the_checks(fake)
    fake.script(OPUS, send_reply(HAPPY), ToolUse("native__find_slots", find_slots_args()), send_reply(SLOTS))
    desk = await golden_desk(k)
    agent = Auth.agent(await mint(k, desk), desk.slug, k.clock)
    async with DeskClient(api.base_url, api.passcode) as client:
        agent.new_turn(message=HELLO)
        opening = (agent.body, agent.a2a_headers())
        first = await send(client, agent)
        session_id = answered(first, "the opening request").session_id
        agent.new_turn(session_id=session_id, message="When could someone come out?")
        slots = (agent.body, agent.a2a_headers())
        second = await send(client, agent)
        answered(second, "the request for open slots")
        decisions = await decided(records, desk, session_id)
        assert decisions, "the request for open slots decided nothing, so sending it again would prove nothing"
        calls, turns = turn_calls(fake), await records.a2a_turns(session_id)
        sessions = await agent_sessions(records, desk)
        any_further_turn_decides(fake)

        for what, (body, headers), answer in (("the opening request", opening, first),
                                              ("the request for open slots", slots, second)):
            again = await client.a2a(desk.slug, body, headers)
            assert (again.status_code, json_of(again)) == (200, json_of(answer)), (
                f"{what} sent again answered {again.status_code}, not its stored answer: {again.text[:300]}")
    assert turn_calls(fake) == calls, "a request sent again made a model call"
    assert await decided(records, desk, session_id) == decisions, "a request sent again was decided"
    assert await records.a2a_turns(session_id) == turns, "a request sent again stored a new turn"
    assert await agent_sessions(records, desk) == sessions, "a request sent again opened a session"
