/**
 * The public page is a column the window's height: the business's header and the AI disclosure at
 * the top, the composer at the bottom, and only the conversation scrolling between them. The
 * document itself never scrolls, so however long the chat gets, and wherever the visitor is in it,
 * the disclosure (part of the always-on baseline) stays on screen. The same rule as AppShell's.
 */
import { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';

import type { PublicDesk } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { chooseTheme } from '../../test/theme.ts';
import { Composer } from '../Composer/Composer.tsx';
import { Transcript } from '../Transcript/Transcript.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { VisitorMessage } from '../VisitorMessage/VisitorMessage.tsx';
import { PublicShell, type PublicBrand } from './PublicShell.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** A window's width and height. */
type Size = readonly [width: number, height: number];

/** A laptop, a phone, and the smallest phone the page is drawn for. */
const WINDOWS: readonly Size[] = [
  [1440, 900],
  [390, 844],
  [320, 568],
];

/**
 * Windows shorter than the pinned header, chat head and composer need: a phone turned on its side,
 * a short phone, and a 360 × 640 phone with its on-screen keyboard open.
 */
const SHORT: readonly Size[] = [
  [568, 320],
  [320, 480],
  [360, 380],
];

const DISCLOSURE = "You're chatting with Claude, an AI answering for Turner Plumbing. Ask for Mike Turner anytime.";

/** The chat head's line while Mike is in the chat, in place of the disclosure. */
const PAUSED = {
  en: 'Mike Turner is in this chat. Claude, an AI, is paused until Mike Turner hands it back.',
  es: 'Mike Turner está en este chat. Claude, una IA, está en pausa hasta que Mike Turner le devuelva el chat.',
} as const;

/** The long draft that once pushed the disclosure off a short window: six lines and a counter. */
const LONG_DRAFT = 'word '.repeat(380);

const desk = rivera.publicDesk.en;

/**
 * The longest open status line the kernel writes, in Spanish: Wednesday 14:00 after Wednesday's
 * hours, closed until 13:00 a week ahead, with the closed line under it. The Spanish page shows it.
 */
const CLOSED_ES_LONGEST = {
  open: false,
  until: null,
  opens_at: '2026-11-04T13:00:00-08:00',
  text: 'Cerrado ahora. Abre el próximo miércoles a las 13:00',
  as_of: '2026-10-28T14:00:00-07:00',
  refresh_at: '2026-10-29T00:00:00-07:00',
};

const OPEN_EN = {
  open: true,
  until: '2026-10-29T18:00:00-07:00',
  opens_at: null,
  text: 'Open now, until 6:00 pm',
  as_of: '2026-10-29T10:00:00-07:00',
  refresh_at: '2026-10-29T18:00:00-07:00',
};

/** A tagline that takes two lines on a phone. */
const TWO_LINE_TAGLINE = 'Fontanería de urgencia y calentadores de agua en Oakland';

/** A tagline that takes three lines on a phone on its side. */
const THREE_LINE_TAGLINE =
  'Fontanería de urgencia, calentadores de agua, desagües, tuberías y reformas de baños y cocinas para casas y negocios en Oakland, Berkeley, Alameda, Emeryville y Piedmont, de lunes a sábado';

/** The page's brand, as the screen maps `PublicDesk` to it. */
function brandOf(publicDesk: PublicDesk): PublicBrand {
  return {
    name: publicDesk.business_name,
    tagline: publicDesk.desk_name,
    monogram: Array.from(publicDesk.business_name)[0] ?? '',
    field: publicDesk.brand.primary ?? '',
    ink: 'var(--text-on-brand)',
    inkSecondary: 'var(--text-on-brand-secondary)',
    statusHandled: 'var(--status-handled-on-brand)',
    accent: publicDesk.brand.accent ?? '',
  };
}

interface LongChatOptions {
  /** English with the open status, or Spanish with the longest closed status. */
  language?: 'en' | 'es';
  /** The links for people's agents in the about column. */
  links?: boolean;
  /** A tagline in place of the Desk's name, long enough to wrap the header onto more lines. */
  tagline?: string;
  /** How many messages: 80 unless given. */
  rows?: number;
  /**
   * Keep the newest message just above the composer after every render, as the public chat page
   * does in a layout effect of its own, which runs after the shell's.
   */
  follow?: boolean;
  /** A 64 px line above the brand header, as the vision bar is. */
  banner?: boolean;
  /** Mike is in the chat: the take-over, from the stream's `owner_joined` until its `owner_left`. */
  ownerInChat?: boolean;
  /** The composer is disabled, as the page disables it while it can't send. */
  composerDisabled?: boolean;
  askDisabled?: boolean;
  /** The message, counted from 1, written long: several lines on a phone, fewer on a wider window. */
  longMessage?: number;
  /** A 61 px line above the composer, in its area, as the public chat shows one for a waiting request. */
  lineAbove?: boolean;
  /** The shell's `keepComposerRoom`. */
  keepComposerRoom?: boolean;
}

/** A long message's words: five lines or so on a phone. */
const LONG_MESSAGE =
  'the water heater in the garage is leaking from the bottom, the pilot light keeps going out, and there is a puddle by the floor drain. Can someone come out on Saturday morning, and is the call-out fee the same at the weekend?';

/** The element whose scrolling moves `el`: its nearest scrolling ancestor, as the public chat page finds it. */
function scrollerOfEl(el: Element): Element {
  for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * The public page with a chat of 80 messages, each with the screen-reader-only line a receipt
 * carries: absolutely placed, so it would stretch the document if the conversation's scroll region
 * didn't hold it. In English or Spanish, whose disclosure is longer, and with the links for
 * people's agents in the about column if asked.
 */
function LongChat({
  language = 'en',
  links = false,
  tagline,
  rows = 80,
  follow = false,
  banner = false,
  ownerInChat = false,
  composerDisabled = false,
  askDisabled = false,
  longMessage,
  lineAbove = false,
  keepComposerRoom = false,
}: LongChatOptions) {
  const page = rivera.publicDesk[language];
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const marker = end.current;
    const area = marker?.closest('.cd-public-shell')?.querySelector('.cd-public-shell__composer');
    if (!follow || !marker || !area) return;
    const hidden = marker.getBoundingClientRect().bottom - area.getBoundingClientRect().top;
    if (hidden > 0) scrollerOfEl(marker).scrollBy({ top: hidden, behavior: 'instant' });
  });
  return (
    <PublicShell
      brand={{ ...brandOf(page), ...(tagline ? { tagline } : {}) }}
      ownerName={rivera.business.ownerName}
      language={language}
      openStatus={language === 'es' ? CLOSED_ES_LONGEST : OPEN_EN}
      banner={banner ? <div data-testid="banner" style={{ height: 96 }} /> : undefined}
      ownerInChat={ownerInChat}
      askDisabled={askDisabled}
      keepComposerRoom={keepComposerRoom}
      onAskForOwner={() => {}}
      about={page.charter}
      aboutLinks={links ? [{ label: 'What agents can do here', href: `/d/${rivera.business.slug}/agents` }] : undefined}
      composer={
        <>
          {lineAbove ? <div data-testid="line-above" style={{ height: 61 }} /> : null}
          <Composer
            variant="visitor"
            label="Message Turner Plumbing"
            placeholder="Message Turner Plumbing"
            maxLength={2000}
            disabled={composerDisabled}
            onSend={() => {}}
          />
        </>
      }
    >
      <Transcript label="Conversation with Turner Plumbing">
        {Array.from({ length: rows }, (_, index) => (
          <TranscriptRow key={index}>
            <VisitorMessage
              text={`Message ${index + 1}: ${index + 1 === longMessage ? LONG_MESSAGE : 'is drain clearing the same price on a Saturday?'}`}
            />
            <span className="cd-sr-only">Reply checked before the visitor saw it.</span>
          </TranscriptRow>
        ))}
      </Transcript>
      <div ref={end} />
    </PublicShell>
  );
}

/** The public page with a chat of one message, and a charter of two cards. */
function ShortChat() {
  return (
    <PublicShell
      brand={brandOf(desk)}
      ownerName={rivera.business.ownerName}
      language="en"
      onAskForOwner={() => {}}
      about={desk.charter.slice(0, 2)}
      composer={<Composer variant="visitor" label="Message Turner Plumbing" placeholder="Message Turner Plumbing" maxLength={2000} onSend={() => {}} />}
    >
      <Transcript label="Conversation with Turner Plumbing">
        <TranscriptRow>
          <VisitorMessage text="Is drain clearing the same price on a Saturday?" />
        </TranscriptRow>
      </Transcript>
    </PublicShell>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  window.scrollTo(0, 0);
  await page.viewport(1280, 820);
});

/** Opens the long chat in a window of `size`, once the conversation has laid out. */
async function renderLongChat([width, height]: Size, options: LongChatOptions = {}): Promise<void> {
  act(() => root.render(null));
  await page.viewport(width, height);
  act(() => root.render(<LongChat {...options} />));
  await vi.waitFor(() => expect(container.querySelectorAll('.cd-transcript-row')).toHaveLength(options.rows ?? 80));
}

function one<T extends Element = HTMLElement>(selector: string): T {
  const el = container.querySelector<T>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

/** The line that reads the AI disclosure in full. */
function disclosure(): HTMLElement {
  const lines = [...container.querySelectorAll<HTMLElement>('p')].filter((line) => line.textContent === DISCLOSURE);
  if (lines.length !== 1) throw new Error(`expected one disclosure line, found ${lines.length}`);
  return lines[0] as HTMLElement;
}

/** The AI disclosure's line, in either language. */
function disclosureLine(): HTMLElement {
  return one('.cd-public-shell__disclosure');
}

/** Two frames on: the composer has sized its text box to what was typed. */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/** Types the long draft into the composer, as a paste does. */
async function pasteLongDraft(): Promise<void> {
  await userEvent.fill(one('.cd-composer__input'), LONG_DRAFT);
  await nextFrames();
}

/**
 * The element whose scrolling moves the conversation: its scroll region, or on a short window the
 * shell itself.
 */
function scroller(): HTMLElement {
  const shell = one('.cd-public-shell');
  for (let node = one('[role="log"]').parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    if (node === shell) break;
  }
  throw new Error('nothing in the shell scrolls the conversation');
}

/** How much of the conversation shows between the chat's head and the composer area. */
function conversationShown(): number {
  return one('.cd-public-shell__composer').getBoundingClientRect().top - one('.cd-public-shell__chat-head').getBoundingClientRect().bottom;
}

/**
 * Whether `el` is wholly inside the window and nothing covers it: what the browser finds on top at
 * each of its corners and at its middle is `el` or inside it.
 */
function uncovered(el: Element): boolean {
  if (!inWindow(el)) return false;
  const { top, bottom, left, right } = el.getBoundingClientRect();
  const points = [
    [left + 1, top + 1],
    [right - 1, top + 1],
    [left + 1, bottom - 1],
    [right - 1, bottom - 1],
    [(left + right) / 2, (top + bottom) / 2],
  ] as const;
  return points.every(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && el.contains(hit);
  });
}

/** Whether `el` is wholly inside the window. */
function inWindow(el: Element): boolean {
  const { top, bottom, left, right } = el.getBoundingClientRect();
  return top >= 0 && left >= 0 && bottom <= innerHeight && right <= innerWidth;
}

/** The element between the conversation and the shell whose own scrolling moves it, if any. */
function scrollRegion(): HTMLElement | null {
  const shell = one('.cd-public-shell');
  for (let node = one('[role="log"]').parentElement; node && node !== shell; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/** The newest message. */
function lastRow(): HTMLElement {
  const rows = container.querySelectorAll<HTMLElement>('.cd-transcript-row');
  const last = rows[rows.length - 1];
  if (!last) throw new Error('no conversation rows');
  return last;
}

/** A computed color's alpha: 0 for `rgba(0, 0, 0, 0)`, 1 for `rgb(…)`. */
function alphaOf(color: string): number {
  const parts = /^rgba?\(([^)]*)\)$/.exec(color)?.[1]?.split(',') ?? [];
  return parts.length === 4 ? parseFloat(parts[3] ?? '0') : 1;
}

/**
 * The horizontal lines a visitor sees within `depth` px under the chat head's bottom edge, as how
 * far under it each lies: the head's own hairline (-1), and every drawn top or bottom border in the
 * shell below the head, where the head doesn't hide it. A border is drawn when it has a style, a
 * width and a color that isn't wholly transparent.
 */
function linesUnderTheHead(depth: number): number[] {
  const head = one('.cd-public-shell__chat-head');
  const edge = head.getBoundingClientRect().bottom;
  const found = new Set<number>();
  for (const el of one('.cd-public-shell').querySelectorAll<HTMLElement>('*')) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (style.visibility !== 'visible' || box.width === 0 || box.right <= 0 || box.left >= innerWidth) continue;
    const sides = [
      { y: box.top, style: style.borderTopStyle, width: style.borderTopWidth, color: style.borderTopColor },
      { y: box.bottom - parseFloat(style.borderBottomWidth), style: style.borderBottomStyle, width: style.borderBottomWidth, color: style.borderBottomColor },
    ];
    for (const side of sides) {
      const drawn = side.style !== 'none' && side.style !== 'hidden' && parseFloat(side.width) > 0 && alphaOf(side.color) > 0;
      const shown = el === head || side.y >= edge;
      const under = Math.round(side.y - edge);
      if (drawn && shown && under >= -1 && under < depth) found.add(under);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Brings the conversation to rest with the about column's hairline `gap` px under the chat head's
 * edge, wherever the page or the visitor leaves it, and waits the frames the shell needs to hear of
 * the scroll. Returns how far under the head's edge the hairline came to rest, in whole px.
 */
async function restAboutLine(gap: number): Promise<number> {
  const about = one('.cd-public-shell__scroll > .cd-public-shell__about');
  const head = one('.cd-public-shell__chat-head');
  const under = () => about.getBoundingClientRect().bottom - 1 - head.getBoundingClientRect().bottom;
  const scrolls = scroller();
  // Twice: on a short shell, scrolling moves the chat's head too until the brand header is gone.
  for (let pass = 0; pass < 2; pass += 1) scrolls.scrollTop += under() - gap;
  await nextFrames();
  return Math.round(under());
}

/** Whether the about column draws its hairline as the chat's head draws its own: 1 px, in the same color. */
function aboutDrawsItsLine(): boolean {
  const about = getComputedStyle(one('.cd-public-shell__scroll > .cd-public-shell__about'));
  return about.borderBottomWidth === '1px' && about.borderBottomColor === getComputedStyle(one('.cd-public-shell__chat-head')).borderBottomColor;
}

/** Each window's name: "390x844". */
const named = ([width, height]: Size) => `${width}x${height}`;

it('the_header_keeps_paper_ink_on_the_owners_colour_in_either_theme', () => {
  // On the owner's colour the header's name and tagline are paper ink, its open dot the on-brand
  // green and its closed ring paper ink too, the same in both themes, as the page's mapping gives
  // them. On the panel, where the colour can't be used, they take the theme's own: light on the dark
  // ground, dark on light paper.
  const onPanel: PublicBrand = {
    ...brandOf(desk),
    field: 'var(--bg-panel)',
    ink: 'var(--text-primary)',
    inkSecondary: 'var(--text-secondary)',
    statusHandled: 'var(--status-handled)',
  };
  const closed = { ...OPEN_EN, open: false, until: null, opens_at: '2026-10-30T08:00:00-07:00', text: 'Closed now, opens at 8:00 am' };
  const seen = [];
  for (const theme of ['dark', 'light'] as const) {
    chooseTheme(theme);
    for (const [ground, brand] of [['colour', brandOf(desk)], ['panel', onPanel]] as const) {
      const look: Record<string, string> = {};
      for (const status of [OPEN_EN, closed]) {
        act(() => root.render(
          <PublicShell brand={brand} ownerName="Mike Turner" language="en" openStatus={status} onAskForOwner={() => {}} composer={null}>
            {null}
          </PublicShell>,
        ));
        const dot = getComputedStyle(one('.cd-public-shell__open-status > .cd-status-dot'));
        if (status.open) look.openDot = dot.backgroundColor;
        else look.closedRing = dot.borderTopColor;
        look.name = getComputedStyle(one('.cd-public-shell__brand-name')).color;
        look.tagline = getComputedStyle(one('.cd-public-shell__tagline')).color;
      }
      seen.push({ theme, ground, ...look });
    }
  }
  const paper = { name: 'rgba(250, 249, 245, 0.92)', tagline: 'rgba(250, 249, 245, 0.64)', openDot: 'rgb(111, 168, 89)', closedRing: 'rgba(250, 249, 245, 0.64)' };
  expect(seen).toEqual([
    { theme: 'dark', ground: 'colour', ...paper },
    { theme: 'dark', ground: 'panel', ...paper },
    { theme: 'light', ground: 'colour', ...paper },
    {
      theme: 'light',
      ground: 'panel',
      name: 'rgba(28, 27, 25, 0.92)',
      tagline: 'rgba(28, 27, 25, 0.68)',
      openDot: 'rgb(63, 122, 46)',
      closedRing: 'rgba(28, 27, 25, 0.68)',
    },
  ]);
});

it('the_english_disclosure_keeps_one_period_after_the_business_name', () => {
  act(() => root.render(
    <PublicShell brand={{ ...brandOf(desk), name: 'Chen & Co.' }} ownerName="Linda" language="en" onAskForOwner={() => {}} composer={null}>
      {null}
    </PublicShell>,
  ));
  const line = disclosureLine();
  expect(line.textContent).toBe("You're chatting with Claude, an AI answering for Chen & Co. Ask for Linda anytime.");
  expect([...line.querySelectorAll('[data-copy="user"]')].map((name) => name.textContent)).toEqual(['Chen & Co.', 'Linda']);
});

it('the_spanish_disclosure_keeps_one_period_after_the_business_name', () => {
  act(() => root.render(
    <PublicShell brand={{ ...brandOf(desk), name: 'Chen & Co.' }} ownerName="Linda" language="es" onAskForOwner={() => {}} composer={null}>
      {null}
    </PublicShell>,
  ));
  const line = disclosureLine();
  expect(line.textContent).toBe('Estás hablando con Claude, una IA que responde por Chen & Co. Puedes pedir hablar con Linda cuando quieras.');
  expect([...line.querySelectorAll('[data-copy="user"]')].map((name) => name.textContent)).toEqual(['Chen & Co.', 'Linda']);
});

it('the_no_name_disclosure_keeps_one_period_after_the_business_name', () => {
  // With no owner name, the approved line still takes one period after a name that ends in one.
  for (const [language, expected] of [
    ['en', "You're chatting with Claude, an AI answering for Chen & Co. Ask for a person anytime."],
    ['es', 'Estás hablando con Claude, una IA que responde por Chen & Co. Puedes pedir hablar con una persona cuando quieras.'],
  ] as const) {
    act(() => root.render(
      <PublicShell brand={{ ...brandOf(desk), name: 'Chen & Co.' }} ownerName={null} language={language} onAskForOwner={() => {}} composer={null}>
        {null}
      </PublicShell>,
    ));
    const line = disclosureLine();
    expect(line.textContent, language).toBe(expected);
    expect([...line.querySelectorAll('[data-copy="user"]')].map((name) => name.textContent), language).toEqual(['Chen & Co.']);
  }
});

it('the_document_never_scrolls', async () => {
  // However long the chat, the page is the window's height and width: the conversation scrolls
  // inside the shell, and its screen-reader lines don't stretch the document behind it.
  const seen = [];
  for (const size of WINDOWS) {
    await renderLongChat(size);
    seen.push([named(size), document.documentElement.scrollHeight, document.documentElement.scrollWidth]);
  }
  expect(seen).toEqual(WINDOWS.map((size) => [named(size), size[1], size[0]]));
});

it('header_and_disclosure_stay_in_view', async () => {
  // At the end of a long chat, where a reply arriving or a reload on a phone leaves the visitor,
  // the business's header and the AI disclosure are still on screen.
  const seen = [];
  for (const size of WINDOWS) {
    await renderLongChat(size);
    lastRow().scrollIntoView({ block: 'end', behavior: 'instant' });
    seen.push({ window: named(size), header: inWindow(one('.cd-public-shell__brand')), disclosure: inWindow(disclosure()) });
  }
  expect(seen).toEqual(WINDOWS.map((size) => ({ window: named(size), header: true, disclosure: true })));
});

it('composer_stays_in_view_while_the_log_scrolls', async () => {
  // The conversation has a scroll region of its own, between the disclosure and the composer area,
  // and the composer area (the composer and the footer under it) is on screen at the start of the
  // chat and at its end, where the newest message sits just above it.
  const seen = [];
  for (const size of WINDOWS) {
    await renderLongChat(size);
    const region = scrollRegion();
    const composer = one('.cd-public-shell__composer');
    const head = one('.cd-public-shell__chat-head');
    const scrolls = region !== null && region.scrollHeight > region.clientHeight;
    const between =
      region !== null &&
      region.getBoundingClientRect().top >= head.getBoundingClientRect().bottom &&
      region.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top;
    if (region) region.scrollTop = 0;
    const atTheStart = inWindow(composer);
    if (region) region.scrollTop = region.scrollHeight;
    const newest = lastRow().getBoundingClientRect();
    seen.push({
      window: named(size),
      scrolls,
      between,
      atTheStart,
      atTheEnd: inWindow(composer),
      newestAboveTheComposer: newest.bottom <= composer.getBoundingClientRect().top && newest.bottom > (region?.getBoundingClientRect().top ?? 0),
    });
  }
  expect(seen).toEqual(
    WINDOWS.map((size) => ({ window: named(size), scrolls: true, between: true, atTheStart: true, atTheEnd: true, newestAboveTheComposer: true })),
  );
});

it('about_column_beside_the_chat_or_atop_the_conversation', async () => {
  // On a laptop the about column stands at the right of the chat, from the header to the window's
  // foot, and stays put while the conversation scrolls. Narrower than 900 px there is no room
  // beside the chat, and the page doesn't scroll, so the column opens the conversation's scroll
  // region instead: above the first message, the region's full width, scrolled away as the chat
  // goes on and back into view at its start.
  const seen = [];
  for (const size of WINDOWS) {
    await renderLongChat(size);
    const about = one('[aria-labelledby]:is(aside, section)');
    const region = scrollRegion();
    const main = one('main');
    if (size[0] >= 900) {
      const before = about.getBoundingClientRect();
      if (region) region.scrollTop = region.scrollHeight;
      const after = about.getBoundingClientRect();
      seen.push({
        window: named(size),
        beside: before.left >= main.getBoundingClientRect().right && before.right === innerWidth,
        underTheHeader: before.top === one('.cd-public-brand').getBoundingClientRect().bottom && before.bottom === innerHeight,
        still: after.top === before.top && after.left === before.left,
      });
    } else {
      if (region) region.scrollTop = 0;
      const box = about.getBoundingClientRect();
      seen.push({
        window: named(size),
        inTheRegion: region !== null && region.contains(about) && about.compareDocumentPosition(one('[role="log"]')) === Node.DOCUMENT_POSITION_FOLLOWING,
        regionWide: region !== null && box.left === region.getBoundingClientRect().left && box.width === region.clientWidth,
        atItsStart: region !== null && box.top === region.getBoundingClientRect().top,
      });
    }
  }
  expect(seen).toEqual(
    WINDOWS.map((size) =>
      size[0] >= 900
        ? { window: named(size), beside: true, underTheHeader: true, still: true }
        : { window: named(size), inTheRegion: true, regionWide: true, atItsStart: true },
    ),
  );
});

it('one_line_under_the_chat_head_at_the_chats_start', async () => {
  // On a phone the about column opens the scroll region with a hairline under it, above the first
  // message. Where the chat comes to rest at its start (as when the page follows a reopened chat a
  // little shorter than the region to its end), that hairline can lie just under the chat's head,
  // which draws its own: the visitor sees the head's one line there, not two a few px apart. Lower
  // down, as the column scrolls into view mid-page, its hairline is drawn as ever.
  const seen = [];
  for (const language of ['en', 'es'] as const) {
    await renderLongChat([390, 844], { language });
    await nextFrames();
    for (const gap of [0, 1, 3, 6, 12, 20]) {
      seen.push({ language, gap: await restAboutLine(gap), lines: linesUnderTheHead(24) });
    }
    seen.push({ language, gap: await restAboutLine(60), aboutDrawsItsLine: aboutDrawsItsLine() });
    scroller().scrollTop = 0;
    await nextFrames();
    seen.push({ language, atTheTop: true, aboutDrawsItsLine: aboutDrawsItsLine() });
  }
  // Only the column's own hairline steps aside: a card's edge 21 px above it is content scrolling
  // under the head, so the runs above stop at 20 px. With the links for people's agents last, whose
  // part has no line at its foot, the sweep runs past the threshold: the head's one line through
  // 23 px, and from 24 px the column's hairline drawn again.
  await renderLongChat([390, 844], { links: true });
  await nextFrames();
  for (const gap of THRESHOLD_SWEEP) {
    seen.push({ links: true, gap: await restAboutLine(gap), lines: linesUnderTheHead(32) });
  }
  expect(seen).toEqual([
    ...(['en', 'es'] as const).flatMap((language) => [
      ...[0, 1, 3, 6, 12, 20].map((gap) => ({ language, gap, lines: [-1] })),
      { language, gap: 60, aboutDrawsItsLine: true },
      { language, atTheTop: true, aboutDrawsItsLine: true },
    ]),
    ...THRESHOLD_SWEEP.map((gap) => ({ links: true, gap, lines: gap < 24 ? [-1] : [-1, gap] })),
  ]);
});

/** Where the about column's hairline rests under the chat's head, up to and past the 24 px threshold. */
const THRESHOLD_SWEEP = [0, 1, 3, 6, 12, 20, 21, 23, 24, 30];

it('one_line_under_the_chat_head_on_a_short_shell_too', async () => {
  // On a phone on its side the shell itself scrolls, and the about column passes under the chat's
  // pinned head: where its hairline comes to rest just under the head, the head's is the one line,
  // and mid-page the column draws its own again.
  await renderLongChat([568, 320]);
  await nextFrames();
  expect(isShort()).toBe(true);
  expect(scroller()).toBe(one('.cd-public-shell'));
  const seen = [];
  for (const gap of [3, 60, 20]) {
    const rested = await restAboutLine(gap);
    seen.push(gap < 24 ? { gap: rested, lines: linesUnderTheHead(24) } : { gap: rested, aboutDrawsItsLine: aboutDrawsItsLine() });
  }
  expect(seen).toEqual([
    { gap: 3, lines: [-1] },
    { gap: 60, aboutDrawsItsLine: true },
    { gap: 20, lines: [-1] },
  ]);
});

/**
 * Forces colors for the rest of the test, as a visitor's high-contrast setting does; the project's
 * reduced motion stays on, and colors are no longer forced after the test.
 */
async function forceColors(): Promise<void> {
  const emulate = async (forced: 'active' | 'none'): Promise<void> => {
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'forced-colors', value: forced },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
  };
  await emulate('active');
  onTestFinished(() => emulate('none'));
  expect(window.matchMedia('(forced-colors: active)').matches).toBe(true);
}

it('one_line_under_the_chat_head_with_forced_colors', async () => {
  // With forced colors the browser draws every border in the system's colors, a transparent one
  // too: the column's own hairline, at rest just under the chat's head, still can't be told from
  // the column's ground there, while the head's line and, mid-page, the column's are drawn.
  await forceColors();
  await renderLongChat([390, 844]);
  await nextFrames();
  const about = one('.cd-public-shell__scroll > .cd-public-shell__about');
  const head = one('.cd-public-shell__chat-head');
  // Whether a border shows against the ground behind it.
  const shows = (line: string, ground: string) => alphaOf(line) > 0 && line !== ground;
  const aboutLineShows = () => shows(getComputedStyle(about).borderBottomColor, getComputedStyle(about).backgroundColor);
  const headLineShows = () => shows(getComputedStyle(head).borderBottomColor, getComputedStyle(one('.cd-public-shell')).backgroundColor);
  const seen = [];
  for (const gap of [3, 60, 12]) {
    seen.push({ gap: await restAboutLine(gap), headLineShows: headLineShows(), aboutLineShows: aboutLineShows() });
  }
  expect(seen).toEqual([
    { gap: 3, headLineShows: true, aboutLineShows: false },
    { gap: 60, headLineShows: true, aboutLineShows: true },
    { gap: 12, headLineShows: true, aboutLineShows: false },
  ]);
});

it('the_mark_follows_the_about_column_changing_height', async () => {
  // The column's own height can change with nothing scrolled and nothing rendered, as when the web
  // font arrives after the fallback has laid the column out: its hairline moves away from the
  // chat's head or up under it, and whether it is drawn follows. So it does for a column that has
  // just moved into the scroll region, as the window narrows past 900 px.
  await renderLongChat([390, 844], { links: true });
  await nextFrames();
  const seen = [];
  for (const when of ['opened on a phone', 'moved back from beside the chat'] as const) {
    if (when === 'moved back from beside the chat') {
      await page.viewport(1440, 900);
      await vi.waitFor(() => expect(container.querySelector('.cd-public-shell__scroll > .cd-public-shell__about')).toBeNull());
      await page.viewport(390, 844);
      await vi.waitFor(() => one('.cd-public-shell__scroll > .cd-public-shell__about'));
      await nextFrames();
    }
    const about = one('.cd-public-shell__scroll > .cd-public-shell__about');
    const head = one('.cd-public-shell__chat-head');
    const gap = () => Math.round(about.getBoundingClientRect().bottom - 1 - head.getBoundingClientRect().bottom);
    seen.push({ when, gap: await restAboutLine(10), lines: linesUnderTheHead(24) });
    // A line more at the column's end, added straight to the page: the hairline moves 24 px or more lower.
    const line = document.createElement('li');
    line.textContent = 'A line the column gained';
    one('.cd-public-shell__link-list').append(line);
    await nextFrames();
    const grown = gap();
    seen.push({ when, movedDown: grown >= 34, aboutDrawsItsLine: aboutDrawsItsLine() });
    // Scrolled away and back to rest there, then the line gone again, as a column the font shrank:
    // the hairline comes up under the head.
    await restAboutLine(60);
    await restAboutLine(grown);
    line.remove();
    await nextFrames();
    seen.push({ when, gap: gap(), lines: linesUnderTheHead(24) });
  }
  expect(seen).toEqual(
    (['opened on a phone', 'moved back from beside the chat'] as const).flatMap((when) => [
      { when, gap: 10, lines: [-1] },
      { when, movedDown: true, aboutDrawsItsLine: true },
      { when, gap: 10, lines: [-1] },
    ]),
  );
});

it('about_column_moves_as_the_window_crosses_900_and_the_draft_stays', async () => {
  // A window narrowed past 900 px (or a tablet turned) with the page open: the about column moves
  // into the scroll region, and back when it widens, while the rest of the page stays mounted, so
  // an unsent draft is the same text box with the same words.
  await renderLongChat([1440, 900]);
  const box = page.getByRole('textbox', { name: 'Message Turner Plumbing' });
  await userEvent.type(box, 'Keep this draft');
  const textarea = box.element() as HTMLTextAreaElement;
  const inTheRegion = () => scrollRegion()?.contains(one('[aria-labelledby]:is(aside, section)')) ?? false;
  expect(inTheRegion()).toBe(false);

  expect(document.activeElement).toBe(textarea);

  await page.viewport(820, 900);
  await vi.waitFor(() => expect(inTheRegion()).toBe(true));
  expect(box.element()).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft');
  expect(document.activeElement).toBe(textarea);
  expect(document.documentElement.scrollHeight).toBe(900);

  await page.viewport(1440, 900);
  await vi.waitFor(() => expect(inTheRegion()).toBe(false));
  expect(box.element()).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft');
  expect(document.activeElement).toBe(textarea);
});

it('the_scroll_region_takes_the_keyboard', async () => {
  // A conversation with nothing to focus in it can still be scrolled from the keyboard: the region
  // is a stop in the tab order after "Ask for Mike Turner", named by the chat's title, and End
  // takes it to the newest message.
  await renderLongChat([390, 844]);
  const region = scrollRegion();
  if (!region) throw new Error('no scroll region');
  const ask = page.getByRole('button', { name: 'Ask for Mike Turner' }).element() as HTMLElement;
  ask.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(region);
  expect(region.getAttribute('role')).toBe('group');
  expect(document.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Chat with Turner Plumbing');
  expect(region.scrollTop).toBe(0);
  await userEvent.keyboard('{End}');
  await vi.waitFor(() => expect(region.scrollTop + region.clientHeight).toBeGreaterThanOrEqual(region.scrollHeight - 1));
});

it('composer_opens_one_line_high', async () => {
  // The page opens with the composer's text box one line high on every window: nothing in the
  // shell lays out at a width the visitor never sees, which the composer would measure itself at.
  const seen = [];
  for (const size of WINDOWS) {
    await renderLongChat(size);
    const input = one<HTMLTextAreaElement>('.cd-composer__input');
    seen.push([named(size), input.getBoundingClientRect().height]);
  }
  const line = parseFloat(getComputedStyle(one('.cd-composer__input')).lineHeight);
  expect(seen).toEqual(WINDOWS.map((size) => [named(size), line]));
});

it('a_short_conversation_reaches_down_to_the_composer', async () => {
  // As before the page stopped scrolling, the conversation runs down to the composer area however
  // short it is (under the about column when that opens the scroll region), so the end of a short
  // chat is right above the composer and the scroll region has nothing to scroll.
  const seen = [];
  for (const size of [[1440, 900], [390, 844]] satisfies Size[]) {
    act(() => root.render(null));
    await page.viewport(size[0], size[1]);
    act(() => root.render(<ShortChat />));
    const region = scrollRegion();
    const conversation = one('.cd-public-shell__conversation').getBoundingClientRect();
    seen.push({
      window: named(size),
      reaches: conversation.bottom === one('.cd-public-shell__composer').getBoundingClientRect().top,
      scrolls: region !== null && region.scrollHeight > region.clientHeight,
    });
  }
  expect(seen).toEqual([
    { window: '1440x900', reaches: true, scrolls: false },
    { window: '390x844', reaches: true, scrolls: false },
  ]);
});

it('short_windows_keep_the_disclosure_and_composer_in_view', async () => {
  // A phone on its side, a short phone or one with its keyboard open, in either language, with an
  // empty composer or a long draft in it: the AI disclosure and the composer are wholly on screen
  // at the start of a long chat, at the very end (where the footer shows under the composer) and
  // where the page keeps a chat it follows (the newest message just above the composer), the
  // document doesn't scroll, and there at least 96 px of the conversation shows between the chat's
  // head and the composer.
  const seen = [];
  for (const size of SHORT) {
    for (const language of ['en', 'es'] as const) {
      for (const draft of ['empty', 'long'] as const) {
        await renderLongChat(size, { language });
        if (draft === 'long') await pasteLongDraft();
        const scrolls = scroller();
        scrolls.scrollTop = 0;
        // At the very top, a long draft with the longest closed status can meet the chat's head;
        // the composer comes out from under it as soon as it has focus.
        if (draft === 'long') {
          one<HTMLTextAreaElement>('.cd-composer__input').blur();
          one<HTMLTextAreaElement>('.cd-composer__input').focus();
          await nextFrames();
        }
        const atTheStart = uncovered(disclosureLine()) && uncovered(one('.cd-composer'));
        scrolls.scrollTop = scrolls.scrollHeight;
        const atTheEnd = uncovered(disclosureLine()) && uncovered(one('.cd-composer'));
        // The page's own rule for following a chat: scroll until the newest message's foot meets
        // the composer area's top.
        scrolls.scrollTop = 0;
        scrolls.scrollTop += lastRow().getBoundingClientRect().bottom - one('.cd-public-shell__composer').getBoundingClientRect().top;
        const following =
          uncovered(disclosureLine()) &&
          uncovered(one('.cd-composer')) &&
          Math.abs(lastRow().getBoundingClientRect().bottom - one('.cd-public-shell__composer').getBoundingClientRect().top) <= 1;
        seen.push({
          window: named(size),
          language,
          draft,
          atTheStart,
          atTheEnd,
          following,
          documentFits: document.documentElement.scrollHeight <= innerHeight,
          conversationShown: conversationShown() >= 96 ? '96 px or more' : `${conversationShown()} px`,
        });
      }
    }
  }
  expect(seen).toEqual(
    SHORT.flatMap((size) =>
      (['en', 'es'] as const).flatMap((language) =>
        (['empty', 'long'] as const).map((draft) => ({
          window: named(size),
          language,
          draft,
          atTheStart: true,
          atTheEnd: true,
          following: true,
          documentFits: true,
          conversationShown: '96 px or more',
        })),
      ),
    ),
  );
});

it('short_windows_scroll_the_brand_header_and_footer_with_the_chat', async () => {
  // On a short window the brand header and the footer give their room to the conversation: the
  // header is at the top of what scrolls and the footer at its end, while the chat's head and the
  // composer stay put. On a taller window both stay pinned.
  const seen = [];
  for (const size of [...SHORT, [320, 568] as const]) {
    await renderLongChat(size);
    const scrolls = scroller();
    const header = one('.cd-public-brand');
    const footer = one('[data-ds="concept-footer"]');
    scrolls.scrollTop = 0;
    const start = { header: inWindow(header), footer: inWindow(footer) };
    scrolls.scrollTop = scrolls.scrollHeight;
    const end = {
      header: inWindow(header),
      footer: inWindow(footer),
      chatHeadAtTheTop: one('.cd-public-shell__chat-head').getBoundingClientRect().top === (inWindow(header) ? header.getBoundingClientRect().bottom : 0),
    };
    seen.push({ window: named(size), start, end });
  }
  expect(seen).toEqual([
    ...SHORT.map((size) => ({
      window: named(size),
      start: { header: true, footer: false },
      end: { header: false, footer: true, chatHeadAtTheTop: true },
    })),
    { window: '320x568', start: { header: true, footer: true }, end: { header: true, footer: true, chatHeadAtTheTop: true } },
  ]);
});

it('a_long_draft_never_pushes_the_disclosure_out', async () => {
  // At every height the composer's text box stops growing at a sixth of the shell's height and
  // scrolls inside, so a long draft never pushes the disclosure off the screen.
  const seen = [];
  for (const size of [...WINDOWS, ...SHORT]) {
    await renderLongChat(size, { language: 'es' });
    await pasteLongDraft();
    const input = one<HTMLTextAreaElement>('.cd-composer__input');
    const scrolls = scroller();
    scrolls.scrollTop = scrolls.scrollHeight;
    seen.push({
      window: named(size),
      disclosure: uncovered(disclosureLine()),
      composer: uncovered(one('.cd-composer')),
      documentFits: document.documentElement.scrollHeight <= innerHeight,
      capped: input.getBoundingClientRect().height <= one('.cd-public-shell').clientHeight / 6 + 1,
      scrollsInside: input.scrollHeight > input.clientHeight,
    });
  }
  expect(seen).toEqual(
    [...WINDOWS, ...SHORT].map((size) => ({
      window: named(size),
      disclosure: true,
      composer: true,
      documentFits: true,
      capped: true,
      scrollsInside: true,
    })),
  );
});

it('focus_in_the_about_column_survives_the_move', async () => {
  // A keyboard visitor on a link in the about column keeps their place when the window crosses
  // 900 px and the column moves, both ways.
  await renderLongChat([901, 900], { links: true });
  const link = () => page.getByRole('link', { name: 'What agents can do here' }).element() as HTMLElement;
  const inTheRegion = () => one('.cd-public-shell__scroll').contains(one('[aria-labelledby]:is(aside, section)'));
  link().focus();
  expect(document.activeElement).toBe(link());

  await page.viewport(899, 900);
  await vi.waitFor(() => expect(inTheRegion()).toBe(true));
  expect(document.activeElement).toBe(link());

  await page.viewport(901, 900);
  await vi.waitFor(() => expect(inTheRegion()).toBe(false));
  expect(document.activeElement).toBe(link());
});

it('the_about_column_takes_the_keyboard_only_when_it_scrolls', async () => {
  // Beside the chat, a charter taller than the column scrolls in the column, so the column is a
  // stop in the tab order, named by its heading; when it fits, or when it opens the conversation's
  // scroll region, it isn't.
  const seen = [];
  for (const size of [[1024, 640], [1440, 900], [390, 844]] satisfies Size[]) {
    await renderLongChat(size);
    const about = one('[aria-labelledby]:is(aside, section)');
    seen.push({
      window: named(size),
      scrolls: about.scrollHeight > about.clientHeight,
      tabStop: about.tabIndex === 0,
      named: document.getElementById(about.getAttribute('aria-labelledby') ?? '')?.textContent,
    });
  }
  expect(seen).toEqual([
    { window: '1024x640', scrolls: true, tabStop: true, named: 'About Turner Plumbing' },
    { window: '1440x900', scrolls: false, tabStop: false, named: 'About Turner Plumbing' },
    { window: '390x844', scrolls: false, tabStop: false, named: 'About Turner Plumbing' },
  ]);
});

it('the_composer_never_covers_the_disclosure', async () => {
  // At the top of a chat on a short window, the brand header, the chat's head and a composer holding
  // a long draft can be taller than the window together, as with a tagline that wraps. The chat's
  // head then stays over the composer, so the AI disclosure is never covered, wherever the visitor
  // has scrolled to.
  const seen = [];
  for (const size of [[568, 320], [360, 380]] satisfies Size[]) {
    await renderLongChat(size, { language: 'es', tagline: THREE_LINE_TAGLINE });
    await pasteLongDraft();
    const scrolls = scroller();
    const covered = [];
    for (let top = 0; top <= scrolls.scrollHeight; top += 40) {
      scrolls.scrollTop = top;
      if (!uncovered(disclosureLine())) covered.push(scrolls.scrollTop);
    }
    seen.push({ window: named(size), covered });
  }
  expect(seen).toEqual([
    { window: '568x320', covered: [] },
    { window: '360x380', covered: [] },
  ]);
});

/** Whether the shell is laid out short: the brand header and the footer scroll with the chat. */
function isShort(): boolean {
  return one('.cd-public-shell').classList.contains('cd-public-shell--short');
}

/** Scrolls as the public chat page does to follow a chat: the newest message's foot at the composer area's top. */
function followTheChat(): void {
  const scrolls = scroller();
  scrolls.scrollTop = 0;
  scrolls.scrollTop += lastRow().getBoundingClientRect().bottom - one('.cd-public-shell__composer').getBoundingClientRect().top;
}

/** Whether the newest message sits just above the composer area. */
function newestAboveTheComposer(): boolean {
  return Math.abs(lastRow().getBoundingClientRect().bottom - one('.cd-public-shell__composer').getBoundingClientRect().top) <= 1;
}

it('a_shell_too_full_for_its_height_turns_short', async () => {
  // Just above 520 px, a wrapped tagline, the longest closed status in Spanish or a long draft can
  // leave the conversation almost nothing with the header and the footer pinned. The shell turns
  // short when the conversation would get less than 120 px, not only below 520 px, so it always
  // keeps at least 96 px of conversation and the document never scrolls.
  const seen = [];
  for (const size of [[320, 520], [320, 545], [320, 560], [360, 520]] satisfies Size[]) {
    for (const variant of ['long draft', 'two-line tagline', 'both'] as const) {
      await renderLongChat(size, { language: 'es', tagline: variant === 'long draft' ? undefined : TWO_LINE_TAGLINE });
      if (variant !== 'two-line tagline') await pasteLongDraft();
      await nextFrames();
      followTheChat();
      seen.push({
        window: named(size),
        variant,
        documentFits: document.documentElement.scrollHeight <= innerHeight,
        conversationShown: conversationShown() >= 96 ? '96 px or more' : `${conversationShown()} px`,
        disclosure: uncovered(disclosureLine()),
        composer: uncovered(one('.cd-composer')),
      });
    }
  }
  expect(seen).toEqual(
    [[320, 520], [320, 545], [320, 560], [360, 520]].flatMap(([width, height]) =>
      (['long draft', 'two-line tagline', 'both'] as const).map((variant) => ({
        window: `${width}x${height}`,
        variant,
        documentFits: true,
        conversationShown: '96 px or more',
        disclosure: true,
        composer: true,
      })),
    ),
  );
});

it('short_mode_leaves_only_with_room_to_spare', async () => {
  // A draft growing past the point where the conversation would get less than 120 px turns the
  // shell short; taking one line back off doesn't turn it back, so the page can't flap between the
  // two as the visitor types at the edge. Clearing the draft does. A 320 px phone 586 px tall leaves
  // the Spanish page's empty draft 150 px of conversation: enough to turn tall again, and each 22 px
  // line of draft lands the room clear of both edges.
  await renderLongChat([320, 586], { language: 'es' });
  expect(isShort()).toBe(false);
  const input = one<HTMLTextAreaElement>('.cd-composer__input');
  const lines: string[] = [];
  for (let line = 1; line <= 6 && !isShort(); line += 1) {
    lines.push(`line ${line}`);
    await userEvent.fill(input, lines.join('\n'));
    await nextFrames();
  }
  expect(isShort()).toBe(true);
  await userEvent.fill(input, lines.slice(0, -1).join('\n'));
  await nextFrames();
  await nextFrames();
  expect(isShort()).toBe(true);
  await userEvent.clear(input);
  await vi.waitFor(() => expect(isShort()).toBe(false));
});

it('kept_composer_room_holds_the_shell_as_a_line_above_the_composer_comes_and_goes', async () => {
  // A line the page shows above the composer at times (the public chat's, for a waiting request)
  // can tip a shell at the edge into short, and taking it away turns it tall again. Each switch
  // moves the conversation, which can bring the reason for the line into view and out of it again,
  // so the page and the shell would answer each other for ever. While the page asks the shell to
  // keep the composer's room, it counts the composer area at the tallest it has been since, and the
  // line coming and going switches nothing; once the page lets the room go, the shell fits itself
  // again at once.
  // With the banner pinned too, so the window that leaves the conversation that much room is over
  // the 520 px under which a shell is short whatever it holds.
  await renderLongChat([390, 844], { banner: true });
  const region = one('.cd-public-shell__scroll');
  // Tall, with 150 px of conversation: more than the 136 a short shell needs to turn tall again, and
  // less than the 181 the line's 61 px leaves the 120 a tall one keeps.
  const height = 844 - region.clientHeight + 150;
  expect(height).toBeGreaterThanOrEqual(520);
  const seen: { keep: boolean; step: string; short: boolean }[] = [];
  for (const keep of [false, true]) {
    await renderLongChat([390, height], { banner: true, follow: true, keepComposerRoom: keep });
    await nextFrames();
    seen.push({ keep, step: 'no line', short: isShort() });
    act(() => root.render(<LongChat banner follow keepComposerRoom={keep} lineAbove />));
    await nextFrames();
    seen.push({ keep, step: 'line', short: isShort() });
    act(() => root.render(<LongChat banner follow keepComposerRoom={keep} />));
    await nextFrames();
    seen.push({ keep, step: 'line gone', short: isShort() });
    if (keep) {
      act(() => root.render(<LongChat banner follow />));
      await nextFrames();
      seen.push({ keep, step: 'room let go', short: isShort() });
    }
  }
  expect(seen).toEqual([
    { keep: false, step: 'no line', short: false },
    { keep: false, step: 'line', short: true },
    { keep: false, step: 'line gone', short: false },
    { keep: true, step: 'no line', short: false },
    { keep: true, step: 'line', short: true },
    { keep: true, step: 'line gone', short: true },
    { keep: true, step: 'room let go', short: false },
  ]);
});

it('keyboard_scrolling_on_a_short_shell_skips_nothing', async () => {
  // On a short shell the chat's head and the composer sit over the conversation. Tabbing from
  // "Ask for Mike Turner" into the conversation leaves the newest message just above the composer,
  // and Page Down moves by no more than the conversation that shows, so nothing passes unseen
  // under the chat's head.
  const seen = [];
  for (const size of [[568, 320], [360, 380]] satisfies Size[]) {
    await renderLongChat(size);
    followTheChat();
    (page.getByRole('button', { name: 'Ask for Mike Turner' }).element() as HTMLElement).focus();
    await userEvent.tab();
    const tabbed = document.activeElement === one('.cd-public-shell__scroll') && newestAboveTheComposer();

    const scrolls = scroller();
    scrolls.scrollTop = scrolls.scrollHeight / 2;
    const shown = conversationShown();
    const before = scrolls.scrollTop;
    await userEvent.keyboard('{PageDown}');
    await vi.waitFor(() => expect(scrolls.scrollTop).toBeGreaterThan(before));
    await nextFrames();
    seen.push({ window: named(size), tabbed, pageDownWithinWhatShows: scrolls.scrollTop - before <= shown });
  }
  expect(seen).toEqual([
    { window: '568x320', tabbed: true, pageDownWithinWhatShows: true },
    { window: '360x380', tabbed: true, pageDownWithinWhatShows: true },
  ]);
});

it('a_reopened_chat_opens_at_its_newest_message', async () => {
  // Reopening a chat on a short phone: the page brings the newest message above the composer in a
  // layout effect of its own, after the shell's. The shell has already decided it is short, so the
  // page scrolls the right element and the newest message is just above the composer, not left far
  // below it by a switch after the page has scrolled.
  await renderLongChat([360, 380], { rows: 8, follow: true });
  await nextFrames();
  expect(isShort()).toBe(true);
  expect(newestAboveTheComposer()).toBe(true);
});

it('the_reading_place_survives_a_switch_to_short_and_back', async () => {
  // A visitor reading at message 6 on a tall phone, whose window then gets short (the keyboard
  // opens) and tall again: message 6 stays where it was under the chat's head, both ways. After each
  // switch the shell tells the page, once, which element now scrolls the conversation.
  await renderLongChat([360, 640]);
  const events: Element[] = [];
  const listen = (event: Event) => events.push((event as CustomEvent<{ scroller: Element }>).detail.scroller);
  document.addEventListener('cd-public-shell-scroller', listen);
  try {
    const row = container.querySelectorAll<HTMLElement>('.cd-transcript-row')[5] as HTMLElement;
    const head = one('.cd-public-shell__chat-head');
    const scrolls = scroller();
    scrolls.scrollTop += row.getBoundingClientRect().top - head.getBoundingClientRect().bottom - 10;
    const offset = () => Math.round(row.getBoundingClientRect().top - head.getBoundingClientRect().bottom);
    expect(offset()).toBe(10);

    await page.viewport(360, 380);
    await vi.waitFor(() => expect(isShort()).toBe(true));
    await nextFrames();
    expect(offset()).toBe(10);
    expect(events).toEqual([one('.cd-public-shell')]);

    await page.viewport(360, 640);
    await vi.waitFor(() => expect(isShort()).toBe(false));
    await nextFrames();
    expect(offset()).toBe(10);
    expect(events).toEqual([one('.cd-public-shell'), one('.cd-public-shell__scroll')]);
  } finally {
    document.removeEventListener('cd-public-shell-scroller', listen);
  }
});

it('the_reading_place_survives_a_phone_turning', async () => {
  // The same visitor reading at message 6 on a phone, who turns it on its side and back. The width
  // changes as well as the height, so the about column, the messages and the chat's head wrap onto
  // other lines before the shell hears of the new size, as it switches to short and back. Message 6
  // still stays where it was under the chat's head, whether the browser's own scroll anchoring
  // moves the conversation first (keeping still whichever element it picks) or doesn't.
  const seen = [];
  for (const anchoring of ['browser', 'none'] as const) {
    const noAnchoring = document.createElement('style');
    noAnchoring.textContent = anchoring === 'none' ? '* { overflow-anchor: none; }' : '';
    document.head.append(noAnchoring);
    try {
      await renderLongChat([390, 844]);
      const row = container.querySelectorAll<HTMLElement>('.cd-transcript-row')[5] as HTMLElement;
      const head = one('.cd-public-shell__chat-head');
      const offset = () => row.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
      scroller().scrollTop += offset() - 10;
      await nextFrames();
      const before = offset();
      expect(Math.round(before)).toBe(10);

      for (const size of [[568, 320], [390, 844]] satisfies Size[]) {
        await page.viewport(...size);
        await vi.waitFor(() => expect(isShort()).toBe(size[1] < 520));
        await nextFrames();
        const drift = offset() - before;
        seen.push({ anchoring, window: named(size), drift: Math.abs(drift) <= 1 ? 'within 1 px' : `${drift.toFixed(1)} px` });
      }
    } finally {
      noAnchoring.remove();
    }
  }
  expect(seen).toEqual([
    { anchoring: 'browser', window: '568x320', drift: 'within 1 px' },
    { anchoring: 'browser', window: '390x844', drift: 'within 1 px' },
    { anchoring: 'none', window: '568x320', drift: 'within 1 px' },
    { anchoring: 'none', window: '390x844', drift: 'within 1 px' },
  ]);
});

it('a_scroll_before_the_shell_hears_of_a_turn_isnt_the_reading_place', async () => {
  // As the phone turns, something can scroll the conversation before the shell hears of the new
  // size: the browser's scroll anchoring at a layout a render forces mid-reply, or, as here, a
  // resize listener. That scroll isn't the visitor's: message 6 goes back where the visitor last
  // saw it, turning either way.
  const seen = [];
  const scrollAsTheWindowResizes = () => {
    scroller().scrollTop += 40;
  };
  for (const [from, to] of [[[390, 844], [568, 320]], [[568, 320], [390, 844]]] satisfies [Size, Size][]) {
    await renderLongChat(from);
    const row = container.querySelectorAll<HTMLElement>('.cd-transcript-row')[5] as HTMLElement;
    const head = one('.cd-public-shell__chat-head');
    const offset = () => row.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
    // Twice: on a short shell, scrolling moves the chat's head too until the brand header is gone.
    for (let pass = 0; pass < 2; pass += 1) scroller().scrollTop += offset() - 10;
    await nextFrames();
    const before = offset();
    expect(Math.round(before)).toBe(10);

    window.addEventListener('resize', scrollAsTheWindowResizes, { once: true });
    try {
      await page.viewport(...to);
      await vi.waitFor(() => expect(isShort()).toBe(to[1] < 520));
      await nextFrames();
    } finally {
      window.removeEventListener('resize', scrollAsTheWindowResizes);
    }
    const drift = offset() - before;
    seen.push({ turn: `${named(from)} to ${named(to)}`, drift: Math.abs(drift) <= 1 ? 'within 1 px' : `${drift.toFixed(1)} px` });
  }
  expect(seen).toEqual([
    { turn: '390x844 to 568x320', drift: 'within 1 px' },
    { turn: '568x320 to 390x844', drift: 'within 1 px' },
  ]);
});

it('the_chats_start_stays_put_as_a_phone_turns', async () => {
  // A visitor at the start of a chat on a phone, where the about column opens the conversation's
  // scroll region and is what sits under the chat's head, turns the phone on its side and back. The
  // column wraps shorter on the wider window, but its top stays where it was at the head's edge
  // both ways: none of it is left hidden under the head.
  await renderLongChat([390, 844]);
  const about = one('.cd-public-shell__scroll > .cd-public-shell__about');
  const head = one('.cd-public-shell__chat-head');
  const offset = () => about.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
  expect(scroller().scrollTop).toBe(0);
  const before = offset();

  const seen = [];
  for (const size of [[568, 320], [390, 844]] satisfies Size[]) {
    await page.viewport(...size);
    await vi.waitFor(() => expect(isShort()).toBe(size[1] < 520));
    await nextFrames();
    const drift = offset() - before;
    seen.push({ window: named(size), aboutTop: Math.abs(drift) <= 1 ? 'where it was' : `${drift.toFixed(1)} px off` });
  }
  expect(seen).toEqual([
    { window: '568x320', aboutTop: 'where it was' },
    { window: '390x844', aboutTop: 'where it was' },
  ]);
});

it('a_message_partly_under_the_head_keeps_its_share_as_a_phone_turns', async () => {
  // A visitor reading a long message 6, its first part already scrolled up under the chat's head,
  // turns the phone on its side and back. The message wraps onto fewer lines on the wider window;
  // the same share of it stays above the head's edge, so the same part of it is at the edge, and it
  // is still the first message under the head.
  await renderLongChat([390, 844], { longMessage: 6 });
  const rows = () => [...container.querySelectorAll<HTMLElement>('.cd-transcript-row')];
  const row = rows()[5] as HTMLElement;
  const head = one('.cd-public-shell__chat-head');
  const edge = () => head.getBoundingClientRect().bottom;
  const offset = () => row.getBoundingClientRect().top - edge();
  const height = () => row.getBoundingClientRect().height;
  const firstUnderTheHead = () => rows().findIndex((candidate) => candidate.getBoundingClientRect().bottom > edge()) + 1;
  scroller().scrollTop += offset() + height() * 0.85;
  await nextFrames();
  const share = -offset() / height();
  const tall = height();
  expect(Math.round(share * 100)).toBe(85);
  expect(firstUnderTheHead()).toBe(6);

  const seen = [];
  for (const size of [[568, 320], [390, 844]] satisfies Size[]) {
    await page.viewport(...size);
    await vi.waitFor(() => expect(isShort()).toBe(size[1] < 520));
    await nextFrames();
    const drift = offset() + share * height();
    seen.push({
      window: named(size),
      wraps: height() < tall - 1 ? 'shorter' : height() > tall + 1 ? 'taller' : 'as before',
      share: Math.abs(drift) <= 1 ? 'within 1 px' : `${drift.toFixed(1)} px off`,
      firstUnderTheHead: firstUnderTheHead(),
    });
  }
  expect(seen).toEqual([
    { window: '568x320', wraps: 'shorter', share: 'within 1 px', firstUnderTheHead: 6 },
    { window: '390x844', wraps: 'as before', share: 'within 1 px', firstUnderTheHead: 6 },
  ]);
});

it('a_place_read_on_the_side_holds_as_the_phone_turns_back', async () => {
  // A visitor turns the phone on its side, scrolls on to message 12 there, and turns it back:
  // message 12 stays where they left it under the chat's head. The place put back is the one read
  // on the wider window, not one from before the first turn.
  await renderLongChat([390, 844]);
  await page.viewport(568, 320);
  await vi.waitFor(() => expect(isShort()).toBe(true));
  await nextFrames();
  const row = container.querySelectorAll<HTMLElement>('.cd-transcript-row')[11] as HTMLElement;
  const head = one('.cd-public-shell__chat-head');
  const offset = () => row.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
  // Twice: on a short shell, scrolling moves the chat's head too until the brand header is gone.
  for (let pass = 0; pass < 2; pass += 1) scroller().scrollTop += offset() - 10;
  await nextFrames();
  const before = offset();
  expect(Math.round(before)).toBe(10);

  await page.viewport(390, 844);
  await vi.waitFor(() => expect(isShort()).toBe(false));
  await nextFrames();
  const drift = offset() - before;
  expect(Math.abs(drift) <= 1 ? 'within 1 px' : `${drift.toFixed(1)} px`).toBe('within 1 px');
});

it('the_reading_place_survives_a_width_change_that_keeps_the_layout', async () => {
  // A visitor reading at message 6 whose window gets wider while the shell stays short or tall: a
  // phone turned with the keyboard open, a short window widened, a phone a little wider. The
  // messages and the chat's head still wrap onto other lines, and message 6 stays where it was under
  // the chat's head, whether the browser's own scroll anchoring moves the conversation first or
  // doesn't.
  const seen = [];
  for (const anchoring of ['browser', 'none'] as const) {
    for (const [from, to] of [
      [[390, 380], [568, 380]],
      [[568, 320], [700, 320]],
      [[390, 844], [430, 844]],
    ] satisfies [Size, Size][]) {
      const noAnchoring = document.createElement('style');
      noAnchoring.textContent = anchoring === 'none' ? '* { overflow-anchor: none; }' : '';
      document.head.append(noAnchoring);
      try {
        await renderLongChat(from);
        const short = isShort();
        const row = container.querySelectorAll<HTMLElement>('.cd-transcript-row')[5] as HTMLElement;
        const head = one('.cd-public-shell__chat-head');
        const offset = () => row.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
        // Twice: on a short shell, scrolling moves the chat's head too until the brand header is gone.
        for (let pass = 0; pass < 2; pass += 1) scroller().scrollTop += offset() - 10;
        await nextFrames();
        const before = offset();
        expect(Math.round(before)).toBe(10);

        await page.viewport(...to);
        await vi.waitFor(() => expect(window.innerWidth).toBe(to[0]));
        await nextFrames();
        expect(isShort()).toBe(short);
        const drift = offset() - before;
        seen.push({ anchoring, change: `${named(from)} to ${named(to)}`, drift: Math.abs(drift) <= 1 ? 'within 1 px' : `${drift.toFixed(1)} px` });
      } finally {
        noAnchoring.remove();
      }
    }
  }
  expect(seen).toEqual([
    { anchoring: 'browser', change: '390x380 to 568x380', drift: 'within 1 px' },
    { anchoring: 'browser', change: '568x320 to 700x320', drift: 'within 1 px' },
    { anchoring: 'browser', change: '390x844 to 430x844', drift: 'within 1 px' },
    { anchoring: 'none', change: '390x380 to 568x380', drift: 'within 1 px' },
    { anchoring: 'none', change: '568x320 to 700x320', drift: 'within 1 px' },
    { anchoring: 'none', change: '390x844 to 430x844', drift: 'within 1 px' },
  ]);
});

it('a_switch_just_after_a_width_change_keeps_the_reading_place', async () => {
  // The shell can turn short just after it has laid itself out at a new width: here the composer
  // area grows as soon as the window is wider, as a draft's text box can resize to the new width.
  // The shell then reads the place at a width it has already laid out, and message 6 still stays
  // where the visitor last saw it under the chat's head.
  const seen = [];
  for (const anchoring of ['browser', 'none'] as const) {
    const noAnchoring = document.createElement('style');
    noAnchoring.textContent = anchoring === 'none' ? '* { overflow-anchor: none; }' : '';
    document.head.append(noAnchoring);
    let grow: ResizeObserver | undefined;
    try {
      await renderLongChat([390, 640], { lineAbove: true });
      expect(isShort()).toBe(false);
      // Made after the shell's own observer, so it hears of the new width just after the shell does.
      grow = new ResizeObserver(() => {
        if (window.innerWidth === 430) one('[data-testid="line-above"]').style.height = '400px';
      });
      const row = container.querySelectorAll<HTMLElement>('.cd-transcript-row')[5] as HTMLElement;
      const head = one('.cd-public-shell__chat-head');
      const offset = () => row.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
      scroller().scrollTop += offset() - 10;
      await nextFrames();
      const before = offset();
      expect(Math.round(before)).toBe(10);

      grow.observe(one('.cd-public-shell'));
      await page.viewport(430, 640);
      await vi.waitFor(() => expect(isShort()).toBe(true));
      await nextFrames();
      const drift = offset() - before;
      seen.push({ anchoring, drift: Math.abs(drift) <= 1 ? 'within 1 px' : `${drift.toFixed(1)} px` });
    } finally {
      grow?.disconnect();
      noAnchoring.remove();
    }
  }
  expect(seen).toEqual([
    { anchoring: 'browser', drift: 'within 1 px' },
    { anchoring: 'none', drift: 'within 1 px' },
  ]);
});

it('a_message_above_the_place_changing_height_moves_the_place_with_it', async () => {
  // Where the browser doesn't anchor scrolling, a message above the one being read changing height
  // moves what shows under the chat's head without any scroll. The place kept is what the visitor
  // now sees: message 3 grows by one message's height, so message 5 comes to where message 6 was,
  // and once the phone turns, message 5 is still there.
  const noAnchoring = document.createElement('style');
  noAnchoring.textContent = '* { overflow-anchor: none; }';
  document.head.append(noAnchoring);
  onTestFinished(() => noAnchoring.remove());
  await renderLongChat([390, 844]);
  const rows = container.querySelectorAll<HTMLElement>('.cd-transcript-row');
  const third = rows[2] as HTMLElement;
  const fifth = rows[4] as HTMLElement;
  const sixth = rows[5] as HTMLElement;
  const head = one('.cd-public-shell__chat-head');
  const offset = (row: HTMLElement) => row.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
  scroller().scrollTop += offset(sixth) - 10;
  await nextFrames();
  expect(Math.round(offset(sixth))).toBe(10);

  const step = sixth.getBoundingClientRect().top - fifth.getBoundingClientRect().top;
  third.style.paddingTop = `${parseFloat(getComputedStyle(third).paddingTop) + step}px`;
  await nextFrames();
  const before = offset(fifth);
  expect(Math.round(before)).toBe(10);

  await page.viewport(568, 320);
  await vi.waitFor(() => expect(isShort()).toBe(true));
  await nextFrames();
  const drift = offset(fifth) - before;
  expect(Math.abs(drift) <= 1 ? 'within 1 px' : `${drift.toFixed(1)} px`).toBe('within 1 px');
});

it('follows_the_visual_viewport_when_the_keyboard_opens', async () => {
  // Safari on an iPhone doesn't shrink the page for the on-screen keyboard; it shrinks the visual
  // viewport and pans it. The shell takes the visual viewport's height and place instead, so it is
  // short and its chat head stays at the top of what shows. Checked here with a faked visual
  // viewport: a 390 x 844 window with 380 px left above the keyboard, then the keyboard closing.
  class FakeViewport extends EventTarget {
    height = 380;
    width = 390;
    offsetTop = 0;
    offsetLeft = 0;
    scale = 1;
  }
  const fake = new FakeViewport();
  const real = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
  try {
    await renderLongChat([390, 844]);
    const shell = one('.cd-public-shell');
    await vi.waitFor(() => expect(isShort()).toBe(true));
    expect(shell.getBoundingClientRect().height).toBe(380);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(innerHeight);

    // Panned 200 px down as the browser brings the composer into view: the shell moves with it.
    fake.offsetTop = 200;
    fake.dispatchEvent(new Event('scroll'));
    expect(shell.getBoundingClientRect().top).toBe(200);

    // The keyboard closes: the shell is the window's height again, and tall.
    fake.height = 844;
    fake.offsetTop = 0;
    fake.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(isShort()).toBe(false));
    expect(shell.getBoundingClientRect().height).toBe(844);
    expect(shell.getBoundingClientRect().top).toBe(0);
  } finally {
    if (real) Object.defineProperty(window, 'visualViewport', real);
    else Reflect.deleteProperty(window, 'visualViewport');
  }
});

it('the_about_column_keeps_focus_when_it_stops_scrolling', async () => {
  // Focus on the about column while it scrolls on its own, then a taller window where it fits:
  // focus stays on the column, and once it moves on, the column is no longer a stop.
  await renderLongChat([1024, 640]);
  const about = one('[aria-labelledby]:is(aside, section)');
  expect(about.tabIndex).toBe(0);
  about.focus();
  await page.viewport(1024, 1100);
  await vi.waitFor(() => expect(about.scrollHeight).toBeLessThanOrEqual(about.clientHeight));
  await nextFrames();
  expect(document.activeElement).toBe(about);
  (page.getByRole('button', { name: 'Ask for Mike Turner' }).element() as HTMLElement).focus();
  await vi.waitFor(() => expect(about.hasAttribute('tabindex')).toBe(false));
});

it('the_composer_comes_out_from_under_the_chat_head', async () => {
  // At the top of a chat on a short shell, a wrapped tagline can leave the chat's head over the
  // composer. When the composer takes focus or grows there, the shell scrolls by the overlap, so the
  // visitor sees what they type.
  const seen = [];
  for (const size of [[568, 320], [360, 380]] satisfies Size[]) {
    await renderLongChat(size, { language: 'es', tagline: THREE_LINE_TAGLINE });
    scroller().scrollTop = 0;
    await pasteLongDraft();
    await nextFrames();
    const head = one('.cd-public-shell__chat-head').getBoundingClientRect();
    const composer = one('.cd-public-shell__composer').getBoundingClientRect();
    seen.push({ window: named(size), clear: head.bottom <= composer.top + 1, composer: uncovered(one('.cd-composer')), disclosure: uncovered(disclosureLine()) });
  }
  expect(seen).toEqual([
    { window: '568x320', clear: true, composer: true, disclosure: true },
    { window: '360x380', clear: true, composer: true, disclosure: true },
  ]);
});

it('a_window_crossing_900_in_one_step_settles_without_a_switch', async () => {
  // A laptop window snapped to a phone's size in one step, and back: the about column moves first,
  // then the shell judges whether it is short with the column where it now is. A column still beside
  // a chat too narrow for it would squeeze the chat's head and the composer and turn a roomy phone
  // short for a frame; nothing switches, and the shell tells the page of no new scroller.
  await renderLongChat([1440, 900]);
  const events: Event[] = [];
  const listen = (event: Event) => events.push(event);
  document.addEventListener('cd-public-shell-scroller', listen);
  try {
    await page.viewport(390, 844);
    await vi.waitFor(() => expect(one('.cd-public-shell__scroll').contains(one('[aria-labelledby]:is(aside, section)'))).toBe(true));
    await nextFrames();
    expect(isShort()).toBe(false);
    await page.viewport(1440, 900);
    await vi.waitFor(() => expect(one('.cd-public-shell__scroll').contains(one('[aria-labelledby]:is(aside, section)'))).toBe(false));
    await nextFrames();
    expect(isShort()).toBe(false);
    expect(events).toHaveLength(0);
  } finally {
    document.removeEventListener('cd-public-shell-scroller', listen);
  }
});

it('a_banner_sits_above_the_header_and_counts_in_the_fit', async () => {
  // A banner (the vision bar) is the top of the shell's column: pinned with the brand header while
  // tall, scrolled away with it while short. Its height counts among the pinned parts, so a phone
  // with room for the conversation without it (320 x 568) is short with it. The banner is 96 px,
  // well past the fit's margin, so the result doesn't hang on a few pixels of font metrics.
  const seen = [];
  for (const size of [[1440, 900], [568, 320], [320, 568]] satisfies Size[]) {
    await renderLongChat(size, { banner: true });
    const banner = one('[data-testid="banner"]');
    const scrolls = scroller();
    scrolls.scrollTop = 0;
    const start = { bannerAtTheTop: banner.getBoundingClientRect().top === 0, headerUnderIt: one('.cd-public-brand').getBoundingClientRect().top === banner.getBoundingClientRect().bottom };
    followTheChat();
    seen.push({
      window: named(size),
      short: isShort(),
      start,
      followingBannerInView: inWindow(banner),
      disclosure: uncovered(disclosureLine()),
      documentFits: document.documentElement.scrollHeight <= innerHeight,
      conversationShown: conversationShown() >= 96 ? '96 px or more' : `${conversationShown()} px`,
    });
  }
  const start = { bannerAtTheTop: true, headerUnderIt: true };
  expect(seen).toEqual([
    { window: '1440x900', short: false, start, followingBannerInView: true, disclosure: true, documentFits: true, conversationShown: '96 px or more' },
    { window: '568x320', short: true, start, followingBannerInView: false, disclosure: true, documentFits: true, conversationShown: '96 px or more' },
    { window: '320x568', short: true, start, followingBannerInView: false, disclosure: true, documentFits: true, conversationShown: '96 px or more' },
  ]);
});

it('owner_in_chat_says_so_in_the_chat_head', async () => {
  // While Mike is in the chat, the chat's head says so on the disclosure's own line, in its type:
  // Claude is still named as an AI, paused until he hands the chat back. Each of his names is
  // marked as written by someone, as the shell marks names, and "Ask for Mike Turner" isn't there.
  const seen = [];
  for (const language of ['en', 'es'] as const) {
    await renderLongChat([1440, 900], { language, ownerInChat: true });
    const head = one('.cd-public-shell__chat-head');
    const lines = [...head.querySelectorAll<HTMLElement>('.cd-public-shell__disclosure')];
    seen.push({
      language,
      lines: lines.map((line) => line.textContent),
      meta: lines.every((line) => line.localName === 'p' && line.classList.contains('cd-type-meta')),
      names: lines.flatMap((line) => [...line.querySelectorAll('[data-copy="user"]')].map((name) => name.textContent)),
      buttons: head.querySelectorAll('button').length,
    });
  }
  expect(seen).toEqual([
    { language: 'en', lines: [PAUSED.en], meta: true, names: ['Mike Turner', 'Mike Turner'], buttons: 0 },
    { language: 'es', lines: [PAUSED.es], meta: true, names: ['Mike Turner', 'Mike Turner'], buttons: 0 },
  ]);
});

/** The words of each button in the chat's head. */
function headButtons(): (string | null)[] {
  return [...one('.cd-public-shell__chat-head').querySelectorAll('button')].map((button) => button.textContent);
}

it('the_disclosure_and_ask_come_back_when_the_owner_hands_back', async () => {
  // Mike joins and hands back on an open page: the chat's head follows each time, on the same
  // line. While he is in the chat there is no "Ask for Mike Turner"; once he hands back, the
  // usual disclosure and the button are back.
  await renderLongChat([390, 844]);
  const line = disclosureLine();
  const state = () => ({ words: disclosureLine().textContent, sameLine: disclosureLine() === line, buttons: headButtons() });
  const seen = [state()];
  act(() => root.render(<LongChat ownerInChat />));
  seen.push(state());
  act(() => root.render(<LongChat />));
  seen.push(state());
  expect(seen).toEqual([
    { words: DISCLOSURE, sameLine: true, buttons: ['Ask for Mike Turner'] },
    { words: PAUSED.en, sameLine: true, buttons: [] },
    { words: DISCLOSURE, sameLine: true, buttons: ['Ask for Mike Turner'] },
  ]);
});

it('the_shell_fits_itself_again_as_the_owner_joins_and_hands_back', async () => {
  // The paused line wraps otherwise than the disclosure, and Ask leaves the chat's head with it, so
  // the head changes height as Mike joins and hands back, and the shell judges short or tall again
  // each time. On a phone under a banner, in a window that leaves the conversation a little under
  // 120 px while Ask is shown (short), the head without Ask leaves it more than the 136 px a short
  // shell needs to turn tall; when he hands back, it is short again.
  await renderLongChat([390, 844], { banner: true });
  const parts = ['.cd-public-shell__banner', '.cd-public-brand', '.cd-public-shell__chat-head', '.cd-public-shell__composer', '.cd-public-shell__footer'];
  const pinned = parts.reduce((sum, selector) => sum + one(selector).offsetHeight, 0);
  const withAsk = one('.cd-public-shell__chat-head').offsetHeight;
  act(() => root.render(<LongChat banner ownerInChat />));
  const freed = withAsk - one('.cd-public-shell__chat-head').offsetHeight;
  // Ask's row and the gap over it, at least, less the 16 px a short shell keeps to spare.
  expect(freed).toBeGreaterThan(24);
  const height = pinned + 120 - Math.round((freed - 16) / 2);
  expect(height).toBeGreaterThanOrEqual(520);

  act(() => root.render(<LongChat banner />));
  await page.viewport(390, height);
  await vi.waitFor(() => expect(isShort()).toBe(true));
  const shell = one('.cd-public-shell');
  const fitted = () => shell.style.getPropertyValue('--cd-public-head-height') === `${one('.cd-public-shell__chat-head').offsetHeight}px`;
  const seen = [{ short: isShort(), fitted: fitted() }];
  act(() => root.render(<LongChat banner ownerInChat />));
  await vi.waitFor(() => expect(isShort()).toBe(false));
  seen.push({ short: isShort(), fitted: fitted() });
  act(() => root.render(<LongChat banner />));
  await vi.waitFor(() => expect(isShort()).toBe(true));
  seen.push({ short: isShort(), fitted: fitted() });
  expect(seen).toEqual([
    { short: true, fitted: true },
    { short: false, fitted: true },
    { short: true, fitted: true },
  ]);
});

it('focus_on_ask_goes_on_to_the_composer_as_the_owner_joins', async () => {
  // A keyboard visitor on "Ask for Mike Turner" as Mike joins: the button leaves the chat's head,
  // and focus goes on to the composer's text box rather than dropping to the page; with the text box
  // disabled, to the conversation's scroll region, the stop after Ask. Focus anywhere else, or
  // nowhere, stays where it was.
  await renderLongChat([390, 844]);
  const ask = () => page.getByRole('button', { name: 'Ask for Mike Turner' }).element() as HTMLElement;
  const join = (options: LongChatOptions = {}) => act(() => root.render(<LongChat {...options} ownerInChat />));
  const leave = (options: LongChatOptions = {}) => act(() => root.render(<LongChat {...options} />));
  const focused = () => {
    const active = document.activeElement;
    if (active === one('.cd-composer__input')) return 'the text box';
    if (active === one('.cd-public-shell__scroll')) return 'the scroll region';
    return active === document.body ? 'the page' : (active?.localName ?? 'nothing');
  };
  const seen: Record<string, string> = {};

  ask().focus();
  join();
  seen.fromAsk = focused();

  leave({ composerDisabled: true });
  ask().focus();
  join({ composerDisabled: true });
  seen.fromAskWithTheComposerDisabled = focused();

  leave();
  one('.cd-public-shell__scroll').focus();
  join();
  seen.fromTheScrollRegion = focused();

  leave();
  (document.activeElement as HTMLElement | null)?.blur();
  join();
  seen.fromNowhere = focused();

  expect(seen).toEqual({
    fromAsk: 'the text box',
    fromAskWithTheComposerDisabled: 'the scroll region',
    fromTheScrollRegion: 'the scroll region',
    fromNowhere: 'the page',
  });
});

it('focus_on_ask_moves_on_when_the_chat_cannot_be_written_in', async () => {
  await renderLongChat([390, 844]);
  const ask = () => page.getByRole('button', { name: 'Ask for Mike Turner' });
  for (const composerDisabled of [false, true]) {
    act(() => root.render(<LongChat composerDisabled={composerDisabled} />));
    (ask().element() as HTMLElement).focus();
    await expect.element(ask()).toHaveFocus();
    act(() => root.render(<LongChat composerDisabled={composerDisabled} askDisabled />));
    await expect.element(ask()).toBeDisabled();
    expect(document.activeElement).toBe(one(composerDisabled ? '.cd-public-shell__scroll' : '.cd-composer__input'));
  }
  act(() => root.render(<LongChat />));
  one('.cd-public-shell__scroll').focus();
  act(() => root.render(<LongChat askDisabled />));
  expect(document.activeElement).toBe(one('.cd-public-shell__scroll'));
});

it('focus_moving_on_from_ask_scrolls_nothing', async () => {
  // On a short shell, a keyboard visitor reading mid-chat with focus on "Ask for Mike Turner" as
  // Mike joins: focus goes on to the composer's text box, or with that disabled to the scroll
  // region, without scrolling. The message they were reading stays where it was on screen. The
  // shell's scrollTop moves only by what the chat's head lost with Ask, as the browser keeps the
  // conversation in place under a head that got shorter (scroll anchoring).
  const seen = [];
  for (const composerDisabled of [false, true]) {
    await renderLongChat([568, 320], { composerDisabled });
    const shell = one('.cd-public-shell');
    const head = one('.cd-public-shell__chat-head');
    shell.scrollTop = Math.round(shell.scrollHeight / 2);
    (page.getByRole('button', { name: 'Ask for Mike Turner' }).element() as HTMLElement).focus();
    await nextFrames();
    const reading = [...container.querySelectorAll<HTMLElement>('.cd-transcript-row')].find(
      (row) => row.getBoundingClientRect().top > head.getBoundingClientRect().bottom,
    );
    if (!reading) throw new Error('no message under the chat head');
    const before = { scrollTop: shell.scrollTop, head: head.offsetHeight, reading: reading.getBoundingClientRect().top };
    act(() => root.render(<LongChat composerDisabled={composerDisabled} ownerInChat />));
    await nextFrames();
    seen.push({
      composerDisabled,
      short: isShort(),
      focused: document.activeElement === one(composerDisabled ? '.cd-public-shell__scroll' : '.cd-composer__input'),
      readingMoved: reading.getBoundingClientRect().top - before.reading,
      scrolledPastWhatTheHeadLost: shell.scrollTop - before.scrollTop + (before.head - head.offsetHeight),
    });
  }
  expect(seen).toEqual([
    { composerDisabled: false, short: true, focused: true, readingMoved: 0, scrolledPastWhatTheHeadLost: 0 },
    { composerDisabled: true, short: true, focused: true, readingMoved: 0, scrolledPastWhatTheHeadLost: 0 },
  ]);
});
