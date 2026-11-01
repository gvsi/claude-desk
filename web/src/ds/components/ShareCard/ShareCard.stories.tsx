import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { ShareCard } from './ShareCard.tsx';

/**
 * A stand-in for the web app's QR code (plan 04 draws the real one from the Desk's link): a fixed
 * pattern of squares on a light ground, so the story shows the slot filled. It encodes nothing.
 */
function QrPlaceholder({ url = 'desk.example/rivera' }: { url?: string }) {
  const cells: [number, number][] = [];
  for (let y = 0; y < 21; y += 1) {
    for (let x = 0; x < 21; x += 1) {
      const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      const ring = finder && (x % 14 === 0 || x % 14 === 6 || x === 20 || y % 14 === 0 || y % 14 === 6 || y === 20 || (x % 14 >= 2 && x % 14 <= 4 && y % 14 >= 2 && y % 14 <= 4));
      if (finder ? ring : (x * 7 + y * 13 + x * y) % 5 < 2) cells.push([x, y]);
    }
  }
  return (
    <svg viewBox="-1 -1 23 23" width="152" height="152" role="img" aria-label={`QR code for ${url}`} style={{ display: 'block', background: '#faf9f5' }}>
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#141413" />
      ))}
    </svg>
  );
}

const meta = {
  title: 'Share/ShareCard',
  component: ShareCard,
  args: { name: 'Turner Plumbing', url: 'desk.example/rivera', ownerName: 'Mike Turner', language: 'en', qr: <QrPlaceholder />, onPrint: fn() },
  render: (args) => (
    <div style={{ maxWidth: 300 }}>
      <ShareCard {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Run2-Share' },
} satisfies Meta<typeof ShareCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Printable: Story = {
  parameters: { canvasNote: 'The printable card on Share: the business, the QR code the web app draws, the link and who answers, then Print card. The QR here is a placeholder.' },
  play: async ({ args, canvas, userEvent }) => {
    // share_card_says_who_answers: the business, the link, and the AI disclosure, which can't be left off.
    const card = canvas.getByRole('figure', { name: 'Turner Plumbing' });
    await expect(within(card).getByText('desk.example/rivera')).toBeVisible();
    const disclosure = card.querySelector('figcaption')!;
    await expect(disclosure).toHaveTextContent(/^Answered by Claude, an AI\. Ask for Mike Turner any time\.$/);
    expectComputed(disclosure, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)', textAlign: 'center' });
    expectComputed(within(card).getByText('Turner Plumbing'), { fontSize: '15px', lineHeight: '20px', fontWeight: '520', textAlign: 'center' });
    expectComputed(card, { paddingTop: '20px', paddingLeft: '20px', borderTopLeftRadius: '12px', backgroundColor: 'rgba(250, 249, 245, 0.03)' });
    // The QR code is the screen's, in a 152 px square slot, 12 px under the name, centered.
    const qr = within(card).getByRole('img', { name: 'QR code for desk.example/rivera' });
    const slot = qr.parentElement!.getBoundingClientRect();
    await expect([slot.width, slot.height]).toEqual([152, 152]);
    const box = card.getBoundingClientRect();
    await expect(Math.round(slot.left - box.left)).toBe(Math.round(box.right - slot.right));
    // 300 px wide and, with the line on two lines, 306 px tall, as on the board.
    await expect([Math.round(box.width), Math.round(box.height)]).toEqual([300, 306]);
    // Print card under it, 12 px down; it only calls the screen.
    const print = canvas.getByRole('button', { name: 'Print card' });
    await expect(Math.round(print.getBoundingClientRect().top - box.bottom)).toBe(12);
    await userEvent.click(print);
    await expect(args.onPrint).toHaveBeenCalledOnce();
  },
};

export const Spanish: Story = {
  args: { language: 'es', onPrint: undefined },
  parameters: { canvas: 'none', canvasNote: 'N-Run2-Share’s card printed in Spanish: who answers in Spanish, the name and link as they are, and no Print card button when the screen gives none.' },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('figure', { name: 'Turner Plumbing' });
    await expect(card).toHaveAttribute('lang', 'es');
    await expect(card.querySelector('figcaption')).toHaveTextContent(/^Responde Claude, una IA\. Puedes pedir hablar con Mike Turner cuando quieras\.$/);
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const Phone: Story = {
  render: (args) => (
    <div style={{ maxWidth: 358 }}>
      <ShareCard {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Share-Phone: on a phone the card takes the whole 358 px column, and Print card sits centered under it.',
  },
  play: async ({ canvas, canvasElement }) => {
    // share_card_spans_a_phones_column: the card fills the column; Print card is centered under it.
    const card = canvas.getByRole('figure', { name: 'Turner Plumbing' });
    const column = canvasElement.querySelector<HTMLElement>('.cd-share-card')!.parentElement!.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.width)]).toEqual([Math.round(column.left), 358]);
    const print = canvas.getByRole('button', { name: 'Print card' }).getBoundingClientRect();
    await expect(Math.round(print.left - box.left)).toBe(Math.round(box.right - print.right));
    await expect(Math.round(print.top - box.bottom)).toBe(12);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const MarkedName: Story = {
  name: 'A business name marked as theirs',
  args: { name: 'AAA Plumbing', url: 'desk.example/aaa', ownerName: 'JJ Okafor', qr: <QrPlaceholder url="desk.example/aaa" /> },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Share’s card for a business whose name has capitals: the name, the link and the owner are theirs, marked as user text, and the card is named by the marked name.',
  },
  play: async ({ canvas }) => {
    // share_card_names_are_user_text: the card's name comes from the marked business name, not a
    // label of its own, so nothing the business wrote is read as the card's words.
    const card = canvas.getByRole('figure', { name: 'AAA Plumbing' });
    await expect(card).not.toHaveAttribute('aria-label');
    const name = card.ownerDocument.getElementById(card.getAttribute('aria-labelledby') ?? '');
    await expect(name).toHaveTextContent(/^AAA Plumbing$/);
    await expect(name).toHaveAttribute('data-copy', 'user');
    await expect(within(card).getByText('desk.example/aaa')).toHaveAttribute('data-copy', 'user');
    await expect(within(card).getByText('JJ Okafor')).toHaveAttribute('data-copy', 'user');
  },
};

export const OwnerNameWithDirectionOverride: Story = {
  name: 'An owner name with a direction override',
  args: { ownerName: 'Mike \u202ETurner', onPrint: undefined },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Share’s card for an owner whose name holds a right-to-left override (U+202E): the name is isolated in its sentence, so it can’t reorder the words after it.',
  },
  play: async ({ canvas }) => {
    // share_card_owner_name_is_isolated: "any time." stays after the owner's name, at its right.
    const caption = canvas.getByRole('figure', { name: 'Turner Plumbing' }).querySelector('figcaption');
    const owner = caption?.querySelector<HTMLElement>('[data-copy="user"]');
    const after = caption?.lastChild;
    if (!caption || !owner || !after || after.textContent !== ' any time.') throw new Error('No owner name and the words after it');
    const range = document.createRange();
    range.setStart(after, 1);
    range.setEnd(after, 4);
    const any = range.getBoundingClientRect();
    // The name may wrap over the caption's two lines: "any" follows its last line box.
    const rects = [...owner.getClientRects()];
    const name = rects[rects.length - 1];
    if (!name) throw new Error('The owner name has no box');
    await expect(Math.round(any.top), '"any" is on the name’s last line').toBe(Math.round(name.top));
    await expect(any.left, '"any" after the name').toBeGreaterThanOrEqual(name.right - 0.5);
    expectComputed(owner, { unicodeBidi: 'isolate' });
  },
};
