"""Urgent callbacks use the native callback boundary and alert the owner immediately."""

from datetime import datetime

import pytest
from sqlalchemy import select

from desk.contracts import RuleCard
from desk.db.models import ActorSession, Desk, Fact, Handoff, NotificationPref, Tool
from desk.db.models import DemoInboxEntry as DemoInboxRow
from desk.kernel_service import adapters
from desk.kernel_service.adapters import request_callback
from desk.kernel_service.adapters.base import ExecCtx
from desk.kernel_service.sessions import principal_for

from .helpers import activate_cards, kernel_ctx, ledger_rows, rows_of
from .test_adapters import rivera
from .test_business_tools import put
from .test_approvals import public_key
from .test_context import context_of
from .test_decide import decided, open_visitor, set_session, verify_signature
from .test_execute import executed, post_execute, read
from .test_lead_tools import CALLBACK, TZ
from .test_reply_check import checked, clause
from .test_verification import session_inbox


TOOL = 'desk.urgent-help'
TITLE = 'Urgent help'


def urgent(**updates):
    return {'tool': TOOL, 'title': TITLE, 'description': 'Report an urgent problem.',
            'config': {'block': 'urgent', 'urgent_when': 'A burst pipe or no heating.'}, **updates}


def auto():
    return RuleCard(card_id='urgent-auto', applies_to=TOOL, mode='auto', who='anyone', reason='Report urgent problems.')


async def test_urgent_title_refuses_bidi_controls_without_writing_business_data(app, client):
    copy = await rivera(app, client)
    before_facts = {row.fact_id: (row.claims, row.readers, row.status)
                    for row in await rows_of(app, copy.copy_id, select(Fact))}
    before_inbox = {row.entry_id for row in await rows_of(app, copy.copy_id, select(DemoInboxRow))}
    before_tools = {row.tool: (row.status, row.definition_sha256) for row in await rows_of(
        app, copy.copy_id, select(Tool).where(Tool.source == 'business'))}
    assert before_tools == {'desk.emergency-callback': ('enabled', before_tools['desk.emergency-callback'][1])}
    response = await put(client, copy, [urgent(title='Urgent \u202edeetnaraug\u202c')])
    assert response.status_code == 422, response.text
    assert {row.tool: (row.status, row.definition_sha256) for row in await rows_of(
        app, copy.copy_id, select(Tool).where(Tool.source == 'business'))} == before_tools   # the seed's, as it was
    assert not await rows_of(app, copy.copy_id, select(Handoff))
    assert {row.fact_id: (row.claims, row.readers, row.status)
            for row in await rows_of(app, copy.copy_id, select(Fact))} == before_facts
    assert {row.entry_id for row in await rows_of(app, copy.copy_id, select(DemoInboxRow))} == before_inbox
    *_, entry = [row for row in await ledger_rows(app, copy) if row.event.kind == 'business_tools']
    assert entry.event.summary == {'tools': [], 'refused': 'public_promise'}


async def configured(app, client, *, cards=None, prefs=()):
    copy = await rivera(app, client)
    assert (await put(client, copy, [urgent()])).status_code == 200
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        [row] = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == TOOL)))
        row.status, row.review_reason = 'enabled', None
        await activate_cards(ctx, copy.desk_id, [auto()] if cards is None else cards)
        [settings] = await ctx.db.scalars(ctx.repo.scoped(select(NotificationPref)))
        if prefs is None:
            await ctx.db.delete(settings)
        else:
            settings.now = list(prefs)
    return copy, await open_visitor(client, copy)


async def alerts(app, copy):
    return await rows_of(app, copy.copy_id, select(DemoInboxRow).where(
        DemoInboxRow.kind == 'alert', DemoInboxRow.preview == 'Urgent callback requested'))


@pytest.mark.parametrize('prefs', [(), None], ids=['empty-now', 'no-prefs-row'])
async def test_urgent_opens_native_callback_and_alerts_without_notification_preferences(app, client, frozen_clock, prefs):
    frozen_clock.travel(datetime(2026, 10, 31, 19, 0, tzinfo=TZ))
    copy, visitor = await configured(app, client, prefs=prefs)
    decision = await decided(client, visitor, TOOL, CALLBACK)
    assert decision.outcome == 'allow', decision.reason_plain
    assert decision.action.resource.kind == 'desk'
    assert decision.action.amount_cents is None and decision.action.recipient is None
    result = await executed(client, visitor, decision)
    assert result.state == 'succeeded'
    [handoff] = await rows_of(app, copy.copy_id, select(Handoff))
    # urgent: no next-open-hour window (it's Saturday evening; the next open hour is Monday at 8), so the
    # visitor's card reads "<owner> will call you back" while the owner is alerted at once
    assert (handoff.kind, handoff.status, handoff.window_start, handoff.window_end, handoff.action_id) == (
        'callback', 'open', None, None, decision.action.action_id)
    assert handoff.callback_window is None
    [fact] = result.facts
    assert (fact.fact_id, fact.kind, fact.status, fact.expires_at, fact.claims) == (
        f'handoff:{handoff.handoff_id}', 'handoff', 'committed', None, request_callback.window_claims(None))
    assert fact.label.readers == ['owner', f'session:{visitor.session_id}']
    assert result.model_view == {'fact_id': fact.fact_id, 'handoff_id': handoff.handoff_id}
    assert result.inbox == []
    [alert] = await alerts(app, copy)
    assert (alert.to, alert.kind, alert.decision_id, alert.body) == (
        'owner', 'alert', None,
        'Reported as urgent through “Urgent help”. ' + request_callback.claudes_note(
            (CALLBACK['name'], CALLBACK['contact'], CALLBACK['reason'])))
    settings = await rows_of(app, copy.copy_id, select(NotificationPref))
    assert len(settings) == (0 if prefs is None else 1)
    assert not settings or settings[0].now == []
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        adapter = await adapters.resolve(ctx, copy.desk_id, TOOL)
        assert (adapter.locks_session, adapter.free_text_fields, adapter.model_view_keys,
                adapter.releases_private_data) == (
            True, request_callback.ADAPTER.free_text_fields, request_callback.ADAPTER.model_view_keys, False)
        assert isinstance(adapter, request_callback.RequestCallbackAdapter)
        [desk] = await ctx.db.scalars(ctx.repo.scoped(select(Desk)))
        [session] = await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
            ActorSession.session_id == visitor.session_id)))
        reconciled = await adapter.reconcile(ExecCtx(ctx, desk, session, principal_for(session)), decision.action)
    assert (reconciled.facts, reconciled.model_view) == (result.facts, result.model_view)
    verdict = await checked(client, visitor, 'I passed your request on.', [clause('callback_confirmed', fact.fact_id)])
    assert verdict.ok, verdict.violations
    assert verdict.blocks[-1].template == 'callback_confirmed'
    assert verdict.blocks[-1].text == 'Mike Turner will call you back'      # no time promised for an urgent call


async def test_urgent_and_native_callback_each_alert_once_and_replace_the_open_handoff(app, client):
    native_auto = RuleCard(card_id='callback-auto', applies_to='native.request_callback', mode='auto',
                           who='anyone', reason='Take callback requests.')
    copy, visitor = await configured(app, client, cards=[auto(), native_auto], prefs=['callback'])
    before = {row.entry_id for row in await rows_of(app, copy.copy_id, select(DemoInboxRow))}
    urgent_decision = await decided(client, visitor, TOOL, CALLBACK)
    assert urgent_decision.outcome == 'allow'
    first = await executed(client, visitor, urgent_decision)
    assert await executed(client, visitor, urgent_decision) == first
    new_alerts = [row for row in await rows_of(app, copy.copy_id, select(DemoInboxRow)) if row.entry_id not in before]
    assert [row.preview for row in new_alerts] == ['Urgent callback requested']
    native_decision = await decided(client, visitor, 'native.request_callback', CALLBACK, call_id='native')
    assert native_decision.outcome == 'allow'
    second = await executed(client, visitor, native_decision)
    assert await executed(client, visitor, native_decision) == second
    new_alerts = [row for row in await rows_of(app, copy.copy_id, select(DemoInboxRow)) if row.entry_id not in before]
    assert sorted(row.preview for row in new_alerts) == ['Callback requested', 'Urgent callback requested']
    # the native call-back gives its next open hour; the urgent one gives no time, only who and why
    native_body = next(row.body for row in new_alerts if row.preview == 'Callback requested')
    urgent_body = next(row.body for row in new_alerts if row.preview == 'Urgent callback requested')
    assert native_body.startswith('Call back on ')
    assert urgent_body == 'Reported as urgent through “Urgent help”. ' + native_body[native_body.index("Claude's note"):]
    handoffs = {row.handoff_id: row for row in await rows_of(app, copy.copy_id, select(Handoff))}
    assert handoffs[first.model_view['handoff_id']].status == 'done'
    assert handoffs[second.model_view['handoff_id']].status == 'open'
    [old_fact] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.fact_id == first.model_view['fact_id']))
    assert old_fact.status == 'expired'
    third = await executed(client, visitor, await decided(client, visitor, TOOL, CALLBACK, call_id='urgent-again'))
    handoffs = {row.handoff_id: row for row in await rows_of(app, copy.copy_id, select(Handoff))}
    assert handoffs[second.model_view['handoff_id']].status == 'done'
    assert handoffs[third.model_view['handoff_id']].status == 'open'


@pytest.mark.parametrize('language,line', [
    ('en', '“Urgent help”: urgent request sent to Mike Turner'),
    ('es', '“Urgent help”: solicitud urgente enviada a Mike Turner'),
])
async def test_urgent_receipt_names_the_title_and_owner_alert_is_never_in_the_session_view(app, client, language, line):
    copy, visitor = await configured(app, client)
    await set_session(app, copy, visitor.session_id, last_language=language)
    decision = await decided(client, visitor, TOOL, CALLBACK)
    assert decision.outcome == 'allow'
    result = await executed(client, visitor, decision)
    assert set(result.model_view) == {'fact_id', 'handoff_id'}
    assert result.inbox == []
    receipt = await read(client, visitor.headers, decision)
    assert receipt.visitor_plain == line
    verify_signature(await public_key(client), receipt)
    assert await session_inbox(client, visitor) == []
    seen = await context_of(client, visitor.session_id, visitor.headers)
    assert 'Reported as urgent' not in seen.model_dump_json()
    assert 'Urgent callback requested' not in receipt.model_dump_json()
    [alert] = await alerts(app, copy)
    assert alert.entry_id not in result.model_dump_json()


@pytest.mark.parametrize('key,value', [
    ('urgent', False), ('block', 'intake'), ('config', {'block': 'intake'}),
    ('title', 'Different title'), ('alert', {'to': 'visitor', 'body': 'Forged'}),
    ('window', 'today'), ('reason', 'x' * 201), ('contact', ''),
])
async def test_urgent_args_cannot_change_configuration_or_alerts(app, client, key, value):
    copy, visitor = await configured(app, client)
    decision = await decided(client, visitor, TOOL, {**CALLBACK, key: value})
    assert (decision.outcome, decision.action) == ('refuse', None)
    assert not await rows_of(app, copy.copy_id, select(Handoff))
    assert not await alerts(app, copy)
    [entry] = [entry for entry in await ledger_rows(app, copy) if entry.event.ref_id == decision.decision_id]
    assert entry.event.kind == 'decide'


@pytest.mark.parametrize('kind', ['visitor', 'agent'])
@pytest.mark.parametrize('status', ['enabled', 'needs_review', 'disabled'])
async def test_urgent_is_given_with_answering_off_only_while_enabled(app, client, frozen_clock, kind, status):
    from .test_agent_auth import mint, open_agent, turn

    copy, visitor = await configured(app, client)
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        [row] = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == TOOL)))
        row.status = status
    response = await client.put(f'/desks/{copy.desk_id}/answering', headers=copy.owner, json={'on': False})
    assert response.status_code == 200, response.text
    if kind == 'agent':
        agent = await mint(client, copy.owner, copy.desk_id)
        opened = await open_agent(client, copy.slug, agent, frozen_clock)
        visitor = turn(agent, copy.slug, opened.state.session_id, frozen_clock)
    seen = await context_of(client, visitor.session_id, visitor.headers)
    assert (TOOL in {profile.tool for profile in seen.tools}) is (status == 'enabled')
    assert (TOOL in {profile.tool for profile in seen.tools_declared}) is (status == 'enabled')
    decision = await decided(client, visitor, TOOL, CALLBACK)
    assert decision.outcome == ('allow' if status == 'enabled' else 'refuse'), decision.reason_plain
    if status == 'enabled':
        assert (await executed(client, visitor, decision)).state == 'succeeded'
        assert len(await alerts(app, copy)) == 1
    else:
        assert decision.action is None
        assert not await alerts(app, copy)


async def test_urgent_default_hold_and_probe_have_signed_words_and_approval_runs_once(app, client):
    from .test_probe import probe, probed

    copy, visitor = await configured(app, client, cards=[])
    held = await decided(client, visitor, TOOL, CALLBACK)
    assert held.outcome == 'hold'
    assert held.reason_plain.startswith('A stranger asked to report something urgent through “Urgent help”. ')
    [probed_call] = await probed(client, copy, held.policy_version, [probe(TOOL, CALLBACK)])
    assert probed_call.outcome == 'hold'
    assert probed_call.reason_plain.startswith('A stranger asks to report something urgent through “Urgent help”. ')
    assert (await post_execute(client, visitor, held)).status_code == 409
    assert not await rows_of(app, copy.copy_id, select(Handoff))
    assert not await alerts(app, copy)
    response = await client.post(f'/approvals/{held.decision_id}/answer', headers=copy.owner,
                                 json={'answer': 'allow_once'})
    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer['decision']['state'] == 'executed'
    assert answer['execution']['state'] == 'succeeded'
    assert len(await rows_of(app, copy.copy_id, select(Handoff))) == 1
    assert len(await alerts(app, copy)) == 1
    again = await executed(client, visitor, held)
    assert again.model_view == answer['execution']['model_view']
    assert len(await alerts(app, copy)) == 1


async def test_urgent_effect_never_refuses_before_writing_any_callback(app, client):
    never = RuleCard(card_id='no-changes', applies_to='effect:change', mode='never', who='anyone', reason='No changes.')
    copy, visitor = await configured(app, client, cards=[auto(), never])
    decision = await decided(client, visitor, TOOL, CALLBACK)
    assert decision.outcome == 'refuse' and decision.action is not None
    assert decision.card_ids == ['no-changes']
    assert (await post_execute(client, visitor, decision)).status_code == 409
    assert not await rows_of(app, copy.copy_id, select(Handoff))
    assert not await alerts(app, copy)


@pytest.mark.parametrize('authorization', ['approved', 'allowed'])
async def test_changed_urgent_config_refuses_at_execution_without_handoff_fact_or_alert(app, client, monkeypatch,
                                                                                      authorization):
    from desk.kernel_service import execute

    copy, visitor = await configured(app, client, cards=[] if authorization == 'approved' else [auto()])
    decision = await decided(client, visitor, TOOL, CALLBACK)
    assert decision.outcome == ('hold' if authorization == 'approved' else 'allow')

    async def change_config():
        response = await put(client, copy, [urgent(config={'block': 'urgent', 'urgent_when': 'Locked out.'})])
        assert response.status_code == 200, response.text

    monkeypatch.setattr(execute, '_after_intent', change_config)
    if authorization == 'approved':
        response = await client.post(f'/approvals/{decision.decision_id}/answer', headers=copy.owner,
                                     json={'answer': 'allow_once'})
        assert response.status_code == 200, response.text
        assert response.json()['decision']['state'] == 'refused_at_execution'
    else:
        assert (await post_execute(client, visitor, decision)).status_code == 409
        assert (await read(client, visitor.headers, decision)).state == 'refused_at_execution'
    assert not await rows_of(app, copy.copy_id, select(Handoff))
    assert not await rows_of(app, copy.copy_id, select(Fact).where(Fact.action_id == decision.action.action_id))
    assert not await alerts(app, copy)
    [row] = await rows_of(app, copy.copy_id, select(Tool).where(Tool.tool == TOOL))
    assert row.status == 'needs_review' and row.review_reason == 'changed'
