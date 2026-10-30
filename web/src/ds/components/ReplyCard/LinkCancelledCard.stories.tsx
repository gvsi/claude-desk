import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { LinkCancelledCard } from './LinkCancelledCard.tsx';

/** The kernel's line for a link a rule change cancelled, in each language, for Maria Rivera's Desk. */
const LINE = {
  en: "This payment link was cancelled because Maria Rivera's rules changed. Ask again if you still want to pay.",
  es: 'Este enlace de pago se canceló porque cambiaron las reglas de Maria Rivera. Pídelo de nuevo si todavía quieres pagar.',
} as const;

const meta = {
  title: 'Reply cards/LinkCancelledCard',
  component: LinkCancelledCard,
  args: { line: LINE.en, language: 'en' },
  render: (args) => (
    <div style={{ maxWidth: 680 }}>
      <LinkCancelledCard {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-R2-Chat-Link-Cancelled' },
} satisfies Meta<typeof LinkCancelledCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const English: Story = {
  parameters: {
    canvasNote:
      'The card in the chat for a payment link a rule change cancelled: its label, the payment link’s icon and the kernel’s one line. The board draws an earlier shape, with an amount, a reason and the test-payment note.',
  },
  play: async ({ canvas, canvasElement }) => {
    // link_cancelled_card_shows_the_kernels_line: named by its fixed label, then the line as written.
    const card = canvas.getByRole('article', { name: 'Payment link cancelled' });
    const line = canvas.getByText(LINE.en);
    expectComputed(line, { fontSize: '15px', lineHeight: '20px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(card.textContent).toBe(`Payment link cancelled${LINE.en}`);
    // The payment link's icon beside the label, 16 px and hidden from screen readers.
    const icon = canvasElement.querySelector<SVGSVGElement>('.cd-reply-card__label svg')!;
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon.getBoundingClientRect().width).toBe(16);
    await expect([...icon.querySelectorAll('rect, path')].map((shape) => shape.tagName)).toEqual(['rect', 'path']);
    // A cancelled link moves no money, so no test-payment note; and it has no link or button.
    await expect(card).not.toHaveTextContent('Test payment');
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
    // A reply card: at most 520 px, padded 16 px.
    await expect(canvasElement.querySelector<HTMLElement>('.cd-reply-card')!.getBoundingClientRect().width).toBe(520);
    expectComputed(card, { paddingTop: '16px', paddingLeft: '16px' });
  },
};

export const Spanish: Story = {
  args: { line: LINE.es, language: 'es' },
  parameters: { canvas: 'none', canvasNote: 'N-R2-Chat-Link-Cancelled in Spanish: the label in Spanish, the kernel’s line as it arrives.' },
  play: async ({ canvas, canvasElement }) => {
    const card = canvas.getByRole('article', { name: 'Enlace de pago cancelado' });
    await expect(card).toHaveTextContent(LINE.es);
    await expect(canvasElement.querySelector('[lang="es"]')).not.toBeNull();
  },
};
