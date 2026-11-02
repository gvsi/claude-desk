import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { expectUserText } from '../../test/expectUserText.ts';
import { RuleSentence, type RuleSentenceProps } from './RuleSentence.tsx';

/** C1's rows for Turner Plumbing, as `ruleSentence` and `ruleMeta` word them. */
const ROWS: readonly RuleSentenceProps[] = [
  {
    parts: [{ text: 'Claude can send quotes from your price list, at ' }, { text: 'list price', key: true }],
    meta: { tools: { titles: ['Quote'] }, who: 'Anyone' },
    outcome: 'auto',
  },
  {
    parts: [{ text: 'Claude can book visits on ' }, { text: 'weekdays, 8:00 am to 6:00 pm', key: true }],
    meta: { tools: { titles: ['Find open times', 'Book a visit'] }, who: 'Anyone' },
    outcome: 'auto',
  },
  {
    parts: [{ text: "Claude can share customers' own documents and charges" }],
    meta: { tools: { titles: ['Share a document', 'See charges'] }, who: "The record's owner, verified" },
    outcome: 'auto',
  },
  {
    parts: [{ text: 'Claude asks you before payment links over ' }, { text: '$300', key: true }, { text: ' or agent payments over ' }, { text: '$20', key: true }],
    meta: { tools: { titles: ['Payment link', 'Charge within a signed limit'] }, who: 'Anyone' },
    outcome: 'ask',
  },
  {
    parts: [{ text: "Claude never says it's anything but an AI" }],
    meta: { tools: 'Every tool', who: 'Everyone' },
    outcome: 'never',
  },
];

const CANVAS_NOTE =
  'The rule sentence from the REV-RULES-C boards, in review on the In review page (C1 at 1512, C3 at 390, C4 with the outcome at the right); no signed board draws it yet. The nearest signed board is N-Conn-02-Payments.';

const meta = {
  title: 'Rules/RuleSentence',
  component: RuleSentence,
  args: ROWS[0] as RuleSentenceProps,
  render: () => (
    <ul role="list" style={{ maxWidth: 738, margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-16)' }}>
      {ROWS.map((row, index) => (
        <li key={index}>
          <RuleSentence {...row} />
        </li>
      ))}
    </ul>
  ),
  parameters: { layout: 'padded', canvas: 'none', canvasNote: CANVAS_NOTE },
} satisfies Meta<typeof RuleSentence>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Each key value in the interface font's medium weight with tabular figures, in primary. */
function expectKeys(canvasElement: HTMLElement) {
  const keys = [...canvasElement.querySelectorAll<HTMLElement>('.cd-rule-sentence__key')];
  expect(keys.map((el) => el.textContent)).toEqual(['list price', 'weekdays, 8:00 am to 6:00 pm', '$300', '$20']);
  for (const el of keys) expectComputed(el, { fontWeight: '520', fontVariantNumeric: 'tabular-nums', color: 'rgba(250, 249, 245, 0.92)' });
}

export const Desktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(1440);
    expectKeys(canvasElement);
    // The sentence in secondary, the rest of its words plainer than its values.
    const sentence = canvas.getByText(/^Claude can send quotes from your price list/);
    expectComputed(sentence, { color: 'rgba(250, 249, 245, 0.64)' });
    // The meta line: each tool its own user-text title, then " · " and who.
    const metaLine = canvas.getByText((_, el) => el?.classList.contains('cd-rule-sentence__meta') === true && el.textContent === 'Find open times and Book a visit · Anyone');
    expectUserText(metaLine, 'Find open times');
    expectUserText(metaLine, 'Book a visit');
    // A group of tools is the app's words, drawn as a title is but not marked as user text.
    const group = canvas.getByText('Every tool');
    await expect(group.closest('[data-copy="user"]')).toBeNull();
    // The outcome sits at the right of its sentence, on the same line.
    const allow = canvas.getAllByText('Allow')[0];
    if (allow === undefined) throw new Error('no outcome');
    await expect(allow.getBoundingClientRect().left).toBeGreaterThan(sentence.getBoundingClientRect().right);
    await expect(canvas.getByText('Ask me first')).toBeVisible();
    await expect(canvas.getByText('Never')).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(390);
    expectKeys(canvasElement);
    // Nothing is dropped: every sentence, its meta line and its outcome show.
    await expect(canvasElement.querySelectorAll('.cd-rule-sentence__meta')).toHaveLength(ROWS.length);
    await expect(canvasElement.querySelectorAll('.cd-rule-sentence__outcome')).toHaveLength(ROWS.length);
    // The outcome stacks under the meta line, lined up with the sentence.
    const metaLine = canvasElement.querySelector<HTMLElement>('.cd-rule-sentence__meta');
    const outcome = canvasElement.querySelector<HTMLElement>('.cd-rule-sentence__outcome');
    const sentence = canvasElement.querySelector<HTMLElement>('.cd-rule-sentence__sentence');
    if (!metaLine || !outcome || !sentence) throw new Error('no row');
    await expect(outcome.getBoundingClientRect().top).toBeGreaterThanOrEqual(metaLine.getBoundingClientRect().bottom);
    await expect(Math.round(outcome.getBoundingClientRect().left)).toBe(Math.round(sentence.getBoundingClientRect().left));
    // Nothing scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await expect(canvas.getByText('Every tool')).toBeVisible();
  },
};

const CHANGE: readonly RuleSentenceProps[] = [
  {
    parts: [{ text: 'Claude can send quotes from your price list, at ' }, { text: 'list price', key: true }],
    meta: { tools: { titles: ['Quote'] }, who: 'Anyone' },
    outcome: 'auto',
    changed: 'before',
  },
  {
    parts: [{ text: 'Claude can send quotes from your price list, at ' }, { text: 'list price', key: true }, { text: ' on ' }, { text: 'weekdays, all day', key: true }],
    meta: { tools: { titles: ['Quote'] }, who: 'Anyone' },
    outcome: 'auto',
    changed: 'after',
  },
];

/** The two sides of a changed rule, as B3 draws them: a refused-tone line by the rule as it was, a handled one by the rule as it will be. */
export const Changed: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  render: () => (
    <div style={{ maxWidth: 738, display: 'flex', flexDirection: 'column', gap: 'var(--space-12)' }}>
      {CHANGE.map((row, index) => (
        <RuleSentence key={index} {...row} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const before = canvasElement.querySelector<HTMLElement>('.cd-rule-sentence--before');
    const after = canvasElement.querySelector<HTMLElement>('.cd-rule-sentence--after');
    if (!before || !after) throw new Error('no sides');
    expectComputed(before, { borderLeftWidth: '2px', borderLeftStyle: 'solid', borderLeftColor: 'rgb(220, 130, 144)' });
    expectComputed(after, { borderLeftWidth: '2px', borderLeftStyle: 'solid', borderLeftColor: 'rgb(111, 168, 89)' });
  },
};

/** The same change on a phone: both lines, both outcomes under their sentences, and nothing wider than the window. */
export const ChangedPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: Changed.render,
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const before = canvasElement.querySelector<HTMLElement>('.cd-rule-sentence--before');
    const after = canvasElement.querySelector<HTMLElement>('.cd-rule-sentence--after');
    if (!before || !after) throw new Error('no sides');
    expectComputed(before, { borderLeftWidth: '2px', borderLeftStyle: 'solid', borderLeftColor: 'rgb(220, 130, 144)' });
    expectComputed(after, { borderLeftWidth: '2px', borderLeftStyle: 'solid', borderLeftColor: 'rgb(111, 168, 89)' });
    // Each side's outcome shows, stacked under its own meta line.
    const outcomes = canvas.getAllByText('Allow');
    await expect(outcomes).toHaveLength(2);
    for (const side of [before, after]) {
      const metaLine = side.querySelector<HTMLElement>('.cd-rule-sentence__meta');
      const outcome = side.querySelector<HTMLElement>('.cd-rule-sentence__outcome');
      if (!metaLine || !outcome) throw new Error('no meta line or outcome');
      await expect(outcome).toBeVisible();
      await expect(outcome.getBoundingClientRect().top).toBeGreaterThanOrEqual(metaLine.getBoundingClientRect().bottom);
    }
    // Nothing overflows the window, and nothing scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
