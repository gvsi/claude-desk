import { expect, it, vi } from 'vitest';

import type { StatusEvent } from '../api/contracts.ts';
import { VISITOR_PLAIN } from '../mocks/script.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

const NOT_SHARED = 'Not shared: their session ended when their contact changed';

it('Today_keeps_the_refused_approval_in_place_with_its_owner_line_and_null_fallback', async () => {
  for (const fallback of [false, true]) {
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/today`, { seed: 'rivera', viewport: fallback ? 'phone' : 'desktop' });
    const world = mockStore.world;
    const held = [...world.decisions.values()].find((r) => r.decision.state === 'held')!;
    const card = screen.getByRole('article', { name: `Held for you: ${held.decision.reason_plain}`, exact: true });
    await expect.element(card).toBeVisible();
    const element = card.element();
    const desk = world.desk(RIVERA.deskId)!;
    const rule = desk.policy.cards.find((r) => r.applies_to === 'native.quote')!;
    const draft = world.draft(desk, [{ ...rule, mode: 'never' }]);
    world.confirmDraft(desk, draft.version);
    const answer = world.answer.bind(world);
    const spy = vi.spyOn(world, 'answer').mockImplementation((record, given) => {
      const result = answer(record, given);
      result.owner_plain = fallback ? null : NOT_SHARED;
      return result;
    });
    try {
      await card.getByRole('button', { name: 'Allow this time', exact: true }).click();
      const line = fallback ? "Your rules changed before this ran, so it wasn't done." : NOT_SHARED;
      await expect.poll(() => element.querySelector('.cd-approval-card__status-line')?.textContent).toBe(line);
      expect(held.decision.state).toBe('refused_at_execution');
      expect(held.decision.owner_plain).toBe(fallback ? null : NOT_SHARED);
      const row = screen.getByRole('heading', { name: 'Answer a held request', exact: true }).element().closest('li')!;
      await expect.poll(() => row.querySelector('.cd-things__detail')?.textContent).toBe(line);
      expect(element.querySelector('.cd-status-dot--refused')).not.toBeNull();
      await expect.element(screen.getByRole('button', { name: 'Dismiss', exact: true }).first()).toBeVisible();
      expectNoHorizontalScroll();
    } finally { spy.mockRestore(); }
  }
});

it('the_owner_receipt_uses_the_execution_refusal_annotation_with_a_null_fallback', async () => {
  for (const ownerPlain of [NOT_SHARED, null]) {
    mockStore.reset('rivera');
    const held = mockStore.world.addHeldRefund();
    const record = mockStore.world.decisions.get(held.decision_id)!;
    const chat = mockStore.world.sessions.get(held.session_id)!;
    const answered = mockStore.world.answer(record, 'allow_once');
    record.decision = { ...answered, state: 'refused_at_execution', owner_plain: ownerPlain, visitor_plain: VISITOR_PLAIN.en.refused_at_execution };
    const event: StatusEvent = {
      type: 'resolved', decision_id: held.decision_id, state: 'refused_at_execution',
      visitor_plain: record.decision.visitor_plain, ledger_seq: record.decision.ledger_seq,
      signature: record.decision.signature,
    };
    mockStore.world.emit(chat, event);
    const { screen } = await renderRoute(`/app/${RIVERA.deskId}/conversations/${held.session_id}`);
    const line = ownerPlain ?? event.visitor_plain;
    await expect.element(screen.getByRole('button', { name: `${line} Open the full trace.` })).toBeVisible();
    await expect.element(screen.getByText(`Latest: ${line}`, { exact: true })).toBeVisible();
    const receipt = [...document.querySelectorAll('.cd-margin-receipt')].find((el) => el.textContent?.includes(line));
    expect(receipt?.querySelector('.cd-status-dot--refused')).not.toBeNull();
    expectNoHorizontalScroll();
  }
});
