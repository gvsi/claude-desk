import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, fn, within } from 'storybook/test';

import type { EvMessage, PublicDesk, SseEvent, StatusEvent } from '../../../api/contracts.ts';
import { contrastRatio } from '../../contrast.ts';
import { rivera, type TranscriptTurn } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { FollowTheChat } from '../../test/followTheChat.tsx';
import { loadWebFonts } from '../../test/fonts.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { Composer } from '../Composer/Composer.tsx';
import { MarginReceipt } from '../MarginReceipt/MarginReceipt.tsx';
import { receiptFromEvent } from '../MarginReceipt/receiptTone.ts';
import { PersonMessage } from '../PersonMessage/PersonMessage.tsx';
import { initialsOf } from '../Sidebar/Sidebar.tsx';
import { SystemLine } from '../SystemLine/SystemLine.tsx';
import { Transcript } from '../Transcript/Transcript.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { VISION_INERT_LINE } from '../VisionBar/visionInert.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { PublicShell, type PublicBrand } from './PublicShell.tsx';
import { PublicShellSkeleton } from './PublicShellSkeleton.tsx';

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
    canvas: 'N-Public-Rivera-Run1',
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
 * about_opens_the_scroll_region: too narrow for the about column beside the chat, it is the first
 * thing in the conversation's scroll region, under the chat's head and above the conversation, the
 * region's full width.
 */
async function expectAboutAtopTheConversation(root: HTMLElement, about: HTMLElement, width: number): Promise<void> {
  const region = about.closest<HTMLElement>('.cd-public-shell__scroll');
  const head = root.querySelector<HTMLElement>('.cd-public-shell__chat-head');
  const log = root.querySelector<HTMLElement>('[role="log"]');
  if (!region || !head || !log) throw new Error('the about column is not in the scroll region, or there is no chat head or log');
  await expect(region.firstElementChild).toBe(about);
  await expect(about.getBoundingClientRect().top).toBe(head.getBoundingClientRect().bottom);
  await expect(log.getBoundingClientRect().top).toBeGreaterThanOrEqual(about.getBoundingClientRect().bottom);
  await expect(about.getBoundingClientRect().width).toBe(width);
  expectComputed(about, { borderTopWidth: '0px', borderLeftWidth: '0px', borderBottomWidth: '1px' });
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
    // A real page has no vision line, before or after asking.
    await expect(canvasElement.querySelector('.cd-vision-inert-line')).toBeNull();

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

/** A small tablet's width, where there is no room for the about column beside the chat. */
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
    canvasNote:
      'No board shows the public page at 800 px. There is no room for the about column of N-Public-Rivera-Run1 beside the chat, and the page never scrolls, so the column opens the conversation\'s scroll region, above the first message; the rows still fill the chat column.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByTestId('tablet').getBoundingClientRect().width).toBe(TABLET);
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expectAboutAtopTheConversation(canvasElement, about, TABLET);
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
    canvasNote:
      "N-Public-Rivera-Run1 on a phone, with 16 px gutters. The phone board draws the about column under the footer on a page that scrolls; the page never scrolls now, so the column opens the conversation's scroll region instead, above the first message, and scrolls away as the chat goes on.",
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
    // The about column opens the conversation's scroll region, the phone's full width, with the
    // gutters inside it.
    const about = canvas.getByRole('complementary', { name: 'About Rivera Plumbing' });
    await expectAboutAtopTheConversation(canvasElement, about, PHONE);
    expectComputed(about, { paddingLeft: '16px', paddingRight: '16px' });
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
      "No board shows the public page inside Today; it is N-Public-Rivera-Run1 in the owner's 420 px panel, without the footer, which the owner screen has its own of.",
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

/** Under a full-width line, as the vision page for a Claude account draws the vision bar over the public page. */
export const WithBanner: Story = {
  args: {
    banner: (
      <div role="note" aria-label="Vision" style={{ height: 40, background: 'var(--bg-panel)' }}>
        Vision
      </div>
    ),
  },
  parameters: {
    canvas: 'N-R2-Vision-ClaudeAccount',
    canvasNote: 'Only the banner’s place is checked here: a 40 px line over the brand header, the page still the window’s height.',
  },
  play: async ({ canvas, canvasElement }) => {
    // public_shell_banner_over_the_header: first in the shell, full width, then the brand header right under it.
    const banner = canvas.getByRole('note', { name: 'Vision' });
    const shell = canvasElement.querySelector<HTMLElement>('.cd-public-shell')!;
    await expect(shell.firstElementChild?.contains(banner)).toBe(true);
    await expect(banner.getBoundingClientRect().top).toBe(0);
    await expect(banner.getBoundingClientRect().width).toBe(document.documentElement.clientWidth);
    const header = canvas.getByRole('banner');
    await expect(header.getBoundingClientRect().top).toBe(40);
    // The banner is inside the window's height, not added to it: the shell stays as tall as the window.
    await expect(Math.round(shell.getBoundingClientRect().height)).toBe(window.innerHeight);
  },
};

/** On a vision page, which makes no requests: "Ask for {owner}" looks and focuses as ever, and asks for no one. */
export const InertAsk: Story = {
  args: { inertAsk: true },
  parameters: {
    canvas: 'N-R2-Vision-CityOffice-Resident',
    canvasNote: 'The vision pages’ public chats (the city office and the Claude account): Ask for {owner} keeps its look and place, and pressing it sends nothing.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // inert_ask_sends_nothing: a click and a key press each leave the page as it was.
    const main = canvas.getByRole('main');
    const head = canvasElement.querySelector<HTMLElement>('.cd-public-shell__chat-head')!;
    const ask = within(main).getByRole('button', { name: 'Ask for Maria Rivera' });
    await expect(head).toContainElement(ask);
    expectComputed(ask, { height: '32px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
    // A polite live region waits in the chat's pinned head, empty and taking no room until the first
    // press: the head keeps its height.
    const lines = [...canvasElement.querySelectorAll<HTMLElement>('.cd-vision-inert-line')];
    await expect(lines).toHaveLength(1);
    const status = lines[0] as HTMLElement;
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveTextContent(/^$/);
    await expect(status.getBoundingClientRect().height).toBeLessThanOrEqual(1);
    await expect(head).toContainElement(status);
    const headHeight = head.getBoundingClientRect().height;
    const title = head.querySelector<HTMLElement>('.cd-public-shell__chat-title')!;
    const rowBottom = () => Math.max(title.getBoundingClientRect().bottom, ask.getBoundingClientRect().bottom);
    await userEvent.click(ask);
    await expect(ask).toHaveFocus();
    await expect(args.onAskForOwner).not.toHaveBeenCalled();
    // vision_inert_line_on_first_press: the first press fills it with the one line, in a secondary
    // caption on a row of its own in the pinned head, 8 px under the title and Ask, above the
    // head's hairline, the column's width.
    await expect(status).toHaveTextContent(VISION_INERT_LINE);
    expectComputed(status, { fontSize: '12px', lineHeight: '17px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(Math.round(status.getBoundingClientRect().top - rowBottom())).toBe(8);
    await expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(head.getBoundingClientRect().bottom);
    await expect(Math.round(status.getBoundingClientRect().width)).toBe(Math.round(head.getBoundingClientRect().width));
    await expect(Math.round(head.getBoundingClientRect().height - headHeight)).toBe(8 + 17);
    // Enter on it sends nothing either, and a second press changes nothing: still the one line.
    await userEvent.keyboard('{Enter}');
    await expect(args.onAskForOwner).not.toHaveBeenCalled();
    await expect(ask).toHaveFocus();
    await expect(canvas.getAllByText(VISION_INERT_LINE)).toEqual([status]);
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
    // list_role_survives_unstyled_markers: Safari announces the links' list only with role="list".
    await expect(about.querySelector('.cd-public-shell__link-list')).toHaveAttribute('role', 'list');
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
/** In Spanish, Wednesday 10:00, open until midnight at the end of Friday: the copy table's longest open line. */
const OPEN_ES_FRIDAY_MIDNIGHT = {
  open: true,
  until: '2026-10-31T00:00:00-07:00',
  opens_at: null,
  text: 'Abierto ahora, hasta el viernes a medianoche',
  as_of: '2026-10-28T10:00:00-07:00',
  refresh_at: '2026-10-29T00:00:00-07:00',
};
/**
 * In Spanish, Wednesday 14:00 after Wednesday's hours, closed until 13:00 a week ahead: the longest
 * line the kernel writes, with "el próximo", the longest weekday and a two-digit hour, wider than
 * any open line, and the closed line under it.
 */
const CLOSED_ES_LONGEST = {
  open: false,
  until: null,
  opens_at: '2026-11-04T13:00:00-08:00',
  text: 'Cerrado ahora. Abre el próximo miércoles a las 13:00',
  as_of: '2026-10-28T14:00:00-07:00',
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
 * language, in caption type and the tagline's ink, lined up with the words.
 */
async function expectClosed(header: HTMLElement, status: HTMLElement, line: HTMLElement, dot: HTMLElement, help: string): Promise<void> {
  expectComputed(dot, { backgroundColor: 'rgba(0, 0, 0, 0)', borderTopWidth: '1px', borderTopStyle: 'solid' });
  await expect(dot).toHaveClass('cd-status-dot--info');
  const helpLine = lineReading(status, help);
  await expect(helpLine).not.toHaveAttribute('data-copy');
  expectComputed(helpLine, {
    fontSize: '12px',
    lineHeight: '17px',
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
  // The kernel's words on one meta line, and the closed line on one caption line.
  for (const line of status.querySelectorAll('p')) {
    const caption = line.classList.contains('cd-public-shell__still-helps');
    await expect(line.getBoundingClientRect().height).toBe(caption ? 17 : 18);
  }
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
      'The "Open now" sign-off board\'s phone header in Spanish: N-Public-Rivera-Run1 at 390 px, with the closed status and "Claude puede ayudarte igual." on their own lines under the name and tagline.',
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

export const OpenNowEsUntilFridayMidnightPhone: Story = {
  ...phone,
  args: { ...spanish, openStatus: OPEN_ES_FRIDAY_MIDNIGHT },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The "Open now" sign-off board\'s phone header with the copy table\'s longest Spanish open line: N-Public-Rivera-Run1 at 390 px, the status on its own line under the name, still on one line.',
  },
  play: async ({ canvas }) => {
    const header = canvas.getByRole('banner');
    const { status, dot } = await openStatusIn(header, OPEN_ES_FRIDAY_MIDNIGHT.text);
    await expectOpen(status, dot);
    await expectOwnLineOnAPhone(canvas.getByTestId('phone'), header, status);
  },
};

export const ClosedNowEsLongestPhone: Story = {
  ...phone,
  args: { ...spanish, openStatus: CLOSED_ES_LONGEST },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The "Open now" sign-off board\'s phone header with the longest Spanish status: N-Public-Rivera-Run1 at 390 px, closed until next Wednesday at 13:00 with "Claude puede ayudarte igual." under it, on their own lines under the name. Each still fits on one line, and nothing reaches past the phone\'s edge.',
  },
  play: async ({ canvas }) => {
    const header = canvas.getByRole('banner');
    const { status, line, dot } = await openStatusIn(header, CLOSED_ES_LONGEST.text);
    await expectClosed(header, status, line, dot, STILL_HELPS.es);
    await expectOwnLineOnAPhone(canvas.getByTestId('phone'), header, status);
  },
};

export const OpenAllWeekPhone: Story = {
  ...phone,
  args: { openStatus: OPEN_ALL_WEEK },
  parameters: {
    canvas: 'none',
    canvasNote:
      'The "Open now" sign-off board\'s phone header with the shortest line: N-Public-Rivera-Run1 at 390 px, the status on its own line under the name even though it would fit beside it.',
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

/** Half of a 1280 px board: each state of the handoff board is a whole page 640 px wide. */
const HALF = 640;

export const HalfWidth: Story = {
  args: { openStatus: OPEN_EN },
  decorators: [
    (Story) => (
      <div data-testid="half" style={{ width: HALF }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    canvas: 'N-Public-Handoff-Run1',
    canvasNote: 'One state of the board, 640 px wide: 16 px gutters, with the open status still at the right of the name, where the board labels the state.',
  },
  play: async ({ canvas }) => {
    // Under 720 px the gutters are 16 px, header and chat alike, as the board draws each half.
    const header = canvas.getByRole('banner');
    expectComputed(header, { paddingLeft: '16px', paddingRight: '16px', height: '76px' });
    expectComputed(canvas.getByRole('main'), { paddingLeft: '16px', paddingRight: '16px' });
    // From 640 px up the open status stays on the name's line, at the right; only a phone wraps it.
    const status = within(header).getByText(OPEN_EN.text);
    const name = within(header).getByRole('heading', { level: 1, name: 'Rivera Plumbing' });
    await expect(status.getBoundingClientRect().left).toBeGreaterThan(name.getBoundingClientRect().right);
    await expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(header.getBoundingClientRect().bottom);
    await expect(canvas.getByTestId('half').scrollWidth).toBeLessThanOrEqual(HALF);
  },
};

// The owner in the chat: take-over option A, signed on 2026-10-30.

/** The chat head's line while Maria is in the chat, in place of the disclosure. */
const OWNER_IN_CHAT = {
  en: 'Maria Rivera is in this chat. Claude, an AI, is paused until Maria Rivera hands it back.',
  es: 'Maria Rivera está en este chat. Claude, una IA, está en pausa hasta que Maria Rivera le devuelva el chat.',
};

/**
 * The line the page writes in the chat as the owner joins, in the visitor's language: a stand-in for
 * `joined` in web/src/public/copy.ts, which the design system doesn't import.
 */
const JOINED = { en: (name: string) => `${name} joined the chat`, es: (name: string) => `${name} se unió al chat` };

/**
 * Maria in the chat, from the Rivera fixture. In English: Dana asks for her, the kernel's handoff
 * card, then the take-over's events as the stream delivers them, less her hand-back. In Spanish:
 * Lucía's chat from her ask for Maria to Maria's words.
 */
const TAKE_OVER: Record<'en' | 'es', TranscriptTurn[]> = {
  en: [
    { kind: 'visitor', text: `I'd like to talk to ${ownerName}.` },
    required(
      rivera.events.heldTurn.flatMap((event): TranscriptTurn[] => (event.type === 'message' ? [{ kind: 'event', event }] : []))[0],
      'handoff reply',
    ),
    ...rivera.events.takeOver.flatMap((event): TranscriptTurn[] => (event.type === 'owner_left' ? [] : [{ kind: 'event', event }])),
  ],
  es: (() => {
    const turns = rivera.conversations.lucia.turns;
    const ask = turns.findIndex((turn) => turn.kind === 'visitor' && turn.text.includes('hablar con Maria'));
    const said = turns.findIndex((turn) => turn.kind === 'event' && turn.event.type === 'message' && turn.event.author === 'owner');
    if (ask < 0 || said < ask) throw new Error("the Rivera fixture has no Spanish take-over in Lucía's chat");
    return turns.slice(ask, said + 1);
  })(),
};

/**
 * The take-over's rows, as the public page draws them: the visitor's words, Claude's and Maria's
 * messages with their receipts under them, and the line that says Maria joined; the chat's end is
 * kept above the composer. Not the boards' `TurnRows`: that is for the `Boards/*` stories only, and
 * writes the joined line in English only.
 */
function TakeOverConversation({ language }: { language: 'en' | 'es' }) {
  const rows: ReactNode[] = [];
  let pending: StatusEvent[] = [];
  TAKE_OVER[language].forEach((turn, index) => {
    if (turn.kind === 'visitor') {
      rows.push(
        <TranscriptRow key={index}>
          <VisitorMessage text={turn.text} />
        </TranscriptRow>,
      );
      return;
    }
    if (turn.kind !== 'event') return;
    const { event } = turn;
    if (event.type === 'receipt' || event.type === 'held' || event.type === 'resolved') {
      pending.push(event);
    } else if (event.type === 'owner_joined') {
      rows.push(
        <TranscriptRow key={index}>
          <SystemLine text={JOINED[language](event.name)} initials={initialsOf(event.name)} />
        </TranscriptRow>,
      );
    } else if (event.type === 'message') {
      const margin = [...pending, event].map((each) => {
        const view = receiptFromEvent(each);
        return <MarginReceipt key={view.ledgerSeq} {...view} />;
      });
      pending = [];
      rows.push(
        <TranscriptRow key={index} margin={margin}>
          {event.author === 'owner' ? (
            <PersonMessage name={ownerName} blocks={event.blocks} language={event.language} />
          ) : (
            <ClaudeMessage blocks={event.blocks} language={event.language} ownerName={ownerName} />
          )}
        </TranscriptRow>,
      );
    }
  });
  return (
    <>
      <Transcript label={language === 'en' ? 'Conversation with Rivera Plumbing' : 'Conversación con Rivera Plumbing'}>{rows}</Transcript>
      <FollowTheChat />
    </>
  );
}

/**
 * owner_in_chat_line: the chat's head says Maria is in the chat and Claude, an AI, is paused, on the
 * disclosure's own line and in its type, both of her names marked as written by someone; the usual
 * disclosure and "Ask for Maria Rivera" aren't there. Under the head, the line that says she joined,
 * then her words, in view above the composer.
 */
async function expectOwnerInChat(root: HTMLElement, language: 'en' | 'es'): Promise<void> {
  const head = root.querySelector<HTMLElement>('.cd-public-shell__chat-head');
  if (!head) throw new Error('no chat head');
  const line = lineReading(head, OWNER_IN_CHAT[language]);
  await expect(line).toHaveClass('cd-public-shell__disclosure', 'cd-type-meta');
  expectComputed(line, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)' });
  await expect([...line.querySelectorAll('[data-copy="user"]')].map((name) => name.textContent)).toEqual([ownerName, ownerName]);
  await expect(root).not.toHaveTextContent(DISCLOSURE[language]);
  await expect(head.querySelectorAll('button')).toHaveLength(0);
  const joined = [...root.querySelectorAll<HTMLElement>('[role="status"]')].find(
    (status) => status.querySelector('.cd-system-line__text')?.textContent === JOINED[language](ownerName),
  );
  const said = root.querySelector<HTMLElement>('.cd-person-message');
  if (!joined || !said) throw new Error('no line that says Maria joined, or no words of hers');
  await expect(joined.getBoundingClientRect().top).toBeGreaterThanOrEqual(head.getBoundingClientRect().bottom);
  await expect(said.getBoundingClientRect().top).toBeGreaterThan(joined.getBoundingClientRect().bottom);
  await expect(said).toHaveTextContent(ownerName);
  // Both in view, between the head and the composer, where the page keeps the end of the chat.
  const composerArea = root.querySelector<HTMLElement>('.cd-public-shell__composer');
  await expect(said.getBoundingClientRect().bottom).toBeLessThanOrEqual(composerArea?.getBoundingClientRect().top ?? 0);
}

const ownerInChatNote =
  'The chat head of take-over option A: while Maria is in the chat it says so and that Claude, an AI, is paused until she hands it back, and Ask for Maria isn’t shown. Built from the signed option; its render and the by-eye comparison are tracked in issue #230. The conversation is the fixture’s take-over, its end kept above the composer as the page keeps it, and the about column shows the charter’s cards.';

export const OwnerInChat: Story = {
  args: { ownerInChat: true, openStatus: OPEN_EN, children: <TakeOverConversation language="en" /> },
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { canvas: 'N-R2-TakeOver-A-1512-EN', canvasNote: ownerInChatNote },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerInChat(canvas.getByRole('main'), 'en');
    await expect(canvas.queryByRole('button', { name: 'Ask for Maria Rivera' })).toBeNull();
    // The rest of the page is as ever: the about column beside the chat, the composer at its foot.
    await expect(canvas.getByRole('complementary', { name: 'About Rivera Plumbing' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Message Rivera Plumbing' })).toBeVisible();
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'en');
  },
};

export const OwnerInChatPhone: Story = {
  args: { ownerInChat: true, openStatus: OPEN_EN, children: <TakeOverConversation language="en" /> },
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-R2-TakeOver-A-390-EN', canvasNote: ownerInChatNote },
  play: async ({ canvas, canvasElement }) => {
    await expect(window.innerWidth).toBe(PHONE);
    await expectOwnerInChat(canvas.getByRole('main'), 'en');
    // No sideways scroll: nothing reaches past the phone's width, the paused line wraps inside it.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE);
    for (const el of canvasElement.querySelectorAll('.cd-public-shell *')) {
      await expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(PHONE + 0.5);
    }
  },
};

export const OwnerInChatEs: Story = {
  args: { ...spanish, ownerInChat: true, openStatus: CLOSED_ES, children: <TakeOverConversation language="es" /> },
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    canvas: 'N-R2-TakeOver-A-1512-EN',
    canvasNote: `${ownerInChatNote} The board is in English; the same page in Spanish, with Lucía’s take-over from the fixture.`,
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'es');
    await expectOwnerInChat(canvas.getByRole('main'), 'es');
    await expect(canvas.queryByRole('button', { name: 'Pedir hablar con Maria Rivera' })).toBeNull();
    await expect(canvasElement).not.toHaveTextContent('is in this chat');
  },
};

// No owner name: the owner gave none in setup (issue #335).

/**
 * The chat head's words for a Desk whose owner gave no name: the shell's own, with no name in
 * them, in the owner's approved words.
 */
const NO_NAME = {
  en: {
    disclosure: "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for a person anytime.",
    ask: 'Ask for a person',
    ownerInChat: 'The business owner is in this chat. Claude, an AI, is paused until they hand it back.',
  },
  es: {
    disclosure: 'Estás hablando con Claude, una IA que responde por Rivera Plumbing. Puedes pedir hablar con una persona cuando quieras.',
    ask: 'Pedir hablar con una persona',
    ownerInChat: 'El dueño del negocio está en este chat. Claude, una IA, está en pausa hasta que le devuelva el chat.',
  },
};

const noNameNote =
  'No board draws this yet: N-Public-Rivera-Run1 for a Desk whose owner gave no name in setup, so the page has no one to name. The disclosure and Ask say "a person" instead, and the owner-in-chat line names no one, in the owner’s approved words (issue #335).';

/**
 * no_owner_name_asks_for_a_person: the disclosure and Ask say "a person", in the shell's own words:
 * the business's name is the only name marked as written by someone, and Ask is one run of text.
 */
async function expectAskForAPerson(main: HTMLElement, language: 'en' | 'es'): Promise<HTMLElement> {
  const line = lineReading(main, NO_NAME[language].disclosure);
  await expect(line).toBeVisible();
  await expect([...line.querySelectorAll('[data-copy="user"]')].map((name) => name.textContent)).toEqual(['Rivera Plumbing']);
  const ask = within(main).getByRole('button', { name: NO_NAME[language].ask });
  await expect([...ask.childNodes].map((node) => node.textContent)).toEqual([NO_NAME[language].ask]);
  await expect(ask.querySelector('[data-copy="user"]')).toBeNull();
  await expect(main.querySelector('.cd-public-shell__chat-head')).not.toHaveTextContent(/Owner|Maria/);
  return ask;
}

/**
 * no_owner_name_in_chat_line: the head's line while the owner is in the chat names no one, still
 * names Claude as an AI, on the disclosure's own line and in its type, and there is no Ask.
 */
async function expectNoNameOwnerInChat(root: HTMLElement, language: 'en' | 'es'): Promise<void> {
  const head = root.querySelector<HTMLElement>('.cd-public-shell__chat-head');
  if (!head) throw new Error('no chat head');
  const line = lineReading(head, NO_NAME[language].ownerInChat);
  await expect(line).toHaveClass('cd-public-shell__disclosure', 'cd-type-meta');
  await expect(line.querySelector('[data-copy="user"]')).toBeNull();
  await expect(root).not.toHaveTextContent(NO_NAME[language].disclosure);
  await expect(head.querySelectorAll('button')).toHaveLength(0);
}

export const NoOwnerName: Story = {
  args: { ownerName: null },
  parameters: { canvas: 'none', canvasNote: noNameNote },
  play: async ({ args, canvas, userEvent }) => {
    const ask = await expectAskForAPerson(canvas.getByRole('main'), 'en');
    await userEvent.click(ask);
    await expect(args.onAskForOwner).toHaveBeenCalledTimes(1);
  },
};

export const NoOwnerNameEs: Story = {
  args: { ...spanish, ownerName: null },
  parameters: { canvas: 'none', canvasNote: `${noNameNote} In Spanish, as a visitor whose browser asks for it reads it.` },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(canvasElement.querySelector('.cd-public-shell')).toHaveAttribute('lang', 'es');
    const ask = await expectAskForAPerson(canvas.getByRole('main'), 'es');
    await userEvent.click(ask);
    await expect(args.onAskForOwner).toHaveBeenCalledTimes(1);
    await expect(canvasElement).not.toHaveTextContent(/Ask for|anytime/);
  },
};

export const NoOwnerNameOwnerInChat: Story = {
  args: { ownerName: null, ownerInChat: true, openStatus: OPEN_EN },
  parameters: { canvas: 'none', canvasNote: `${noNameNote} Here the owner has taken the chat over.` },
  play: async ({ canvas }) => {
    await expectNoNameOwnerInChat(canvas.getByRole('main'), 'en');
  },
};

export const NoOwnerNameOwnerInChatEs: Story = {
  args: { ...spanish, ownerName: null, ownerInChat: true, openStatus: CLOSED_ES },
  parameters: { canvas: 'none', canvasNote: `${noNameNote} Here the owner has taken the chat over, in Spanish.` },
  play: async ({ canvas, canvasElement }) => {
    await expectNoNameOwnerInChat(canvas.getByRole('main'), 'es');
    await expect(canvasElement).not.toHaveTextContent('is in this chat');
  },
};

export const Skeleton: Story = {
  beforeEach: loadWebFonts,
  parameters: {
    canvas: 'none',
    canvasNote: 'P12-02, UXC-P1202-After (#artboard-d122e70134a0). Every load draws the first view: the greeting, its meta line, the inline composer and three starter chips. A first visit to a Desk with starters lands in place; a resumed chat keeps its head, and its composer moves down.',
  },
  render: (args) => (
    <div>
      <div data-real-shell>
        <PublicShell {...args} openStatus={OPEN_EN} firstView starters={{ words: desk.en.starters, onPick: fn() }} children={null} aboutLinks={[
          { label: 'What agents can do here', href: '/d/rivera/agents' },
          { label: 'Send an agent', href: '/d/rivera/agents#send' },
        ]} />
      </div>
      <div data-shaped-shell aria-hidden="true">
        <PublicShellSkeleton language={args.language} footer />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const real = canvasElement.querySelector<HTMLElement>('[data-real-shell]')!;
    const shapes = canvasElement.querySelector<HTMLElement>('[data-shaped-shell]')!;
    await expect(shapes.querySelector('button, a[href], input, textarea, [tabindex]')).toBeNull();
    const size = ['top', 'left', 'width', 'height'] as const;
    const line = ['top', 'left', 'height'] as const;
    // The greeting wraps to two lines on a phone, drawn as two shapes: the first marks its place.
    const place = ['top', 'left'] as const;
    const pairs = [
      ['brand-header', '.cd-public-brand', size],
      ['chat-title', '.cd-public-shell__chat-title > h2', line],
      ['disclosure', '.cd-public-shell__disclosure', line],
      ['chat-head', '.cd-public-shell__chat-head', size],
      ['ask-owner', '.cd-public-shell__chat-head > button', size],
      ['conversation', '.cd-public-shell__conversation', size],
      ['greeting', '.cd-public-shell__greeting', place],
      ['invitation', '.cd-public-shell__invitation', line],
      ['composer', '.cd-composer__box', size],
      ['starters', '.cd-public-shell__starters', size],
      ['concept-footer', '.cd-concept-footer', size],
      ['about-title', '.cd-public-shell__about > h2', line],
      ['about-column', '.cd-public-shell__about', size],
    ] as const;
    for (const [anchor, selector, edges] of pairs) {
      const a = real.querySelector(selector)!.getBoundingClientRect();
      const b = shapes.querySelector(`[data-skeleton-anchor="${anchor}"]`)!.getBoundingClientRect();
      const offset = real.getBoundingClientRect().top - shapes.getBoundingClientRect().top;
      for (const edge of edges) {
        await expect(Math.abs(a[edge] - b[edge] - (edge === 'top' ? offset : 0)), `${anchor} ${edge}: real ${a[edge]}, shape ${b[edge]}, offset ${offset}`).toBeLessThanOrEqual(2);
      }
    }
  },
};

export const SkeletonPhone: Story = {
  ...Skeleton,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const SkeletonShort: Story = {
  ...Skeleton,
  globals: { viewport: { value: 'skeleton-short', isRotated: false } },
  parameters: {
    ...Skeleton.parameters,
    viewport: { options: { 'skeleton-short': { name: 'Short phone', styles: { width: '390px', height: '480px' }, type: 'mobile' } } },
  },
};

/** A visitor has not asked anything yet: invitation, composer and the Desk's own starters. */
export const FirstViewEnglish: Story = {
  args: {
    firstView: true,
    openStatus: OPEN_EN,
    starters: { words: desk.en.starters, onPick: fn() },
    children: <Transcript label="Conversation with Rivera Plumbing">{null}</Transcript>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'How can Rivera Plumbing help?' })).toBeVisible();
    await expect(canvas.getByText('Try one of these, or ask in your own words.')).toBeVisible();
    await expect(within(canvas.getByRole('group', { name: 'Suggestions' })).getAllByRole('button')).toHaveLength(3);
  },
};

export const FirstViewSpanish: Story = {
  args: {
    ...FirstViewEnglish.args,
    language: 'es',
    about: desk.es.charter,
    openStatus: { ...OPEN_EN, text: 'Abierto ahora, hasta las 18:00' },
    composer: composer.es,
    starters: { words: desk.es.starters, onPick: fn() },
    children: <Transcript label="Conversación con Rivera Plumbing">{null}</Transcript>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '¿En qué te puede ayudar Rivera Plumbing?' })).toBeVisible();
    await expect(canvas.getByText('Prueba una de estas o pregunta con tus palabras.')).toBeVisible();
    await expect(within(canvas.getByRole('group', { name: 'Sugerencias' })).getAllByRole('button')).toHaveLength(3);
  },
};

export const FirstViewWithoutStarters: Story = {
  args: { ...FirstViewEnglish.args, starters: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'How can Rivera Plumbing help?' })).toBeVisible();
    await expect(canvas.queryByText('Try one of these, or ask in your own words.')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('group', { name: 'Suggestions' })).not.toBeInTheDocument();
  },
};
