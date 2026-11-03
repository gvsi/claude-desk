import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { FONT_TIMEOUT, withinDeadline } from '../../test/fonts.ts';
import { CodeBlock } from './CodeBlock.tsx';

/** The example request on the agents page, as the board writes it: the A2A contract's endpoint, headers and body. */
const REQUEST = [
  'POST /api/a2a/rivera',
  'X-Agent-Key-Id: demo-7f3a2c',
  'X-Agent-Ts: 2026-10-30T09:12:04Z',
  'X-Agent-Nonce: 7c2e91d4',
  'X-Agent-Sig: <Ed25519 signature, lowercase hex>',
  '',
  '{"desk_slug": "rivera", "message": "Earliest visit for a leaking water heater"}',
].join('\n');

const meta = {
  title: 'Agents/CodeBlock',
  component: CodeBlock,
  args: { code: REQUEST },
  render: (args) => (
    <div style={{ maxWidth: 726 }}>
      <CodeBlock {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Agents-01-Page' },
} satisfies Meta<typeof CodeBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The block is 12 px, then whole 20 px lines, then 12 px: at least `lines` of them, more where a
 * long line wraps. Nothing in it scrolls sideways.
 */
async function expectWholeLines(block: HTMLElement, lines: number): Promise<void> {
  const height = block.getBoundingClientRect().height;
  const drawn = (height - 24) / 20;
  await expect(Number.isInteger(drawn), `${height} px is 24 px and whole 20 px lines`).toBe(true);
  await expect(drawn).toBeGreaterThanOrEqual(lines);
  await expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
}

export const ExampleRequest: Story = {
  parameters: { canvasNote: 'The example request under “Connect your own agent”, at the card’s inner width, 726 px.' },
  play: async ({ canvasElement }) => {
    // The mono font may arrive after the first layout, and a wider fallback wraps the longest line.
    await withinDeadline(document.fonts.load('13px "JetBrains Mono"'), FONT_TIMEOUT, 'Code block JetBrains Mono');
    // code_reads_as_written: every line exactly as given, in mono, marked as machine text.
    const block = canvasElement.querySelector('pre')!;
    await expect(block).not.toBeNull();
    await expect(block.textContent).toBe(REQUEST);
    await expect(block).toHaveAttribute('data-copy', 'code');
    // A page translator leaves it alone, as it does the full trace.
    await expect(block).toHaveAttribute('translate', 'no');
    expectComputed(block, {
      fontFamily: /^"JetBrains Mono"/,
      fontSize: '13px',
      lineHeight: '20px',
      color: 'rgba(250, 249, 245, 0.92)',
      backgroundColor: 'rgba(250, 249, 245, 0.1)',
      borderTopLeftRadius: '8px',
      paddingTop: '12px',
      paddingLeft: '14px',
    });
    // code_wraps_inside_its_box: whole 20 px lines between 12 px above and below, at least one per
    // line of code (144 px for six, as on the board), and nothing scrolls sideways. A wider font
    // may wrap the longest line, so the count isn't fixed.
    await expectWholeLines(block, REQUEST.split('\n').length);
  },
};

export const Phone: Story = {
  render: (args) => (
    <div style={{ maxWidth: 324 }}>
      <CodeBlock {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'N-R2-Agents-06-Phone',
    canvasNote:
      'The example request alone, at the phone card’s inner width, 324 px, as the board draws it under “Connect your own agent”: long lines wrap inside the block, and nothing scrolls sideways. The card, its signing lines and the rest of the board’s 390 × 2000 page aren’t drawn, and the story runs at the 390 × 844 phone window.',
  },
  play: async ({ canvasElement }) => {
    await withinDeadline(document.fonts.load('13px "JetBrains Mono"'), FONT_TIMEOUT, 'Code block JetBrains Mono');
    const block = canvasElement.querySelector('pre')!;
    await expectWholeLines(block, REQUEST.split('\n').length);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    // Wrapped, the same text: nothing is cut or rewritten.
    await expect(block.textContent).toBe(REQUEST);
  },
};
