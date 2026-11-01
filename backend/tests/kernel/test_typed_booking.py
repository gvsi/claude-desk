"""Configured appointment types use the native booking path and kernel-owned card facts."""

import asyncio

import pytest
from sqlalchemy import select

from desk.contracts import Clause, ReplyDraft, RuleCard
from desk.db.models import ActorSession, Booking, CalendarSlot, DemoInboxEntry, Fact, NotificationPref, Tool
from desk.kernel_service import render
from desk.kernel_service.render.cards import DeskInfo

from .helpers import activate_cards, kernel_ctx, ledger_rows, rows_of
from .test_adapters import rivera
from .test_business_tools import put
from .test_decide import decided, open_visitor
from .test_execute import executed, read


TOOL = 'desk.consult'
SLOT = 'S-20261102-1000'
DESK = DeskInfo(owner_display_name='Mike Turner', timezone='America/Los_Angeles')


@pytest.mark.parametrize('config', [None, {'block': 'intake', 'questions': ['What?']},
    {'block': 'purpose_payment', 'purpose': 'Retainer', 'amount_cents': 5000},
    {'block': 'urgent', 'urgent_when': 'A burst pipe'}])
def test_typed_booking_adapter_refuses_non_typed_profiles(config, monkeypatch):
    from desk.contracts import BusinessToolDef
    from desk.kernel_service.adapters import blocks
    from desk.kernel_service.adapters.book import PROFILE

    monkeypatch.setattr(blocks, 'SUPPORTED_BLOCKS', frozenset({'intake', 'typed_booking', 'purpose_payment', 'urgent'}))
    supplied = PROFILE if config is None else blocks.profile('desk.other', BusinessToolDef(
        title='Other task', description='Take details.', config=config))
    with pytest.raises(ValueError, match='unsupported_block'):
        blocks.TypedBookingAdapter(supplied)


def test_typed_booking_factory_consumes_one_code_built_profile(monkeypatch):
    from desk.contracts import BusinessToolDef
    from desk.kernel_service.adapters import blocks
    from desk.kernel_service.adapters.book import BookArgs

    definition = BusinessToolDef(title='Free consult', description='Book an introduction.',
                                 config={'block': 'typed_booking', 'appointment_type': 'Free consult', 'minutes': 20})
    built = blocks.profile(TOOL, definition)
    calls = []

    def build(tool, config):
        calls.append((tool, config))
        return built

    monkeypatch.setattr(blocks, 'profile', build)
    adapter = blocks.adapter_for(definition, TOOL)
    assert calls == [(TOOL, definition)]
    assert blocks.BLOCK_ADAPTERS['typed_booking'] is blocks.TypedBookingAdapter
    assert 'typed_booking' in blocks.SUPPORTED_BLOCKS
    assert blocks.BLOCK_BASE['typed_booking'] == 'native.book'
    assert blocks.CARD_FIELDS['typed_booking'] == ('title', 'appointment_type')
    assert adapter.profile == built.model_copy(update={'status': 'enabled', 'review_reason': None})
    assert adapter.Args is BookArgs
    assert adapter.appointment() == ('Free consult', 20)
    assert adapter.profile.description_confirmed.startswith(
        "Books one open time on the business's calendar for this kind of appointment.")


def typed_booking(**config):
    return {'tool': TOOL, 'title': 'Book a consult', 'description': 'Book an introduction.',
            'config': {'block': 'typed_booking', 'appointment_type': 'Consult', 'minutes': 20, **config}}


async def configured(app, client, *, cards=None, config=None):
    copy = await rivera(app, client)
    response = await put(client, copy, [typed_booking(**(config or {}))])
    assert response.status_code == 200, response.text
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(
            Tool.desk_id == copy.desk_id, Tool.tool == TOOL)))).one()
        row.status, row.review_reason = 'enabled', None
        # The appointment duration is display metadata; a whole calendar slot is still booked.
        slot = (await ctx.db.scalars(ctx.repo.scoped(select(CalendarSlot).where(
            CalendarSlot.desk_id == copy.desk_id, CalendarSlot.slot_id == SLOT)))).one()
        slot.minutes = 60
        prefs = (await ctx.db.scalars(ctx.repo.scoped(select(NotificationPref)))).one()
        prefs.now = [*prefs.now, 'booking']
        await activate_cards(ctx, copy.desk_id, cards if cards is not None else [RuleCard(
            card_id='consult-auto', applies_to=TOOL, mode='auto', who='anyone', reason='Book consultations.')])
    return copy, await open_visitor(client, copy)


async def test_typed_booking_executes_from_config_and_renders_both_languages(app, client):
    copy, visitor = await configured(app, client)
    decision = await decided(client, visitor, TOOL, {'slot_id': SLOT})
    assert decision.outcome == 'allow', decision
    assert decision.action.resource.kind == 'slot'
    result = await executed(client, visitor, decision)
    assert result.state == 'succeeded', result
    [fact] = result.facts
    claims = {claim.key: claim.value for claim in fact.claims}
    assert claims['appointment_type'] == 'Consult'
    assert claims['appointment_minutes'] == '20'
    assert claims['minutes'] == '60'
    assert all(claim.kind == 'text' for claim in fact.claims if claim.key.startswith('appointment_'))
    [stored] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.fact_id == fact.fact_id))
    assert stored.claims == fact.claims
    [booking] = await rows_of(app, copy.copy_id, select(Booking))
    assert (booking.slot_id, booking.status, booking.action_id) == (SLOT, 'confirmed', decision.action.action_id)
    for lang, title, lines, receipt in [
        ('en', 'Monday, November 2', ['“Consult” at 10:00 am', 'About 20 minutes', 'With Mike Turner'],
         '“Book a consult”: booked on Mike Turner\'s calendar'),
        ('es', 'lunes 2 de noviembre', ['“Consult” a las 10:00', 'Unos 20 minutos', 'Con Mike Turner'],
         '“Book a consult”: reservado en el calendario de Mike Turner')]:
        card = render.render_clause(Clause(template='booking_confirmed', fact_id=fact.fact_id), fact, lang, DESK)
        assert (card.title, card.lines) == (title, lines)
        from desk.contracts import BusinessToolDef
        definition = BusinessToolDef.model_validate({k: v for k, v in typed_booking().items() if k != 'tool'})
        assert render.executed_status(TOOL, lang, owner=DESK.owner_display_name, business=definition) == receipt
    assert (await read(client, visitor.headers, decision)).visitor_plain == '“Book a consult”: booked on Mike Turner\'s calendar'
    [alert] = await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(DemoInboxEntry.preview == 'New booking'))
    assert alert.body == 'A stranger booked “Consult” Monday, November 2, from 10:00 am to 11:00 am.'
    assert result.inbox == []


@pytest.mark.parametrize('prose,language', [('Your consult is confirmed.', 'en'),
                                          ('Tu consulta está confirmada.', 'es')])
async def test_typed_booking_confirmation_requires_its_booking_card(app, client, prose, language):
    from desk.kernel_service import reply_check
    from .test_reply_check import checked, clause

    copy, visitor = await configured(app, client)
    decision = await decided(client, visitor, TOOL, {'slot_id': SLOT})
    assert decision.outcome == 'allow'
    [booking] = (await executed(client, visitor, decision)).facts
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
            ActorSession.session_id == visitor.session_id)))).one()
        verdict = await reply_check.check_draft(ctx, row, ReplyDraft(
            session_id=visitor.session_id, generation=row.generation, prose=prose))
    assert not verdict.ok
    assert f'lex.{language}.booking' in {violation.rule_id for violation in verdict.violations}
    backed = await checked(client, visitor, prose, [clause('booking_confirmed', booking.fact_id)])
    assert backed.ok, backed.violations


async def test_free_consult_is_accepted_and_confirmed_through_core_card_fields(app, client, monkeypatch):
    from desk.kernel_service import desks

    scans = []
    original = desks.refuse_public_promises

    async def checked(ctx, part, values, desk_id=None, **kwargs):
        # Only this tool's scans: every Turner copy also seeds its urgent tool through the same check.
        if part == 'business_tools' and any(key.startswith(f'{TOOL}.') for key in values):
            scans.append({'part': part, 'values': values, 'desk_id': desk_id, **kwargs})
        await original(ctx, part, values, desk_id, **kwargs)

    monkeypatch.setattr(desks, 'refuse_public_promises', checked)
    copy, visitor = await configured(app, client, config={'appointment_type': 'Free consult'})
    assert len(scans) == 1
    assert list(scans[0]['values'].items()) == [(f'{TOOL}.0-title', 'Book a consult'),
                                               (f'{TOOL}.1-appointment_type', 'Free consult')]
    assert 'free' in scans[0]['allow_words'][f'{TOOL}.0-title']
    assert 'free' in scans[0]['allow_words'][f'{TOOL}.1-appointment_type']
    decision = await decided(client, visitor, TOOL, {'slot_id': SLOT})
    assert decision.outcome == 'allow'
    [fact] = (await executed(client, visitor, decision)).facts
    assert {claim.key: claim.value for claim in fact.claims}['appointment_type'] == 'Free consult'
    for language, first_line in [('en', '“Free consult” at 10:00 am'), ('es', '“Free consult” a las 10:00')]:
        card = render.render_clause(Clause(template='booking_confirmed', fact_id=fact.fact_id), fact, language, DESK)
        assert card.lines[0] == first_line
    assert (await read(client, visitor.headers, decision)).visitor_plain == '“Book a consult”: booked on Mike Turner\'s calendar'


@pytest.mark.solver
async def test_identical_put_refreshes_and_reproves_an_old_typed_booking_profile(app, client, desk_prove):
    from desk.kernel_service import adapters
    from .test_business_tools import business_rows

    copy, visitor = await configured(app, client)
    original = (await business_rows(app, copy))[TOOL]
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        row = (await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == TOOL)))).one()
        # A previously stored typed tool predates the optional booking note's input schema.
        schema = {**row.profile.input_schema, 'properties': {
            key: value for key, value in row.profile.input_schema['properties'].items() if key != 'note'}}
        row.profile = row.profile.model_copy(update={'input_schema': schema})
        row.profile_sha256 = adapters.profile_sha256(row.profile)
        assert await adapters.resolve(ctx, copy.desk_id, TOOL) is None
    assert (await put(client, copy, [typed_booking()])).status_code == 200
    refreshed = (await business_rows(app, copy))[TOOL]
    assert (refreshed.status, refreshed.review_reason) == ('needs_review', 'changed')
    assert refreshed.definition_sha256 == original.definition_sha256
    assert refreshed.profile_sha256 == original.profile_sha256
    response = await client.post('/tools/confirm', headers=copy.owner, json={
        'desk_id': copy.desk_id, 'tools': [{'tool': TOOL, 'definition_sha256': refreshed.definition_sha256}],
        'enable': True})
    assert response.status_code == 200, response.text
    draft = response.json()['draft']
    assert draft['status'] == 'proved' and draft['proof']['method'] == 'symcc', draft
    response = await client.post('/policy/confirm', headers=copy.owner, json={
        'desk_id': copy.desk_id, 'version': draft['version']})
    assert response.status_code == 200, response.text
    decision = await decided(client, visitor, TOOL, {'slot_id': SLOT, 'note': 'Side entrance.'})
    assert decision.outcome == 'allow'
    assert (await executed(client, visitor, decision)).state == 'succeeded'


async def test_native_booking_keeps_the_existing_card_and_fact(app, client):
    copy, visitor = await configured(app, client, cards=[RuleCard(
        card_id='native-auto', applies_to='native.book', mode='auto', who='anyone', reason='Book visits.')])
    decision = await decided(client, visitor, 'native.book', {'slot_id': SLOT})
    assert decision.outcome == 'allow'
    result = await executed(client, visitor, decision)
    [fact] = result.facts
    assert not any(claim.key.startswith('appointment_') for claim in fact.claims)
    for lang, title, lines in [
        ('en', 'Monday, November 2', ['Arriving 10:00 am to 11:00 am', 'With Mike Turner']),
        ('es', 'lunes 2 de noviembre', ['Llegada de 10:00 a 11:00', 'Con Mike Turner'])]:
        card = render.render_clause(Clause(template='booking_confirmed', fact_id=fact.fact_id), fact, lang, DESK)
        assert (card.title, card.lines) == (title, lines)
    [alert] = await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(DemoInboxEntry.preview == 'New booking'))
    assert alert.body == 'A stranger booked Monday, November 2, from 10:00 am to 11:00 am.'


@pytest.mark.parametrize('extra', [{'appointment_type': 'Viewing'}, {'minutes': 60},
                                 {'appointment_minutes': '60'}, {'config': {'minutes': 60}}, {'block': 'intake'}])
async def test_visitor_cannot_override_the_config_in_args(app, client, extra):
    copy, visitor = await configured(app, client)
    decision = await decided(client, visitor, TOOL, {'slot_id': SLOT, **extra})
    assert (decision.outcome, decision.action) == ('refuse', None)
    assert "The request wasn't in a form the tool takes" in decision.reason_plain
    assert not await rows_of(app, copy.copy_id, select(Booking))
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        from desk.kernel_service import adapters
        adapter = await adapters.resolve(ctx, copy.desk_id, TOOL)
        # The optional owner-only note is shared with native.book; appointment config stays row-only.
        assert set(adapter.Args.model_fields) == {'slot_id', 'note'}


async def test_typed_booking_uses_the_slot_time_for_weekday_hours(app, client, reviewer):
    from desk.kernel_service.seed import RIVERA_CARDS
    from .test_adapters import add_slot, local
    from .test_decide import PASS

    reviewer.answer = PASS
    weekday = next(card for card in RIVERA_CARDS if card.card_id == 'rv-book-wk')
    copy, visitor = await configured(app, client, cards=[weekday.model_copy(update={'applies_to': TOOL})])
    await add_slot(app, copy, 'S-20261102-2200', minutes=60)
    outside = await decided(client, visitor, TOOL, {'slot_id': 'S-20261102-2200'}, call_id='outside')
    assert outside.outcome == 'hold'
    assert outside.action.starts_at == local('S-20261102-2200')
    assert outside.card_ids == ['rv-book-wk']
    inside = await decided(client, visitor, TOOL, {'slot_id': SLOT}, call_id='inside')
    assert inside.outcome == 'allow'
    assert inside.action.starts_at == local(SLOT)
    assert inside.action.resource.id == SLOT


@pytest.mark.parametrize('change', [{'appointment_type': 'Viewing'}, {'minutes': 45}])
async def test_config_changed_after_approval_fails_before_booking(app, client, monkeypatch, change):
    from desk.kernel_service import execute

    copy, visitor = await configured(app, client, cards=[])
    held = await decided(client, visitor, TOOL, {'slot_id': SLOT})
    assert held.outcome == 'hold'

    async def change_after_approval():
        response = await put(client, copy, [typed_booking(**change)])
        assert response.status_code == 200, response.text

    # T1 has already checked and consumed the signed approval; T2 must re-read the row.
    monkeypatch.setattr(execute, '_after_intent', change_after_approval)
    response = await client.post(f'/approvals/{held.decision_id}/answer', headers=copy.owner,
                                 json={'answer': 'allow_once'})
    assert response.status_code == 200, response.text
    assert response.json()['decision']['state'] == 'refused_at_execution'
    assert not await rows_of(app, copy.copy_id, select(Booking))
    assert not await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == 'booking'))
    assert not await rows_of(app, copy.copy_id, select(DemoInboxEntry).where(DemoInboxEntry.preview == 'New booking'))


@pytest.mark.parametrize('appointment_type', ['$50 consultation', 'guaranteed', '20% discount'])
async def test_put_refuses_unsafe_appointment_type_under_its_public_key(app, client, monkeypatch, appointment_type):
    from desk.kernel_service import desks

    copy = await rivera(app, client)
    seen = []
    original = desks.refuse_public_promises

    async def checked(ctx, part, values, desk_id=None, **kwargs):
        if part == 'business_tools' and any(key.startswith(f'{TOOL}.') for key in values):
            seen.append(values)
        await original(ctx, part, values, desk_id, **kwargs)

    monkeypatch.setattr(desks, 'refuse_public_promises', checked)
    response = await put(client, copy, [typed_booking(appointment_type=appointment_type)])
    assert response.status_code == 422, response.text
    assert [list(values.items()) for values in seen] == [[(f'{TOOL}.0-title', 'Book a consult'),
                                                         (f'{TOOL}.1-appointment_type', appointment_type)]]
    assert response.json()['detail'] == {f'{TOOL}.appointment_type': ['public_promise']}
    assert not await rows_of(app, copy.copy_id, select(Tool).where(Tool.tool == TOOL))  # the seeded urgent tool stays


async def test_typed_and_native_booking_race_for_the_same_slot(app, client, monkeypatch):
    from desk.kernel_service.adapters import book

    cards = [RuleCard(card_id=f'book-{index}', applies_to=tool, mode='auto', who='anyone', reason='Book times.')
             for index, tool in enumerate((TOOL, 'native.book'))]
    copy, first = await configured(app, client, cards=cards)
    second = await open_visitor(client, copy)
    typed = await decided(client, first, TOOL, {'slot_id': SLOT})
    native = await decided(client, second, 'native.book', {'slot_id': SLOT})
    assert [typed.outcome, native.outcome] == ['allow', 'allow']
    original = book.commit_booking
    arrivals, both = [], asyncio.Event()

    async def race(ctx, action, slot, **kwargs):
        arrivals.append(action.tool)
        if len(arrivals) == 2:
            both.set()
        await asyncio.wait_for(both.wait(), timeout=10)
        return await original(ctx, action, slot, **kwargs)

    monkeypatch.setattr(book, 'commit_booking', race)
    results = await asyncio.gather(executed(client, first, typed), executed(client, second, native))
    assert sorted(result.state for result in results) == ['failed', 'succeeded']
    assert set(arrivals) == {TOOL, 'native.book'}
    [booking] = await rows_of(app, copy.copy_id, select(Booking))
    assert (booking.slot_id, booking.status) == (SLOT, 'confirmed')
    [fact] = await rows_of(app, copy.copy_id, select(Fact).where(Fact.kind == 'booking'))
    assert fact.action_id == booking.action_id
    failed = [entry.event.summary for entry in await ledger_rows(app, copy)
              if entry.event.kind == 'execute' and entry.event.summary.get('state') == 'failed']
    assert [entry['reason'] for entry in failed] == ['slot_taken']


@pytest.mark.parametrize('kind', ['visitor', 'agent'])
async def test_typed_tool_requires_answering_and_an_enabled_row(app, client, frozen_clock, kind):
    from .test_agent_auth import mint, open_agent, turn
    from .test_context import context_of

    copy, visitor = await configured(app, client)
    if kind == 'agent':
        agent = await mint(client, copy.owner, copy.desk_id)
        created = await open_agent(client, copy.slug, agent, frozen_clock, mandate=False)
        visitor = turn(agent, copy.slug, created.state.session_id, frozen_clock)

    async def names():
        seen = await context_of(client, visitor.session_id, visitor.headers)
        return {profile.tool for profile in seen.tools}

    assert {TOOL, 'native.book', 'native.find_slots'} <= await names()
    decision = await decided(client, visitor, TOOL, {'slot_id': SLOT})
    assert decision.outcome == 'allow'
    assert (await executed(client, visitor, decision)).state == 'succeeded'
    response = await client.put(f'/desks/{copy.desk_id}/answering', headers=copy.owner, json={'on': False})
    assert response.status_code == 200
    assert TOOL not in await names()
    refused = await decided(client, visitor, TOOL, {'slot_id': SLOT}, call_id='off')
    assert (refused.outcome, refused.action) == ('refuse', None)
    response = await client.put(f'/desks/{copy.desk_id}/answering', headers=copy.owner, json={'on': True})
    assert response.status_code == 200
    for status in ('needs_review', 'disabled'):
        async with kernel_ctx(app) as ctx:
            ctx.bind(copy.copy_id)
            row = (await ctx.db.scalars(ctx.repo.scoped(select(Tool).where(Tool.tool == TOOL)))).one()
            row.status = status
        assert TOOL not in await names()
        refused = await decided(client, visitor, TOOL, {'slot_id': SLOT}, call_id=status)
        assert (refused.outcome, refused.action) == ('refuse', None)


async def test_typed_metadata_stays_quoted_on_checked_cards_and_reconciles(app, client):
    from desk.db.models import ActorSession, Desk
    from desk.kernel_service import adapters
    from desk.kernel_service.adapters.base import ExecCtx
    from desk.kernel_service.sessions import principal_for
    from .test_reply_check import checked, clause

    appointment_type = 'Consult “special”\nvisit'
    copy, visitor = await configured(app, client, config={'appointment_type': appointment_type})
    decision = await decided(client, visitor, TOOL, {'slot_id': SLOT})
    assert decision.outcome == 'allow'
    result = await executed(client, visitor, decision)
    [fact] = result.facts
    assert next(claim.value for claim in fact.claims if claim.key == 'appointment_type') == appointment_type
    for prose, line in [('Here are the details.', '“Consult "special" visit” at 10:00 am'),
                        ('Aquí tiene los detalles.', '“Consult "special" visit” a las 10:00')]:
        verdict = await checked(client, visitor, prose, [clause('booking_confirmed', fact.fact_id)])
        assert verdict.violations == []
        [card] = [block for block in verdict.blocks if block.kind == 'card']
        assert card.lines[0] == line
    async with kernel_ctx(app) as ctx:
        ctx.bind(copy.copy_id)
        adapter = await adapters.resolve(ctx, copy.desk_id, TOOL)
        desk = (await ctx.db.scalars(ctx.repo.scoped(select(Desk).where(Desk.desk_id == copy.desk_id)))).one()
        session = (await ctx.db.scalars(ctx.repo.scoped(select(ActorSession).where(
            ActorSession.session_id == visitor.session_id)))).one()
        recovered = await adapter.reconcile(ExecCtx(ctx=ctx, desk_row=desk, session_row=session,
                                                   principal=principal_for(session)), decision.action)
        assert recovered.facts == result.facts
        assert recovered.model_view == result.model_view
