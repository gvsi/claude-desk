"""The business-tools write contract, run unchanged against the fake and real kernel."""

import hashlib
import json
from datetime import timedelta
from zoneinfo import ZoneInfo

import pytest

from desk.api.schemas import ToolRow
from desk.contracts import BusinessTool, Clause, HoursWindow, ReplyDraft, RuleCard, ToolCall
from desk.kernel_api import (BusinessToolsRequest, CheckReplyRequest, PolicyConfirmRequest, PolicyDraftRequest, PolicyProbeRequest,
                             Probe, ToolPin, ToolsConfirmRequest)
from tests.kernel_contract.test_contract import decide, desk_slug, execute, new_copy, new_visitor, read_decision, refused


@pytest.mark.kernel_plan("01c")
@pytest.mark.parametrize('title,config,accepted', [
    ('AED and CPR training', {'block': 'intake', 'questions': ['What?']}, True),
    ('CAD drafting consult', {'block': 'intake', 'questions': ['What?']}, True),
    ('Pay 50 CAD', {'block': 'intake', 'questions': ['What?']}, False),
    ('CHF 20 deposit', {'block': 'intake', 'questions': ['What?']}, False),
    ('Book a free intro consult', {'block': 'intake', 'questions': ['What?']}, True),
    ('Intro consult', {'block': 'typed_booking', 'appointment_type': 'Free consult', 'minutes': 30}, True),
    ('Intro consult', {'block': 'typed_booking', 'appointment_type': 'Consultas gratuitas', 'minutes': 30}, True),
    ('Book a $0 intro consult', {'block': 'intake', 'questions': ['What?']}, False),
    ('Free consult, 50% off', {'block': 'intake', 'questions': ['What?']}, False),
    ('Retainer', {'block': 'purpose_payment', 'purpose': 'Free retainer', 'amount_cents': 5000}, False),
    ('Free consultation', {'block': 'purpose_payment', 'purpose': 'Initial retainer', 'amount_cents': 5000}, False),
    ('Complimentary review', {'block': 'purpose_payment', 'purpose': 'Initial retainer', 'amount_cents': 5000}, False),
    ('Free consultation', {'block': 'intake', 'questions': ['What?']}, True),
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
    rows = ro_read(schema, copy.copy_id, "SELECT tool FROM {ro}.tools WHERE tool = 'desk.consult'", ())
    assert bool(rows) is accepted


AMENITY_WORDING = ('Free parking', 'Complimentary coffee', 'Estacionamiento gratis', 'No cost parking')
INTAKE = {'block': 'intake', 'questions': ['What?']}
PAYMENT = {'block': 'purpose_payment', 'purpose': 'Initial retainer', 'amount_cents': 5000}
SEEDED_URGENT = 'desk.emergency-callback'   # the Rivera seed's urgent business tool, on every copy


async def put_card(kernel, ro_read, title, config):
    """PUT one tool `desk.card`; return the refusal's detail (None when it passes) and the stored rows,
    leaving out the Rivera seed's own urgent tool (`SEEDED_URGENT`), which every copy has."""
    from desk.api.kernel_client import KernelFailed

    http, schema, _ = kernel
    copy = await new_copy(http)
    request = BusinessToolsRequest(tools=[BusinessTool(
        tool='desk.card', title=title, description='Take details.', config=config)])
    try:
        await http.owner(copy.owner_token).call('PUT /desks/{id}/business_tools', request,
                                                path={'id': copy.desk_ids[0]})
        detail = None
    except KernelFailed as error:
        assert (error.status, error.code) == (422, 'invalid')
        detail = error.detail
    return detail, ro_read(schema, copy.copy_id,
                           "SELECT tool FROM {ro}.tools WHERE source = 'business' AND tool <> %s", (SEEDED_URGENT,))


@pytest.mark.kernel_plan('01c')
@pytest.mark.parametrize('title,config,field', [
    *[('Retainer', {**PAYMENT, 'purpose': purpose}, 'purpose') for purpose in AMENITY_WORDING],
    *[(title, PAYMENT, 'title') for title in AMENITY_WORDING if title != 'Free parking'],
    ('Complimentary coffee', INTAKE, 'title'),
    ('No cost parking', INTAKE, 'title'),
])
async def test_business_card_text_gets_no_amenity_exception(kernel, ro_read, title, config, field):
    # The amenity exception is for charter policy text; a card field passes a promise word only as
    # an allowed free word in its title or appointment type.
    detail, rows = await put_card(kernel, ro_read, title, config)
    assert detail == {f'desk.card.{field}': ['public_promise']}
    assert rows == []


@pytest.mark.kernel_plan('01c')
async def test_purpose_payment_title_free_parking_is_refused(kernel, ro_read):
    detail, rows = await put_card(kernel, ro_read, 'Free parking', PAYMENT)
    assert detail == {'desk.card.title': ['public_promise']}
    assert rows == []


@pytest.mark.kernel_plan('01c')
@pytest.mark.parametrize('title,config', [
    ('Book a free intro call', INTAKE),
    ('Intro call', {'block': 'typed_booking', 'appointment_type': 'Free intro call', 'minutes': 30}),
    ('Free parking', INTAKE),
    ('Free consultation', INTAKE),
])
async def test_free_word_in_a_title_or_appointment_type_still_passes(kernel, ro_read, title, config):
    detail, rows = await put_card(kernel, ro_read, title, config)
    assert detail is None
    assert [row['tool'] for row in rows] == ['desk.card']


@pytest.mark.kernel_plan('01c')
@pytest.mark.parametrize('title,config,fields,rule', [
    ('Pay no', {'block': 'purpose_payment', 'purpose': 'charge', 'amount_cents': 5000},
     ['title', 'purpose'], 'public_promise'),
    ('Intake \u202edeetnaraug\u202c', {'block': 'intake', 'questions': ['What?']}, ['title'], 'format_control'),
    ('guaran\u200bteed', {'block': 'intake', 'questions': ['What?']}, ['title'], 'format_control'),
])
async def test_public_refusal_details_use_stable_fields_and_never_reach_a_receipt(
        kernel, ro_read, title, config, fields, rule):
    from desk.api.kernel_client import KernelFailed

    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    tool = BusinessTool(tool='desk.intake', title=title, description='Take details.', config=config)
    with pytest.raises(KernelFailed) as refused_call:
        await http.owner(copy.owner_token).call('PUT /desks/{id}/business_tools',
            BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    assert (refused_call.value.status, refused_call.value.code) == (422, 'invalid')
    assert refused_call.value.detail == {f'{tool.tool}.{field}': [rule] for field in fields}
    assert ro_read(schema, copy.copy_id, "SELECT tool FROM {ro}.tools WHERE tool = %s", (tool.tool,)) == []
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    blocked = await decide(http.session(visitor.session_token), visitor.state.session_id, visitor.state.generation,
                           'refused-intake', tool.tool, {'name': 'Dana', 'answers': ['Consult']})
    assert blocked.outcome == 'refuse' and blocked.action is None
    assert title not in blocked.visitor_plain


@pytest.mark.kernel_plan("01c")
@pytest.mark.parametrize('first_title,second_title,first_rule,second_rule', [
    ('Tomorrow intake', 'Guaranteed service', 'public_promise', 'public_promise'),
    ('Intake \u202edeetnaraug\u202c', 'Guaranteed service', 'format_control', 'public_promise'),
    ('Tomorrow intake', 'guaran\u200bteed', 'public_promise', 'format_control'),
])
async def test_batch_refusal_names_every_unsafe_tool_without_changing_stored_rows(
        kernel, ro_read, first_title, second_title, first_rule, second_rule):
    from desk.api.kernel_client import KernelFailed

    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    stored = BusinessTool(tool='desk.existing', title='Customer enquiry', description='Take details.',
                          config={'block': 'intake', 'questions': ['What do you need?']})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[stored]), path={'id': desk_id})

    def rows():
        return ro_read(schema, copy.copy_id, "SELECT * FROM {ro}.tools WHERE source = 'business'", ())

    before = rows()
    tools = [stored.model_copy(update={'tool': 'desk.safe'}),
             stored.model_copy(update={'tool': 'desk.first', 'title': first_title}),
             stored.model_copy(update={'tool': 'desk.second', 'title': second_title})]
    with pytest.raises(KernelFailed) as refused_call:
        await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=tools), path={'id': desk_id})
    assert (refused_call.value.status, refused_call.value.code) == (422, 'invalid')
    assert refused_call.value.detail == {'desk.first.title': [first_rule], 'desk.second.title': [second_rule]}
    assert rows() == before
    ledger = await owner.call('GET /ledger/{desk_id}?verify=true', path={'desk_id': desk_id})
    events = [entry.event for entry in ledger.entries if entry.event.kind == 'business_tools']
    assert [event.summary.get('refused') for event in events[-2:]] == [None, 'public_promise']
    assert events[-1].summary == {'tools': [], 'refused': 'public_promise'}


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
async def test_business_tools_invalid_batches_are_atomic_and_owner_only(kernel, ro_read, arrange):
    from desk.api.kernel_client import KernelFailed

    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool="desk.enquiry", title="Customer enquiry", description="Take details.",
                        config={"block": "intake", "questions": ["What do you need?"]})
    valid = BusinessToolsRequest(tools=[tool])
    await owner.call("PUT /desks/{id}/business_tools", valid, path={"id": desk_id})
    for invalid, detail in (
            (BusinessToolsRequest(tools=[tool, tool]), {}),
            (BusinessToolsRequest.model_construct(tools=[tool.model_copy(update={"tool": f"desk.enquiry-{i}"})
                                                         for i in range(9)]), {}),
            (BusinessToolsRequest(tools=[tool.model_copy(update={
                "title": "Guaranteed help", "description": arrange.canary(copy.copy_id)})]), {}),
            (BusinessToolsRequest(tools=[tool.model_copy(update={"title": "Guaranteed help"})]),
             {f'{tool.tool}.title': ['public_promise']})):
        with pytest.raises(KernelFailed) as refused_call:
            await owner.call("PUT /desks/{id}/business_tools", invalid, path={"id": desk_id})
        assert (refused_call.value.status, refused_call.value.code) == (422, "invalid")
        assert refused_call.value.detail == detail
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    assert await refused(http.session(visitor.session_token).call(
        "PUT /desks/{id}/business_tools", valid, path={"id": desk_id})) == (401, "auth")
    rows = ro_read(schema, copy.copy_id, "SELECT tool, status, business FROM {ro}.tools"
                                       " WHERE desk_id = %s AND source = 'business' AND status <> 'disabled'", (desk_id,))
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


@pytest.mark.kernel_plan("01c")
@pytest.mark.parametrize("status", ["needs_review", "disabled"])
async def test_business_money_drafts_require_an_amount_within_the_cap(kernel, status):
    http, _, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    deposit = BusinessTool(tool="desk.deposit", title="Deposit", description="Take a deposit.",
                           config={"block": "purpose_payment", "purpose": "Deposit", "amount_cents": 5000})
    await owner.call("PUT /desks/{id}/business_tools", BusinessToolsRequest(tools=[deposit]), path={"id": desk_id})
    if status == "disabled":
        await owner.call("PUT /desks/{id}/business_tools", BusinessToolsRequest(tools=[]), path={"id": desk_id})
    for maximum in (None, 2001):
        card = RuleCard(card_id="deposit", applies_to="desk.deposit", mode="auto", who="anyone",
                        max_amount_cents=maximum, reason="Deposits.")
        request = PolicyDraftRequest(desk_id=desk_id, expected_parent=1, cards=[card], auto_money_cap_cents=2000)
        assert await refused(owner.call("POST /policy/draft", request)) == (422, "invalid")
    request.cards = [card.model_copy(update={"max_amount_cents": 2000})]
    drafted = await owner.call("POST /policy/draft", request)
    assert drafted.auto_money_cap_cents == 2000


@pytest.mark.kernel_plan('01c')
@pytest.mark.parametrize('amount', [5000, 0])
async def test_reviewed_purpose_payment_obeys_fixed_price_baseline_and_cap(kernel, ro_read, amount):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.deposit', title='Consultation deposit', description='Take the deposit.',
                        config={'block': 'purpose_payment', 'purpose': 'Consultation deposit', 'amount_cents': amount})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    enabled = await owner.call('POST /tools/confirm', ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool.tool, definition_sha256=row['definition_sha256'])], enable=True))
    assert enabled.draft.status == 'proved'
    active = await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=enabled.draft.version))
    card = RuleCard(card_id='deposit-auto', applies_to=tool.tool, mode='auto', who='anyone', max_amount_cents=5000,
                    reason='Take the deposit.')
    draft = await owner.call('POST /policy/draft', PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version, cards=[card], auto_money_cap_cents=5000))
    assert draft.status == 'proved'
    await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    caller = http.session(visitor.session_token)
    for index, args in enumerate(({'amount_cents': 1}, {'purpose': 'Other'}, {'title': 'Other'}, {'quote_id': 'Other'})):
        bad = await decide(caller, visitor.state.session_id, 0, f'bad-payment-{index}', tool.tool, args)
        assert bad.outcome == 'refuse' and bad.action is None
    allowed = await decide(caller, visitor.state.session_id, 0, 'purpose-payment', tool.tool, {})
    assert allowed.action.amount_cents == amount and allowed.action.resource.kind == 'desk'
    if amount == 0:
        assert allowed.outcome == 'refuse' and any('money_has_amount' in p for p in allowed.policy_ids)
        assert not ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.quotes')
        assert not ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.payment_links')
        return
    assert allowed.outcome == 'allow', allowed.reason_plain
    result = await execute(caller, allowed, 0)
    assert result.state == 'succeeded' and result.model_view['amount_cents'] == amount
    assert {fact.kind for fact in result.facts} == {'quote', 'payment_link'}
    assert (await execute(caller, allowed, 0)) == result
    assert (await read_decision(caller, allowed.decision_id)).visitor_plain == '“Consultation deposit”: payment link made'
    [quote] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.quotes')
    [link] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.payment_links')
    assert quote['amount_cents'] == link['amount_cents'] == amount
    assert quote['quote_id'] == link['quote_id']
    ledger = await owner.call('GET /ledger/{desk_id}?verify=true', path={'desk_id': desk_id})
    payments = [entry.event for entry in ledger.entries if entry.event.kind == 'payment']
    assert len(payments) == 1 and payments[0].summary['link_id'] == link['link_id']
    lower = card.model_copy(update={'max_amount_cents': 2000})
    draft = await owner.call('POST /policy/draft', PolicyDraftRequest(
        desk_id=desk_id, expected_parent=draft.version, cards=[lower], auto_money_cap_cents=2000))
    await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    held = await decide(caller, visitor.state.session_id, 0, 'above-new-cap', tool.tool, {})
    assert held.outcome == 'hold' and held.action.amount_cents == 5000
    assert len(ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.quotes')) == 1


@pytest.mark.kernel_plan('01c')
@pytest.mark.parametrize('rules', ['tighter for dana', 'shipped charge ask'])
async def test_reviewed_purpose_payment_rules_rank_by_specificity(kernel, ro_read, rules):
    """The most specific card decides a purpose payment, as the compiler ranks cards: Dana's own $10 auto card holds
    her $50 deposit though a $50 card for anyone covers it (and still allows anyone else), and an auto card on the
    tool outranks the shipped ask on its charge effect."""
    from desk.presets import PRESETS
    from tests.kernel_contract.test_contract import DANA, code_in, session_inbox, verify_check, verify_start

    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.deposit', title='Consultation deposit', description='Take the deposit.',
                        config={'block': 'purpose_payment', 'purpose': 'Consultation deposit', 'amount_cents': 5000})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    enabled = await owner.call('POST /tools/confirm', ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool.tool, definition_sha256=row['definition_sha256'])], enable=True))
    active = await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=enabled.draft.version))
    anyone = RuleCard(card_id='deposit-auto', applies_to=tool.tool, mode='auto', who='anyone', max_amount_cents=5000,
                      reason='Take the deposit.')
    if rules == 'tighter for dana':
        [dana] = ro_read(schema, copy.copy_id, "SELECT person_id FROM {ro}.people WHERE desk_id = %s"
                                               " AND display_name = 'Dana Whitfield'", (desk_id,))
        cards = [anyone, RuleCard(card_id='deposit-dana', applies_to=tool.tool, mode='auto', who='person',
                                  person_id=dana['person_id'], max_amount_cents=1000, reason="Dana's deposits to $10.")]
    else:
        [charge_ask] = [card for card in PRESETS['auto'] if card.card_id == 'preset-charge-ask']
        cards = [anyone, charge_ask]
    draft = await owner.call('POST /policy/draft', PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version, cards=cards, auto_money_cap_cents=5000))
    assert draft.status == 'proved'
    await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    slug = desk_slug(ro_read, schema, copy)
    visitor = await new_visitor(http, slug)
    caller, session_id = http.session(visitor.session_token), visitor.state.session_id
    if rules == 'tighter for dana':
        stranger = await new_visitor(http, slug)
        allowed = await decide(http.session(stranger.session_token), stranger.state.session_id, 0, 'stranger',
                               tool.tool, {})
        assert allowed.outcome == 'allow', allowed.reason_plain
        started = await verify_start(caller, session_id, DANA)
        await verify_check(caller, session_id, code_in(await session_inbox(caller, session_id),
                                                       started.inbox[0].entry_id))
    decided = await decide(caller, session_id, 0, 'ranked', tool.tool, {})
    assert decided.action.amount_cents == 5000
    assert decided.outcome == ('hold' if rules == 'tighter for dana' else 'allow'), decided.reason_plain


@pytest.mark.kernel_plan('01c')
async def test_reviewed_purpose_payment_asked_again_answers_with_its_open_link(kernel, ro_read):
    """Asked again in the session, a purpose payment answers with the session's open link for it: one quote and one
    link, never a second the visitor could pay twice."""
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.deposit', title='Consultation deposit', description='Take the deposit.',
                        config={'block': 'purpose_payment', 'purpose': 'Consultation deposit', 'amount_cents': 5000})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    enabled = await owner.call('POST /tools/confirm', ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool.tool, definition_sha256=row['definition_sha256'])], enable=True))
    active = await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=enabled.draft.version))
    card = RuleCard(card_id='deposit-auto', applies_to=tool.tool, mode='auto', who='anyone', max_amount_cents=5000,
                    reason='Take the deposit.')
    draft = await owner.call('POST /policy/draft', PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version, cards=[card], auto_money_cap_cents=5000))
    assert draft.status == 'proved'
    await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    caller, session_id = http.session(visitor.session_token), visitor.state.session_id
    first = await execute(caller, await decide(caller, session_id, 0, 'first', tool.tool, {}), 0)
    again = await decide(caller, session_id, 0, 'again', tool.tool, {})
    assert again.outcome == 'allow', again.reason_plain
    answered = await execute(caller, again, 0)
    assert answered.state == 'succeeded' and answered.model_view == first.model_view
    assert [fact.kind for fact in answered.facts] == ['payment_link']
    assert len(ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.quotes')) == 1
    assert len(ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.payment_links')) == 1


@pytest.mark.kernel_plan('01c')
async def test_reviewed_typed_booking_books_its_slot_and_keeps_its_note_owner_only(kernel, ro_read):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id, owner = copy.desk_ids[0], http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.consult', title='Book a consult', description='Book an introduction.',
                        config={'block': 'typed_booking', 'appointment_type': 'Free consult', 'minutes': 20})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    confirmed = await owner.call('POST /tools/confirm', ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool.tool, definition_sha256=row['definition_sha256'])], enable=True))
    assert confirmed.draft.status == 'proved'
    active = await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=confirmed.draft.version))
    slots = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.calendar_slots WHERE desk_id = %s ORDER BY starts_at', (desk_id,))
    slot = slots[0]
    local = slot['starts_at'].astimezone(ZoneInfo('America/Los_Angeles'))
    hours = HoursWindow(days=[local.strftime('%a').lower()], start=local.time().replace(tzinfo=None),
                        end=(local + timedelta(minutes=slot['minutes'])).time().replace(tzinfo=None))
    draft = await owner.call('POST /policy/draft', PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version, cards=[RuleCard(
            card_id='consult-auto', applies_to=tool.tool, mode='auto', who='anyone', hours=hours,
            reason='Book consultations during this window.')]))
    assert draft.status == 'proved'
    await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    session = http.session(visitor.session_token)
    args = {'slot_id': slot['slot_id'], 'note': 'Use the side entrance.'}
    allowed = await decide(session, visitor.state.session_id, visitor.state.generation, 'consult', tool.tool, args)
    assert allowed.outcome == 'allow'
    assert allowed.action.resource.kind == 'slot' and allowed.action.resource.id == slot['slot_id']
    assert allowed.action.starts_at == slot['starts_at']
    result = await execute(session, allowed, visitor.state.generation)
    assert result.state == 'succeeded'
    [fact] = result.facts
    claims = {claim.key: claim.value for claim in fact.claims}
    assert (claims['appointment_type'], claims['appointment_minutes']) == ('Free consult', '20')
    assert 'note' not in claims and 'Use the side entrance.' not in result.model_dump_json()
    [note] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.facts WHERE fact_id = %s',
                     ('booking_note:' + result.model_view['booking_id'],))
    assert note['readers'] == ['owner']
    assert {claim['key']: claim['value'] for claim in note['claims']}['note'] == args['note']
    assert (await read_decision(session, allowed.decision_id)).visitor_plain == (
        '“Book a consult”: booked on Maria Rivera\'s calendar')
    checked = await session.call('POST /check_reply', CheckReplyRequest(draft=ReplyDraft(
        session_id=visitor.state.session_id, generation=visitor.state.generation, prose='Here are the details.',
        clauses=[Clause(template='booking_confirmed', fact_id=fact.fact_id)])))
    assert checked.ok
    [card] = [block for block in checked.blocks if block.template == 'booking_confirmed']
    assert '“Free consult”' in card.text and 'About 20 minutes' in card.text
    seen = await session.call('GET /context/{session_id}?desk_id=', path={'session_id': visitor.state.session_id})
    assert 'note' in next(profile for profile in seen.tools if profile.tool == 'native.book').input_schema['properties']
    assert note['fact_id'] not in {visible.fact_id for visible in seen.facts}
    for index, extra in enumerate(({'appointment_type': 'Other'}, {'type': 'Other'}, {'minutes': 15},
                                    {'config': {'block': 'intake'}}, {'block': 'intake'}, {'note': 'x' * 201})):
        blocked = await decide(session, visitor.state.session_id, visitor.state.generation,
                               f'bad-consult-{index}', tool.tool, {**args, **extra})
        assert blocked.outcome == 'refuse' and blocked.action is None
