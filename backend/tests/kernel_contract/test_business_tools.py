"""The business-tools write contract, run unchanged against the fake and real kernel."""

import hashlib
import json

import pytest

from desk.api.schemas import ToolRow
from desk.contracts import BusinessTool, RuleCard, ToolCall
from desk.kernel_api import (BusinessToolsRequest, PolicyConfirmRequest, PolicyDraftRequest, PolicyProbeRequest,
                             Probe, ToolPin, ToolsConfirmRequest)
from tests.kernel_contract.test_contract import decide, desk_slug, execute, new_copy, new_visitor, read_decision, refused


@pytest.mark.kernel_plan("01c")
@pytest.mark.parametrize('title,config,accepted', [
    ('Book a free intro consult', {'block': 'intake', 'questions': ['What?']}, True),
    ('Intro consult', {'block': 'typed_booking', 'appointment_type': 'Free consult', 'minutes': 30}, True),
    ('Intro consult', {'block': 'typed_booking', 'appointment_type': 'Consultas gratuitas', 'minutes': 30}, True),
    ('Book a $0 intro consult', {'block': 'intake', 'questions': ['What?']}, False),
    ('Free consult, 50% off', {'block': 'intake', 'questions': ['What?']}, False),
    ('Retainer', {'block': 'purpose_payment', 'purpose': 'Free retainer', 'amount_cents': 5000}, False),
    ('Pay no', {'block': 'purpose_payment', 'purpose': 'charge', 'amount_cents': 5000}, False),
    ('Half-price check', {'block': 'intake', 'questions': ['What?']}, False),
    ('Tuesday 5pm drop-in', {'block': 'intake', 'questions': ['What?']}, False),
    ('Reply within 24 hours', {'block': 'intake', 'questions': ['What?']}, False),
    ('We will call you back today', {'block': 'intake', 'questions': ['What?']}, False),
    ('Call \u202eyadot\u202c', {'block': 'intake', 'questions': ['What?']}, False),
    ('guaran\u200bteed', {'block': 'intake', 'questions': ['What?']}, False),
    ('Consultation gratuite', {'block': 'intake', 'questions': ['What?']}, False),
    ('Kostenlose Beratung', {'block': 'intake', 'questions': ['What?']}, False),
    ('Intake \u202edeetnaraug\u202c', {'block': 'intake', 'questions': ['What?']}, False),
])
async def test_business_card_text_and_narrow_free_word_exception(kernel, ro_read, title, config, accepted):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    request = BusinessToolsRequest(tools=[BusinessTool(
        tool='desk.consult', title=title, description='Take details.', config=config)])
    call = http.owner(copy.owner_token).call('PUT /desks/{id}/business_tools', request, path={'id': desk_id})
    if accepted:
        assert (await call).desk_id == desk_id
    else:
        assert await refused(call) == (422, 'invalid')
    rows = ro_read(schema, copy.copy_id, "SELECT tool FROM {ro}.tools WHERE source = 'business'", ())
    assert bool(rows) is accepted


@pytest.mark.kernel_plan('01c')
@pytest.mark.parametrize('title,config,fields', [
    ('Pay no', {'block': 'purpose_payment', 'purpose': 'charge', 'amount_cents': 5000}, ['title', 'purpose']),
    ('Intake \u202edeetnaraug\u202c', {'block': 'intake', 'questions': ['What?']}, ['title']),
])
async def test_public_refusal_details_use_stable_fields_and_never_reach_a_receipt(kernel, ro_read, title, config, fields):
    from desk.api.kernel_client import KernelFailed

    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    tool = BusinessTool(tool='desk.intake', title=title, description='Take details.', config=config)
    with pytest.raises(KernelFailed) as refused_call:
        await http.owner(copy.owner_token).call('PUT /desks/{id}/business_tools',
            BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    assert (refused_call.value.status, refused_call.value.code) == (422, 'invalid')
    assert refused_call.value.detail == {f'{tool.tool}.{field}': ['public_promise'] for field in fields}
    assert ro_read(schema, copy.copy_id, "SELECT tool FROM {ro}.tools WHERE source = 'business'", ()) == []
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    blocked = await decide(http.session(visitor.session_token), visitor.state.session_id, visitor.state.generation,
                           'refused-intake', tool.tool, {'name': 'Dana', 'answers': ['Consult']})
    assert blocked.outcome == 'refuse' and blocked.action is None
    assert title not in blocked.visitor_plain


@pytest.mark.kernel_plan("01c")
async def test_business_tools_replace_and_expose_review_definition(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool="desk.enquiry", title="Customer enquiry", description="Take the details.",
                        config={"block": "intake", "questions": ["What do you need?"]})
    request = BusinessToolsRequest(tools=[tool])
    answer = await owner.call("PUT /desks/{id}/business_tools", request, path={"id": desk_id})
    assert answer.desk_id == desk_id

    def stored():
        return ro_read(schema, copy.copy_id, "SELECT * FROM {ro}.tools WHERE desk_id = %s AND tool = %s",
                       (desk_id, tool.tool))[0]

    row = stored()
    assert (row["source"], row["status"], row["review_reason"]) == ("business", "needs_review", "new")
    assert row["business"] == tool.model_dump(mode="json", exclude={"tool"})
    expected = hashlib.sha256(json.dumps(row["business"], sort_keys=True, separators=(",", ":"),
                                         ensure_ascii=False).encode()).hexdigest()
    assert row["definition_sha256"] == expected
    assert ToolRow(**row, cards=[]).business.title == tool.title
    await owner.call("PUT /desks/{id}/business_tools", request, path={"id": desk_id})
    assert stored() == row
    changed = tool.model_copy(update={"title": "Client enquiry"})
    await owner.call("PUT /desks/{id}/business_tools", BusinessToolsRequest(tools=[changed]), path={"id": desk_id})
    assert stored()["review_reason"] == "changed"
    assert stored()["definition_sha256"] != expected
    await owner.call("PUT /desks/{id}/business_tools", BusinessToolsRequest(tools=[]), path={"id": desk_id})
    assert stored()["status"] == "disabled"


@pytest.mark.kernel_plan('01c')
async def test_readded_business_tool_returns_for_review_as_new(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.intake', title='New client intake', description='Take details.',
                        config={'block': 'intake', 'questions': ['What?']})
    request = BusinessToolsRequest(tools=[tool])
    await owner.call('PUT /desks/{id}/business_tools', request, path={'id': desk_id})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[]), path={'id': desk_id})
    await owner.call('PUT /desks/{id}/business_tools', request, path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    assert (row['status'], row['review_reason']) == ('needs_review', 'new')
    ledger = await owner.call('GET /ledger/{desk_id}?verify=true', path={'desk_id': desk_id})
    event = [entry.event for entry in ledger.entries if entry.event.kind == 'business_tools'][-1]
    assert event.summary['tools'][0]['change'] == 'new'


@pytest.mark.kernel_plan("01c")
async def test_business_tools_invalid_batches_are_atomic_and_owner_only(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool="desk.enquiry", title="Customer enquiry", description="Take details.",
                        config={"block": "intake", "questions": ["What do you need?"]})
    valid = BusinessToolsRequest(tools=[tool])
    await owner.call("PUT /desks/{id}/business_tools", valid, path={"id": desk_id})
    for invalid in (BusinessToolsRequest(tools=[tool, tool]),
                    BusinessToolsRequest.model_construct(tools=[tool.model_copy(update={"tool": f"desk.enquiry-{i}"})
                                                                 for i in range(9)]),
                    BusinessToolsRequest(tools=[tool.model_copy(update={"title": "Guaranteed help"})])):
        assert await refused(owner.call("PUT /desks/{id}/business_tools", invalid, path={"id": desk_id})) == (422, "invalid")
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    assert await refused(http.session(visitor.session_token).call(
        "PUT /desks/{id}/business_tools", valid, path={"id": desk_id})) == (401, "auth")
    rows = ro_read(schema, copy.copy_id, "SELECT tool, status, business FROM {ro}.tools"
                                       " WHERE desk_id = %s AND source = 'business'", (desk_id,))
    assert len(rows) == 1 and rows[0]["status"] == "needs_review"
    assert rows[0]["business"]["title"] == tool.title


@pytest.mark.kernel_plan('01c')
async def test_reviewed_intake_decides_executes_and_cannot_select_its_config(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.intake', title='New client intake', description='Take details.',
                        config={'block': 'intake', 'questions': ['What do you need?', 'Where?']})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    row = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))[0]
    confirmed = await owner.call('POST /tools/confirm', ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool.tool, definition_sha256=row['definition_sha256'])], enable=True))
    assert confirmed.draft.status == 'proved'
    active = await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=confirmed.draft.version))
    auto = RuleCard(card_id='intake-auto', applies_to=tool.tool, mode='auto', who='anyone', reason='Take enquiries.')
    [person, *_] = ro_read(schema, copy.copy_id, 'SELECT person_id FROM {ro}.people WHERE desk_id = %s', (desk_id,))
    scoped_never = RuleCard(card_id='intake-never-person', applies_to=tool.tool, mode='never', who='person',
                            person_id=person['person_id'], reason='This person asks another way.')
    draft = await owner.call('POST /policy/draft', PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version, cards=[auto, scoped_never]))
    assert draft.status == 'proved'
    await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    session = http.session(visitor.session_token)
    seen = await session.call('GET /context/{session_id}?desk_id=', path={'session_id': visitor.state.session_id})
    assert tool.tool in {profile.tool for profile in seen.tools}
    assert tool.tool in {profile.tool for profile in seen.tools_declared}
    args = {'name': 'Dana', 'answers': ['Tax help', 'Remote']}
    allowed = await decide(session, visitor.state.session_id, visitor.state.generation, 'intake', tool.tool, args)
    assert allowed.outcome == 'allow'
    result = await execute(session, allowed, visitor.state.generation)
    assert result.state == 'succeeded' and result.model_view == {'lead_id': result.model_view['lead_id'], 'saved': True}
    assert result.facts == []
    receipt = await read_decision(session, allowed.decision_id)
    assert receipt.visitor_plain == '“New client intake”: details saved for Maria Rivera'
    [fact] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.facts WHERE fact_id = %s',
                     ('lead:' + result.model_view['lead_id'],))
    assert fact['readers'] == ['owner']
    assert {claim['key']: claim['value'] for claim in fact['claims']}['answer:1'] == 'Remote'
    for index, extra in enumerate(({'block': 'purpose_payment'}, {'config': {'block': 'urgent'}}, {'answers': ['Only one']})):
        blocked = await decide(session, visitor.state.session_id, visitor.state.generation,
                               f'bad-intake-{index}', tool.tool, {**args, **extra})
        assert blocked.outcome == 'refuse' and blocked.action is None


@pytest.mark.kernel_plan('01c')
async def test_probe_treats_a_tools_confirm_drafts_intake_as_on_without_activating_it(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.intake', title='New client intake', description='Take details.',
                        config={'block': 'intake', 'questions': ['What?']})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    confirmed = await owner.call('POST /tools/confirm', ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool.tool, definition_sha256=row['definition_sha256'])], enable=True))
    version = confirmed.draft.version
    request = PolicyProbeRequest(desk_id=desk_id, probes=[Probe(
        actor='visitor', who='anyone', resource_kind='desk',
        call=ToolCall(call_id='probe-intake', tool=tool.tool, args={'name': 'Dana', 'answers': ['Consult']}))])
    [result] = await owner.call('POST /policy/{version}/probe', request, path={'version': version})
    defaults = [card.card_id for card in confirmed.draft.cards if card.is_default and card.applies_to == tool.tool]
    assert len(defaults) == 1
    assert result.outcome == 'hold' and result.card_ids == defaults
    assert not result.depends_on_review
    [stored] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    assert stored['status'] == 'needs_review'
    [draft] = ro_read(schema, copy.copy_id, 'SELECT status FROM {ro}.policy_versions WHERE desk_id = %s AND version = %s',
                      (desk_id, version))
    assert draft['status'] == 'proved'
    # A subsequent configuration change removes the draft's stale pin from the probe only.
    changed = tool.model_copy(update={'title': 'Client enquiry'})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[changed]), path={'id': desk_id})
    [result] = await owner.call('POST /policy/{version}/probe', request, path={'version': version})
    assert result.outcome == 'refuse' and result.card_ids == []
    ledger = await owner.call('GET /ledger/{desk_id}?verify=true', path={'desk_id': desk_id})
    assert not any(entry.event.summary.get('refused') == 'pin_changed' for entry in ledger.entries)
