"""An owner's approved refund completes once and reaches the visitor as its genuine card."""

from xml.etree import ElementTree

import pytest

from desk.contracts import DemoInboxEntry
from evals.client import DeskClient
from evals.fakes import ToolUse
from evals.tier1.args import refund_args
from evals.tier1.golden_desk import START, charge_id
from evals.tier1.harness import Auth, Expect
from evals.tier1.test_api_payloads import OPUS, chat_turn, last_id, read_turn, send_reply
from evals.tier1.test_verification import code_in


@pytest.mark.requires("01a", "02a")
async def test_approved_refund_shows_its_result_card_once(k, api, fake, records):
    k.clock.travel(START)
    async with DeskClient(api.base_url, api.passcode) as client:
        copy = await client.enter()
        desk_id, slug = copy["desks"][0]["desk_id"], copy["desks"][0]["slug"]
        await client.open_chat(slug)
        await client.verify_start("dana@example.com")
        inbox = await client.my_demo_inbox()
        entry = next(DemoInboxEntry.model_validate(entry) for entry in inbox
                     if entry["kind"] == "verification_code")
        fake.script(OPUS, send_reply("How can I help you?"))
        await client.verify_check(code_in(entry))
        verified = await read_turn(client, None)
        person = next(row["person_id"] for row in await records.people(copy["copy_id"])
                      if row["display_name"].startswith("Dana"))
        charge = charge_id(await records.facts(copy["copy_id"]), person, 25_000, "Leak repair")
        fake.script(OPUS, ToolUse("payments__create_refund", refund_args(charge)),
                    send_reply("This is waiting for approval; you can see where it stands in this chat."))
        held = await chat_turn(client, "Please refund my payment.", last_id(verified))
        (decision_id,) = [event.data["decision_id"] for event in held if event.type == "held"]
        associated = []

        def after_answer(body):
            if associated:
                return
            for message in body["messages"]:
                for block in message["content"]:
                    if block.get("type") == "text" and block["text"].startswith("<action_update "):
                        update = ElementTree.fromstring(block["text"])
                        assert update.attrib["decision_id"] == decision_id
                        associated.extend(update.attrib["result_fact_ids"].split())
                        assert len(associated) == 1
                        fake.script(OPUS, ToolUse("send_reply", {
                            "prose": "Here are the details of your request.",
                            "clauses": [{"template": "refund_issued", "fact_id": associated[0]}],
                        }))

        fake.on_request(OPUS, after_answer)
        answered = await client.owner_answer(decision_id, "allow_once")
        assert answered["decision"]["state"] == "executed"
        resumed = await read_turn(client, last_id(held))
        cards = [block for event in resumed if event.type == "message" for block in event.data["blocks"]
                 if block.get("template") == "refund_issued"]
        assert [block["fact_id"] for block in cards] == associated
        assert len(cards) == 1
        refunds = [row["fact_id"] for row in await records.facts(copy["copy_id"]) if row["kind"] == "refund"]
        assert refunds == associated
        executions = [entry for entry in await records.ledger_entries(copy["copy_id"], desk_id)
                      if entry.event.kind == "execute" and entry.event.ref_id == decision_id]
        assert len(executions) == 1
        stranger = await k.call("POST /sessions", body={"desk_slug": slug, "kind": "visitor"}, auth=Auth.none())
        draft = {"session_id": stranger.state.session_id, "generation": stranger.state.generation,
                 "prose": "Here are the details of your request.",
                 "clauses": [{"template": "refund_issued", "fact_id": associated[0]}]}
        verdict = await k.call("POST /check_reply", body={"draft": draft}, auth=Auth.session(stranger),
                               expect=Expect(fields={"ok": False}))
        assert any(violation.rule_id == "not_a_reader" for violation in verdict.violations)
        assert all(block.fact_id != associated[0] for block in verdict.blocks)
        for prose in ("It costs $250.", "It happens tomorrow."):
            verdict = await k.call("POST /check_reply", body={"draft": {**draft, "prose": prose, "clauses": []}},
                                   auth=Auth.session(stranger), expect=Expect(fields={"ok": False}))
            assert not verdict.ok
