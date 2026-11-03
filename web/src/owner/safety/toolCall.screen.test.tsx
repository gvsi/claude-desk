import { expect, it } from 'vitest';

import type { LedgerEntry, LedgerPage } from '../../api/contracts.ts';
import { rivera } from '../../ds/fixtures/index.ts';
import { loadWebFonts } from '../../ds/test/fonts.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

const SAFETY = `/app/${RIVERA.deskId}/safety?view=entries`;

function entry(seq: number, kind: LedgerEntry['event']['kind'], summary: Record<string, unknown>): LedgerEntry {
  return {
    ...rivera.ledger.verified.entries[0]!, seq,
    created_at: '2026-11-02T21:46:12.402000Z',
    event: { kind, origin: 'kernel', session_id: null, ref_id: 'dec-tool', summary },
  };
}

function record(tool = 'native.book', state = 'executed'): LedgerPage {
  return {
    ...rivera.ledger.verified,
    entries: [
      entry(19, 'decide', { decision_id: 'dec-tool', tool, outcome: 'allow', card_ids: ['rv-book-wk'], reviewed: true }),
      entry(20, 'execute', { decision_id: 'dec-tool', state, action_id: 'act-tool', policy_version: 7 }),
    ],
  };
}

function injectLedger(ledger: LedgerPage) {
  mockStore.inject({ route: 'ledger', status: 200, times: 10_000, body: ledger });
}

it.each([
  ['native.book', 'Book a visit', false, 'Bookings · Built in'],
  ['payments.create_refund', 'Refund', false, 'Stripe'],
  ['desk.emergency-callback', 'Emergency callback', false, "Your Desk's jobs"],
  ['unknown.send', 'unknown.send', true, 'Connected tool'],
  ['native.fetch_website', 'Website reading', false, 'Built in'],
] as const)('names %s in the row and its accessible name', async (tool, name, mono, source) => {
  injectLedger(record(tool));
  const { screen } = await renderRoute(SAFETY);
  const row = screen.getByRole('button', { name: new RegExp(`^Entry 20, Tool call: ${name}, Recorded by your Desk,`) });
  await expect.element(row).toBeVisible();
  expect(row.element().querySelector('.cd-record__kind')?.textContent).toBe(`Tool call: ${name}`);
  expect(row.element().querySelector('.cd-record__kind .cd-type-trace') !== null).toBe(mono);
  await row.click();
  const section = screen.getByRole('group', { name: 'Tool call', exact: true });
  await expect.element(section.getByText(source, { exact: true })).toBeVisible();
  expect(section.element().querySelector('dd')?.classList.contains('cd-type-trace')).toBe(mono);
});

it('shows the tool, its source, result and the reviewed rule before the technical fields', async () => {
  injectLedger(record());
  const { screen } = await renderRoute(SAFETY);
  await screen.getByRole('button', { name: /^Entry 20,/ }).click();
  const trace = screen.getByRole('region', { name: 'Full trace of entry 20' });
  const section = trace.getByRole('group', { name: 'Tool call', exact: true });
  await expect.element(section).toBeVisible();
  const el = section.element();
  expect([...el.querySelectorAll('dt')].map((field) => field.textContent)).toEqual(['Tool', 'Source', 'Outcome']);
  expect([...el.querySelectorAll('dd')].map((field) => field.textContent)).toEqual(['Book a visit', 'Bookings · Built in', 'Ran']);
  expect(el.querySelector('.cd-status-dot--handled')).not.toBeNull();
  await expect.element(section.getByText('The rule that allowed it', { exact: true })).toBeVisible();
  expect(el.querySelector('.cd-rule-sentence__sentence')?.textContent).toBe('Claude can book visits on weekdays, 8:00 am to 6:00 pm');
  expect(el.querySelector('.cd-rule-sentence__meta')?.textContent).toBe('Book a visit · Anyone · Checked by the reviewer');
  expect(el.querySelector('.cd-rule-sentence__outcome')?.textContent).toBe('Allow');
  expect(el.previousElementSibling?.classList.contains('cd-full-trace__plain')).toBe(true);
  expect(el.nextElementSibling?.classList.contains('cd-full-trace__fields')).toBe(true);
});

it.each([
  ['executed', 'Ran', 'handled'],
  ['failed', "Didn't run", 'refused'],
  ['expired', "Didn't run", 'refused'],
  ['refused_at_execution', 'Stopped at the last check', 'refused'],
  ['unknown', 'Result unknown', 'held'],
] as const)('names the tool and maps %s to its recorded outcome', async (state, text, tone) => {
  injectLedger(record('native.book', state));
  const { screen } = await renderRoute(SAFETY);
  const row = screen.getByRole('button', { name: /^Entry 20, Tool call: Book a visit,/ });
  await expect.element(row).toBeVisible();
  await row.click();
  const section = screen.getByRole('group', { name: 'Tool call', exact: true });
  await expect.element(section.getByText(text, { exact: true })).toBeVisible();
  expect(section.element().querySelector('dd:last-child .cd-status-dot')?.classList.contains(`cd-status-dot--${tone}`)).toBe(true);
});

it('keeps Action ran with no tool section or extra reads across a page boundary', async () => {
  const ledger = record();
  ledger.entries = [entry(18, 'decide', { decision_id: 'another-decision', tool: 'native.quote' }), ledger.entries[1]!];
  injectLedger(ledger);
  const { screen } = await renderRoute(SAFETY, { pollScale: 100 });
  const row = screen.getByRole('button', { name: /^Entry 20, Action ran, Recorded by your Desk,/ });
  await expect.element(row).toBeVisible();
  const reads = mockStore.requests.filter((request) => request.key === 'ledger').length;
  await row.click();
  await expect.element(screen.getByRole('region', { name: 'Full trace of entry 20' })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Tool call', exact: true }).elements()).toHaveLength(0);
  expect(mockStore.requests.filter((request) => request.key === 'ledger')).toHaveLength(reads);
});

it('shows an unreviewed allowing rule without claiming a reviewer checked it', async () => {
  const ledger = record();
  ledger.entries[0]!.event.summary.reviewed = false;
  injectLedger(ledger);
  const { screen } = await renderRoute(SAFETY);
  await screen.getByRole('button', { name: /^Entry 20,/ }).click();
  const rule = screen.getByRole('group', { name: 'The rule that allowed it', exact: true });
  await expect.element(rule).toBeVisible();
  expect(rule.element().querySelector('.cd-rule-sentence__meta')?.textContent).toBe('Book a visit · Anyone');
});

it("shows You allowed it when the loaded record has the owner's approval of the decision", async () => {
  const ledger = record();
  // As the kernel records it: the decision held, then an approval entry for the same decision.
  ledger.entries[0]!.event.summary = { decision_id: 'dec-tool', tool: 'native.book', outcome: 'hold', card_ids: ['rv-book-wk'] };
  ledger.entries.splice(1, 0, entry(20, 'approval', { decision_id: 'dec-tool', action_id: 'act-tool', answer: 'approve', state: 'approved' }));
  ledger.entries[2] = { ...ledger.entries[2]!, seq: 21 };
  injectLedger(ledger);
  const { screen } = await renderRoute(SAFETY);
  await screen.getByRole('button', { name: /^Entry 21,/ }).click();
  const section = screen.getByRole('group', { name: 'Tool call', exact: true });
  await expect.element(section).toBeVisible();
  // One line, a handled dot and "You allowed it" in primary body type: no label over it and no lone Allow.
  const approval = section.element().querySelector<HTMLElement>('.cd-tool-call__approved');
  expect(approval?.textContent).toBe('You allowed it');
  expect(approval?.classList.contains('cd-type-body')).toBe(true);
  expect(approval?.querySelector('.cd-status-dot')).not.toBeNull();
  const probe = document.createElement('span');
  probe.style.color = 'var(--text-primary)';
  section.element().append(probe);
  expect(getComputedStyle(approval!).color).toBe(getComputedStyle(probe).color);
  probe.remove();
  expect(section.getByText('Allow', { exact: true }).elements()).toHaveLength(0);
  expect(section.element().querySelector('.cd-rule-sentence')).toBeNull();
  expect(section.element().querySelector('.cd-attempt__label + .cd-tool-call__approved')).toBeNull();
  expect(screen.getByText('The rule that allowed it', { exact: true }).elements()).toHaveLength(0);
});

it('draws the allowing rule sentence in primary ink, as the turned-down rule box does', async () => {
  injectLedger(record());
  const { screen } = await renderRoute(SAFETY);
  await screen.getByRole('button', { name: /^Entry 20,/ }).click();
  const rule = screen.getByRole('group', { name: 'The rule that allowed it', exact: true });
  await expect.element(rule).toBeVisible();
  const sentence = rule.element().querySelector<HTMLElement>('.cd-rule-sentence__sentence')!;
  const probe = document.createElement('span');
  probe.style.color = 'var(--text-primary)';
  rule.element().append(probe);
  expect(getComputedStyle(sentence).color).toBe(getComputedStyle(probe).color);
  probe.remove();
});

it.each(['missing', 'different tool', 'not automatic'] as const)('leaves out the rule box when the recorded card is %s', async (why) => {
  const ledger = record();
  ledger.entries[0]!.event.summary.card_ids = [why === 'missing' ? 'gone' : why === 'different tool' ? 'rv-quote' : 'rv-refund'];
  injectLedger(ledger);
  const { screen } = await renderRoute(SAFETY);
  await screen.getByRole('button', { name: /^Entry 20,/ }).click();
  const section = screen.getByRole('group', { name: 'Tool call', exact: true });
  await expect.element(section).toBeVisible();
  expect(section.element().querySelector('.cd-tool-call__rule')).toBeNull();
});

it('pairs older entries by ref_id and leaves other kinds unchanged', async () => {
  const ledger = record();
  delete ledger.entries[0]!.event.summary.decision_id;
  delete ledger.entries[1]!.event.summary.decision_id;
  ledger.entries.push(entry(21, 'approval', { tool: 'native.book' }), entry(22, 'reply', { tool: 'native.book', ok: true }));
  injectLedger(ledger);
  const { screen } = await renderRoute(SAFETY);
  for (const [seq, words] of [[22, 'Reply checked'], [21, 'Your answer'], [20, 'Tool call: Book a visit'], [19, 'Action checked']] as const) {
    const row = screen.getByRole('button', { name: new RegExp(`^Entry ${seq}, ${words},`) });
    await expect.element(row).toBeVisible();
    await row.click();
    await expect.element(screen.getByRole('region', { name: `Full trace of entry ${seq}` })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Tool call', exact: true }).elements()).toHaveLength(seq === 20 ? 1 : 0);
  }
});

it('keeps the same Tool call rows on a phone with Allow below the sentence', async () => {
  await loadWebFonts();
  injectLedger(record());
  const { screen } = await renderRoute(SAFETY, { viewport: 'phone' });
  await screen.getByRole('button', { name: /^Entry 20,/ }).click();
  const section = screen.getByRole('group', { name: 'Tool call', exact: true });
  await expect.element(section).toBeVisible();
  const el = section.element();
  const layout = el.querySelector<HTMLElement>('.cd-rule-sentence__layout')!;
  const meta = el.querySelector('.cd-rule-sentence__meta')!;
  const outcome = el.querySelector('.cd-rule-sentence__outcome')!;
  expect(getComputedStyle(layout).flexDirection).toBe('column');
  expect(outcome.getBoundingClientRect().top).toBeGreaterThanOrEqual(meta.getBoundingClientRect().bottom);
  expect([...el.querySelectorAll('dt')].map((field) => field.textContent)).toEqual(['Tool', 'Source', 'Outcome']);
  expect(document.documentElement.scrollWidth).toBe(window.innerWidth);
  const trace = screen.getByRole('region', { name: 'Full trace of entry 20' }).element();
  expect(trace.getBoundingClientRect().top).toBeGreaterThan(document.querySelector('.cd-record')!.getBoundingClientRect().bottom);
});

it('the mock record includes paired business and reviewed tool calls', async () => {
  const response = await mockStore.dispatch('ledger', { params: { desk_id: RIVERA.deskId } });
  if ('network' in response) throw new Error('the mock ledger is available');
  const ledger = response.body as LedgerPage;
  const calls = ledger.entries.filter((item) => item.event.kind === 'execute').map((item) => ({
    item,
    decision: ledger.entries.find((candidate) => candidate.event.kind === 'decide' && candidate.event.ref_id === item.event.ref_id),
  }));
  expect(calls.every(({ decision }) => decision !== undefined)).toBe(true);
  expect(calls.some(({ decision }) => decision?.event.summary.tool === 'desk.emergency-callback')).toBe(true);
  expect(calls.some(({ decision }) => decision?.event.summary.reviewed === true)).toBe(true);
});

it('leaves out the rule box when the decision ran under another rules version', async () => {
  const ledger = record();
  // The card keeps its ID across versions, so a newer version's sentence must not explain an older call.
  ledger.entries[1]!.event.summary.policy_version = 6;
  injectLedger(ledger);
  const { screen } = await renderRoute(SAFETY);
  await screen.getByRole('button', { name: /^Entry 20,/ }).click();
  const section = screen.getByRole('group', { name: 'Tool call', exact: true });
  await expect.element(section).toBeVisible();
  expect(section.element().querySelector('.cd-tool-call__rule')).toBeNull();
  expect(screen.getByText('The rule that allowed it', { exact: true }).elements()).toHaveLength(0);
});
