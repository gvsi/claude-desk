import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { SHARE_CHANNELS } from '../../lib/channels.ts';
import '../../owner/share/ShareKit.css';

import { Button } from '../components/Button/Button.tsx';
import { Card } from '../components/Card/Card.tsx';
import { AppShellOnly } from '../components/AppShell/AppShell.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { CopyList } from '../components/CopyList/CopyList.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { SHARE_CARD_QR_COLORS, ShareCard } from '../components/ShareCard/ShareCard.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { PUBLIC_LINK, RiveraFrame } from './parts.tsx';
import { SPEC, expectFooter, expectOwnerFrame, expectTabOrder, one } from './spec.ts';

/** Share's ready-made words for Turner Plumbing, as the board writes them. */
const WORDS = [
  { title: 'Google profile', text: 'Questions, quotes and bookings, any time: desk.example/rivera. Answered by Claude, an AI, under Mike Turner’s rules.' },
  { title: 'Email signature', text: 'Need a plumber? Ask Turner Plumbing any time at desk.example/rivera (answered by Claude, an AI).' },
  {
    title: 'Voicemail',
    text: 'You’ve reached Turner Plumbing. For quotes and bookings, visit desk.example slash rivera, where Claude, an AI, answers any time. For an emergency, leave a message and Mike Turner will call you back.',
  },
];

/**
 * A stand-in for the web app's QR code (plan 04 draws the real one from the Desk's link): a fixed
 * pattern of squares in the card's QR colors, filling its sand tile. It encodes nothing.
 */
function QrPlaceholder() {
  const cells: [number, number][] = [];
  for (let y = 0; y < 25; y += 1) {
    for (let x = 0; x < 25; x += 1) {
      const corner = (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17);
      const cx = x > 17 ? x - 18 : x;
      const cy = y > 17 ? y - 18 : y;
      const ring = cx === 0 || cx === 6 || cy === 0 || cy === 6 || (cx >= 2 && cx <= 4 && cy >= 2 && cy <= 4);
      if (corner ? ring : (x * 7 + y * 13 + x * y) % 5 < 2) cells.push([x, y]);
    }
  }
  return (
    <svg viewBox="-1 -1 27 27" width="100%" height="100%" role="img" aria-label={`QR code for ${PUBLIC_LINK}`} style={{ display: 'block', background: SHARE_CARD_QR_COLORS.light }}>
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={SHARE_CARD_QR_COLORS.dark} />
      ))}
    </svg>
  );
}

function Share() {
  return (
    <RiveraFrame current="share" counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}>
      <div className="board-share">
        <PageHeader title="Share" subtitle="Put your Desk where customers already look for you." />
        <Card as="section" label="Your link" padding={20}>
          <p className="board-share__caption cd-type-caption">Your link</p>
          <div className="board-share__link">
            <p className="board-share__url cd-type-section" data-copy="user">
              {PUBLIC_LINK}
            </p>
            <Button variant="primary" size="main" onClick={fn()}>
              Copy link
            </Button>
            <Button variant="secondary" size="main" href="#public-page" external>
              Open
            </Button>
          </div>
        </Card>
        <div className="board-share__kit">
          <ShareCard name={rivera.business.name} url={PUBLIC_LINK} ownerName={rivera.business.ownerName} language="en" qr={<QrPlaceholder />} onPrint={fn()} />
          <div className="board-share__words">
            <h2 className="board-share__heading cd-type-section">Ready-made words</h2>
            <CopyList label="Ready-made words" items={WORDS} onCopy={fn(async () => {})} />
            <section className="cd-share-kit__channels" aria-label="More channels">
              <h2 className="cd-share-kit__heading cd-type-section">More channels</h2>
              <Card padding={0}>
                <ul role="list" className="cd-share-kit__channel-list">
                  {SHARE_CHANNELS.map((channel) => (
                    <li key={channel.key} className="cd-share-kit__later">
                      <div className="cd-share-kit__later-text">
                        <p className="cd-share-kit__later-title cd-type-control">{channel.name}</p>
                        <p className="cd-share-kit__later-line cd-type-meta">{channel.line}</p>
                      </div>
                      <Pill>Coming later</Pill>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          </div>
        </div>
        <AppShellOnly layout="compact"><ConceptFooter /></AppShellOnly>
      </div>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Share',
  render: () => <Share />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Share',
    canvasNote: [
      'More channels follows the signed Share boards from November 1.',
      'Share: the printable card is ShareCard, with the QR code in its slot (a placeholder here: the web app’s QrCode draws the real one), and the ready-made words are a CopyList.',
      'The link card, its Copy link (the web app’s CopyLink), More channels and the page’s columns are page layout the web app (plan 04) owns; the sidebar’s Connectors row belongs to another change.',
      'The board draws the link card 1 px taller, so everything under it sits 1 px higher here.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Share');
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Share' }), SPEC.pageTitle);

    // The printable card at the left, 300 px, and the ready-made words 32 px to its right.
    const card = canvas.getByRole('figure', { name: rivera.business.name });
    const words = canvas.getByRole('list', { name: 'Ready-made words' });
    const cardBox = card.getBoundingClientRect();
    const wordsBox = words.getBoundingClientRect();
    // Everything under the link card sits 1 px higher than the board, which draws that card 1 px taller.
    await expect([Math.round(cardBox.left), Math.round(cardBox.top), Math.round(cardBox.width), Math.round(cardBox.height)]).toEqual([408, 233, 300, 306]);
    await expect([Math.round(wordsBox.left), Math.round(wordsBox.width)]).toEqual([740, 628]);
    await expect(Math.round(wordsBox.top)).toBe(261);
    await expect(within(words).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(
      WORDS.map((block) => `Copy ${block.title}`),
    );
    // The link card's buttons at its right, Copy link the page's one primary.
    const link = canvas.getByRole('region', { name: 'Your link' });
    expectComputed(within(link).getByRole('button', { name: 'Copy link' }), SPEC.primary);
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(105);
    const channels = canvas.getByRole('region', { name: 'More channels' });
    const channelHeading = within(channels).getByRole('heading', { level: 2, name: 'More channels' });
    const channelCard = one(channels, '.cd-card');
    await expect(Math.round(channelHeading.getBoundingClientRect().top - wordsBox.bottom)).toBe(8);
    await expect(Math.round(channelCard.getBoundingClientRect().top - channelHeading.getBoundingClientRect().bottom)).toBe(12);
    const rows = within(channels).getAllByRole('listitem');
    await expect(rows.map((row) => row.textContent)).toEqual(SHARE_CHANNELS.map(({ name, line }) => `${name}${line}Coming later`));
    rows.forEach((row, index) => expectComputed(row, { ...SPEC.shareChannelRow, borderTopWidth: index === 0 ? '0px' : '1px' }));
    await expectFooter(canvasElement);
    await expectTabOrder(userEvent, [
      within(link).getByRole('button', { name: 'Copy link' }),
      within(link).getByRole('link', { name: 'Open' }),
      canvas.getByRole('button', { name: 'Print card' }),
      within(words).getByRole('button', { name: 'Copy Google profile' }),
    ]);
  },
};
