"""Triage output crosses the real model parser before the owner-only job stores it."""

import json

import pytest
from sqlalchemy import text as sql

from desk.api.deliver import Status, deliver
from desk.api.model import AnthropicModel
from desk.api.store import append_message
from desk.api.triage import ANNOTATION_MODEL, triage_attempt
from tests.api.fakes import FakeMessagesApi
from tests.api.test_model import message
from tests.api.test_owner_reads import guest, new_owner


@pytest.mark.parametrize("category", ["prices", "wording", "discount_push", "garbage"])
async def test_triage_job_validates_new_model_categories(
    api, browser, fake, kernel_http, engine, ro_schema, category,
):
    owner = await new_owner(api, browser, fake, kernel_http)
    visitor = await guest(kernel_http, fake, owner)
    fake.never(owner.desk_id, "native.find_slots")
    refused = await visitor.decide("native.find_slots", {})
    async with engine.connect() as conn:
        await append_message(conn, visitor.ids, "visitor_text", text="What times can I book?")
        await deliver(conn, visitor.ids, Status(refused, "receipt"), ro_schema=ro_schema)
        await conn.commit()

    output = {"summary": "Asked about booking times. The Desk refused the request.", "category": category}
    server = FakeMessagesApi(message({"type": "text", "text": json.dumps(output)}, model=ANNOTATION_MODEL))
    model = AnthropicModel("test-key", base_url="https://model.test", http_client=server.client())
    try:
        stored = await triage_attempt(engine, model, visitor.ids, refused.decision_id, "decision", ro_schema=ro_schema)
    finally:
        await model.aclose()
    valid = category in {"prices", "wording"}
    assert stored is valid
    assert len(server.requests) == 1                     # invalid structured output isn't retried
    async with engine.connect() as conn:
        notes = (await conn.execute(sql(
            "SELECT kind, text FROM app.messages WHERE session_id = :s AND kind IN ('triage', 'annotation')"
            " ORDER BY n"), {"s": visitor.session_id})).all()
        usage = (await conn.execute(sql(
            "SELECT model, input_tokens, output_tokens FROM app.model_calls WHERE session_id = :s"
            " AND route = 'triage'"), {"s": visitor.session_id})).all()
    assert usage == [(ANNOTATION_MODEL, 300, 80)]         # invalid output still records its usage
    if valid:
        assert [row.kind for row in notes] == ["triage", "annotation"]
        assert json.loads(notes[0].text) == output
    else:
        assert notes == []
    safety = await owner.get(f"desks/{owner.desk_id}/safety")
    assert safety.status_code == 200, safety.text
    assert safety.json()[0]["triage"] == (output if valid else None)
    transcript = await owner.get(f"conversations/{visitor.session_id}")
    assert transcript.status_code == 200, transcript.text
    assert transcript.json()["items"][1]["triage"] == (output if valid else None)
