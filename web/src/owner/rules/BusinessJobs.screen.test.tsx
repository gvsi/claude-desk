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

it.each([1440, 1512, 390])('at %i px, Rules lists job rules as sentences and leaves uncovered jobs to the default ask', async (width) => {
  seedJobs();
  const { screen } = await renderRoute(`${DESK}/rules`, { connectorPages: true, viewport: { width, height: width === 390 ? 844 : 900 } });
  const allow = screen.getByRole('region', { name: 'Allow', exact: true });
  await expect.element(allow).toBeVisible();
  expect([...allow.element().querySelectorAll('.cd-rule-sentence__meta')].map((el) => el.textContent)).toEqual(['New client intake · Anyone']);
  await expect.element(allow.getByText('Claude can use new client intake', { exact: true })).toBeVisible();
  expect(screen.getByText('Book a free intro call', { exact: true }).elements()).toHaveLength(0);
  const fallback = screen.getByText('Anything not listed here, Claude asks you first.', { exact: true });
  await expect.element(fallback).toBeVisible();
  expect(allow.element().compareDocumentPosition(fallback.element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.container.querySelector('.cd-rules__groups a, .cd-rules__groups button')).toBeNull();
  expect(screen.getByRole('region', { name: 'Your Desk’s jobs' }).elements()).toHaveLength(0);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
  await page.screenshot({ path: `../../.vitest/attachments/task-3/rules-${width}.png` });
});

it.each([1440, 1512, 390])('at %i px, Your tools lists jobs with sentence rules before its connectors', async (width) => {
  seedJobs();
  const { screen } = await renderRoute(`${DESK}/rules/all`, { connectorPages: true, viewport: { width, height: width === 390 ? 844 : 900 } });
  const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
  await expect.element(jobs).toBeVisible();
  expect([...jobs.element().querySelectorAll('.cd-house-rules__tool-name')].map((el) => el.textContent)).toEqual([
    'Book a free intro call', 'New client intake',
  ]);
  await expect.element(jobs.getByText('Free intro call, 20 minutes, in your opening hours')).toBeVisible();
  await expect.element(jobs.getByText('Asks: Is this for you or for a business? Which tax years do you need help with? Do you already have a bookkeeper?')).toBeVisible();
  await expect.element(jobs.getByText('Claude can use new client intake', { exact: true })).toBeVisible();
  await expect.element(jobs.getByText('Claude asks you before using book a free intro call', { exact: true })).toBeVisible();
  expect(jobs.getByRole('region', { name: 'New client intake' }).element().querySelector('.cd-status-dot--handled')).not.toBeNull();
  expect(jobs.getByRole('region', { name: 'Book a free intro call' }).element().querySelector('.cd-status-dot--held')).not.toBeNull();
  expect(jobs.getByText('Anything else here: ask me.').elements()).toHaveLength(0);
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
      await expect.element(screen.getByRole('region', { name: path === 'rules' ? 'Allow' : 'Quotes', exact: true })).toBeVisible();
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
    if (path === 'rules') {
      const allow = screen.getByRole('region', { name: 'Allow', exact: true });
      await expect.element(allow.getByText(title, { exact: true }).first()).toBeVisible();
      expectUserText(allow.element(), title);
      expect(allow.element().querySelectorAll('img, a, script')).toHaveLength(0);
      expect(screen.getByText(`Asks: ${question}`, { exact: true }).elements()).toHaveLength(0);
      continue;
    }
    const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
    const titleSelector = '.cd-house-rules__tool-name';
    await expect.element(jobs).toBeVisible();
    expect([...jobs.element().querySelectorAll(titleSelector)].some((name) => name.textContent === title)).toBe(true);
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
    if (path === 'rules') {
      await expect.element(screen.getByRole('region', { name: 'Allow', exact: true })).toBeVisible();
      const rows = [...screen.container.querySelectorAll<HTMLElement>('.cd-rules__row[data-rule-cards]')];
      // Each untitled job is on the Desk, so its rule keeps its outcome sentence in the app's words.
      for (const [index, mode] of ['Allow', 'Never', 'Ask me first'].entries()) {
        const row = rows.find((candidate) => candidate.dataset.ruleCards === `untitled-${index}`);
        expect(row).toBeDefined();
        expect(row?.querySelector('.cd-rule-sentence__sentence')?.textContent).toBe(
          ['Claude can use a connected tool', 'Claude never uses a connected tool', 'Claude asks you before using a connected tool'][index],
        );
        expect(row?.querySelector('.cd-rule-sentence__meta')?.textContent).toBe(`A connected tool · Anyone${index === 2 ? ' · Needs your review' : ''}`);
        expect(row?.closest('section')?.querySelector('h2')?.textContent).toBe(mode);
        expect(row?.querySelectorAll('a')).toHaveLength(0);
      }
      expect(screen.container.querySelector('.cd-rules__groups')?.textContent).not.toMatch(/desk\./);
      expect(screen.container.querySelector('.cd-rules__groups')?.textContent).not.toContain(intro.description_confirmed);
      for (const name of ['Unknown configuration job', 'Malformed configuration job']) {
        expect(screen.getByText(name, { exact: true }).elements()).toHaveLength(0);
      }
      await expect.element(screen.getByText('Anything not listed here, Claude asks you first.', { exact: true })).toBeVisible();
      expect(screen.container.querySelector('.cd-app-error')).toBeNull();
      continue;
    }
    const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
    await expect.element(jobs).toBeVisible();
    const prefix = '.cd-house-rules';
    expect([...jobs.element().querySelectorAll(`${prefix}__tool-name`)].map((el) => el.textContent)).toEqual([
      'Book a free intro call', 'New client intake', 'Changed intro call',
      'A connected tool', 'A connected tool', 'A connected tool',
      'Unknown configuration job', 'Malformed configuration job',
    ]);
    const untitled = jobs.getByRole('region', { name: 'A connected tool', exact: true }).elements();
    expect(untitled.map((card) => card.querySelector(`${prefix}__tool-description`)?.textContent)).toEqual([
      undefined, 'Free intro call, 20 minutes, in your opening hours', 'Free intro call, 20 minutes, in your opening hours',
    ]);
    for (const [index, card] of untitled.entries()) {
      expect(card.querySelectorAll('.cd-house-rules__rule')).toHaveLength(1);
      expect(card.textContent).toContain(['Claude can use a connected tool', 'Claude never uses a connected tool', 'Claude asks you before using a connected tool'][index]);
      expect(card.querySelectorAll('a')).toHaveLength(0);
    }
    expect(jobs.element().textContent).not.toMatch(/desk\./);
    expect(jobs.element().textContent).not.toContain(intro.description_confirmed);
    for (const name of ['Unknown configuration job', 'Malformed configuration job']) {
      const job = jobs.getByRole('region', { name });
      if (name === 'Malformed configuration job') {
        await expect.element(job.getByText(BUSINESS_OWNER_LINES.intake, { exact: true })).toBeVisible();
      } else {
        expect(job.element().querySelector(`${prefix}__tool-description`)).toBeNull();
      }
      expect([...job.element().querySelectorAll('p')].every((paragraph) => paragraph.textContent?.trim())).toBe(true);
      expect(job.element().querySelector('.cd-status-dot--held')).not.toBeNull();
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
    if (path === 'rules/all') {
      const jobs = screen.getByRole('region', { name: 'Your Desk’s jobs' });
      await expect.element(jobs.getByRole('region', { name: title })).toBeVisible();
    } else {
      await expect.element(screen.getByRole('region', { name: 'Ask me first', exact: true }).getByText(title, { exact: true })).toBeVisible();
    }
    // On the job's card and in every shared rule's line, the title is its own user-text element.
    expectUserText(screen.container, title);
    if (path === 'rules/all') {
      const shared = [...screen.container.querySelectorAll('[data-rule-id="changes-ask"] .cd-house-rules__shared')];
      expect(shared).toHaveLength(1);
      expect(shared[0]?.textContent).toBe('Shared rule. Also applies to:Quote, Book a visit, Save a lead and Request a callback');
      expect(shared[0]?.querySelector('br + [data-copy="user"]')).not.toBeNull();
      expect(screen.container.querySelectorAll('.cd-house-rules__rule--reference[data-rule-id="changes-ask"]')).toHaveLength(4);
    } else {
      const shared = screen.container.querySelector('[data-rule-cards="changes-ask"] .cd-rule-sentence__meta');
      expect(shared).not.toBeNull();
      expect(shared?.textContent).toBe(`${CHANGE_TOOLS} · Anyone`);
      expect([...shared!.querySelectorAll('[data-copy="user"]')].map((el) => el.textContent)).toEqual(CHANGE_TOOL_TITLES);
    }
    await expectScreenBasics(screen.container, { owner: true });
  }
});
