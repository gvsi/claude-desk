"""The same urgent callback and immediate owner delivery against fake and real kernels."""

import json

import pytest

from desk.contracts import BusinessTool, NotificationDefaults, RuleCard
from desk.kernel_api import (BusinessToolsRequest, CreateSessionRequest, DeskNotificationsRequest, PolicyConfirmRequest, PolicyDraftRequest,
                             ToolPin, ToolsConfirmRequest)
from desk.kernel_service.adapters.base import claudes_note
from tests.kernel_contract.test_contract import decide, desk_slug, execute, new_copy, new_visitor, read_decision


@pytest.mark.kernel_plan('01c')
@pytest.mark.parametrize('preview', [False, True], ids=['visitor', 'owner-preview'])
async def test_reviewed_urgent_callback_alerts_now_and_configuration_stays_owner_owned(kernel, ro_read, preview):
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    tool = BusinessTool(tool='desk.urgent-help', title='Urgent help', description='Report an urgent problem.',
                        config={'block': 'urgent', 'urgent_when': 'A burst pipe or no heating.'})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[tool]), path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    confirmed = await owner.call('POST /tools/confirm', ToolsConfirmRequest(
        desk_id=desk_id, tools=[ToolPin(tool=tool.tool, definition_sha256=row['definition_sha256'])], enable=True))
    assert confirmed.draft.status == 'proved'
    active = await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=confirmed.draft.version))
    draft = await owner.call('POST /policy/draft', PolicyDraftRequest(
        desk_id=desk_id, expected_parent=active.version,
        cards=[RuleCard(card_id='urgent-auto', applies_to=tool.tool, mode='auto', who='anyone', reason='Report urgent problems.')]))
    assert draft.status == 'proved'
    await owner.call('POST /policy/confirm', PolicyConfirmRequest(desk_id=desk_id, version=draft.version))
    await owner.call('PUT /desks/{id}/notifications', DeskNotificationsRequest(
        notifications=NotificationDefaults(now=[], briefing=[])), path={'id': desk_id})
    slug = desk_slug(ro_read, schema, copy)
    visitor = (await owner.call('POST /sessions', CreateSessionRequest(desk_slug=slug, kind='visitor', preview=True))
               if preview else await new_visitor(http, slug))
    session = http.session(visitor.session_token)
    seen = await session.call('GET /context/{session_id}?desk_id=', path={'session_id': visitor.state.session_id})
    assert tool.tool in {profile.tool for profile in seen.tools}
    args = {'name': 'Sam Lee', 'contact': '(510) 555-0100', 'reason': 'The water heater is leaking'}
    allowed = await decide(session, visitor.state.session_id, visitor.state.generation, 'urgent', tool.tool, args)
    assert allowed.outcome == 'allow'
    assert allowed.action.resource.kind == 'desk'
    assert allowed.action.amount_cents is None and allowed.action.recipient is None
    result = await execute(session, allowed, visitor.state.generation)
    assert result.state == 'succeeded'
    assert set(result.model_view) == {'fact_id', 'handoff_id'} and result.inbox == []
    [handoff] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.handoffs WHERE handoff_id = %s',
                        (result.model_view['handoff_id'],))
    assert handoff['kind'] == 'callback' and handoff['status'] == ('done' if preview else 'open')
    assert handoff['reason'] == 'Sam Lee · (510) 555-0100 · The water heater is leaking'
    assert handoff['callback_window'] is None              # urgent: no next-open-hour window, no time promised
    [fact] = result.facts
    assert fact.fact_id == result.model_view['fact_id'] and fact.kind == 'handoff'
    assert fact.claims == []
    # no window to end at: a visitor's card lasts while the handoff is open; a preview's, which no
    # Mark done closes, for a day
    assert (fact.expires_at is None) != preview
    receipt = await read_decision(session, allowed.decision_id)
    assert receipt.visitor_plain == '“Urgent help”: urgent request sent to Maria Rivera'
    expected_body = 'Reported as urgent through “Urgent help”. ' + claudes_note((args['name'], args['contact'], args['reason']))
    inbox = await owner.call('GET /demo_inbox')
    assert len([entry for entry in inbox if entry.body == expected_body and entry.to == 'owner' and entry.kind == 'alert']) == (0 if preview else 1)
    assert await session.call('GET /demo_inbox?session_id=', query={'session_id': visitor.state.session_id}) == []
    assert await execute(session, allowed, visitor.state.generation) == result
    assert len([entry for entry in await owner.call('GET /demo_inbox') if entry.body == expected_body]) == (0 if preview else 1)
    for index, extra in enumerate(({'urgent': False}, {'block': 'intake'}, {'config': {'block': 'intake'}},
                                   {'title': 'Changed title'}, {'alert': 'Pretend delivery'})):
        refused = await decide(session, visitor.state.session_id, visitor.state.generation,
                               f'invalid-urgent-{index}', tool.tool, {**args, **extra})
        assert refused.outcome == 'refuse' and refused.action is None
    changed = tool.model_copy(update={'config': tool.config.model_copy(update={'urgent_when': 'Locked out.'})})
    await owner.call('PUT /desks/{id}/business_tools', BusinessToolsRequest(tools=[changed]), path={'id': desk_id})
    [row] = ro_read(schema, copy.copy_id, 'SELECT * FROM {ro}.tools WHERE tool = %s', (tool.tool,))
    assert (row['status'], row['review_reason']) == ('needs_review', 'changed')


@pytest.mark.kernel_plan('01c')
async def test_a_fresh_copy_handles_an_emergency_through_the_seeded_urgent_tool(kernel, ro_read):
    """An emergency on a new copy is urgent: the Rivera seed's `desk.emergency-callback` is enabled,
    given to a stranger beside the native callback, allowed by the seed's `rv-urgent` card, and
    alerts Maria at once with the seed's notification settings as they are."""
    http, schema, _ = kernel
    copy = await new_copy(http)
    desk_id = copy.desk_ids[0]
    owner = http.owner(copy.owner_token)
    [row] = ro_read(schema, copy.copy_id, "SELECT * FROM {ro}.tools WHERE source = 'business'", ())
    assert (row['desk_id'], row['tool'], row['status'], row['review_reason']) == (
        desk_id, 'desk.emergency-callback', 'enabled', None)
    assert row['business'] == {'title': 'Emergency callback',
                               'description': 'Asks Maria to call back urgently about an emergency.',
                               'config': {'block': 'urgent', 'urgent_when':
                                          'A burst or leaking pipe, flooding, a sewage backup, or no water'}}
    # written as the owner's replacement writes it, then turned on by the seed's version 1
    ledger = await owner.call('GET /ledger/{desk_id}?verify=true', path={'desk_id': desk_id})
    seeded = [(entry.event.kind, entry.event.summary) for entry in ledger.entries
              if entry.event.kind in ('business_tools', 'tool_pin') and 'emergency' in json.dumps(entry.event.summary)]
    assert seeded == [
        ('business_tools', {'tools': [{'tool': 'desk.emergency-callback', 'block': 'urgent',
                                       'definition_sha256': row['definition_sha256'], 'change': 'new'}]}),
        ('tool_pin', {'tool': 'desk.emergency-callback', 'event': 'enabled', 'version': 1,
                      'definition_sha256': row['definition_sha256']})]
    visitor = await new_visitor(http, desk_slug(ro_read, schema, copy))
    session = http.session(visitor.session_token)
    seen = await session.call('GET /context/{session_id}?desk_id=', path={'session_id': visitor.state.session_id})
    assert {'desk.emergency-callback', 'native.request_callback'} <= {profile.tool for profile in seen.tools}
    args = {'name': 'Sam Lee', 'contact': '(510) 555-0100', 'reason': 'My pipes have burst'}
    allowed = await decide(session, visitor.state.session_id, visitor.state.generation, 'burst',
                           'desk.emergency-callback', args)
    assert (allowed.outcome, allowed.card_ids) == ('allow', ['rv-urgent'])
    result = await execute(session, allowed, visitor.state.generation)
    assert result.state == 'succeeded' and result.inbox == []
    receipt = await read_decision(session, allowed.decision_id)
    assert receipt.visitor_plain == '“Emergency callback”: urgent request sent to Maria Rivera'
    alerts = [entry for entry in await owner.call('GET /demo_inbox') if entry.to == 'owner' and entry.kind == 'alert'
              and entry.body.startswith('Reported as urgent through “Emergency callback”. ')]
    assert len(alerts) == 1
