import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { Card } from '../Card/Card.tsx';
import { SignedLimitPanel, type SignedLimitPanelProps } from './SignedLimitPanel.tsx';

/** The built-in agent's signed mandate, as `POST /agents/demo` returns it: $20 a charge, $100 in all, for one hour. */
const mandate = rivera.demoAgentIssued.mandate;

/**
 * The agents page's static words for the built-in agent's limit, as the page passes them: the
 * amounts are checked against the seed's mandate (`signed_limit_matches_the_seed`), never Claude's.
 */
const LIMIT = {
  en: { perCharge: '$20', total: '$100', duration: 'One hour', source: 'Signed limit from Alex Kim’s demo wallet' },
  es: { perCharge: '$20', total: '$100', duration: 'Una hora', source: 'Límite firmado por la billetera de demostración de Alex Kim' },
} as const;

/** The whole cents a written amount like "$20" or "$40.50" stands for, to check it against the mandate. */
function centsOf(amount: string): number {
  const match = /^\$(\d+)(?:\.(\d{2}))?$/.exec(amount);
  if (match === null) throw new Error(`not a dollar amount: ${amount}`);
  return Number(match[1]) * 100 + Number(match[2] ?? 0);
}

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

const meta = {
  title: 'Agents/SignedLimitPanel',
  component: SignedLimitPanel,
  args: { ...LIMIT.en, language: 'en' },
  // In the "Send an agent" card at the agents page's 760 px, as the board nests it.
  render: (args) => (
    <div style={{ maxWidth: 760 }}>
      <Card as="section" label="Send an agent" padding={16}>
        <SignedLimitPanel {...args} />
      </Card>
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Agents-03-Send' },
} satisfies Meta<typeof SignedLimitPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Each term as a screen reader pairs it: its name, then its value. */
function terms(panel: HTMLElement): string[][] {
  return [...panel.querySelectorAll('dl > div')].map((term) => [term.querySelector('dt')?.textContent ?? '', term.querySelector('dd')?.textContent ?? '']);
}

export const SendAnAgent: Story = {
  name: 'Send an agent',
  parameters: { canvasNote: 'The panel in the “Send an agent” card, as N-R2-Agents-03 and -05 draw it: the mandate’s amounts and how long it lasts, and who signed it at the right.' },
  play: async ({ canvas }) => {
    // signed_limit_matches_the_seed: the page's words for the amounts are the mandate's own cents.
    for (const words of [LIMIT.en, LIMIT.es]) {
      await expect([centsOf(words.perCharge), centsOf(words.total)]).toEqual([mandate.per_charge_cents, mandate.total_cents]);
    }
    // signed_limit_shows_the_pages_words: each term as given, and nothing else.
    const panel = canvas.getByRole('region', { name: 'Signed limit' });
    await expect(panel).toHaveAttribute('lang', 'en');
    await expect(terms(panel)).toEqual([
      ['Per charge', '$20'],
      ['In total', '$100'],
      ['For', 'One hour'],
    ]);
    const source = within(panel).getByText(LIMIT.en.source);

    // The board's inset: the card look, padded 12 px 16 px, 63 px tall, the terms 16 px apart, each
    // name in secondary caption type over its value in body type at 520.
    expectComputed(panel, {
      backgroundColor: 'rgba(250, 249, 245, 0.03)',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.14)',
      borderTopLeftRadius: '12px',
      paddingTop: '12px',
      paddingRight: '16px',
      paddingBottom: '12px',
      paddingLeft: '16px',
    });
    await expect(Math.round(panel.getBoundingClientRect().height)).toBe(63);
    const parts = [...panel.querySelectorAll<HTMLElement>('dl > div')];
    for (const part of parts) {
      expectComputed(part.querySelector('dt') as HTMLElement, { fontSize: '13px', lineHeight: '18px', color: SECONDARY, marginLeft: '0px' });
      expectComputed(part.querySelector('dd') as HTMLElement, { fontSize: '16px', lineHeight: '22px', fontWeight: '520', color: PRIMARY, marginLeft: '0px' });
    }
    for (const [index, part] of parts.slice(1).entries()) {
      await expect(Math.round(part.getBoundingClientRect().left - (parts[index] as HTMLElement).getBoundingClientRect().right)).toBe(16);
    }
    // Who signed it, in secondary caption type at the right, centered on the panel.
    expectComputed(source, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
    const panelBox = panel.getBoundingClientRect();
    const sourceBox = source.getBoundingClientRect();
    await expect(Math.round(panelBox.right - sourceBox.right)).toBe(17);
    await expect(Math.round(sourceBox.top + sourceBox.height / 2)).toBe(Math.round(panelBox.top + panelBox.height / 2));
  },
};

export const Spanish: Story = {
  args: { ...LIMIT.es, language: 'es' },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-03’s panel on the agents page in Spanish: the design system’s labels and name in Spanish, the page’s words as given.' },
  play: async ({ canvas }) => {
    // signed_limit_speaks_the_pages_language: the region's name, the labels and `lang` follow `language`.
    const panel = canvas.getByRole('region', { name: 'Límite firmado' });
    await expect(panel).toHaveAttribute('lang', 'es');
    await expect(terms(panel)).toEqual([
      ['Por cargo', '$20'],
      ['En total', '$100'],
      ['Durante', 'Una hora'],
    ]);
    await expect(within(panel).getByText(LIMIT.es.source)).toBeVisible();
  },
};

export const Used: Story = {
  args: { used: '$20' },
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote: 'The panel as the agent’s conversation draws it for the owner, with what the agent has used so far after In total; here it sits in a card at the agents page’s width.',
  },
  play: async ({ canvas }) => {
    // signed_limit_shows_used: the screen's words for what the agent has used, a term like the others,
    // after In total and before how long the limit lasts.
    const panel = canvas.getByRole('region', { name: 'Signed limit' });
    await expect(terms(panel)).toEqual([
      ['Per charge', '$20'],
      ['In total', '$100'],
      ['Used', '$20'],
      ['For', 'One hour'],
    ]);
    const used = [...panel.querySelectorAll<HTMLElement>('dl > div')][2] as HTMLElement;
    expectComputed(used.querySelector('dt') as HTMLElement, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
    expectComputed(used.querySelector('dd') as HTMLElement, { fontSize: '16px', lineHeight: '22px', fontWeight: '520', color: PRIMARY });
    await expect(Math.round(panel.getBoundingClientRect().height)).toBe(63);
    await expect(within(panel).getByText(LIMIT.en.source)).toBeVisible();
  },
};

export const UsedInSpanish: Story = {
  args: { ...LIMIT.es, used: '$20', language: 'es' },
  parameters: { canvas: 'none', canvasNote: 'N-Conv-Agent-Run1’s panel with what was used, in Spanish: the design system’s label in Spanish, the screen’s words as given.' },
  play: async ({ canvas }) => {
    const panel = canvas.getByRole('region', { name: 'Límite firmado' });
    await expect(terms(panel)).toEqual([
      ['Por cargo', '$20'],
      ['En total', '$100'],
      ['Usado', '$20'],
      ['Durante', 'Una hora'],
    ]);
  },
};

/** Each field left blank or only spaces, one panel per case: none of them draws, `used` included when it is given. */
const BLANKS: { field: keyof typeof LIMIT.en | 'used'; value: string }[] = (['perCharge', 'total', 'duration', 'source', 'used'] as const).flatMap((field) => [
  { field, value: '' },
  { field, value: '   ' },
]);

export const BlankFields: Story = {
  name: 'Blank fields',
  render: (args) => (
    <div style={{ maxWidth: 760 }}>
      {BLANKS.map(({ field, value }) => {
        const props: SignedLimitPanelProps = { ...args, [field]: value };
        return (
          <div key={`${field}-${value.length}`} data-case={`${field}-${value.length}`}>
            <SignedLimitPanel {...props} />
          </div>
        );
      })}
    </div>
  ),
  parameters: { canvas: 'none', canvasNote: 'A guard for N-R2-Agents-03’s panel: a blank or whitespace field, any of the four or a given `used`, draws no panel at all.' },
  play: async ({ canvasElement }) => {
    // signed_limit_fails_closed: a limit it can't show whole isn't shown.
    const cases = [...canvasElement.querySelectorAll<HTMLElement>('[data-case]')];
    await expect(cases.map((item) => item.dataset.case)).toEqual(BLANKS.map(({ field, value }) => `${field}-${value.length}`));
    for (const item of cases) await expect(item, item.dataset.case).toBeEmptyDOMElement();
  },
};

export const Phone: Story = {
  render: (args) => (
    <div style={{ maxWidth: 358 }}>
      <Card as="section" label="Send an agent" padding={16}>
        <SignedLimitPanel {...args} />
      </Card>
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Agents-06-Phone draws no panel; N-R2-Agents-03’s panel in a phone’s card: who signed it takes its own line under the terms.' },
  play: async ({ canvas }) => {
    const panel = canvas.getByRole('region', { name: 'Signed limit' });
    const source = within(panel).getByText(LIMIT.en.source);
    const first = panel.querySelector('dl > div') as HTMLElement;
    await expect(Math.round(source.getBoundingClientRect().left)).toBe(Math.round(first.getBoundingClientRect().left));
    await expect(source.getBoundingClientRect().top).toBeGreaterThanOrEqual(first.getBoundingClientRect().bottom);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
