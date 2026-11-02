import { expect, it, onTestFinished, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import type { RuleCard } from '../../api/contracts.ts';
import { rivera } from '../../ds/fixtures/rivera.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;

it.each(['desktop', 'phone'] as const)('at %s, a generated hold keeps its agent audience beside an anyone limit', async (viewport) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.payment_link')!;
  desk.policy.cards = [
    { ...base, card_id: 'anyone-payment', mode: 'auto', who: 'anyone', max_amount_cents: 30_000 },
    { ...base, card_id: 'agent-payment', mode: 'auto', who: 'agent', agent_key_id: 'key-one-agent', max_amount_cents: 2_000 },
  ];
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport });
  const payments = screen.getByRole('region', { name: 'Payments', exact: true });
  const agentHold = payments.getByText('Over $20, Claude asks you first', { exact: true });
  const anyoneHold = payments.getByText('Over $300, Claude asks you first', { exact: true });
  await expect.element(agentHold).toBeVisible();
  await expect.element(anyoneHold).toBeVisible();
  expect(screen.container.querySelector('[data-rule-id="agent-payment"] .cd-rule-sentence__meta')?.textContent).toBe('One agent');
  const audience = agentHold.element().closest('li')!.querySelector('.cd-rule-sentence__meta');
  expect(audience?.textContent).toBe('One agent');
  expect(audience?.classList.contains('cd-type-meta')).toBe(true);
  expect(anyoneHold.element().closest('li')!.querySelector('.cd-rule-sentence__meta')).toBeNull();
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it('an Allow private-data rule keeps its verified record-owner scope', async () => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards = [{ ...base, card_id: 'shared-owner', applies_to: 'effect:private_data', mode: 'auto', who: 'record_owner' }];
  const { screen } = await renderRoute(`${DESK}/rules/all`);
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  await expect.element(stripe.getByText("Claude can share private data, once they've confirmed it's them", { exact: true })).toBeVisible();
  const rows = screen.container.querySelectorAll('[data-rule-id="shared-owner"]');
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    const meta = row.querySelector('.cd-rule-sentence__meta');
    expect(meta?.textContent).toBe("The record's owner, verified");
    expect(meta?.classList.contains('cd-type-meta')).toBe(true);
  }
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)('at %s, every outcome preserves each audience without adding an Anyone line', async (viewport) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  const scopes: { who: RuleCard['who']; text: string | null }[] = [
    { who: 'anyone', text: null },
    { who: 'verified', text: 'Verified customers' },
    { who: 'record_owner', text: "The record's owner, verified" },
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
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport });
  await expect.element(screen.getByText('Dana Whitfield, verified', { exact: true }).first()).toBeVisible();
  for (const mode of ['auto', 'ask', 'never'] as const) {
    for (const { who, text } of [...scopes, { who: 'paid', text: 'The customer who paid, verified' }]) {
      const row = screen.container.querySelector(`[data-rule-id="${mode}:${who}"]`)!;
      const meta = row.querySelector('.cd-rule-sentence__meta');
      expect(meta?.textContent ?? null).toBe(text);
      const sentence = row.querySelector('.cd-rule-sentence__sentence')!;
      expect(sentence.textContent).toMatch(mode === 'auto' ? /^Claude can / : mode === 'ask' ? /^Claude asks you before / : /^Claude never /);
      if (meta !== null) {
        expect(meta.classList.contains('cd-type-meta')).toBe(true);
        expect(meta.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      }
    }
  }
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it.each(['ask', 'never'] as const)('at 390, a shared %s rule keeps its owner scope on the expanded row and references', async (mode) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards = [{ ...base, card_id: 'shared-owner', applies_to: 'effect:private_data', mode }];
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport: 'phone' });
  await expect.element(screen.getByText("The record's owner, verified", { exact: true }).first()).toBeVisible();
  const rows = [...screen.container.querySelectorAll('[data-rule-id="shared-owner"]')];
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.classList.contains('cd-house-rules__rule--reference'))).toHaveLength(2);
  for (const row of rows) expect(row.querySelector('.cd-rule-sentence__meta')?.textContent).toBe("The record's owner, verified");
  expectNoHorizontalScroll();
});

it('Your tools gives Payments and Stripe C4 sentences with dots alone', async () => {
  const { screen } = await renderRoute(`${DESK}/rules/all`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Your tools' })).toBeVisible();
  const payments = screen.getByRole('region', { name: 'Payments', exact: true });
  await expect.element(payments.getByText('Built in', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Claude can send payment links up to $300', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Over $300, Claude asks you first', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Claude can take agent payments up to $20 from a signed limit', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Over $20, Claude asks you first', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Any payment over $500 asks you first', { exact: true })).toBeVisible();
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  await expect.element(stripe.getByText('Mock', { exact: true })).toBeVisible();
  await expect.element(stripe.getByText("Claude can show customers their own charges, once they've confirmed it's them", { exact: true })).toBeVisible();
  await expect.element(stripe.getByText('Claude asks you before any refund', { exact: true })).toBeVisible();
  expect(stripe.element().querySelectorAll('.cd-status-dot')).toHaveLength(3);
  expect(stripe.getByText('Allow', { exact: true }).elements()).toHaveLength(0);
  expect(stripe.getByText('Ask me first', { exact: true }).elements()).toHaveLength(0);
  expect(screen.container.textContent).not.toContain('Checked by the reviewer');
  expect(screen.container.textContent).not.toContain('Anything else here: ask me.');
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it('at 390, a shared card and the money cap each show in full only once across connectors', async () => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards.push({ ...base, card_id: 'shared-private', applies_to: 'effect:private_data', mode: 'never', who: 'anyone' });
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport: 'phone' });
  const documents = screen.getByRole('region', { name: 'Documents', exact: true });
  await expect.element(documents.getByText('Claude never shares private data', { exact: true })).toBeVisible();
  const shared = documents.element().querySelector('.cd-house-rules__shared');
  expect(shared?.textContent).toBe('Shared rule. Also applies to:See charges and Refund');
  expect([...shared!.querySelectorAll('[data-copy="user"]')].map((title) => title.textContent)).toEqual(['See charges', 'Refund']);
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  expect(stripe.getByText('Claude never shares private data · Shared rule, as above', { exact: true }).elements()).toHaveLength(2);
  expect(screen.getByText('Any payment over $500 asks you first', { exact: true }).elements()).toHaveLength(1);
  expect(screen.getByText('Any payment over $500 asks you first · Shared rule, as above', { exact: true }).elements()).toHaveLength(2);
  const payments = screen.getByRole('region', { name: 'Payments', exact: true });
  expect(payments.element().querySelector('.cd-house-rules__shared')?.textContent)
    .toBe('Shared rule. Also applies to:Charge within a signed limit and Refund');
  expect([...payments.element().querySelectorAll('strong')].map((value) => value.textContent)).toContain('$500');
  expect(screen.container.querySelectorAll('.cd-house-rules__tool-name[data-copy="user"]')).toHaveLength(12);
  expect(screen.container.textContent).not.toMatch(/input_schema|Cedar|Checked by the reviewer/);
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
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport });
  const link = screen.getByRole('region', { name: 'Payment link', exact: true });
  await expect.element(link.getByText('Claude can send payment links up to $300', { exact: true })).toBeVisible();

  // One Details per tool and per rule row, every one closed, and no panel drawn.
  const toggles = screen.getByRole('button', { name: 'Details', exact: true }).elements();
  const rows = screen.container.querySelectorAll('.cd-house-rules__tool').length + screen.container.querySelectorAll('.cd-house-rules__rule').length;
  expect(toggles).toHaveLength(rows);
  expect(toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'false')).toBe(true);
  expect(screen.container.querySelector('.cd-advanced-details__panel')).toBeNull();

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
  const { screen } = await renderRoute(`${DESK}/rules/all`);
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

  // Its hold reads the same card; the payment limit's block is the version's limit.
  const hold = screen.getByText('Over $300, Claude asks you first', { exact: true }).element().closest('li')!;
  expect(JSON.parse((await openCode(hold.querySelector<HTMLElement>('.cd-house-rules__rule-actions > button')!)).textContent!)).toMatchObject({ card_id: 'rv-link' });
  const cap = screen.getByText('Any payment over $500 asks you first', { exact: true }).element().closest('li')!;
  const capCode = await openCode(cap.querySelector<HTMLElement>('.cd-house-rules__rule-actions > button')!);
  expect(JSON.parse(capCode.textContent!)).toEqual({ auto_money_cap_cents: 50_000 });
  expect(fieldsOf(panelOf(cap.querySelector('.cd-house-rules__rule-actions > button')!)).map(([label]) => label)).toEqual(['Version', 'Policy hash']);
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
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport });
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
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport });
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
