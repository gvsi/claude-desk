import { expect, it, onTestFinished, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import type { RuleCard } from '../../api/contracts.ts';
import { rivera } from '../../ds/fixtures/rivera.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;

/** Each rule row under `root` as the owner reads it: its sentence, then " / " and the line under it when it has one. */
function cells(root: Element): string[] {
  return [...root.querySelectorAll('.cd-house-rules__rule')].map((row) => {
    const sentence = row.querySelector('.cd-rule-sentence__sentence')?.textContent ?? '';
    const line = row.querySelector('.cd-house-rules__rule-line')?.textContent;
    return line === undefined ? sentence : `${sentence} / ${line}`;
  });
}

/** The line under a rule's sentence: who it is for and its qualifiers. */
const lineOf = (row: Element | null) => row?.querySelector('.cd-house-rules__rule-line')?.textContent ?? null;

it.each(['desktop', 'phone'] as const)('at %s, a hold keeps its agent audience beside an anyone limit, on each rule\'s own line', async (viewport) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.payment_link')!;
  desk.policy.cards = [
    { ...base, card_id: 'anyone-payment', mode: 'auto', who: 'anyone', max_amount_cents: 30_000, review: false },
    { ...base, card_id: 'agent-payment', mode: 'auto', who: 'agent', agent_key_id: 'key-one-agent', max_amount_cents: 2_000, review: false },
  ];
  const { screen } = await renderRoute(`${DESK}/rules`, { viewport });
  const link = screen.getByRole('region', { name: 'Payment link', exact: true });
  await expect.element(link.getByText('Claude can send payment links up to $20', { exact: true })).toBeVisible();
  // Past each limit it asks, for the people that rule is for: a qualifier on its line, not a row of its own.
  expect(lineOf(screen.container.querySelector('[data-rule-id="agent-payment"]'))).toBe('One agent · Over $20, it asks you first');
  expect(lineOf(screen.container.querySelector('[data-rule-id="anyone-payment"]'))).toBe('Anyone · Over $300, it asks you first');
  expect(link.element().querySelectorAll('.cd-house-rules__rule')).toHaveLength(2);
  expect(screen.container.querySelector('[data-rule-id="agent-payment"] .cd-house-rules__rule-line')?.classList.contains('cd-type-meta')).toBe(true);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it('an Allow private-data rule keeps its verified record-owner scope', async () => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards = [{ ...base, card_id: 'shared-owner', applies_to: 'effect:private_data', mode: 'auto', who: 'record_owner' }];
  const { screen } = await renderRoute(`${DESK}/rules`);
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  await expect.element(stripe.getByText('Claude can share private data', { exact: true })).toBeVisible();
  const rows = screen.container.querySelectorAll('[data-rule-id="shared-owner"]');
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    expect(lineOf(row)).toBe('The customer, once verified');
    expect(row.querySelector('.cd-house-rules__rule-line')?.classList.contains('cd-type-meta')).toBe(true);
  }
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)('at %s, every outcome says whom it is for in the same words', async (viewport) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  const scopes: { who: RuleCard['who']; text: string }[] = [
    { who: 'anyone', text: 'Anyone' },
    { who: 'verified', text: 'The customer, once verified' },
    { who: 'record_owner', text: 'The customer, once verified' },
    { who: 'person', text: 'Dana Whitfield, verified' },
    { who: 'agent', text: 'One agent' },
  ];
  desk.policy.cards = (['auto', 'ask', 'never'] as const).flatMap((mode) => [
    ...scopes.map(({ who }) => ({
      ...base, card_id: `${mode}:${who}`, mode, who,
      person_id: who === 'person' ? 'per-dana' : null,
      agent_key_id: who === 'agent' ? 'key-one-agent' : null,
    })),
    { ...base, card_id: `${mode}:paid`, mode, applies_to: 'payments.create_refund' },
  ]);
  const { screen } = await renderRoute(`${DESK}/rules`, { viewport });
  await expect.element(screen.getByText('Dana Whitfield, verified', { exact: true }).first()).toBeVisible();
  for (const mode of ['auto', 'ask', 'never'] as const) {
    for (const { who, text } of [...scopes, { who: 'paid', text: 'The customer, once verified' }]) {
      const row = screen.container.querySelector(`[data-rule-id="${mode}:${who}"]`)!;
      const line = row.querySelector('.cd-house-rules__rule-line')!;
      expect(line.textContent, `${mode} ${who}`).toBe(text);
      const sentence = row.querySelector('.cd-rule-sentence__sentence')!;
      expect(sentence.textContent).toMatch(mode === 'auto' ? /^Claude can / : mode === 'ask' ? /^Claude asks you before / : /^Claude never /);
      expect(line.classList.contains('cd-type-meta')).toBe(true);
      expect(line.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    }
  }
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it.each(['ask', 'never'] as const)('at 390, a shared %s rule keeps its owner scope on the expanded row and references', async (mode) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards = [{ ...base, card_id: 'shared-owner', applies_to: 'effect:private_data', mode }];
  const { screen } = await renderRoute(`${DESK}/rules`, { viewport: 'phone' });
  await expect.element(screen.getByText('The customer, once verified', { exact: true }).first()).toBeVisible();
  const rows = [...screen.container.querySelectorAll('[data-rule-id="shared-owner"]')];
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.classList.contains('cd-house-rules__rule--reference'))).toHaveLength(2);
  for (const row of rows) expect(lineOf(row)).toBe('The customer, once verified');
  expectNoHorizontalScroll();
});

it('Payments and Stripe open with the money band, then each tool with its rules', async () => {
  const { screen } = await renderRoute(`${DESK}/rules`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeVisible();
  const payments = screen.getByRole('region', { name: 'Payments', exact: true });
  await expect.element(payments.getByText('Built in', { exact: true })).toBeVisible();
  // The band, on the card's fill: the payment limit over the card's money tools, then "never moves money", always on.
  const band = payments.element().querySelector('.cd-house-rules__money')!;
  expect(cells(band)).toEqual([
    'Claude asks you before any payment over $500, whatever the rules below say / Payment link and Charge within a signed limit',
    'Claude never moves money without your rule or a signed limit / Payment link and Charge within a signed limit',
  ]);
  expect(getComputedStyle(band).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  // The limit's row: Change, then its held dot, then Details.
  const actions = [...band.querySelector('[data-money-limit] .cd-house-rules__rule-actions')!.children];
  expect(actions.map((part) => part.textContent || part.className)).toEqual(['Change', 'cd-status-dot cd-status-dot--held', 'Details']);
  expect(cells(payments.getByRole('region', { name: 'Payment link' }).element())).toEqual([
    'Claude can send payment links up to $300 / Anyone · Checked by the reviewer · Over $300, it asks you first',
  ]);
  expect(cells(payments.getByRole('region', { name: 'Charge within a signed limit' }).element())).toEqual([
    "Claude can take a visiting agent's payment, up to $20, from its signed limit / Anyone · Over $20, it asks you first",
  ]);
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  await expect.element(stripe.getByText('Mock', { exact: true })).toBeVisible();
  expect(cells(stripe.element().querySelector('.cd-house-rules__money')!)).toEqual([
    'Claude asks you before any payment over $500, whatever the rules below say / Refund',
    'Claude never moves money without your rule or a signed limit / Refund',
  ]);
  expect(cells(stripe.getByRole('region', { name: 'See charges' }).element())).toEqual([
    'Claude can show customers their own charges / The customer, once verified',
    'Claude never shows private data to anyone but its verified owner',
  ]);
  expect(cells(stripe.getByRole('region', { name: 'Refund' }).element())).toEqual(['Claude asks you before any refund / The customer, once verified']);
  // The outcome is in each sentence; at the right only dots, "Always on" and Details.
  expect(stripe.getByText('Allow', { exact: true }).elements()).toHaveLength(0);
  expect(stripe.getByText('Ask me first', { exact: true }).elements()).toHaveLength(0);
  expect(screen.container.textContent).not.toContain('Any payment over $500 asks you first');
  expect(screen.container.textContent).not.toContain('Anything else here: ask me.');
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it('at 390, a shared card shows in full only once across connectors, and the payment limit once in each money band', async () => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards.push({ ...base, card_id: 'shared-private', applies_to: 'effect:private_data', mode: 'never', who: 'anyone' });
  const { screen } = await renderRoute(`${DESK}/rules`, { viewport: 'phone' });
  const documents = screen.getByRole('region', { name: 'Documents', exact: true });
  await expect.element(documents.getByText('Claude never shares private data', { exact: true })).toBeVisible();
  const shared = documents.element().querySelector('.cd-house-rules__shared');
  expect(shared?.textContent).toBe('Shared rule. Also applies to:See charges and Refund');
  expect([...shared!.querySelectorAll('[data-copy="user"]')].map((title) => title.textContent)).toEqual(['See charges', 'Refund']);
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  expect(stripe.getByText('Claude never shares private data · Shared rule, as above', { exact: true }).elements()).toHaveLength(2);
  expect(screen.getByText('Claude asks you before any payment over $500, whatever the rules below say', { exact: true }).elements()).toHaveLength(2);
  expect(screen.container.querySelectorAll('[data-money-limit]')).toHaveLength(2);
  expect(screen.container.textContent).not.toContain('Shared rule, as above · Any payment');
  const payments = screen.getByRole('region', { name: 'Payments', exact: true });
  expect(payments.element().querySelector('.cd-house-rules__shared')).toBeNull();
  expect([...payments.element().querySelectorAll('strong')].map((value) => value.textContent)).toContain('$500');
  expect(screen.container.querySelectorAll('.cd-house-rules__tool-name[data-copy="user"]')).toHaveLength(12);
  expect(screen.container.textContent).not.toMatch(/input_schema|Cedar/);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

/** A Details panel's list, label then value, as the owner reads it. */
function fieldsOf(panel: Element): [string, string][] {
  return [...panel.querySelectorAll('.cd-advanced-details__field')].map((field) => [
    field.querySelector('dt')?.textContent ?? '',
    field.querySelector('dd')?.textContent ?? '',
  ]);
}

/** The panel a Details button opens. */
function panelOf(toggle: Element): HTMLElement {
  return document.getElementById(toggle.getAttribute('aria-controls')!)!;
}

it.each(['desktop', 'phone'] as const)('at %s, every tool and rule has Details, collapsed, that the keyboard opens and closes', async (viewport) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const { screen } = await renderRoute(`${DESK}/rules`, { viewport });
  const link = screen.getByRole('region', { name: 'Payment link', exact: true });
  await expect.element(link.getByText('Claude can send payment links up to $300', { exact: true })).toBeVisible();

  // One Details per tool and per rule row with a dot, every one closed, and no panel drawn; an
  // always-on rule has none, and "Anything not listed here" keeps Details' empty place.
  const toggles = screen.getByRole('button', { name: 'Details', exact: true }).elements();
  const drawn = (selector: string) => [...screen.container.querySelectorAll(selector)].filter((el) => el.closest('.cd-skeleton-screen__layer') === null);
  const ruleRows = drawn('.cd-house-rules__rule');
  const withDetails = ruleRows.filter((row) => row.querySelector('.cd-status-dot') !== null && row.querySelector('.cd-advanced-details__slot') === null);
  expect(toggles).toHaveLength(drawn('.cd-house-rules__tool').length + withDetails.length);
  expect(ruleRows.filter((row) => row.querySelector('.cd-house-rules__always-on') !== null).every((row) => row.querySelector('button') === null)).toBe(true);
  expect(toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'false')).toBe(true);
  expect(screen.container.querySelector('.cd-advanced-details__panel')).toBeNull();
  // Every rule's status dot sits in one column, just left of its Details (REV-RULES-D v351).
  const dots = drawn('.cd-house-rules__rule-actions > .cd-status-dot');
  expect(new Set(dots.map((dot) => Math.round(dot.getBoundingClientRect().left))).size).toBe(1);
  expect(new Set(toggles.map((toggle) => Math.round(toggle.getBoundingClientRect().right))).size).toBe(1);

  // A tool's Details follows its title; Enter opens its panel above its rules, Space closes it.
  const toolToggle = link.element().querySelector<HTMLElement>('.cd-house-rules__tool-header > button')!;
  expect(toolToggle.getAttribute('aria-describedby')).toBe(link.element().querySelector('.cd-house-rules__tool-name')?.id);
  toolToggle.focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(toolToggle).toHaveAttribute('aria-expanded', 'true');
  const toolPanel = panelOf(toolToggle);
  expect(toolPanel.hidden).toBe(false);
  expect(toolPanel.nextElementSibling?.classList.contains('cd-house-rules__rules')).toBe(true);
  const row = desk.tools.find((tool) => tool.tool === 'native.payment_link')!;
  expect(fieldsOf(toolPanel)).toEqual([
    ['Name', 'native.payment_link'],
    ['Source', 'Built in'],
    ['Claude sees', row.description_confirmed],
    ['Effects', "Charges money · Can't be undone"],
    ['Status', 'Turned on'],
    ['Pinned', 'Matches its pin'],
  ]);
  expect(toolPanel.querySelector('.cd-status-dot--handled')).not.toBeNull();
  await userEvent.keyboard(' ');
  await expect.element(toolToggle).toHaveAttribute('aria-expanded', 'false');
  expect(toolPanel.hidden).toBe(true);
  expect(toolPanel.textContent).toBe('');

  // A rule's Details follows its status dot, and opens under its sentence.
  const rule = screen.container.querySelector('[data-rule-id="rv-link"]')!;
  const ruleToggle = rule.querySelector<HTMLElement>('.cd-house-rules__rule-actions > button')!;
  expect(ruleToggle.previousElementSibling?.classList.contains('cd-status-dot')).toBe(true);
  ruleToggle.focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(ruleToggle).toHaveAttribute('aria-expanded', 'true');
  const hash = desk.policy.cedar_sha256;
  expect(fieldsOf(panelOf(ruleToggle))).toEqual([
    ['Rule', 'rv-link'],
    ['Version', '7, proved against the always-on rules'],
    ['Policy hash', `sha256 ${hash.slice(0, 4)}…${hash.slice(-4)}`],
  ]);
  expect(panelOf(ruleToggle).closest('li')).toBe(rule);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
  ruleToggle.focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(ruleToggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.container.querySelector('.cd-advanced-details__panel')).toBeNull();
});

/** Opens a Details panel with a click and gives back its code block. */
async function openCode(toggle: HTMLElement): Promise<HTMLPreElement> {
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
  return panelOf(toggle).querySelector('pre')!;
}

it('the JSON in Details is the tool row and the rule card, and Copy copies it', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  onTestFinished(() => writeText.mockRestore());
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const { screen } = await renderRoute(`${DESK}/rules`);
  const link = screen.getByRole('region', { name: 'Payment link', exact: true });
  await expect.element(link.getByText('Claude can send payment links up to $300', { exact: true })).toBeVisible();

  // The tool: the row's own fields as GET /rules lists them, in a mono block with a 2-space indent.
  const toolCode = await openCode(link.element().querySelector<HTMLElement>('.cd-house-rules__tool-header > button')!);
  const row = desk.tools.find((tool) => tool.tool === 'native.payment_link')!;
  expect(JSON.parse(toolCode.textContent!)).toEqual({
    tool: row.tool, source: row.source, effects: row.effects, reversible: row.reversible, status: row.status,
    description_confirmed: row.description_confirmed, definition_sha256: row.definition_sha256,
  });
  expect(toolCode.textContent).toContain('\n  "tool": "native.payment_link",\n');
  expect(toolCode.classList.contains('cd-type-trace')).toBe(true);
  expect(getComputedStyle(toolCode).whiteSpace).toBe('pre');
  expect(getComputedStyle(toolCode).overflowX).toBe('auto');
  expect(getComputedStyle(toolCode).fontVariantLigatures).toBe('none');
  const toolPanel = toolCode.closest('.cd-advanced-details__panel')!;
  expect(toolPanel.querySelector('.cd-advanced-details__code-label')?.textContent).toBe('As your Desk lists it');

  // Copy copies the text as shown, and says so with CopyField's words.
  const toolCopy = toolPanel.querySelector<HTMLElement>('.cd-advanced-details__code-head button')!;
  expect(toolCopy.textContent).toBe('Copy');
  await userEvent.click(toolCopy);
  expect(writeText).toHaveBeenLastCalledWith(toolCode.textContent);
  await expect.element(screen.getByText('Copied.', { exact: true })).toBeVisible();

  // The rule: its card as set, the fields sent empty left out; Copy copies it, and only its block says so.
  const rule = screen.container.querySelector('[data-rule-id="rv-link"]')!;
  const ruleCode = await openCode(rule.querySelector<HTMLElement>('.cd-house-rules__rule-actions > button')!);
  const card = desk.policy.cards.find((each) => each.card_id === 'rv-link')!;
  expect(JSON.parse(ruleCode.textContent!)).toEqual(Object.fromEntries(Object.entries(card).filter(([, value]) => value !== null)));
  expect(JSON.parse(ruleCode.textContent!)).toMatchObject({ card_id: 'rv-link', max_amount_cents: 30_000, review: true });
  const rulePanel = ruleCode.closest('.cd-advanced-details__panel')!;
  expect(rulePanel.querySelector('.cd-advanced-details__code-label')?.textContent).toBe('The rule as you set it');
  await userEvent.click(rulePanel.querySelector<HTMLElement>('.cd-advanced-details__code-head button')!);
  expect(writeText).toHaveBeenLastCalledWith(ruleCode.textContent);
  await expect.element(screen.getByText('Copied.', { exact: true })).toBeVisible();
  expect(rulePanel.textContent).toContain('Copied.');
  expect(toolPanel.textContent).not.toContain('Copied.');

  // The payment limit's block is the version's limit.
  const cap = screen.container.querySelector('[data-money-limit]')!;
  const capToggle = cap.querySelector<HTMLElement>('.cd-house-rules__rule-actions > .cd-advanced-details__toggle')!;
  const capCode = await openCode(capToggle);
  expect(JSON.parse(capCode.textContent!)).toEqual({ auto_money_cap_cents: 50_000 });
  expect(fieldsOf(panelOf(capToggle)).map(([label]) => label)).toEqual(['Version', 'Policy hash']);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)('at %s, with every Details open, no input schema or Cedar text is anywhere in the page', async (viewport) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  // Refund's definition changed on the server: its new text, input schema and all, waits for review.
  const changed = rivera.toolProfiles.createRefundChanged;
  desk.tools = desk.tools.map((tool) => tool.tool === changed.tool
    ? { ...tool, status: changed.status, review_reason: changed.review_reason, pending_definition_text: changed.pending_definition_text, pending_sha256: changed.pending_sha256 }
    : tool);
  // A tool no card covers asks by default; its sentence comes from no card.
  desk.policy.cards = desk.policy.cards.filter((card) => card.applies_to !== 'native.find_slots');
  const { screen } = await renderRoute(`${DESK}/rules`, { viewport });
  await expect.element(screen.getByText('Claude can send payment links up to $300', { exact: true })).toBeVisible();
  for (const toggle of screen.getByRole('button', { name: 'Details', exact: true }).elements()) await userEvent.click(toggle);
  const open = screen.getByRole('button', { name: 'Details', exact: true }).elements();
  expect(open.length).toBeGreaterThan(20);
  expect(open.every((toggle) => toggle.getAttribute('aria-expanded') === 'true')).toBe(true);
  expect(screen.container.querySelectorAll('.cd-advanced-details__panel')).toHaveLength(open.length);

  const text = document.body.textContent!;
  expect(text).not.toMatch(/inputSchema|input_schema|"properties"|"required"|additionalProperties/);
  expect(text).not.toContain('destination');
  expect(text).not.toMatch(/\bpermit\b|\bforbid\b|@id\(|@card\(|Action::|principal|Cedar|Parameters|Compiled policy/);
  expect(text).not.toContain(changed.pending_definition_text);

  // Refund's pin no longer matches: it waits for the owner, and it's off until then.
  const refund = screen.getByRole('region', { name: 'Refund', exact: true }).element();
  const refundPanel = panelOf(refund.querySelector('.cd-house-rules__tool-header > button')!);
  expect(fieldsOf(refundPanel).filter(([label]) => label === 'Status' || label === 'Pinned')).toEqual([['Status', 'Turned off'], ['Pinned', 'Needs your review']]);
  expect(refundPanel.querySelector('.cd-status-dot--held')).not.toBeNull();
  // Stripe's tools come from a mock, and say so beside its name.
  expect(fieldsOf(refundPanel).find(([label]) => label === 'Source')).toEqual(['Source', 'Stripe Mock']);

  // The default ask names no card and shows no block: there is no card to show.
  const slots = screen.getByRole('region', { name: 'Find open times', exact: true }).element();
  const askPanel = panelOf(slots.querySelector('.cd-house-rules__rule-actions > button')!);
  expect(fieldsOf(askPanel).map(([label]) => label)).toEqual(['Version', 'Policy hash']);
  expect(askPanel.querySelector('pre')).toBeNull();
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)("at %s, a tool's effects show only in its Details, never as badges on its row", async (viewport) => {
  const { screen } = await renderRoute(`${DESK}/rules`, { viewport });
  const refund = screen.getByRole('region', { name: 'Refund', exact: true });
  await expect.element(refund.getByText('Claude asks you before any refund', { exact: true })).toBeVisible();
  // No tool or rule row carries an effect badge ("Money", "Private data", "Can't be undone").
  expect(screen.container.querySelector('.cd-effect-tags')).toBeNull();
  for (const words of ['Money', 'Private data', "Can't be undone"]) expect(screen.getByText(words, { exact: true }).elements()).toHaveLength(0);
  // Its Details' Effects row says them all.
  const toggle = refund.element().querySelector<HTMLElement>('.cd-house-rules__tool-header > button')!;
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(fieldsOf(panelOf(toggle)).find(([label]) => label === 'Effects')).toEqual(['Effects', "Moves money out · Touches private data · Can't be undone"]);
  expectNoHorizontalScroll();
});
