import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { DisclosureLine } from './DisclosureLine.tsx';

const BOARD = 'N-Disclosure-Run2';

const meta = {
  title: 'Status/DisclosureLine',
  component: DisclosureLine,
  args: { language: 'en', businessName: rivera.business.name },
  parameters: {
    layout: 'padded',
    canvas: 'none',
    canvasNote: `From the owner-signed canvas board ${BOARD}, which draws this line on the Agent Card page and the mock checkout; the line stays outside the reference boards, checked against that board by its own stories.`,
  },
} satisfies Meta<typeof DisclosureLine>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The one line, as a person reads it: its words, its language and its quiet look. */
async function expectDisclosure(root: HTMLElement, words: string, language: 'en' | 'es') {
  const line = root.querySelector<HTMLElement>('.cd-disclosure-line');
  if (!line) throw new Error('the disclosure line did not render');
  await expect(line).toHaveTextContent(words, { normalizeWhitespace: true });
  await expect(line.textContent).toBe(words);
  await expect(line).toHaveAttribute('lang', language);
  // Never hidden: shown, read out and not dismissable, with nothing to press.
  await expect(line).toBeVisible();
  await expect(line.closest('[aria-hidden="true"]')).toBeNull();
  await expect(line.querySelector('button, a')).toBeNull();
  // Meta type in the secondary ink, with no icon and no dot: a statement, not a status.
  expectComputed(line, { fontSize: '13px', lineHeight: '18px', fontWeight: '380', color: 'rgba(250, 249, 245, 0.64)' });
  expectComputed(line, { marginTop: '0px', marginBottom: '0px' });
  await expect(line.querySelector('svg, .cd-status-dot')).toBeNull();
  // The business's name is the owner's own words, set apart from the line's.
  await expect(line.querySelector('[data-copy="user"]')?.textContent).toBe(rivera.business.name);
}

export const WithBusiness: Story = {
  play: async ({ canvasElement }) => {
    // disclosure_line_en_es: with the business's name, in English.
    await expectDisclosure(canvasElement, 'Turner Plumbing answers with Claude, an AI.', 'en');
  },
};

export const Spanish: Story = {
  args: { language: 'es' },
  parameters: {
    canvasNote: `${BOARD}'s Spanish line with the business's name, as the Agent Card page shows it in Spanish.`,
  },
  play: async ({ canvasElement }) => {
    // disclosure_line_en_es: with the business's name, in Spanish.
    await expectDisclosure(canvasElement, 'Turner Plumbing responde con Claude, una IA.', 'es');
  },
};
