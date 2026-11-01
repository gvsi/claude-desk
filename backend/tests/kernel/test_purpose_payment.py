"""Owner-priced purpose payments reuse the quote and payment-link lifecycle."""

import pytest
from sqlalchemy import select

from desk.contracts import RuleCard
from desk.db.models import Quote, Tool
from desk.kernel_service import render

from .helpers import activate_cards, kernel_ctx, ledger_rows, rows_of
from .test_adapters import rivera
from .test_business_tools import business_rows, put
from .test_decide import decided, open_visitor
from .test_execute import executed, read
from .test_payment_links import checkouts, links_of, payment_entries
from .test_reply_check import checked, clause

TOOL = 'desk.consultation-deposit'
TITLE = 'Consultation deposit'
AMOUNT = 5000


def payment(*, amount=AMOUNT, purpose=TITLE):
    return {'tool': TOOL, 'title': TITLE, 'description': 'Take the consultation deposit.',
            'config': {'block': 'purpose_payment', 'purpose': purpose, 'amount_cents': amount}}


def auto(maximum=AMOUNT):
    return RuleCard(card_id='deposit-auto', applies_to=TOOL, mode='auto', who='anyone',
                    max_amount_cents=maximum, reason='Take the consultation deposit.')


async def payment_desk(app, client, *, amount=AMOUNT, maximum=AMOUNT, cap=50_000, cards=None):
    copy = await rivera(app, client)
    assert (await put(client, copy, [payment(amount=amount)])).status_code == 200
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        [row] = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == TOOL)))
        row.status, row.review_reason = 'enabled', None
        await activate_cards(ctx, copy.desk_id, cards if cards is not None else [auto(maximum)],
                             auto_money_cap_cents=cap)
    return copy


async def quotes_of(app, copy):
    return await rows_of(app, copy.copy_id, select(Quote))


async def test_fixed_quote_link_card_receipts_ledger_and_checkout(app, client):
    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    allowed = await decided(client, visitor, TOOL, {})
    assert allowed.outcome == 'allow', allowed.reason_plain
    action = allowed.action
    assert (action.resource.kind, action.resource.id, action.list_cents, action.discount_bp, action.amount_cents) == (
        'desk', copy.desk_id, AMOUNT, 0, AMOUNT)
    result = await executed(client, visitor, allowed)
    assert result.state == 'succeeded', result
    [quote], [link] = await quotes_of(app, copy), await links_of(app, copy)
    assert (quote.action_id, quote.amount_cents, quote.list_cents, quote.discount_bp, quote.status) == (
        action.action_id, AMOUNT, AMOUNT, 0, 'available')
    assert quote.items == [{'item_id': TOOL, 'title': TITLE, 'qty': 1, 'unit_cents': AMOUNT}]
    assert link.quote_id == quote.quote_id and link.amount_cents == AMOUNT and link.title == TITLE
    assert {fact.kind for fact in result.facts} == {'quote', 'payment_link'}
    assert result.model_view == {'fact_id': f'payment_link:{link.link_id}', 'title': TITLE, 'amount_cents': AMOUNT}
    assert checkouts(copy) == [(action.action_id, AMOUNT, TITLE, f'session:{visitor.session_id}', 'open')]
    assert await payment_entries(app, copy) == [(visitor.session_id, {
        'link_id': link.link_id, 'state': 'issued', 'version': allowed.policy_version})]
    for lang, prose, receipt in [('en', 'Here is your payment link.', f'“{TITLE}”: payment link made'),
                                  ('es', 'Aquí tienes tu enlace de pago.', f'“{TITLE}”: enlace de pago creado')]:
        verdict = await checked(client, visitor, prose, [clause('payment_link', f'payment_link:{link.link_id}')])
        assert verdict.ok, verdict.violations
        [_, card] = verdict.blocks
        assert card.title == f'{TITLE}, $50.00' and card.href == f'/pay/{link.token}'
        if lang == 'en':
            assert (await read(client, visitor.headers, allowed)).visitor_plain == receipt
        definition = (await business_rows(app, copy))[TOOL].profile.business
        assert render.executed_status(TOOL, lang, owner='Maria Rivera', business=definition) == receipt
    assert link.token not in result.model_dump_json()
    assert all(link.token not in row.event.model_dump_json() for row in await ledger_rows(app, copy))
    paid = await client.post(f'/payment_links/{link.token}/complete', json={})
    assert paid.status_code == 200, paid.text
    assert (await quotes_of(app, copy))[0].status == 'paid'


async def test_zero_is_refused_by_money_baseline_with_nothing_written(app, client):
    copy = await payment_desk(app, client, amount=0)
    visitor = await open_visitor(client, copy)
    refusal = await decided(client, visitor, TOOL, {})
    assert refusal.outcome == 'refuse' and refusal.action.amount_cents == 0
    assert any('money_has_amount' in name for name in refusal.policy_ids)
    assert await quotes_of(app, copy) == [] and await links_of(app, copy) == [] and checkouts(copy) == []
    assert any(row.event.kind == 'decide' and row.event.summary.get('outcome') == 'refuse'
               for row in await ledger_rows(app, copy))


@pytest.mark.parametrize('cap,maximum', [(2000, 5000), (50_000, 2000), (0, 5000)])
async def test_above_cap_or_card_holds_and_owner_runs_once(app, client, cap, maximum):
    from .test_approvals import answered

    copy = await payment_desk(app, client, cap=cap, maximum=maximum)
    visitor = await open_visitor(client, copy)
    held = await decided(client, visitor, TOOL, {})
    assert held.outcome == 'hold', held.reason_plain
    assert held.reason_plain.startswith('A stranger asked to pay $50 for “Consultation deposit”.')
    assert not await quotes_of(app, copy) and not await links_of(app, copy) and not checkouts(copy)
    answer = await answered(client, copy.owner, held.decision_id, 'allow_once')
    assert answer.decision.state == 'executed' and answer.execution.state == 'succeeded'
    assert (await executed(client, visitor, held)) == answer.execution
    assert len(await quotes_of(app, copy)) == len(await links_of(app, copy)) == len(checkouts(copy)) == 1


async def test_agents_need_mandate_room_and_failed_provider_releases_reservation(app, client, frozen_clock, monkeypatch):
    from desk.kernel_service import decide, payments
    from .test_agent_auth import mint, open_agent, turn
    from .test_context import context_of
    from .test_mandates import reservation_of

    copy = await payment_desk(app, client, amount=2000)
    agent = await mint(client, copy.owner, copy.desk_id)
    no_mandate = await open_agent(client, copy.slug, agent, frozen_clock, mandate=False)
    caller = turn(agent, copy.slug, no_mandate.state.session_id, frozen_clock)
    assert TOOL not in {p.tool for p in (await context_of(client, caller.session_id, caller.headers)).tools}
    refused = await decided(client, caller, TOOL, {})
    assert refused.action is None and refused.outcome == 'refuse'
    # Even if a caller bypasses tool availability, the charge effect enforces the baseline.
    original = decide.tools_given
    with monkeypatch.context() as forced:
        forced.setattr(decide, 'tools_given', lambda *args: original(*args) | {TOOL})
        refused = await decided(client, caller, TOOL, {}, call_id='forced')
        assert refused.outcome == 'refuse'
        assert any('agent_charge_within_mandate' in p for p in refused.policy_ids)
    opened = await open_agent(client, copy.slug, agent, frozen_clock)
    caller = turn(agent, copy.slug, opened.state.session_id, frozen_clock)
    assert TOOL in {p.tool for p in (await context_of(client, caller.session_id, caller.headers)).tools}
    allowed = await decided(client, caller, TOOL, {})
    assert allowed.outcome == 'allow', allowed.reason_plain
    result = await executed(client, caller, allowed)
    assert result.state == 'succeeded', result
    assert await reservation_of(app, copy.copy_id, allowed.action.action_id) == (2000, 'reserved')

    # The demo mandate's per-charge limit is 2000: a larger configured deposit is refused.
    large = await payment_desk(app, client)
    large_agent = await mint(client, large.owner, large.desk_id)
    opened_large = await open_agent(client, large.slug, large_agent, frozen_clock)
    large_caller = turn(large_agent, large.slug, opened_large.state.session_id, frozen_clock)
    refused = await decided(client, large_caller, TOOL, {})
    assert refused.outcome == 'refuse' and any('agent_charge_within_mandate' in p for p in refused.policy_ids)
    assert not await quotes_of(app, large) and not checkouts(large)

    async def provider_refused(*args, **kwargs):
        raise payments.ProviderError('refused')

    monkeypatch.setattr(payments.ProviderClient, 'create_checkout', provider_refused)
    next_call = await decided(client, caller, TOOL, {}, call_id='provider-refuses')
    assert next_call.outcome == 'allow'
    failed = await executed(client, caller, next_call)
    assert failed.state == 'failed'
    assert await reservation_of(app, copy.copy_id, next_call.action.action_id) == (2000, 'released')
    assert len(await quotes_of(app, copy)) == len(await links_of(app, copy)) == len(checkouts(copy)) == 1


async def test_enabled_tool_auto_card_without_maximum_is_refused_at_draft(app, client, caplog):
    import logging
    from .helpers import draft_refusals
    from .test_money_cap import post_draft

    copy = await payment_desk(app, client)
    caplog.set_level(logging.INFO, logger='desk.kernel_service')
    response = await post_draft(client, copy, [auto(None)], 2, auto_money_cap_cents=50_000)
    assert (response.status_code, response.json()) == (422, {'code': 'invalid'})
    assert draft_refusals(caplog) == ['above_money_cap']


@pytest.mark.solver
async def test_lowered_cap_drafts_and_then_holds_the_configured_amount(app, client, desk_prove):
    from desk import money_cap
    from desk.contracts import PolicyVersion
    from .test_money_cap import post_draft

    copy = await payment_desk(app, client)
    [lowered] = money_cap.lower_to_cap([auto()], [auto()], 2000, 'en', money_tools=frozenset({TOOL}))
    assert lowered.max_amount_cents == 2000
    response = await post_draft(client, copy, [lowered], 2, auto_money_cap_cents=2000)
    assert response.status_code == 200, response.text
    version = PolicyVersion.model_validate(response.json())
    assert version.status == 'proved', version.proof
    response = await client.post('/policy/confirm', headers=copy.owner,
                                 json={'desk_id': copy.desk_id, 'version': version.version})
    assert response.status_code == 200, response.text
    visitor = await open_visitor(client, copy)
    held = await decided(client, visitor, TOOL, {})
    assert held.outcome == 'hold' and held.action.amount_cents == AMOUNT
    assert not await quotes_of(app, copy) and not checkouts(copy)


@pytest.mark.parametrize('args', [{'amount_cents': 1}, {'purpose': 'Other'}, {'title': 'Other'},
                                  {'quote_id': 'quote-other'}, {'payer': 'Someone'}, {'anything': None}])
async def test_any_argument_is_refused_at_step_one(app, client, args):
    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    refusal = await decided(client, visitor, TOOL, args)
    assert refusal.outcome == 'refuse' and refusal.action is None
    assert refusal.reason_plain.startswith('A stranger asked to pay for “Consultation deposit”.')
    assert 'form the tool takes' in refusal.reason_plain
    assert not await quotes_of(app, copy) and not await links_of(app, copy) and not checkouts(copy)
    summary = [row.event.summary for row in await ledger_rows(app, copy) if row.event.kind == 'decide'][-1]
    assert summary['reason'] == 'invalid_args'


@pytest.mark.parametrize('approved', [True, False])
async def test_configuration_changed_after_intent_refuses_without_writes(app, client, monkeypatch, approved):
    from desk.kernel_service import execute
    from .test_approvals import answered
    from .test_execute import post_execute

    copy = await payment_desk(app, client, cards=[] if approved else [auto()])
    visitor = await open_visitor(client, copy)
    decision = await decided(client, visitor, TOOL, {})
    assert decision.outcome == ('hold' if approved else 'allow')

    async def change():
        response = await put(client, copy, [payment(amount=AMOUNT + 100)])
        assert response.status_code == 200, response.text

    monkeypatch.setattr(execute, '_after_intent', change)
    if approved:
        result = await answered(client, copy.owner, decision.decision_id, 'allow_once')
        assert result.decision.state == 'refused_at_execution'
    else:
        response = await post_execute(client, visitor, decision)
        assert response.status_code == 409, response.text
    assert not await quotes_of(app, copy) and not await links_of(app, copy) and not checkouts(copy)


async def test_safety_probe_uses_stand_in_amount_and_signed_phrases(app, client):
    from .test_probe import probe, probed

    copy = await payment_desk(app, client)
    [above, missing] = await probed(client, copy, 2, [probe(TOOL, amount_cents=6000), probe(TOOL)])
    assert above.outcome == 'hold', above
    assert above.reason_plain.startswith('A stranger asks to pay $60 for “Consultation deposit”.')
    assert missing.outcome == 'refuse'
    assert missing.reason_plain.startswith('A stranger asks to pay for “Consultation deposit”.')
    assert not await quotes_of(app, copy) and not checkouts(copy)


@pytest.mark.parametrize('purpose,accepted', [('50% off deposit', False), ('Guaranteed refund', False),
                                            ('$20 deposit', False), ('Free consult', False), (TITLE, True)])
async def test_purpose_card_text_is_scanned_at_put(app, client, purpose, accepted):
    copy = await rivera(app, client)
    response = await put(client, copy, [payment(purpose=purpose)])
    assert response.status_code == (200 if accepted else 422), response.text
    assert bool(await business_rows(app, copy)) is accepted
    if not accepted:
        event = [row.event for row in await ledger_rows(app, copy) if row.event.kind == 'business_tools'][-1]
        assert event.summary == {'tools': [], 'refused': 'public_promise'}


@pytest.mark.parametrize('landed', [True, False])
async def test_timeout_reconciles_once_or_voids_without_a_quote(app, client, monkeypatch, landed):
    from desk.kernel_service import payments

    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    decision = await decided(client, visitor, TOOL, {})
    create = payments.ProviderClient.create_checkout

    async def lost_response(self, **kwargs):
        if landed:
            await create(self, **kwargs)
        raise payments.ProviderTimeout('response_lost')

    monkeypatch.setattr(payments.ProviderClient, 'create_checkout', lost_response)
    result = await executed(client, visitor, decision)
    assert result.state == 'unknown'
    assert not await quotes_of(app, copy) and not await links_of(app, copy)
    settled = await read(client, visitor.headers, decision)
    assert settled.state == ('executed' if landed else 'failed'), settled
    for _ in range(2):
        repeated = await executed(client, visitor, decision)
        assert repeated.state == ('succeeded' if landed else 'failed')
    assert len(await quotes_of(app, copy)) == len(await links_of(app, copy)) == int(landed)
    assert len(checkouts(copy)) == 1
    assert checkouts(copy)[0][-1] == ('open' if landed else 'voided')
    if landed:
        assert {fact.kind for fact in repeated.facts} == {'quote', 'payment_link'}
        assert repeated.model_view['amount_cents'] == AMOUNT


async def test_same_decision_racing_executes_one_quote_checkout_and_link(app, client):
    import asyncio
    from .test_execute import post_execute

    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    decision = await decided(client, visitor, TOOL, {})
    answers = await asyncio.gather(*(post_execute(client, visitor, decision) for _ in range(2)))
    assert all(response.status_code in (200, 409) for response in answers)
    assert any(response.status_code == 200 for response in answers)
    result = await executed(client, visitor, decision)
    assert result.state == 'succeeded'
    assert len(await quotes_of(app, copy)) == len(await links_of(app, copy)) == len(checkouts(copy)) == 1


async def test_unknown_checkout_is_cancelled_when_purpose_configuration_changes(app, client, monkeypatch):
    from desk.kernel_service import payments

    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    decision = await decided(client, visitor, TOOL, {})
    create = payments.ProviderClient.create_checkout

    async def lost_response(self, **kwargs):
        await create(self, **kwargs)
        raise payments.ProviderTimeout('response_lost')

    monkeypatch.setattr(payments.ProviderClient, 'create_checkout', lost_response)
    assert (await executed(client, visitor, decision)).state == 'unknown'
    # Even with the same amount, a new purpose cannot relabel the old checkout.
    assert (await put(client, copy, [payment(purpose='Planning deposit')])).status_code == 200
    settled = await read(client, visitor.headers, decision)
    assert settled.state == 'failed', settled
    assert not await quotes_of(app, copy) and not await links_of(app, copy)
    assert checkouts(copy)[0][-1] == 'cancelled'


async def test_rules_changed_after_intent_prevents_quote_and_checkout(app, client, monkeypatch):
    from desk.kernel_service import execute

    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    decision = await decided(client, visitor, TOOL, {})

    async def change_rules():
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            await activate_cards(ctx, copy.desk_id, [])

    monkeypatch.setattr(execute, '_after_intent', change_rules)
    result = await executed(client, visitor, decision)
    assert result.state == 'failed'
    assert not await quotes_of(app, copy) and not await links_of(app, copy) and not checkouts(copy)


@pytest.mark.parametrize('unavailable', ['needs_review', 'disabled', 'answering_off'])
async def test_tool_is_given_only_when_enabled_and_answering(app, client, unavailable):
    from .test_context import context_of

    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    assert TOOL in {p.tool for p in (await context_of(client, visitor.session_id, visitor.headers)).tools}
    if unavailable == 'answering_off':
        assert (await client.put(f'/desks/{copy.desk_id}/answering', headers=copy.owner,
                                 json={'on': False})).status_code == 200
    else:
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            [row] = await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == TOOL)))
            row.status = unavailable
    assert TOOL not in {p.tool for p in (await context_of(client, visitor.session_id, visitor.headers)).tools}
    refusal = await decided(client, visitor, TOOL, {})
    assert refusal.outcome == 'refuse' and refusal.action is None
    assert not await quotes_of(app, copy) and not checkouts(copy)


async def test_reconcile_does_not_issue_while_configuration_is_locked(app, client, monkeypatch):
    from desk.kernel_service import payments

    copy = await payment_desk(app, client)
    visitor = await open_visitor(client, copy)
    decision = await decided(client, visitor, TOOL, {})
    create = payments.ProviderClient.create_checkout

    async def lost_response(self, **kwargs):
        await create(self, **kwargs)
        raise payments.ProviderTimeout('response_lost')

    monkeypatch.setattr(payments.ProviderClient, 'create_checkout', lost_response)
    assert (await executed(client, visitor, decision)).state == 'unknown'
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == TOOL).with_for_update()))
        assert (await read(client, visitor.headers, decision)).state == 'unknown'
        assert not await quotes_of(app, copy) and not await links_of(app, copy)
    assert (await read(client, visitor.headers, decision)).state == 'executed'
    assert len(await quotes_of(app, copy)) == len(await links_of(app, copy)) == 1
