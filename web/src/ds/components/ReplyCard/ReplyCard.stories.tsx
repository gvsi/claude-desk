import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import type { CardBlock } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectDrawsShortArmFirst } from '../../test/expectDrawsShortArmFirst.ts';
import { VISION_INERT_LINE } from '../VisionBar/visionInert.tsx';
import { ReplyCard } from './ReplyCard.tsx';

const { blocks } = rivera;

const meta = {
  title: 'Reply cards/ReplyCard',
  component: ReplyCard,
  args: { block: blocks.quote.en, language: 'en', ownerName: rivera.business.ownerName },
  parameters: { layout: 'padded', canvas: 'N-Public-Rivera-Run1' },
} satisfies Meta<typeof ReplyCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A 390 px phone's line: the screen less two 16 px gutters. */
const PHONE_LINE = 358;

const TEST_PAYMENT = { en: 'Test payment, no money moves', es: 'Pago de prueba, no se mueve dinero' } as const;

/** The sage of a handled outcome (`status-handled`). */
const SAGE = 'rgb(111, 168, 89)';

/** The card's one link: exactly one, with its name and path, and the path never shown as text. */
async function expectOneLink(root: HTMLElement, name: string, href: string) {
  const links = root.querySelectorAll('a');
  await expect(links).toHaveLength(1);
  const [link] = links;
  await expect(link).toHaveAccessibleName(name);
  await expect(link).toHaveAttribute('href', href);
  await expect(root.textContent).not.toContain(href);
}

export const Quote: Story = {
  parameters: {
    canvasNote: 'The board states the price in prose; a reply check blocks prices in prose, so the price arrives as this card.',
  },
  play: async ({ canvas, canvasElement }) => {
    const card = canvas.getByRole('article', { name: 'Quote' });
    // At most 520 px wide, even with room to spare.
    await expect(card.getBoundingClientRect().width).toBeLessThanOrEqual(520);
    await expect(canvasElement.getBoundingClientRect().width).toBeGreaterThan(520);
    // The label is a secondary caption; the headline is the section style; details are secondary meta.
    expectComputed(canvas.getByText('Quote'), { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    expectComputed(canvas.getByText('$180.00'), { fontSize: '16px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(canvas.getByText('Drain clearing'), { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(canvas.getByText('Good until Tuesday, November 3, 2:00 pm')).toBeVisible();
    // A quote carries no link and no button.
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const BookingOptions: Story = {
  args: { block: blocks.booking_options.en },
  parameters: {
    canvasNote:
      'The board names an open time in prose; a reply check blocks times in prose, so they arrive as this list, which the visitor answers in the chat.',
  },
  play: async ({ canvas }) => {
    const options = canvas.getAllByRole('listitem');
    // list_role_survives_unstyled_markers: Safari announces the options only with role="list".
    await expect(canvas.getByRole('list')).toHaveAttribute('role', 'list');
    await expect(options.map((option) => option.textContent)).toEqual(blocks.booking_options.en.options?.map((o) => o.label));
    // The kernel writes each open time as a line and as an option; the card shows it once.
    for (const option of blocks.booking_options.en.options ?? []) {
      await expect(canvas.getAllByText(option.label)).toHaveLength(1);
    }
    // The visitor answers in the chat: the times are text, not controls.
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByRole('radio')).toBeNull();
  },
};

export const BookingConfirmed: Story = {
  args: { block: blocks.booking_confirmed.en },
  parameters: {
    canvasNote:
      "The board's booking card adds a date tile, a price column and calendar buttons; card data carries no separate date or amount, so the card shows only the kernel's title and lines.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('article', { name: 'Booked' })).toBeVisible();
    // The kernel's booking card: the date, the arrival window and who comes, with no booking ID.
    await expect(canvas.getByText('Tuesday, November 3')).toBeVisible();
    await expect(canvas.getByText('2:00 pm to 4:00 pm')).toBeVisible();
    await expect(canvas.getByText('With Mike Turner')).toBeVisible();
    await expect(canvas.queryByText(/B-77/)).toBeNull();
    // The outcome's check is sage, beside the word that says the same, and hidden from screen readers.
    const check = canvasElement.querySelector('.cd-reply-card__check');
    await expect(check).toHaveAttribute('aria-hidden', 'true');
    expectComputed(check as Element, { color: SAGE });
    const stroke = check?.querySelector('path');
    if (!stroke) throw new Error('no check stroke');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Under reduced motion the check doesn't move: it is drawn from the start.
      expectComputed(stroke, { animationName: 'none', strokeDashoffset: '0px' });
      return;
    }
    // It draws once, in motion-base, short arm first.
    expectComputed(stroke, { animationName: 'cd-reply-card-draw', animationDuration: '0.2s', animationIterationCount: '1' });
    await expectDrawsShortArmFirst(stroke);
  },
};

export const PaymentLink: Story = {
  args: { block: blocks.payment_link.en },
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote: "The board shows the deposit link as a chip in the owner's transcript; a visitor gets this card, with its test-payment note.",
  },
  play: async ({ canvas, canvasElement }) => {
    // link_card_has_one_link
    await expectOneLink(canvasElement, 'Open payment page', '/pay/k7Hq2vX9');
    await expect(canvas.getByRole('link')).toHaveClass('cd-button--secondary');
    // payment_card_says_test_payment
    await expect(canvas.getByText(TEST_PAYMENT.en)).toBeVisible();
  },
};

export const DocumentLink: Story = {
  args: { block: blocks.document_link.en },
  parameters: {
    canvas: 'N-Public-Verify-Run1',
    canvasNote: "The board's document card adds a file tile, pills, a preview button and an expiry line; card data carries only the title and the link.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('article', { name: 'Document, only for you' })).toBeVisible();
    await expectOneLink(canvasElement, 'Download', '/api/d/9fK2mQ');
    await expect(canvas.getByRole('link')).toHaveClass('cd-button--primary');
    // A real document card has no vision line.
    await expect(canvasElement.querySelector('.cd-vision-inert-line')).toBeNull();
  },
};

export const Hours: Story = {
  args: { block: blocks.hours.en },
  parameters: { canvasNote: 'The board lists the hours in its side panel; asked in the chat, they arrive as this card.' },
};

export const Policy: Story = {
  args: { block: blocks.policy.en },
  parameters: { canvasNote: 'The board lists the service area in its side panel; asked in the chat, it arrives as this card.' },
};

export const Contact: Story = {
  args: { block: blocks.contact.en },
  parameters: { canvasNote: "The board's header links the phone number; in a card the contact stays text." },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('(510) 555-0142')).toBeVisible();
    // Never a tel: or mailto: link.
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const Handoff: Story = {
  args: { block: blocks.handoff.en },
  parameters: {
    canvas: 'N-Public-Handoff-Run1',
    canvasNote: "The board's handoff is Claude's prose; when the kernel blocks a reply, the visitor gets this card instead, with its receipt.",
  },
};

export const VerifyPrompt: Story = {
  args: { block: blocks.verify_prompt.en },
  parameters: {
    canvas: 'N-Public-Verify-Run1',
    canvasNote: "The board's verification card holds the code form, which is a separate component; this is the kernel's prompt alone.",
  },
};

export const OwnerSaid: Story = {
  args: { block: blocks.owner_said.en },
  parameters: {
    canvas: 'N-Public-Handoff-Run1',
    canvasNote: "The board shows Mike's words as his own message while he is in the chat; passed through Claude, they arrive verbatim in this card.",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('article', { name: 'Mike Turner said' })).toBeVisible();
  },
};

export const Charges: Story = {
  args: { block: blocks.charges.en },
  parameters: { canvas: 'none', canvasNote: "No board shows a verified visitor's charges; the card follows N-Public-Rivera-Run1's booking card." },
};

export const RefundIssued: Story = {
  args: { block: blocks.refund_issued.en },
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows a refund to a visitor; the card follows N-Public-Rivera-Run1's booking card, with its test-payment note.",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('article', { name: 'Refund issued' })).toBeVisible();
    // payment_card_says_test_payment
    await expect(canvas.getByText(TEST_PAYMENT.en)).toBeVisible();
  },
};

export const ChargeConfirmed: Story = {
  args: { block: blocks.charge_confirmed.en },
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote:
      "The board shows the agent's paid deposit as a receipt row in the owner's transcript; the visiting agent gets this card, with its test-payment note.",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('article', { name: 'Charge confirmed' })).toBeVisible();
    // payment_card_says_test_payment
    await expect(canvas.getByText(TEST_PAYMENT.en)).toBeVisible();
  },
};

export const CallbackConfirmed: Story = {
  args: { block: blocks.callback_confirmed.en },
  parameters: {
    canvas: 'N-Public-Handoff-Run1',
    canvasNote: "The board's callback card adds a check, a change button and a reminder line; card data carries only the kernel's title.",
  },
};

export const PaymentConfirmed: Story = {
  args: { block: blocks.payment_confirmed.en },
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote: "The board shows the paid link as a receipt row in the owner's transcript; the visitor gets this card, with its test-payment note.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('article', { name: 'Paid' })).toBeVisible();
    // payment_card_says_test_payment
    await expect(canvas.getByText(TEST_PAYMENT.en)).toBeVisible();
    expectComputed(canvasElement.querySelector('.cd-reply-card__check') as Element, { color: SAGE });
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};

export const LinkCancelled: Story = {
  args: { block: blocks.link_cancelled.en },
  parameters: {
    canvas: 'N-R2-Chat-Link-Cancelled',
    canvasNote:
      "The Desk's card for a payment link a confirmed rule change cancelled: the amount, what the link was for and the kernel's line. The board adds the test-payment note; a cancelled link moves no money, so the card has none.",
  },
  play: async ({ canvas, canvasElement }) => {
    // link_cancelled_card_shows_amount_title_and_line: named by its label, then the kernel's
    // title (the amount) as the headline and its lines (what the link was for, the line) as details.
    const card = canvas.getByRole('article', { name: 'Payment link cancelled' });
    const { title, lines = [] } = blocks.link_cancelled.en;
    await expect(card.textContent).toBe(['Payment link cancelled', title, ...lines].join(''));
    expectComputed(canvas.getByText('$20.00'), { fontSize: '16px', fontWeight: '520', color: 'rgba(250, 249, 245, 0.92)' });
    for (const line of lines) expectComputed(canvas.getByText(line), { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    // The payment link's card icon beside the label, 16 px and hidden from screen readers.
    const icon = canvasElement.querySelector<SVGSVGElement>('.cd-reply-card__label svg')!;
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon.getBoundingClientRect().width).toBe(16);
    await expect([...icon.querySelectorAll('rect, path')].map((shape) => shape.tagName)).toEqual(['rect', 'path']);
    // No money moved and the link is gone: no test-payment note, no link and no button.
    await expect(card).not.toHaveTextContent(TEST_PAYMENT.en);
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const LinkCancelledEs: Story = {
  args: { block: blocks.link_cancelled.es, language: 'es' },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-R2-Chat-Link-Cancelled in Spanish: the label in Spanish, and the kernel’s amount, title and line as they arrive.',
  },
  play: async ({ canvas, canvasElement }) => {
    const card = canvas.getByRole('article', { name: 'Enlace de pago cancelado' });
    const { title, lines = [] } = blocks.link_cancelled.es;
    await expect(card.textContent).toBe(['Enlace de pago cancelado', title, ...lines].join(''));
    await expect(card).not.toHaveTextContent(TEST_PAYMENT.es);
    await expect(canvasElement.querySelector('.cd-reply-card')).toHaveAttribute('lang', 'es');
  },
};

export const QuoteEs: Story = {
  args: { block: blocks.quote.es, language: 'es' },
  parameters: { canvasNote: 'The board is in English; this is the same card for a visitor writing in Spanish.' },
  play: async ({ canvas, canvasElement }) => {
    // chrome_follows_language
    await expect(canvas.getByRole('article', { name: 'Presupuesto' })).toBeVisible();
    await expect(canvas.queryByText('Quote')).toBeNull();
    await expect(canvasElement.querySelector('.cd-reply-card')).toHaveAttribute('lang', 'es');
  },
};

export const BookingConfirmedEs: Story = {
  args: { block: blocks.booking_confirmed.es, language: 'es' },
  parameters: { canvasNote: 'The board is in English and adds a date tile and a price column, which card data does not carry.' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('article', { name: 'Reservado' })).toBeVisible();
    await expect(canvas.getByText('martes 3 de noviembre')).toBeVisible();
    await expect(canvas.getByText('De 14:00 a 16:00')).toBeVisible();
    await expect(canvas.getByText('Con Mike Turner')).toBeVisible();
  },
};

export const PaymentLinkEs: Story = {
  args: { block: blocks.payment_link.es, language: 'es' },
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote: "The board shows the deposit link as a chip in the owner's transcript, in English; this is the visitor's card in Spanish.",
  },
  play: async ({ canvas, canvasElement }) => {
    await expectOneLink(canvasElement, 'Abrir página de pago', '/pay/k7Hq2vX9');
    // payment_card_says_test_payment
    await expect(canvas.getByText(TEST_PAYMENT.es)).toBeVisible();
  },
};

export const DocumentLinkEs: Story = {
  args: { block: blocks.document_link.es, language: 'es' },
  parameters: {
    canvas: 'N-Public-Verify-Run1',
    canvasNote: 'The board is in English; this is the document card for a visitor writing in Spanish.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('article', { name: 'Documento, solo para ti' })).toBeVisible();
    await expectOneLink(canvasElement, 'Descargar', '/api/d/9fK2mQ');
  },
};

const longDocument: CardBlock = {
  ...blocks.document_link.es,
  title: 'Factura_destape_de_desagüe_y_cambio_de_junta_del_calentador_Turner_Plumbing_para_Lucía_Herrera.pdf',
  text: 'Factura_destape_de_desagüe_y_cambio_de_junta_del_calentador_Turner_Plumbing_para_Lucía_Herrera.pdf',
};

const longQuote: CardBlock = {
  ...blocks.quote.es,
  lines: [
    'Destape de desagüe principal con cámara de inspección, limpieza a presión y revisión completa de la junta del calentador',
    'Referencia:presupuesto-1042-destape-desagüe-principal-cámara-inspección-limpieza-presión-junta-calentador',
  ],
};

export const LongUnbrokenText: Story = {
  args: { language: 'es' },
  render: (args) => (
    <div data-testid="phone-line" style={{ width: PHONE_LINE, maxWidth: '100%', display: 'grid', rowGap: 'var(--space-16)' }}>
      <ReplyCard {...args} block={longDocument} />
      <ReplyCard {...args} block={longQuote} />
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows card text wider than a phone's line; it wraps inside the card, as N-Public-Rivera-Run1's cards would.",
  },
  play: async ({ canvas, canvasElement }) => {
    // long_unbroken_text_wraps: nothing reaches past the line or out of its card.
    const line = canvas.getByTestId('phone-line');
    await expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    const lineRight = line.getBoundingClientRect().right;
    const cards = canvasElement.querySelectorAll<HTMLElement>('.cd-card');
    await expect(cards).toHaveLength(2);
    for (const card of cards) {
      await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      for (const part of card.querySelectorAll('*')) {
        await expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(lineRight + 0.5);
      }
    }
    // The unbroken title takes more than one 20 px line.
    await expect(canvas.getByText(longDocument.title as string).getBoundingClientRect().height).toBeGreaterThan(20);
  },
};

export const UnsafeHref: Story = {
  args: { block: { ...blocks.payment_link.en, href: 'javascript:alert(1)' } },
  parameters: {
    canvas: 'N-Conv-Agent-Run1',
    canvasNote: "A payment card whose href is not the checkout's path: it keeps its words and note, and has no link.",
  },
  play: async ({ canvas, canvasElement }) => {
    // unsafe_href_has_no_link
    await expect(canvasElement.querySelectorAll('a')).toHaveLength(0);
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.getByText('Service call deposit, $20.00')).toBeVisible();
    await expect(canvas.getByText(TEST_PAYMENT.en)).toBeVisible();
  },
};

/** A vision page's document card: no destination at all, so its data carries no href. */
const visionDocument = { ...blocks.document_link.en, href: null } satisfies CardBlock;

export const DocumentInertDownload: Story = {
  args: { block: visionDocument, inertDownload: true },
  parameters: {
    canvas: 'N-R2-Vision-ClaudeAccount',
    canvasNote: 'A vision page makes no requests: Download is drawn as on the board, as a plain button with nowhere to go.',
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    // inert_download_makes_no_request: Download looks the same, but is a button with no destination.
    const card = canvas.getByRole('article', { name: 'Document, only for you' });
    const download = canvas.getByRole('button', { name: 'Download' });
    await expect(download.tagName).toBe('BUTTON');
    await expect(download).toHaveAttribute('type', 'button');
    await expect(download).toHaveClass('cd-button--primary');
    await expect(canvasElement.querySelectorAll('a, [href]')).toHaveLength(0);
    await expect(card.textContent).toBe('Document, only for youInvoice, drain clearingDownload');
    // Pressing it goes nowhere: the page stays where it is.
    const before = window.location.href;
    await userEvent.click(download);
    await expect(window.location.href).toBe(before);
    // vision_inert_line_on_first_press: the line shows in a polite live region, a secondary caption
    // 8 px under the button's row, and a second press changes nothing.
    const line = canvas.getByText(VISION_INERT_LINE);
    await expect(line).toHaveAttribute('role', 'status');
    expectComputed(line, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
    const row = canvasElement.querySelector<HTMLElement>('.cd-reply-card__action')!;
    await expect(Math.round(line.getBoundingClientRect().top - row.getBoundingClientRect().bottom)).toBe(8);
    await userEvent.click(download);
    await expect(canvas.getAllByText(VISION_INERT_LINE)).toHaveLength(1);
    await expect(window.location.href).toBe(before);
  },
};

export const InertDownloadIgnoresAnHref: Story = {
  args: { block: blocks.document_link.en, inertDownload: true },
  parameters: {
    canvas: 'N-R2-Vision-ClaudeAccount',
    canvasNote: 'Even a proxied path is not followed on a vision page: the card draws the button, and the path is neither linked nor shown.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(canvasElement.querySelectorAll('a, [href]')).toHaveLength(0);
    await expect(canvasElement.textContent).not.toContain('/api/d/');
  },
};

export const DocumentWithoutItsPath: Story = {
  args: { block: visionDocument },
  parameters: {
    canvas: 'N-Public-Verify-Run1',
    canvasNote: "A real document card whose block has no proxied path: it keeps its words and draws no Download, so only the kernel's /api/d/ path gives a real card its button.",
  },
  play: async ({ canvas, canvasElement }) => {
    // real_document_card_needs_its_path
    await expect(canvas.getByRole('article', { name: 'Document, only for you' })).toHaveTextContent('Invoice, drain clearing');
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvasElement.querySelectorAll('[href]')).toHaveLength(0);
  },
};

export const DocumentWithAnotherPath: Story = {
  args: { block: { ...blocks.document_link.en, href: '/pay/k7Hq2vX9' } },
  parameters: {
    canvas: 'N-Public-Verify-Run1',
    canvasNote: "A real document card with a path that isn't /api/d/: no link and no button, as before.",
  },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

// A template this build doesn't know, as a newer kernel might send; its href is dropped too.
const unknownBlock = {
  kind: 'card',
  template: 'refund_receipt',
  text: 'Refund receipt\nSent to the card you paid with',
  fact_id: 'refund:re-dana-1',
  title: null,
  lines: [],
  href: '/pay/k7Hq2vX9',
  options: [],
} as unknown as CardBlock;

export const UnknownTemplate: Story = {
  args: { block: unknownBlock },
  parameters: {
    canvas: 'none',
    canvasNote: "No board shows a template this build doesn't know; its text shows in a plain card, like N-Public-Rivera-Run1's cards without their label.",
  },
  play: async ({ canvas, canvasElement }) => {
    // unknown_template_renders_text: the text, in a plain frame with no label and no link.
    await expect(canvas.getByText('Refund receipt')).toBeVisible();
    await expect(canvas.getByText('Sent to the card you paid with')).toBeVisible();
    await expect(canvasElement.querySelectorAll('.cd-card')).toHaveLength(1);
    await expect(canvasElement.querySelector('.cd-reply-card__label')).toBeNull();
    await expect(canvasElement.querySelector('svg')).toBeNull();
    await expect(canvas.queryByRole('article')).toBeNull();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
