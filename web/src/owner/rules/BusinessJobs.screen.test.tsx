import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

import type { RuleCard } from '../../api/contracts.ts';
import type { ToolRow } from '../../api/views.ts';
import { expectUserText } from '../../ds/test/expectUserText.ts';
import { chenBusinessTools, seedBusinessTools } from '../../mocks/businessTools.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { BUSINESS_OWNER_LINES } from '../connectors/businessWords.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;
const INTAKE_RULE: RuleCard = {
  card_id: 'intake-auto', applies_to: 'desk.new-client-intake', mode: 'auto', who: 'anyone',
  person_id: null, agent_key_id: null, max_amount_cents: null, max_discount_bp: 0,
  hours: null, review: false, is_default: false,
  reason: 'New clients answer three questions before they book.',
};

/** The main Desk, without the urgent job every Turner copy has, so only the jobs a test gives it show. */
function deskWithoutJobs() {
  const desk = mockStore.world.desk(RIVERA.deskId);
  if (!desk) throw new Error('The mock has the main Desk');
  desk.tools = desk.tools.filter((row) => row.source !== 'business');
  return desk;
}

function seedJobs() {
  const desk = deskWithoutJobs();
  desk.summary.business_name = 'Chen & Co. CPA';
  seedBusinessTools(desk, chenBusinessTools.map((row) => ({ ...row, status: 'enabled', review_reason: null })));
  desk.policy = { ...desk.policy, cards: [INTAKE_RULE] };
  return desk;
}

it.each([1440, 1512, 390])('at %i px, Rules lists the on jobs in API order with configuration, governing rules and the default ask', async (width) => {
  seedJobs();
  const { screen } = await renderRoute(`${DESK}/rules`, { connectorPages: true, viewport: { width, height: width === 390 ? 844 : 900 } });
  const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
  await expect.element(jobs).toBeVisible();
  expect([...jobs.element().querySelectorAll('.cd-tool-rules__tool-name')].map((el) => el.textContent)).toEqual([
    'Book a free intro call', 'New client intake',
  ]);
  const booking = jobs.getByRole('region', { name: 'Book a free intro call' });
  await expect.element(booking.getByText('Free intro call, 20 minutes, in your opening hours')).toBeVisible();
  await expect.element(booking.getByText('Not covered by a rule you set, so I ask you.')).toBeVisible();
  await expect.element(booking.getByText('Ask me first', { exact: true })).toBeVisible();
  expect(booking.getByText('Anything else here: ask me.').elements()).toHaveLength(0);
  const intake = jobs.getByRole('region', { name: 'New client intake' });
  await expect.element(intake.getByText('Asks: Is this for you or for a business? Which tax years do you need help with? Do you already have a bookkeeper?')).toBeVisible();
  await expect.element(intake.getByText(INTAKE_RULE.reason)).toBeVisible();
  await expect.element(intake.getByText('Anyone', { exact: true })).toBeVisible();
  await expect.element(intake.getByText('Automatic', { exact: true })).toBeVisible();
  await expect.element(intake.getByText('Anything else here: ask me.')).toBeVisible();
  expect(jobs.getByRole('link').elements()).toHaveLength(0);
  expect(jobs.element().compareDocumentPosition(screen.getByRole('list', { name: 'Connectors' }).element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
  await page.screenshot({ path: `../../.vitest/attachments/task-3/rules-${width}.png` });
});

it.each([1440, 1512, 390])('at %i px, All rules starts with the same jobs, rules and default ask before its connectors', async (width) => {
  seedJobs();
  const { screen } = await renderRoute(`${DESK}/rules/all`, { connectorPages: true, viewport: { width, height: width === 390 ? 844 : 900 } });
  const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
  await expect.element(jobs).toBeVisible();
  expect([...jobs.element().querySelectorAll('.cd-tool-rules__tool-name')].map((el) => el.textContent)).toEqual([
    'Book a free intro call', 'New client intake',
  ]);
  await expect.element(jobs.getByText('Free intro call, 20 minutes, in your opening hours')).toBeVisible();
  await expect.element(jobs.getByText('Asks: Is this for you or for a business? Which tax years do you need help with? Do you already have a bookkeeper?')).toBeVisible();
  await expect.element(jobs.getByText(INTAKE_RULE.reason)).toBeVisible();
  await expect.element(jobs.getByText('Automatic', { exact: true })).toBeVisible();
  await expect.element(jobs.getByText('Not covered by a rule you set, so I ask you.')).toBeVisible();
  await expect.element(jobs.getByText('Ask me first', { exact: true })).toBeVisible();
  expect(jobs.getByText('Anything else here: ask me.').elements()).toHaveLength(1);
  expect(jobs.getByRole('link').elements()).toHaveLength(0);
  const first = screen.getByRole('main').element().querySelector('.cd-house-rules > section');
  expect(first).toBe(jobs.element());
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
  await page.screenshot({ path: `../../.vitest/attachments/task-3/all-rules-${width}.png` });
});

it('draws no jobs section without an on or changed business tool on either page', async () => {
  for (const withOffJobs of [false, true]) {
    if (withOffJobs) {
      const desk = seedJobs();
      seedBusinessTools(desk, chenBusinessTools.map((row) => ({ ...row, status: 'disabled' })));
    } else {
      // Turner's own urgent job, turned off.
      const desk = mockStore.world.desk(RIVERA.deskId);
      if (!desk) throw new Error('The mock has the main Desk');
      desk.tools = desk.tools.map((row) => (row.source === 'business' ? { ...row, status: 'disabled', review_reason: null } : row));
    }
    for (const path of ['rules', 'rules/all']) {
      const { screen } = await renderRoute(`${DESK}/${path}`);
      await expect.element(screen.getByRole('region', { name: 'Quotes' })).toBeVisible();
      expect(screen.getByRole('region', { name: 'Your Desk’s jobs' }).elements()).toHaveLength(0);
    }
  }
});

it('renders business titles and questions as literal text with no links or injected elements', async () => {
  const desk = seedJobs();
  const intake = chenBusinessTools[1];
  if (!intake?.business) throw new Error('The fixture has an intake definition');
  const title = '<img src="x" onerror="alert(1)">';
  const question = '<a href="https://example.com">Which year?</a>';
  seedBusinessTools(desk, [{ ...intake, business: {
    ...intake.business, title, config: { block: 'intake', questions: [question] },
  } }]);
  for (const path of ['rules', 'rules/all']) {
    const { screen } = await renderRoute(`${DESK}/${path}`);
    const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
    await expect.element(jobs.getByText(title, { exact: true })).toBeVisible();
    await expect.element(jobs.getByText(`Asks: ${question}`, { exact: true })).toBeVisible();
    expect(jobs.element().querySelectorAll('img, a, script')).toHaveLength(0);
  }
});

it('keeps active jobs and their rules with safe fallback names and descriptions on both pages', async () => {
  const desk = seedJobs();
  const intro = chenBusinessTools[0];
  if (!intro?.business) throw new Error('The fixture has an intro call definition');
  seedBusinessTools(desk, [
    { ...intro, tool: 'desk.changed', review_reason: 'changed', business: { ...intro.business, title: 'Changed intro call' } },
    { ...intro, tool: 'desk.new' },
    { ...intro, tool: 'desk.off', status: 'disabled' },
    { ...intro, tool: 'desk.delisted', review_reason: 'delisted' },
    { ...intro, tool: 'desk.null', status: 'enabled', business: null },
    { ...intro, tool: 'desk.blank', status: 'enabled', business: { ...intro.business, title: ' ' } },
    { ...intro, tool: 'desk.missing', review_reason: 'changed', business: { ...intro.business, title: undefined } } as unknown as ToolRow,
    { ...intro, tool: 'desk.Invalid', status: 'enabled', business: null },
    { ...intro, tool: 'desk.unknown', status: 'enabled', business: { ...intro.business, title: 'Unknown configuration job', config: { block: 'unknown' } } } as unknown as ToolRow,
    { ...intro, tool: 'desk.malformed', review_reason: 'changed', business: { ...intro.business, title: 'Malformed configuration job', config: { block: 'intake', questions: ['Which year?', null] } } } as unknown as ToolRow,
    { ...intro, tool: 'desk.effects', status: 'enabled', effects: [null] } as unknown as ToolRow,
    { ...intro, tool: 'desk.future-effect', status: 'enabled', effects: ['future'] } as unknown as ToolRow,
  ]);
  mockStore.world.addActiveRules(desk, ['desk.null', 'desk.blank', 'desk.missing'].map((tool, index) => ({
    ...INTAKE_RULE, card_id: `untitled-${index}`, applies_to: tool,
    mode: index === 0 ? 'auto' : index === 1 ? 'never' : 'ask',
  })));
  for (const path of ['rules', 'rules/all']) {
    const { screen } = await renderRoute(`${DESK}/${path}`);
    const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
    await expect.element(jobs).toBeVisible();
    expect([...jobs.element().querySelectorAll('.cd-tool-rules__tool-name')].map((el) => el.textContent)).toEqual([
      'Book a free intro call', 'New client intake', 'Changed intro call',
      'A connected tool', 'A connected tool', 'A connected tool',
      'Unknown configuration job', 'Malformed configuration job',
    ]);
    const untitled = jobs.getByRole('region', { name: 'A connected tool', exact: true }).elements();
    expect(untitled.map((card) => card.querySelector('.cd-tool-rules__tool-description')?.textContent)).toEqual([
      undefined, 'Free intro call, 20 minutes, in your opening hours', 'Free intro call, 20 minutes, in your opening hours',
    ]);
    for (const [index, card] of untitled.entries()) {
      expect(card.querySelector('.cd-rule-row__reason')?.textContent).toBe(INTAKE_RULE.reason);
      expect(card.querySelectorAll('.cd-rule-row')).toHaveLength(1);
      expect(card.textContent).toContain(['Automatic', 'Never', 'Ask me first'][index]);
      expect(card.querySelectorAll('a')).toHaveLength(0);
    }
    expect(jobs.element().textContent).not.toMatch(/desk\./);
    expect(jobs.element().textContent).not.toContain(intro.description_confirmed);
    for (const name of ['Unknown configuration job', 'Malformed configuration job']) {
      const job = jobs.getByRole('region', { name });
      if (name === 'Malformed configuration job') {
        await expect.element(job.getByText(BUSINESS_OWNER_LINES.intake, { exact: true })).toBeVisible();
      } else {
        expect(job.element().querySelector('.cd-tool-rules__tool-description')).toBeNull();
      }
      expect([...job.element().querySelectorAll('p')].every((paragraph) => paragraph.textContent?.trim())).toBe(true);
      await expect.element(job.getByText('Not covered by a rule you set, so I ask you.')).toBeVisible();
      expect(job.getByRole('link').elements()).toHaveLength(0);
    }
    expect(screen.container.querySelector('.cd-app-error')).toBeNull();
  }
});

/** The tools a rule on every tool that changes something covers on the jobs' Desk, in the order Rules lists them. */
const CHANGE_TOOL_TITLES = ['Quote', 'Book a visit', 'Save a lead', 'Request a callback', 'New client intake', 'Approved by your accountant'];
const CHANGE_TOOLS = 'Quote, Book a visit, Save a lead, Request a callback, New client intake and Approved by your accountant';

it('shows a job title that reads like the app’s own words only as user text on Rules and All rules', async () => {
  // A business can name a job anything in setup, so its title is untrusted text, never the app's sentence.
  const title = 'Approved by your accountant';
  const desk = seedJobs();
  const intro = chenBusinessTools[0];
  if (!intro?.business) throw new Error('The fixture has an intro call definition');
  seedBusinessTools(desk, [{ ...intro, status: 'enabled', review_reason: null, business: { ...intro.business, title } }]);
  // A shared rule on every tool that changes something, which names the job among the tools it covers.
  mockStore.world.addActiveRules(desk, [{ ...INTAKE_RULE, card_id: 'changes-ask', applies_to: 'effect:change', mode: 'ask', reason: 'Changes ask you first.' }]);
  for (const path of ['rules', 'rules/all']) {
    const { screen } = await renderRoute(`${DESK}/${path}`);
    const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
    await expect.element(jobs.getByRole('region', { name: title })).toBeVisible();
    // On the job's card and in every shared rule's line, the title is its own user-text element.
    expectUserText(screen.container, title);
    const shared = [...screen.container.querySelectorAll('.cd-rule-row__shared')];
    expect(shared.length).toBeGreaterThan(0);
    // The line reads word for word as it did: the app's words, then the tools it covers, one period.
    for (const line of shared) {
      expect(line.textContent).toBe(`Shared rule. Applies to every tool that changes something: ${CHANGE_TOOLS}.`);
      expect([...line.querySelectorAll('[data-copy="user"]')].map((el) => el.textContent)).toEqual(CHANGE_TOOL_TITLES);
    }
    await expectScreenBasics(screen.container, { owner: true });
  }
});
