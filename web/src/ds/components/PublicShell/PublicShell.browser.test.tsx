/**
 * The public page is a column the window's height: the business's header and the AI disclosure at
 * the top, the composer at the bottom, and only the conversation scrolling between them. The
 * document itself never scrolls, so however long the chat gets, and wherever the visitor is in it,
 * the disclosure (part of the always-on baseline) stays on screen. The same rule as AppShell's.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import type { PublicDesk } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
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

const DISCLOSURE = "You're chatting with Claude, an AI answering for Rivera Plumbing. Ask for Maria Rivera anytime.";

const desk = rivera.publicDesk.en;

/** The page's brand, as the screen maps `PublicDesk` to it. */
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

/**
 * The public page with a chat of 80 messages, each with the screen-reader-only line a receipt
 * carries: absolutely placed, so it would stretch the document if the conversation's scroll region
 * didn't hold it.
 */
function LongChat() {
  return (
    <PublicShell
      brand={brandOf(desk)}
      ownerName={rivera.business.ownerName}
      language="en"
      openStatus={{
        open: true,
        until: '2026-10-29T18:00:00-07:00',
        opens_at: null,
        text: 'Open now, until 6:00 pm',
        as_of: '2026-10-29T10:00:00-07:00',
        refresh_at: '2026-10-29T18:00:00-07:00',
      }}
      onAskForOwner={() => {}}
      about={desk.charter}
      composer={<Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={() => {}} />}
    >
      <Transcript label="Conversation with Rivera Plumbing">
        {Array.from({ length: 80 }, (_, index) => (
          <TranscriptRow key={index}>
            <VisitorMessage text={`Message ${index + 1}: is drain clearing the same price on a Saturday?`} />
            <span className="cd-sr-only">Reply checked before the visitor saw it.</span>
          </TranscriptRow>
        ))}
      </Transcript>
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
      composer={<Composer variant="visitor" label="Message Rivera Plumbing" placeholder="Message Rivera Plumbing" maxLength={2000} onSend={() => {}} />}
    >
      <Transcript label="Conversation with Rivera Plumbing">
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
async function renderLongChat([width, height]: Size): Promise<void> {
  act(() => root.render(null));
  await page.viewport(width, height);
  act(() => root.render(<LongChat />));
  await vi.waitFor(() => expect(container.querySelectorAll('.cd-transcript-row')).toHaveLength(80));
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

/** Each window's name: "390x844". */
const named = ([width, height]: Size) => `${width}x${height}`;

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

it('about_column_moves_as_the_window_crosses_900_and_the_draft_stays', async () => {
  // A window narrowed past 900 px (or a tablet turned) with the page open: the about column moves
  // into the scroll region, and back when it widens, while the rest of the page stays mounted, so
  // an unsent draft is the same text box with the same words.
  await renderLongChat([1440, 900]);
  const box = page.getByRole('textbox', { name: 'Message Rivera Plumbing' });
  await userEvent.type(box, 'Keep this draft');
  const textarea = box.element() as HTMLTextAreaElement;
  const inTheRegion = () => scrollRegion()?.contains(one('[aria-labelledby]:is(aside, section)')) ?? false;
  expect(inTheRegion()).toBe(false);

  await page.viewport(820, 900);
  await vi.waitFor(() => expect(inTheRegion()).toBe(true));
  expect(box.element()).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft');
  expect(document.documentElement.scrollHeight).toBe(900);

  await page.viewport(1440, 900);
  await vi.waitFor(() => expect(inTheRegion()).toBe(false));
  expect(box.element()).toBe(textarea);
  expect(textarea.value).toBe('Keep this draft');
});

it('the_scroll_region_takes_the_keyboard', async () => {
  // A conversation with nothing to focus in it can still be scrolled from the keyboard: the region
  // is a stop in the tab order after "Ask for Maria Rivera", named by the chat's title, and End
  // takes it to the newest message.
  await renderLongChat([390, 844]);
  const region = scrollRegion();
  if (!region) throw new Error('no scroll region');
  const ask = page.getByRole('button', { name: 'Ask for Maria Rivera' }).element() as HTMLElement;
  ask.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(region);
  expect(region.getAttribute('role')).toBe('group');
  expect(document.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Chat with Rivera Plumbing');
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
