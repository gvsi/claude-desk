import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { VisitorMessage } from './VisitorMessage.tsx';

const [firstTurn] = rivera.conversations.danaLive.turns;
const danaText = firstTurn?.kind === 'visitor' ? firstTurn.text : '';

const meta = {
  title: 'Conversation/VisitorMessage',
  component: VisitorMessage,
  args: { text: danaText },
  parameters: { layout: 'padded', canvas: 'N-Conv-Run1' },
} satisfies Meta<typeof VisitorMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A 390 px phone's line: the screen less two 16 px gutters. */
const PHONE_LINE = 358;

export const Default: Story = {
  parameters: { canvasNote: "The board's first message is about a water heater; the Turner fixture's Dana writes about her kitchen sink." },
  play: async ({ canvas, canvasElement }) => {
    const bubble = canvas.getByText(danaText);
    // A faint bubble in the message type, on the right, never wider than 85% of its column.
    expectComputed(bubble, {
      fontFamily: /Hanken Grotesk/,
      fontSize: '15px',
      lineHeight: '21px',
      backgroundColor: 'rgba(250, 249, 245, 0.06)',
      borderTopLeftRadius: '12px',
      paddingTop: '8px',
      paddingLeft: '14px',
    });
    const column = canvasElement.querySelector('.cd-visitor-message') as HTMLElement;
    const box = bubble.getBoundingClientRect();
    await expect(Math.abs(box.right - column.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
    await expect(box.width).toBeLessThanOrEqual(column.getBoundingClientRect().width * 0.85 + 0.5);
    // The visitor's own words: exempt from the voice rules, never from the design rules.
    await expect(bubble).toHaveAttribute('data-copy', 'user');
    await expect(canvas.queryByText(/Translated by Claude/)).toBeNull();
  },
};

const luciaText = '¿Puedo hablar con Mike? También gotea la llave de paso.';

export const WithTranslation: Story = {
  args: { text: luciaText, translation: 'Can I talk to Mike? The shutoff valve is dripping too.' },
  parameters: {
    canvas: 'N-Conv-TakeOver',
    canvasNote: 'The board reads the label to screen readers only; here "Translated by Claude" is shown to everyone, as the owner reads it.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText(luciaText)).toBeVisible();
    const line = canvasElement.querySelector('.cd-visitor-message__translation') as HTMLElement;
    await expect(line).toHaveTextContent(/^Translated by Claude: Can I talk to Mike\? The shutoff valve is dripping too\.$/);
    // The translate icon is decorative; the words say what the line is.
    await expect(line.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expectComputed(line, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    // The translation carries the visitor's words, so it is user text; the label is not.
    await expect(canvas.getByText('Can I talk to Mike? The shutoff valve is dripping too.')).toHaveAttribute('data-copy', 'user');
  },
};

// No spaces or hyphens in the long words, so the only way to fit is to break inside them.
const longText =
  'Mi número de pedido es RV2026_1103_destape_desagüe_cocina_y_junta_del_calentador_de_agua_de_la_casa_de_Lucía_Herrera, ¿lo tienen?';

export const LongUnbroken: Story = {
  args: { text: longText, translation: 'My order number is RV2026_1103_drain_clearing_kitchen_and_water_heater_gasket_for_Lucía_Herrera, do you have it?' },
  render: (args) => (
    <div data-testid="phone-line" style={{ width: PHONE_LINE, maxWidth: '100%' }}>
      <VisitorMessage {...args} />
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows a word longer than a phone's line; it wraps inside the bubble, as N-Conv-Run1's bubbles would.",
  },
  play: async ({ canvas, canvasElement }) => {
    // long_bubble_wraps: nothing reaches past the line or out of the bubble.
    const line = canvas.getByTestId('phone-line');
    await expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    const lineRight = line.getBoundingClientRect().right;
    for (const part of canvasElement.querySelectorAll('.cd-visitor-message *')) {
      await expect(part.scrollWidth).toBeLessThanOrEqual(part.clientWidth + 0.5);
      await expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(lineRight + 0.5);
    }
    // The unbroken word takes more than one 21 px line.
    await expect(canvas.getByText(longText).getBoundingClientRect().height).toBeGreaterThan(21 + 16);
  },
};
