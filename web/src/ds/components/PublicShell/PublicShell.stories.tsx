import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { EvMessage, PublicDesk, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { contrastRatio } from '../../contrast.ts';
import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { Transcript } from '../Transcript/Transcript.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { PublicShell, type PublicBrand } from './PublicShell.tsx';

const ownerName = rivera.business.ownerName;
const desk = rivera.publicDesk;
const ACCENT = 'rgb(184, 115, 51)';
const DISCLOSURE = {
  en: "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.",
  es: 'Estás hablando con Claude, una IA que responde por Rivera Plumbing. Puedes pedir hablar con Maria Rivera cuando quieras.',
};

/** The public page's brand, as the screen maps `PublicDesk` to it: the seed's field and accent, the text tokens as inks. */
function brandOf(publicDesk: PublicDesk): PublicBrand {
  return {
    name: publicDesk.business_name,
    tagline: publicDesk.desk_name,
    monogram: Array.from(publicDesk.business_name)[0] ?? '',
    field: publicDesk.brand.primary ?? '',
    ink: 'var(--text-primary)',
    inkSecondary: 'var(--text-secondary)',
    accent: publicDesk.brand.accent ?? '',
  };
}

/** A fixture part the stories need, or a thrown error naming what the fixture lost. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the Rivera fixture has no ${what}`);
  return value;
}

/** The visitor's question and Claude's checked quote, with the receipts a visitor reads under it. */
function Conversation({ language }: { language: 'en' | 'es' }) {
  const turns = language === 'en' ? rivera.conversations.danaLive.turns : rivera.conversations.lucia.turns;
  const question = required(
    turns.flatMap((turn) => (turn.kind === 'visitor' ? [turn.text] : []))[0],
    `${language} question`,
  );
  const events: SseEvent[] = language === 'en' ? rivera.events.quoteTurn : rivera.events.quoteTurnEs;
  const receipt = required(
    events.find((event): event is StatusEvent => event.type === 'receipt'),
    `${language} quote receipt`,
  );
  const reply = required(
    events.find((event): event is EvMessage => event.type === 'message'),
    `${language} quote reply`,
  );
  return (
    <Transcript label={language === 'en' ? 'Conversation with Rivera Plumbing' : 'Conversación con Rivera Plumbing'}>
      <TranscriptRow>
        <VisitorMessage text={question} />
      </TranscriptRow>
      <TranscriptRow
        margin={[receiptFromEvent(receipt), receiptFromEvent(reply)].map((view) => (
          <MarginReceipt key={view.ledgerSeq} {...view} />
        ))}
      >
        <ClaudeMessage blocks={reply.blocks} language={reply.language} ownerName={ownerName} />
      </TranscriptRow>
    </Transcript>
  );
}

const composer = {
  en: <Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={fn()} />,
  es: (
    <Composer
      variant="visitor"
      label="Escribe a Rivera Plumbing"
      placeholder="Escribe a Rivera Plumbing"
      sendLabel="Enviar"
      maxLength={2000}
      onSend={fn()}
    />
  ),
};

const meta = {
  title: 'Layout/PublicShell',
  component: PublicShell,
  args: {
    brand: brandOf(desk.en),
    ownerName,
    language: 'en',
    onAskForOwner: fn(),
    about: desk.en.charter,
    composer: composer.en,
    children: <Conversation language="en" />,
  },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Public-Rivera',
    canvasNote:
      "The board's teal and copper are the seed's field and accent here. The accent is only the rule under the header, not the monogram's ring; the header's phone link and opening hours are the about column's cards; and the about column shows the charter's cards, not the board's free text and quote.",
  },
} satisfies Meta<typeof PublicShell>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The one line (`p`) under `root` that reads `text` in full, names included. */
function lineReading(root: HTMLElement, text: string): HTMLElement {
  const lines = [...root.querySelectorAll<HTMLElement>('p')].filter((line) => line.textContent === text);
  if (lines.length !== 1) throw new Error(`expected one line reading "${text}", found ${lines.length}`);
  return lines[0] as HTMLElement;
}

/** Every element that draws text of its own: a text node with something in it. */
function textElements(root: HTMLElement): HTMLElement[] {
  return [root, ...root.querySelectorAll<HTMLElement>('*')].filter((el) =>
    [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''),
  );
}

/** The opaque color under `el`: its own background, or the nearest ancestor's. */
function groundOf(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const ground = getComputedStyle(node).backgroundColor;
    if (ground !== 'rgba(0, 0, 0, 0)' && ground !== 'transparent') return ground;
  }
  throw new Error('no ground under the element');
}

/**
 * public_rows_fill_the_chat: on the public page each conversation row takes the chat column's full
 * width, so the last row ends where the composer ends, rather than at the owner app's reading width.
 */
async function expectRowsFillTheChat(root: HTMLElement): Promise<void> {
  const rows = [...root.querySelectorAll<HTMLElement>('.cd-transcript-row')];
  const last = rows[rows.length - 1];
  const composerBox = root.querySelector<HTMLElement>('.cd-composer');
  if (!last || !composerBox) throw new Error('no conversation row or composer');
  const row = last.getBoundingClientRect();
  const composer = composerBox.getBoundingClientRect();
  await expect(row.right).toBe(composer.right);
  await expect(row.left).toBe(composer.left);
  for (const other of rows) await expect(other.getBoundingClientRect().width).toBe(row.width);
}

export const Rivera: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // The brand header in the business's colors: field, inks and the accent's 2 px rule.
    const header = canvas.getByRole('banner');
    expectComputed(header, {
      minHeight: '76px',
      backgroundColor: 'rgb(31, 78, 74)',
      borderBottomWidth: '2px',
      borderBottomColor: ACCENT,
    });
    const name = within(header).getByRole('heading', { level: 1, name: 'Rivera Plumbing' });
    const tagline = within(header).getByText('Main line');
    const monogram = header.querySelector('.cd-public-shell__monogram');
    await expect(monogram).toHaveAttribute('aria-hidden', 'true');
    await expect(monogram).toHaveTextContent('R');

    // brand_text_meets_contrast: both inks keep 4.5:1 over the field (axe checks the same).
    for (const text of [name, tagline]) {
      const ratio = contrastRatio(getComputedStyle(text).color, groundOf(text));
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    // accent_is_decorative: no element with text has the accent as its color or its ground.
    const accented = textElements(canvasElement).filter((el) => {
      const style = getComputedStyle(el);
      return style.color === ACCENT || style.backgroundColor === ACCENT;
    });
    await expect(accented).toEqual([]);

    // public_shell_always_discloses_ai: under the chat's title, in words.
    const main = canvas.getByRole('main');
    await expect(within(main).getByRole('heading', { level: 2, name: 'Chat with Rivera Plumbing' })).toBeVisible();
    await expect(lineReading(main, DISCLOSURE.en)).toBeVisible();
    await expect(main).toHaveTextContent('an AI answering for Rivera Plumbing');

    // ask_for_owner_calls_back. Its words are one run of text, so the button's gap can't open up
    // between "Ask for" and the name.
    const ask = within(main).getByRole('button', { name: 'Ask for Maria Rivera' });
    await expect([...ask.childNodes].map((node) => node.textContent)).toEqual(['Ask for Maria Rivera']);
    await userEvent.click(ask);
    await expect(args.onAskForOwner).toHaveBeenCalledTimes(1);

    // The conversation, then the composer and the footer under it.
    const log = within(main).getByRole('log', { name: 'Conversation with Rivera Plumbing' });
    const input = within(main).getByRole('textbox', { name: 'Message Rivera Plumbing' });
    await expect(input.getBoundingClientRect().top).toBeGreaterThan(log.getBoundingClientRect().bottom);
    const footer = within(main).getByText('Concept prototype by Giovanni Alcantara, not an Anthropic product');
    await expect(footer.getBoundingClientRect().top).toBeGreaterThan(input.getBoundingClientRect().bottom);
    await expect(within(main).getByText('Claude Desk')).toBeVisible();

    // The about column at the right: the charter's cards, in order, in the page's language.
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expect(within(about).getByRole('heading', { level: 2, name: 'About Rivera Plumbing' })).toBeVisible();
    const cards = [...about.querySelectorAll<HTMLElement>('.cd-reply-card')];
    await expect(cards).toHaveLength(desk.en.charter.length);
    for (const [index, card] of cards.entries()) {
      await expect(card).toHaveAttribute('lang', 'en');
      await expect(card).toHaveTextContent(desk.en.charter[index]?.title ?? '');
    }
    await expect(about.getBoundingClientRect().left).toBeGreaterThanOrEqual(main.getBoundingClientRect().right);
    expectComputed(about, { width: '300px', backgroundColor: 'rgb(34, 34, 32)', borderLeftWidth: '1px' });
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'en');

    // At 1280 px the rows take the 680 px chat column, as the composer does.
    await expect(document.documentElement.clientWidth).toBe(1280);
    await expectRowsFillTheChat(canvasElement);
    await expect(canvasElement.querySelector<HTMLElement>('.cd-transcript-row')?.getBoundingClientRect().width).toBe(680);
  },
};

/** A small tablet's width, where the about column has moved under the chat. */
const TABLET = 800;

export const Tablet: Story = {
  decorators: [
    (Story) => (
      <div data-testid="tablet" style={{ width: TABLET }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'none',
    canvasNote: 'No board shows the public page at 800 px; the about column of N-Public-Rivera moves under the chat, and the rows still fill the chat column.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByTestId('tablet').getBoundingClientRect().width).toBe(TABLET);
    const main = canvas.getByRole('main');
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expect(about.getBoundingClientRect().top).toBeGreaterThanOrEqual(main.getBoundingClientRect().bottom);
    await expectRowsFillTheChat(canvasElement);
  },
};

export const RiveraEs: Story = {
  args: {
    brand: brandOf(desk.es),
    language: 'es',
    about: desk.es.charter,
    composer: composer.es,
    children: <Conversation language="es" />,
  },
  parameters: {
    canvasNote: 'The board is in English; the same page in Spanish, as a visitor whose browser asks for it reads it.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'es');
    const main = canvas.getByRole('main');
    // public_shell_always_discloses_ai, in Spanish.
    await expect(within(main).getByRole('heading', { level: 2, name: 'Chatea con Rivera Plumbing' })).toBeVisible();
    await expect(lineReading(main, DISCLOSURE.es)).toBeVisible();
    await expect(main).toHaveTextContent('una IA que responde por Rivera Plumbing');
    await userEvent.click(within(main).getByRole('button', { name: 'Pedir hablar con Maria Rivera' }));
    await expect(args.onAskForOwner).toHaveBeenCalledTimes(1);
    const about = canvas.getByRole('complementary', { name: 'Sobre Rivera Plumbing' });
    for (const card of about.querySelectorAll('.cd-reply-card')) await expect(card).toHaveAttribute('lang', 'es');
    await expect(canvasElement).not.toHaveTextContent('Chat with');
  },
};

/** A phone's width. */
const PHONE = 390;

export const Compact: Story = {
  decorators: [
    (Story) => (
      <div data-testid="phone" style={{ width: PHONE }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'none',
    canvasNote: 'No board shows the public page on a phone; the about column of N-Public-Rivera moves under the chat, and the gutters are 16 px.',
  },
  play: async ({ canvas, canvasElement }) => {
    const phone = canvas.getByTestId('phone');
    // Nothing reaches past the phone's width.
    await expect(phone.scrollWidth).toBeLessThanOrEqual(PHONE);
    for (const el of canvasElement.querySelectorAll('.cd-public-shell *')) {
      await expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(phone.getBoundingClientRect().right + 0.5);
    }
    // 16 px gutters, the disclosure still under the chat's title.
    expectComputed(canvas.getByRole('banner'), { paddingLeft: '16px', paddingRight: '16px' });
    const main = canvas.getByRole('main');
    expectComputed(main, { paddingLeft: '16px', paddingRight: '16px' });
    await expect(lineReading(main, DISCLOSURE.en)).toBeVisible();
    // The about column comes after the chat, full width.
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    const footer = within(main).getByText('Concept prototype by Giovanni Alcantara, not an Anthropic product');
    await expect(about.getBoundingClientRect().top).toBeGreaterThanOrEqual(footer.getBoundingClientRect().bottom);
    await expect(about.getBoundingClientRect().width).toBe(PHONE);
  },
};

export const Embedded: Story = {
  args: { footer: false },
  decorators: [
    (Story) => (
      <div data-testid="panel" style={{ width: 420, height: 820, overflowY: 'auto', background: 'var(--bg-app)' }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'none',
    canvasNote:
      "No board shows the public page inside Today; it is N-Public-Rivera in the owner's 420 px panel, without the footer, which the owner screen has its own of.",
  },
  play: async ({ canvas, canvasElement }) => {
    // No footer of its own, and no page landmarks: the owner screen has its own.
    await expect(canvasElement.querySelector('[data-ds="concept-footer"]')).toBeNull();
    await expect(canvas.queryByRole('main')).toBeNull();
    await expect(canvas.queryByRole('banner')).toBeNull();
    await expect(canvas.queryByRole('complementary')).toBeNull();
    await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
    // The disclosure can't be left out.
    await expect(lineReading(canvasElement, DISCLOSURE.en)).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: 'Chat with Rivera Plumbing' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Ask for Maria Rivera' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'About Rivera Plumbing' })).toBeVisible();
    const panel = canvas.getByTestId('panel');
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  },
};

export const WithAgentLinks: Story = {
  args: {
    aboutLinks: [
      { label: 'What agents can do here', href: `/d/${rivera.business.slug}/agents` },
      { label: 'Send an agent', href: `/d/${rivera.business.slug}/agents#send` },
    ],
  },
  parameters: {
    canvasNote: 'The board has no agent links; they sit under the charter cards in the about column, under their own heading.',
  },
  play: async ({ canvas }) => {
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    const heading = within(about).getByRole('heading', { level: 3, name: 'For AI agents' });
    const links = within(about).getAllByRole('link');
    await expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['What agents can do here', `/d/${rivera.business.slug}/agents`],
      ['Send an agent', `/d/${rivera.business.slug}/agents#send`],
    ]);
    // Under the heading, after the last card.
    const cards = about.querySelectorAll('.cd-reply-card');
    const lastCard = cards[cards.length - 1] as HTMLElement;
    await expect(heading.getBoundingClientRect().top).toBeGreaterThan(lastCard.getBoundingClientRect().bottom);
    await expect(links[0]?.getBoundingClientRect().top).toBeGreaterThan(heading.getBoundingClientRect().bottom);
  },
};

// The open status in the header: the kernel's words (`PublicDesk.open_status`), shown as written.

/*
 * Each status whole, as the kernel serves it in `PublicDesk.open_status` for a business in
 * America/Los_Angeles. The shell reads only `text` and `open`; the times are the kernel's and are
 * never shown or used on the page.
 */
/** Thursday 10:00, open until 18:00 today. */
const OPEN_EN = {
  open: true,
  until: '2026-10-29T18:00:00-07:00',
  opens_at: null,
  text: 'Open now, until 6:00 pm',
  as_of: '2026-10-29T10:00:00-07:00',
  refresh_at: '2026-10-29T18:00:00-07:00',
};
/** Thursday 19:00, closed until 8:00 tomorrow. */
const CLOSED_EN = {
  open: false,
  until: null,
  opens_at: '2026-10-30T08:00:00-07:00',
  text: 'Closed now. Opens tomorrow at 8:00 am',
  as_of: '2026-10-29T19:00:00-07:00',
  refresh_at: '2026-10-30T00:00:00-07:00',
};
/** Open all week: the shortest line. */
const OPEN_ALL_WEEK = {
  open: true,
  until: null,
  opens_at: null,
  text: 'Open now',
  as_of: '2026-10-29T10:00:00-07:00',
  refresh_at: '2026-10-30T00:00:00-07:00',
};
/** In Spanish, Saturday 14:00, closed until Monday at 8:00 (after the clocks fall back). */
const CLOSED_ES = {
  open: false,
  until: null,
  opens_at: '2026-11-02T08:00:00-08:00',
  text: 'Cerrado ahora. Abre el lunes a las 8:00',
  as_of: '2026-10-31T14:00:00-07:00',
  refresh_at: '2026-11-01T00:00:00-07:00',
};
/** In Spanish, Wednesday 10:00, open until midnight at the end of Friday: the longest line. */
const OPEN_ES_LONGEST = {
  open: true,
  until: '2026-10-31T00:00:00-07:00',
  opens_at: null,
  text: 'Abierto ahora, hasta el viernes a medianoche',
  as_of: '2026-10-28T10:00:00-07:00',
  refresh_at: '2026-10-29T00:00:00-07:00',
};
/** The shell's own line under a closed status. */
const STILL_HELPS = { en: 'Claude can still help.', es: 'Claude puede ayudarte igual.' };

/** The header's element, or a thrown error naming what is missing. */
function partOf(header: HTMLElement, selector: string): HTMLElement {
  const el = header.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no ${selector} in the header`);
  return el;
}

/**
 * The header's open status reading `text`: the kernel's words as written, in meta type and the
 * name's ink, with an `aria-hidden` dot on the middle of their first line.
 */
async function openStatusIn(header: HTMLElement, text: string): Promise<{ status: HTMLElement; line: HTMLElement; dot: HTMLElement }> {
  const line = lineReading(header, text);
  await expect(line).toHaveAttribute('data-copy', 'user');
  // Only the kernel's words: none of the times that come with them.
  await expect(header).not.toHaveTextContent(/\d{4}-\d{2}-\d{2}/);
  const status = line.closest<HTMLElement>('.cd-public-shell__open-status');
  const dot = status?.querySelector<HTMLElement>('.cd-status-dot');
  if (!status || !dot) throw new Error(`no open status with a dot around "${text}"`);
  await expect(dot).toHaveAttribute('aria-hidden', 'true');
  expectComputed(line, {
    fontSize: '13px',
    lineHeight: '18px',
    color: getComputedStyle(partOf(header, '.cd-public-shell__brand-name')).color,
  });
  // The words keep 4.5:1 over the field, the dot 3:1.
  await expect(contrastRatio(getComputedStyle(line).color, groundOf(line))).toBeGreaterThanOrEqual(4.5);
  const dotStyle = getComputedStyle(dot);
  const dotColor = dotStyle.backgroundColor === 'rgba(0, 0, 0, 0)' ? dotStyle.borderTopColor : dotStyle.backgroundColor;
  await expect(contrastRatio(dotColor, groundOf(status))).toBeGreaterThanOrEqual(3);
  const dotBox = dot.getBoundingClientRect();
  await expect(dotBox.top + dotBox.height / 2 - line.getBoundingClientRect().top).toBe(9);
  return { status, line, dot };
}

/** Open: a filled dot, and the kernel's words are the status's only line. */
async function expectOpen(status: HTMLElement, dot: HTMLElement): Promise<void> {
  expectComputed(dot, { backgroundColor: 'rgb(111, 168, 89)' });
  await expect(status.querySelectorAll('p')).toHaveLength(1);
  await expect(status).not.toHaveTextContent('Claude');
}

/**
 * Closed: a hollow dot, and under the kernel's words the shell's quieter line in the page's
 * language, in meta type and the tagline's ink, lined up with the words.
 */
async function expectClosed(header: HTMLElement, status: HTMLElement, line: HTMLElement, dot: HTMLElement, help: string): Promise<void> {
  expectComputed(dot, { backgroundColor: 'rgba(0, 0, 0, 0)', borderTopWidth: '1px', borderTopStyle: 'solid' });
  await expect(dot).toHaveClass('cd-status-dot--info');
  const helpLine = lineReading(status, help);
  await expect(helpLine).not.toHaveAttribute('data-copy');
  expectComputed(helpLine, {
    fontSize: '13px',
    lineHeight: '18px',
    color: getComputedStyle(partOf(header, '.cd-public-shell__tagline')).color,
  });
  await expect(contrastRatio(getComputedStyle(helpLine).color, groundOf(helpLine))).toBeGreaterThanOrEqual(4.5);
  const words = line.getBoundingClientRect();
  const helpBox = helpLine.getBoundingClientRect();
  await expect(helpBox.left).toBe(words.left);
  await expect(helpBox.top).toBe(words.bottom + 2);
  await expect(status.querySelectorAll('p')).toHaveLength(2);
}

/** On a wide page: at the right end of the header's one row, level with the monogram, the header no taller. */
async function expectAtTheRight(header: HTMLElement, status: HTMLElement): Promise<void> {
  const box = header.getBoundingClientRect();
  const statusBox = status.getBoundingClientRect();
  const monogram = partOf(header, '.cd-public-shell__monogram').getBoundingClientRect();
  await expect(statusBox.right).toBe(box.right - parseFloat(getComputedStyle(header).paddingRight));
  await expect(statusBox.top + statusBox.height / 2).toBeCloseTo(monogram.top + monogram.height / 2, 0);
  await expect(box.height).toBe(76);
}

/**
 * On a phone: the status on its own line under the monogram and the name, 8 px below them and from
 * the left gutter, each of its lines on one line, and nothing reaching past the phone's width.
 */
async function expectOwnLineOnAPhone(phone: HTMLElement, header: HTMLElement, status: HTMLElement): Promise<void> {
  await expect(phone.scrollWidth).toBeLessThanOrEqual(PHONE);
  const edge = phone.getBoundingClientRect().right;
  for (const el of header.querySelectorAll('*')) await expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(edge + 0.5);
  const monogram = partOf(header, '.cd-public-shell__monogram').getBoundingClientRect();
  const brandText = partOf(header, '.cd-public-shell__brand-text').getBoundingClientRect();
  const box = status.getBoundingClientRect();
  await expect(box.top).toBeCloseTo(Math.max(monogram.bottom, brandText.bottom) + 8, 1);
  await expect(box.left).toBe(monogram.left);
  await expect(box.left).toBe(header.getBoundingClientRect().left + 16);
  for (const line of status.querySelectorAll('p')) await expect(line.getBoundingClientRect().height).toBe(18);
}

const phone: Pick<Story, 'decorators'> = {
  decorators: [
    (Story) => (
      <div data-testid="phone" style={{ width: PHONE }}>
        <Story />
      </div>
    ),
  ],
};

/** The Spanish page, as `RiveraEs` sets it up. */
const spanish = {
  brand: brandOf(desk.es),
  language: 'es',
  about: desk.es.charter,
  composer: composer.es,
  children: <Conversation language="es" />,
} satisfies Story['args'];

/** Below the board's header, the page is the board's. */
const ABOUT_NOTE = "The about column shows the charter's cards, not the board's free text and quote.";

export const OpenNow: Story = {
  args: { openStatus: OPEN_EN },
  parameters: {
    canvasNote: `The board's header with the open status at its right, as the "Open now" sign-off board places it: a filled dot and the kernel's words. ${ABOUT_NOTE}`,
  },
  play: async ({ canvas }) => {
    const header = canvas.getByRole('banner');
    const { status, dot } = await openStatusIn(header, OPEN_EN.text);
    await expectOpen(status, dot);
    await expectAtTheRight(header, status);
  },
};

export const ClosedNow: Story = {
  args: { openStatus: CLOSED_EN },
  parameters: {
    canvasNote: `The board's header with the closed status at its right, as the "Open now" sign-off board places it: a hollow dot, the kernel's words and "Claude can still help." under them. ${ABOUT_NOTE}`,
  },
  play: async ({ canvas }) => {
    const header = canvas.getByRole('banner');
    const { status, line, dot } = await openStatusIn(header, CLOSED_EN.text);
    await expectClosed(header, status, line, dot, STILL_HELPS.en);
    await expectAtTheRight(header, status);
  },
};

export const ClosedNowEsPhone: Story = {
  ...phone,
  args: { ...spanish, openStatus: CLOSED_ES },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The "Open now" sign-off board\'s phone header in Spanish: N-Public-Rivera at 390 px, with the closed status and "Claude puede ayudarte igual." on their own lines under the name and tagline.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'es');
    const header = canvas.getByRole('banner');
    const { status, line, dot } = await openStatusIn(header, CLOSED_ES.text);
    await expectClosed(header, status, line, dot, STILL_HELPS.es);
    await expect(header).not.toHaveTextContent(STILL_HELPS.en);
    await expectOwnLineOnAPhone(canvas.getByTestId('phone'), header, status);
  },
};

export const OpenNowEsLongestPhone: Story = {
  ...phone,
  args: { ...spanish, openStatus: OPEN_ES_LONGEST },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The "Open now" sign-off board\'s phone header with the longest Spanish line: N-Public-Rivera at 390 px, the status on its own line under the name, still on one line.',
  },
  play: async ({ canvas }) => {
    const header = canvas.getByRole('banner');
    const { status, dot } = await openStatusIn(header, OPEN_ES_LONGEST.text);
    await expectOpen(status, dot);
    await expectOwnLineOnAPhone(canvas.getByTestId('phone'), header, status);
  },
};

export const OpenAllWeekPhone: Story = {
  ...phone,
  args: { openStatus: OPEN_ALL_WEEK },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The "Open now" sign-off board\'s phone header with the shortest line: N-Public-Rivera at 390 px, the status on its own line under the name even though it would fit beside it.',
  },
  play: async ({ canvas }) => {
    const header = canvas.getByRole('banner');
    const { status, dot } = await openStatusIn(header, OPEN_ALL_WEEK.text);
    await expectOpen(status, dot);
    await expectOwnLineOnAPhone(canvas.getByTestId('phone'), header, status);
  },
};

export const NoOpenStatus: Story = {
  args: { openStatus: undefined },
  parameters: {
    canvasNote: `A Desk without hours: the kernel sends no open status, so the header is the board's without the "Open now" line. ${ABOUT_NOTE}`,
  },
  play: async ({ canvas }) => {
    // No line and no dot: the header holds the monogram and the name, as it does with no status at all.
    const header = canvas.getByRole('banner');
    await expect(header.querySelector('.cd-status-dot')).toBeNull();
    await expect([...header.children].map((child) => child.className)).toEqual([
      'cd-public-shell__monogram cd-type-page-title',
      'cd-public-shell__brand-text',
    ]);
    expectComputed(header, { rowGap: '4px' });
    // The name takes the row up to the right gutter, and the header stays one row tall.
    const box = header.getBoundingClientRect();
    await expect(partOf(header, '.cd-public-shell__brand-text').getBoundingClientRect().right).toBe(box.right - 40);
    await expect(box.height).toBe(76);
  },
};
