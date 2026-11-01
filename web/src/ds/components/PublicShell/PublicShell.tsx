import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { CardBlock, PublicDesk, RenderedBlock } from '../../../api/contracts.ts';
import { afterName } from '../../../lib/names.ts';
import { Button } from '../Button/Button.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { ReplyCard } from '../ReplyCard/ReplyCard.tsx';
import { SuggestionChips } from '../SuggestionChips/SuggestionChips.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';
import { VisionInertLine } from '../VisionBar/visionInert.tsx';
import { aboutLinkHref } from './guards.ts';
import { PublicBrandHeader } from './PublicBrandHeader.tsx';
import { useFirstView } from './useFirstView.ts';

import './PublicShell.css';

/** The business's look on its public page, mapped from the Desk the kernel serves (`PublicDesk`). */
export interface PublicBrand {
  /** `business_name`: "Turner Plumbing". */
  name: string;
  /** One line under the name: the Desk's name, "Main line". */
  tagline: string;
  /** The business's first letter, drawn in a square beside the name (`aria-hidden`). */
  monogram: string;
  /** The header's ground: a `#rrggbb` color, or a token as `var(--token)`. */
  field: string;
  /** The name's color over the field; it keeps 4.5:1. */
  ink: string;
  /** The tagline's color over the field; it keeps 4.5:1 too. */
  inkSecondary: string;
  /** Decorative only: the 2 px rule under the header. */
  accent: string;
}

/**
 * Whether the business is open now: `PublicDesk['open_status']`, the kernel's own object, or null
 * for a Desk without hours. The kernel works it out from the business's hours on its own clock and
 * writes `text` in the page's language and the business's time zone ("Open now, until 6:00 pm",
 * "Cerrado ahora. Abre el lunes a las 8:00"). The shell reads only `text` and `open`, shows `text`
 * as written and works out no time.
 *
 * It is the kernel's own `OpenStatus`, as `PublicDesk` carries it, so a screen can only pass what
 * the kernel served, never a time it made up.
 */
export type PublicOpenStatus = PublicDesk['open_status'];

export interface PublicShellProps {
  brand: PublicBrand;
  /**
   * Whom a visitor can ask for: `owner_display_name`, "Mike Turner". Null when the owner gave no
   * name: the shell then asks for "a person" in its own words and names no one.
   */
  ownerName: string | null;
  /** The visitor's language: every line of the shell's own copy, and `lang` on the page. */
  language: CopyLanguage;
  /**
   * `PublicDesk.open_status` as served: the kernel's words in the header, with a filled dot when
   * open, and a hollow one and "Claude can still help." under them when closed. Without it (null
   * for a Desk without hours), or when it isn't whole, the header has no status line.
   */
  openStatus?: PublicOpenStatus;
  /** Asks for the owner in the chat. */
  onAskForOwner: () => void;
  /**
   * The owner is in the chat (a take-over). While it is set, the chat's head says so on the
   * disclosure's line, "{owner} is in this chat. Claude, an AI, is paused until {owner} hands it
   * back.", which still names Claude as an AI, and "Ask for {owner}" isn't shown. `false` by default.
   *
   * Its one source is the kernel's session mode: `SessionState.mode === 'owner'` when the chat opens
   * or reloads, kept current by the stream's `owner_joined` and `owner_left`. The line tells the
   * visitor a person is in the chat, so it is never set from anything else. `PublicChat` passes
   * `chat.ownerInChat` from `PublicChatProvider`, which derives it through `ownerInChatNow`. The flag
   * is false while the stream is disconnected or catching up, or the session mode is not confirmed.
   */
  ownerInChat?: boolean;
  /**
   * Vision pages only, which make no requests: "Ask for {owner}" keeps its look, focus and place,
   * but pressing it does nothing (`onAskForOwner` is never called), and the first press shows the
   * vision line in the chat's pinned head, under its title and the button. Never on a real page.
   */
  inertAsk?: boolean;
  /** `PublicDesk.charter`: cards as `ReplyCard`s, prose as text, in the about column. */
  about?: RenderedBlock[];
  /** Links for people's AI agents, under "For AI agents" after the about blocks. */
  aboutLinks?: { label: string; href: string }[];
  /**
   * `false` when the page sits inside an owner screen with its own footer and landmarks: the
   * concept footer is left out, and the shell's regions aren't page landmarks.
   */
  footer?: boolean;
  /** The visitor's `Composer`, under the conversation. */
  composer: ReactNode;
  /**
   * While true, the shell counts the composer area at the tallest it has been since, when it decides
   * whether it is short, so a line the page shows above the composer and takes away again (the public
   * chat's, for a waiting request) can't switch it between tall and short as it comes and goes. Each
   * switch moves the conversation, which can bring the reason for that line into view and out of it
   * again. Once it turns false, the shell forgets that height and fits itself again at once. `false`
   * by default.
   */
  keepComposerRoom?: boolean;
  /** Before the first message only. Omit for a conversation with any history. */
  firstView?: boolean;
  /** Localized business content. At most three; a pick uses the page's ordinary send path. */
  starters?: { words: readonly string[]; onPick: (text: string) => void; disabled?: boolean };
  /**
   * A full-width line above the brand header, inside the window's height, such as the `VisionBar`
   * over a vision page. Left out, the brand header is the top of the page.
   */
  banner?: ReactNode;
  /** The conversation: a `Transcript` and what goes with it. */
  children: ReactNode;
}

/** A name someone chose, exempt from the copy check's voice rules. */
function Name({ children }: { children: string }) {
  return <span data-copy="user">{children}</span>;
}

/** Shared with the wordless shape's browser measurement. */
export const ASK_OWNER_PREFIX = { en: 'Ask for ', es: 'Pedir hablar con ' } as const;

/**
 * The shell's own copy. The AI disclosure is part of it, in both languages, and can't be turned off.
 * `owner` is the owner's name, marked as written by someone, or null when the owner gave none: then
 * each line asks for "a person" or says "the business owner" instead, in the owner's approved words,
 * and names no one.
 */
const COPY = {
  en: {
    chatWith: (name: ReactNode) => <>Chat with {name}</>,
    /** @param nameText The name's plain text, used only to decide the period. */
    disclosure: (name: ReactNode, owner: ReactNode | null, nameText: string) =>
      owner === null ? (
        <>
          You&apos;re chatting with Claude, an AI answering for {name}{afterName(nameText, '. Ask for a person anytime.')}
        </>
      ) : (
        <>
          You&apos;re chatting with Claude, an AI answering for {name}{afterName(nameText, '. Ask for ')}{owner} anytime.
        </>
      ),
    /** In the disclosure's place while the owner is in the chat: Claude is still named as an AI. */
    ownerInChat: (owner: ReactNode | null) =>
      owner === null ? (
        <>The business owner is in this chat. Claude, an AI, is paused until they hand it back.</>
      ) : (
        <>
          {owner} is in this chat. Claude, an AI, is paused until {owner} hands it back.
        </>
      ),
    askFor: (owner: ReactNode | null) => (owner === null ? <>{ASK_OWNER_PREFIX.en}a person</> : <>{ASK_OWNER_PREFIX.en}{owner}</>),
    about: (name: ReactNode) => <>About {name}</>,
    forAgents: 'For AI agents',
    greeting: (name: ReactNode) => <>How can {name} help?</>,
    invitation: 'Try one of these, or ask in your own words.',
    suggestions: 'Suggestions',
  },
  es: {
    chatWith: (name: ReactNode) => <>Chatea con {name}</>,
    /** @param nameText The name's plain text, used only to decide the period. */
    disclosure: (name: ReactNode, owner: ReactNode | null, nameText: string) =>
      owner === null ? (
        <>
          Estás hablando con Claude, una IA que responde por {name}{afterName(nameText, '. Puedes pedir hablar con una persona cuando quieras.')}
        </>
      ) : (
        <>
          Estás hablando con Claude, una IA que responde por {name}{afterName(nameText, '. Puedes pedir hablar con ')}{owner} cuando quieras.
        </>
      ),
    ownerInChat: (owner: ReactNode | null) =>
      owner === null ? (
        <>El dueño del negocio está en este chat. Claude, una IA, está en pausa hasta que le devuelva el chat.</>
      ) : (
        <>
          {owner} está en este chat. Claude, una IA, está en pausa hasta que {owner} le devuelva el chat.
        </>
      ),
    askFor: (owner: ReactNode | null) => (owner === null ? <>{ASK_OWNER_PREFIX.es}una persona</> : <>{ASK_OWNER_PREFIX.es}{owner}</>),
    about: (name: ReactNode) => <>Sobre {name}</>,
    forAgents: 'Para agentes de IA',
    greeting: (name: ReactNode) => <>¿En qué te puede ayudar {name}?</>,
    invitation: 'Prueba una de estas o pregunta con tus palabras.',
    suggestions: 'Sugerencias',
  },
} satisfies Record<CopyLanguage, unknown>;

/** From this width up, the about column stands at the right of the chat. */
const ABOUT_BESIDE_FROM = 900;

/** Below this height the shell is short, whatever it holds. */
const SHORT_BELOW = 520;

/**
 * The least room the conversation gets with the brand header and the footer pinned, in px. With
 * less the shell is short, whatever its height: a tagline that wraps, the longest closed status or
 * a long draft can fill a shell well over 520 px.
 */
const MIN_CONVERSATION = 120;

/**
 * How much more room than that a short shell needs before it pins the header and the footer
 * again, in px, so it can't flap between the two as a draft grows and shrinks at the edge.
 */
const LEAVE_SHORT_MARGIN = 16;

/** The shell's class while it is short. */
const SHORT_CLASS = 'cd-public-shell--short';

/**
 * How close under the chat's head, in px, the about column's own hairline (its bottom border, not
 * a card's edge inside it) is left out where the column opens the scroll region: the head draws its
 * own line, and the column's a few px under it would read as two. A card's edge passing under the
 * head is the column's content scrolling, as a message's is.
 */
const ABOUT_LINE_CLEAR_OF_HEAD = 24;

/** The about column's class while its own hairline lies that close under the chat's head. */
const ABOUT_UNDER_HEAD_CLASS = 'cd-public-shell__about--under-head';

/**
 * The event a shell sends from its root, bubbling, once each time the element that scrolls its
 * conversation changes (the shell turning short, or tall again). The page that follows the chat
 * listens for it: see the README.
 */
export const PUBLIC_SHELL_SCROLLER_EVENT = 'cd-public-shell-scroller';

/** What `PUBLIC_SHELL_SCROLLER_EVENT` carries. */
export interface PublicShellScrollerDetail {
  /** The element that now scrolls the conversation: the scroll region, or the shell itself when short. */
  scroller: HTMLElement;
}

/** Whatever can take focus inside the about column, in order. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The shell's parts that its layout measures. */
function partsOf(shell: HTMLElement) {
  return {
    banner: shell.querySelector<HTMLElement>(':scope > .cd-public-shell__banner'),
    header: shell.querySelector<HTMLElement>('.cd-public-brand'),
    head: shell.querySelector<HTMLElement>('.cd-public-shell__chat-head'),
    region: shell.querySelector<HTMLElement>('.cd-public-shell__scroll'),
    composer: shell.querySelector<HTMLElement>('.cd-public-shell__composer'),
    footer: shell.querySelector<HTMLElement>('.cd-public-shell__footer'),
  };
}

/** An element's height, or 0 when there is none. */
function heightOf(el: HTMLElement | null): number {
  return el?.offsetHeight ?? 0;
}

/** An element's padding at its top and bottom together. */
function verticalPadding(el: HTMLElement | null): number {
  if (!el) return 0;
  const style = getComputedStyle(el);
  return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
}

/**
 * Where focus goes when "Ask for {owner}" leaves the chat's head with it: the composer's text box,
 * or, while that is disabled or there is none, the conversation's scroll region, the stop after Ask.
 * Without scrolling: the visitor stays where they were reading.
 */
function focusAfterAsk(shell: HTMLElement): void {
  const box = shell.querySelector<HTMLElement>('.cd-public-shell__composer textarea:not(:disabled)');
  (box ?? partsOf(shell).region)?.focus({ preventScroll: true });
}

/** The element that scrolls the conversation now: the shell when it is short, its scroll region when not. */
function scrollerOf(shell: HTMLElement): HTMLElement | null {
  return shell.classList.contains(SHORT_CLASS) ? shell : partsOf(shell).region;
}

/**
 * Where focus is in the about column, as a way to put it back once the column has moved: the same
 * link in the moved column, or the scroll region when the column itself had focus and is no longer
 * a stop of its own. `null` when focus is elsewhere.
 */
function focusInAbout(shell: HTMLElement): (() => void) | null {
  const column = shell.querySelector('.cd-public-shell__about');
  const active = document.activeElement;
  if (!column || !(active instanceof HTMLElement) || !column.contains(active)) return null;
  const index = [...column.querySelectorAll(FOCUSABLE)].indexOf(active);
  return () => {
    if (active.isConnected) return;
    const moved = shell.querySelector('.cd-public-shell__about');
    const same = index >= 0 ? moved?.querySelectorAll<HTMLElement>(FOCUSABLE)[index] : undefined;
    (same ?? partsOf(shell).region)?.focus();
  };
}

/**
 * Where the visitor is reading: what is first under the chat's head, and how far under it. That is
 * the about column while it opens the scroll region and still reaches under the head (the chat's
 * start on a narrow shell), and the first message otherwise. Returns a way to put it back at the
 * same place, whichever element scrolls the conversation by then; `null` when nothing is under the
 * chat's head. Partly above the head, the same share of it goes back above, so the same part of it
 * is at the head's edge however it has wrapped since, and it is still what is first under the head.
 * Nothing is put back once the element that now scrolls the conversation no longer holds it, as
 * when the about column has moved beside the chat.
 *
 * Read it while the page stands as the visitor sees it, not once a new width has laid it out: by
 * then the about column, the messages and the chat's head have wrapped onto other lines, and the
 * browser's scroll anchoring may have moved the conversation to keep some other element still.
 */
function readingPlace(shell: HTMLElement): (() => void) | null {
  const { head } = partsOf(shell);
  if (!head) return null;
  const line = head.getBoundingClientRect().bottom;
  const about = aboutInRegion(shell);
  const rows = [...shell.querySelectorAll<HTMLElement>('.cd-public-shell__conversation .cd-transcript-row')];
  const anchor =
    about && about.getBoundingClientRect().bottom > line
      ? about
      : rows.find((candidate) => candidate.getBoundingClientRect().bottom > line);
  if (!anchor) return null;
  const { top, height } = anchor.getBoundingClientRect();
  const offset = top - line;
  return () => {
    // Twice: on a short shell, scrolling moves the chat's head too until the brand header is gone.
    for (let pass = 0; pass < 2; pass += 1) {
      const scroller = scrollerOf(shell);
      if (!scroller || !anchor.isConnected || !scroller.contains(anchor)) return;
      const now = anchor.getBoundingClientRect();
      const wanted = offset < 0 && height > 0 ? (offset * now.height) / height : offset;
      const drift = now.top - head.getBoundingClientRect().bottom - wanted;
      if (Math.abs(drift) < 0.5) return;
      scroller.scrollTop += drift;
    }
  };
}

/**
 * On a short shell at the top of a chat, the brand header, the chat's head and a tall composer can
 * be taller than the shell together, and the chat's head then stays over the composer. Scrolls the
 * shell by the overlap, so the composer comes out from under it.
 */
function uncoverComposer(shell: HTMLElement): void {
  if (!shell.classList.contains(SHORT_CLASS)) return;
  const { head, composer } = partsOf(shell);
  if (!head || !composer) return;
  const overlap = head.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
  if (overlap > 0) shell.scrollTop += overlap;
}

/** The about column while it opens the scroll region; null while it stands beside the chat, or there is none. */
function aboutInRegion(shell: HTMLElement): HTMLElement | null {
  return partsOf(shell).region?.querySelector<HTMLElement>(':scope > .cd-public-shell__about') ?? null;
}

/**
 * Marks the about column, where it opens the scroll region, while its own hairline lies within
 * `ABOUT_LINE_CLEAR_OF_HEAD` px under the chat's head, so the stylesheet leaves that line out and
 * the head's is the one line there. Lower down the column draws its line as ever.
 */
function markAboutUnderHead(shell: HTMLElement): void {
  const { head } = partsOf(shell);
  const about = aboutInRegion(shell);
  if (!head || !about) return;
  // The column's hairline is its last pixel row: `under` px under the head's edge.
  const under = about.getBoundingClientRect().bottom - 1 - head.getBoundingClientRect().bottom;
  about.classList.toggle(ABOUT_UNDER_HEAD_CLASS, under < ABOUT_LINE_CLEAR_OF_HEAD);
}

/**
 * Has the shell's `observer` watch the about column while it opens the scroll region, and stop
 * watching one that has moved beside the chat or gone (`watched` is the one it watches now). The
 * column's own height moves its hairline, as when the web font arrives after the fallback laid it out.
 */
function watchAbout(shell: HTMLElement, observer: ResizeObserver | null, watched: { current: HTMLElement | null }): void {
  const about = aboutInRegion(shell);
  if (!observer || about === watched.current) return;
  if (watched.current) observer.unobserve(watched.current);
  if (about) observer.observe(about);
  watched.current = about;
}

/**
 * Lays the shell out at its own size. It lays out by its own size, inside an owner's panel as on a
 * page of its own, so it watches itself and its pinned parts, not the window. Returns whether the
 * about column stands beside the chat.
 *
 * - **The about column** stands beside the chat from 900 px wide. Until the shell has measured
 *   itself it opens the scroll region, where it takes nothing from the chat's width, so nothing in
 *   the chat (the composer sizing its text box) measures itself at a width the visitor never sees.
 * - **Short** below 520 px tall, or when the banner (if any), the brand header, the chat's head,
 *   the composer area and the footer, pinned, would leave the conversation under 120 px; tall again
 *   only with 16 px to spare. The short class is set on the shell directly, in a layout effect, so it is in place
 *   before the page's own layout effects run (they run after the shell's) and the page scrolls the
 *   right element from the first render on. React's class for the shell leaves it out, and the
 *   shell puts it back after every render.
 * - **Measurements for the stylesheet:** the shell's height as `--cd-public-shell-height` (it caps
 *   the composer's text box), and the chat's head's and the composer area's heights as
 *   `--cd-public-head-height` and `--cd-public-composer-height` (a short shell's scroll padding).
 * - **The about column's own hairline** under the conversation's start, left out while it lies just
 *   under the chat's head (`markAboutUnderHead`), judged again after every render, scroll and
 *   resize, the column's own included: while it opens the scroll region the shell watches it too,
 *   from whenever it mounts or moves there.
 *
 * When the shell or a pinned part changes size, it lays out again at once, before the browser paints
 * and before the page's own observers measure the conversation. If the about column moves with
 * focus in it, focus goes to the same place in the moved column. If the shell turns short or tall,
 * what the visitor was reading stays where it was under the chat's head (`readingPlace`), and the
 * shell sends `PUBLIC_SHELL_SCROLLER_EVENT` with the element that now scrolls the conversation.
 */
export function useShellLayout(shell: RefObject<HTMLElement | null>, keepComposerRoom = false): boolean {
  const [aboutBeside, setAboutBeside] = useState(false);
  const short = useRef(false);
  const observerRef = useRef<ResizeObserver | null>(null);
  const watchedAbout = useRef<HTMLElement | null>(null);
  // `keepComposerRoom` as the shell last rendered it, and how to lay the shell out again when the page
  // lets that room go.
  const keepRoom = useRef(keepComposerRoom);
  const relayoutRef = useRef<(() => void) | null>(null);

  // After every render, before the page's layout effects: the short class, if the shell is short,
  // and the about column, watched where it now is and its hairline judged there. Kept room the page
  // has let go is forgotten, and the shell fits itself again without it.
  useLayoutEffect(() => {
    const letGo = keepRoom.current && !keepComposerRoom;
    keepRoom.current = keepComposerRoom;
    if (letGo) relayoutRef.current?.();
    shell.current?.classList.toggle(SHORT_CLASS, short.current);
    if (!shell.current) return;
    watchAbout(shell.current, observerRef.current, watchedAbout);
    markAboutUnderHead(shell.current);
  });

  useLayoutEffect(() => {
    const el = shell.current;
    if (!el) return undefined;
    // The chat's head's and the composer area's padding while tall, read whenever the shell is
    // tall (it always is at first), so the room the conversation would have is the same sum
    // whichever way the shell is laid out now.
    const tallPadding = { head: 0, composer: 0 };
    // The composer area's height inside its padding, at the tallest it has been while the page
    // keeps its room (`keepComposerRoom`); otherwise as it is now.
    let composerKept = 0;
    // Short or tall, measured with the about column where it now is: a column still beside a chat
    // that has just become too narrow for it would squeeze the chat's head and the composer.
    const fit = (): void => {
      const { banner, header, head, composer, footer } = partsOf(el);
      const height = el.offsetHeight;
      el.style.setProperty('--cd-public-shell-height', `${height}px`);
      if (!short.current) {
        tallPadding.head = verticalPadding(head);
        tallPadding.composer = verticalPadding(composer);
      }
      const composerInside = heightOf(composer) - verticalPadding(composer);
      composerKept = keepRoom.current ? Math.max(composerKept, composerInside) : composerInside;
      const pinned =
        heightOf(banner) +
        heightOf(header) +
        heightOf(footer) +
        heightOf(head) - verticalPadding(head) + tallPadding.head +
        composerKept + tallPadding.composer;
      const room = height - pinned;
      short.current = height < SHORT_BELOW || room < MIN_CONVERSATION + (short.current ? LEAVE_SHORT_MARGIN : 0);
      el.classList.toggle(SHORT_CLASS, short.current);
      el.style.setProperty('--cd-public-head-height', `${heightOf(head)}px`);
      el.style.setProperty('--cd-public-composer-height', `${heightOf(composer)}px`);
    };
    const fitsBeside = () => el.offsetWidth >= ABOUT_BESIDE_FROM;
    // At first the column opens the scroll region; if the shell is wide enough it moves beside the
    // chat with the next render, and the observer below fits the shell again once it has.
    fit();
    let beside = fitsBeside();
    setAboutBeside(beside);
    // Where the visitor is reading, as they last saw it at the width the shell was laid out at
    // (`laidOutWidth`): read after each scroll of the conversation, and each time the shell has laid
    // itself out. The observer below hears of a new size only once the browser has laid the page out
    // at it. At the same width nothing under the chat's head has moved by then, and the place is read
    // there; at a new width, as when a phone turns, the about column, the messages and the chat's
    // head have wrapped onto other lines, and the place put back is this one. A scroll at a new width
    // the observer hasn't heard of yet isn't read: it may be the browser's, keeping some other element
    // still. The trade-off: a visitor's own scroll in that very frame is taken for the browser's.
    let laidOutWidth = el.offsetWidth;
    let place = readingPlace(el);
    // The column's line steps aside near the head rather than the chat landing past it: the page lands a chat wherever its end falls.
    // Scroll events don't bubble, so the shell listens in the capture phase, for its region and itself.
    // Only the conversation's scrolling moves the place: not the about column's beside the chat, nor
    // the composer's text box.
    const onScroll = (event: Event) => {
      markAboutUnderHead(el);
      if (event.target === scrollerOf(el) && el.offsetWidth === laidOutWidth) place = readingPlace(el);
    };
    el.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const stopScroll = () => el.removeEventListener('scroll', onScroll, { capture: true });
    if (typeof ResizeObserver === 'undefined') return stopScroll;
    // Lays the shell out again: when it or a pinned part changes size, and when the page lets kept
    // room go. Only the observer's call (`sync`) moves the about column at once; from the shell's
    // own layout effect, React is already committing, so the column follows with the next render.
    const relayout = (sync: boolean) => {
      const wasShort = short.current;
      const wasBeside = beside;
      const restoreFocus = focusInAbout(el);
      const restorePlace = el.offsetWidth === laidOutWidth ? readingPlace(el) : place;
      // First the about column, by width, at once; then short or tall, with the column in place.
      beside = fitsBeside();
      if (beside !== wasBeside) {
        if (sync) flushSync(() => setAboutBeside(beside));
        else setAboutBeside(beside);
      }
      fit();
      restoreFocus?.();
      const switched = short.current !== wasShort;
      if (switched || beside !== wasBeside) restorePlace?.();
      const scroller = scrollerOf(el);
      if (switched && scroller) {
        el.dispatchEvent(
          new CustomEvent<PublicShellScrollerDetail>(PUBLIC_SHELL_SCROLLER_EVENT, { bubbles: true, detail: { scroller } }),
        );
      }
      uncoverComposer(el);
      // A scroll the page's later ResizeObserver makes is heard only next frame; that one frame's lag, mid-resize as all moves, is accepted.
      markAboutUnderHead(el);
      laidOutWidth = el.offsetWidth;
      place = readingPlace(el);
    };
    const observer = new ResizeObserver(() => relayout(true));
    relayoutRef.current = () => relayout(false);
    const { banner, header, head, composer } = partsOf(el);
    for (const part of [el, banner, header, head, composer]) if (part) observer.observe(part);
    observerRef.current = observer;
    watchAbout(el, observer, watchedAbout);
    // The composer taking focus at the top of a short chat comes out from under the chat's head.
    const onFocusIn = () => uncoverComposer(el);
    composer?.addEventListener('focusin', onFocusIn);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      relayoutRef.current = null;
      watchedAbout.current = null;
      composer?.removeEventListener('focusin', onFocusIn);
      stopScroll();
    };
  }, [shell]);

  return aboutBeside;
}

/**
 * On a page of its own, the shell takes the visual viewport's height and place while the browser
 * keeps the page's height and only shrinks the visual viewport for the on-screen keyboard (Safari
 * on an iPhone), so it turns short and its chat's head stays at the top of what shows. Not while the
 * visitor has zoomed in, and not inside an owner screen.
 */
export function useVisualViewportFit(shell: RefObject<HTMLElement | null>, embedded: boolean): void {
  useLayoutEffect(() => {
    const el = shell.current;
    const viewport = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (embedded || !el || !viewport) return undefined;
    const fit = () => {
      const keyboard = Math.abs(viewport.scale - 1) < 0.01 && viewport.height < window.innerHeight - 1;
      if (keyboard) {
        el.style.height = `${viewport.height}px`;
        el.style.transform = `translateY(${viewport.offsetTop}px)`;
      } else {
        el.style.removeProperty('height');
        el.style.removeProperty('transform');
      }
    };
    fit();
    viewport.addEventListener('resize', fit);
    viewport.addEventListener('scroll', fit);
    return () => {
      viewport.removeEventListener('resize', fit);
      viewport.removeEventListener('scroll', fit);
      el.style.removeProperty('height');
      el.style.removeProperty('transform');
    };
  }, [shell, embedded]);
}

/**
 * Whether the about column, beside the chat, holds more than it shows and scrolls on its own. It is
 * measured after every render and whenever the column or what is in it changes size.
 */
function useColumnScrolls(column: RefObject<HTMLElement | null>, beside: boolean): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = column.current;
    setScrolls(beside && el !== null && el.scrollHeight > el.clientHeight);
  });
  useLayoutEffect(() => {
    const el = column.current;
    if (!beside || !el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setScrolls(el.scrollHeight > el.clientHeight));
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [column, beside]);
  return scrolls;
}

/**
 * The public page around a conversation, the window's height: the business's brand header (with
 * the kernel's open status when the Desk has hours) and the chat's head with its title, the AI
 * disclosure and "Ask for {owner}" at the top (while the owner is in the chat, the line that says
 * so and that Claude, an AI, is paused, and no Ask); the composer with the concept footer under it
 * at the bottom; and only the conversation's scroll region scrolling between them, so the
 * disclosure never leaves the screen. A banner, such as the vision bar, sits above the brand header and is pinned
 * with it. On a short shell the banner, the brand header and the footer scroll with the conversation
 * and only the chat's head and the composer stay put. The business's charter is an about column at
 * the right, or, when the page is too narrow for it, the start of the conversation's scroll region.
 */
export function PublicShell({
  brand,
  ownerName,
  language,
  openStatus,
  onAskForOwner,
  ownerInChat = false,
  inertAsk = false,
  about,
  aboutLinks,
  footer = true,
  composer,
  keepComposerRoom = false,
  firstView = false,
  starters,
  banner,
  children,
}: PublicShellProps) {
  const copy = COPY[language] ?? COPY.en;
  const embedded = footer === false;
  const aboutId = useId();
  const chatId = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const aboutRef = useRef<HTMLElement>(null);
  useVisualViewportFit(shellRef, embedded);
  const aboutBeside = useShellLayout(shellRef, keepComposerRoom);
  const invitationShown = useFirstView(shellRef, firstView, aboutBeside, starters?.words.length ?? 0);
  // Beside the chat, a column that scrolls on its own is a stop in the tab order, so it scrolls from
  // the keyboard too; it is already named by its heading. It stays one while it has focus, so focus
  // doesn't drop to the page when the column stops scrolling under it.
  const aboutScrolls = useColumnScrolls(aboutRef, aboutBeside);
  const [aboutFocused, setAboutFocused] = useState(false);
  useLayoutEffect(() => {
    setAboutFocused(aboutRef.current !== null && document.activeElement === aboutRef.current);
  }, [aboutBeside]);
  const [inertAskPressed, setInertAskPressed] = useState(false);
  // The owner joining takes "Ask for {owner}" out of the chat's head. Its ref callback notes, as React
  // lets go of it and while it is still on the page, whether it had focus. After the swap, focus goes
  // on (`focusAfterAsk`) only if it had, so it doesn't drop to the page; focus anywhere else, or
  // nowhere, stays where it is.
  const ask = useRef<HTMLButtonElement | null>(null);
  const askLeftWithFocus = useRef(false);
  const askRef = useCallback((element: HTMLButtonElement | null) => {
    if (element === null) askLeftWithFocus.current = ask.current !== null && ask.current === ask.current.ownerDocument.activeElement;
    ask.current = element;
  }, []);
  useLayoutEffect(() => {
    const follow = ownerInChat && askLeftWithFocus.current;
    askLeftWithFocus.current = false;
    if (follow && shellRef.current) focusAfterAsk(shellRef.current);
  }, [ownerInChat]);
  const name = <Name>{brand.name}</Name>;
  const owner = ownerName === null ? null : <Name>{ownerName}</Name>;

  // Standalone, the shell is the page: a banner, the main region and a complementary column.
  // Embedded in an owner screen, the same parts as plain blocks and a named region.
  const Chat = embedded ? 'div' : 'main';
  const About = embedded ? 'section' : 'aside';
  // Only links to a path on this site; anything else is left out.
  const links = (aboutLinks ?? []).flatMap((link) => {
    const href = aboutLinkHref(link.href);
    return href === null ? [] : [{ label: link.label, href }];
  });
  const blocks = about ?? [];
  const hasAbout = blocks.length > 0 || links.length > 0;

  const aboutColumn = hasAbout ? (
    <About
      ref={aboutRef}
      className="cd-public-shell__about"
      aria-labelledby={aboutId}
      tabIndex={aboutBeside && (aboutScrolls || aboutFocused) ? 0 : undefined}
      onFocus={(event) => {
        if (event.target === event.currentTarget) setAboutFocused(true);
      }}
      onBlur={(event) => {
        if (event.target === event.currentTarget) setAboutFocused(false);
      }}
    >
      <h2 id={aboutId} className="cd-public-shell__heading cd-type-section">
        {copy.about(name)}
      </h2>
      {blocks.length > 0 ? (
        <div className="cd-public-shell__blocks">
          {blocks.map((block, index) =>
            block.kind === 'prose' ? (
              block.text.trim() === '' ? null : (
                <p key={index} className="cd-public-shell__prose cd-type-body">
                  {block.text}
                </p>
              )
            ) : (
              // The charter's cards (hours, policies, contact) never name the owner, so a Desk
              // whose owner gave no name has nothing to put in their place.
              <ReplyCard key={index} block={block as CardBlock} language={language} ownerName={ownerName ?? ''} />
            ),
          )}
        </div>
      ) : null}
      {links.length > 0 ? (
        <div className="cd-public-shell__links">
          <h3 className="cd-public-shell__links-heading cd-type-meta">{copy.forAgents}</h3>
          <ul role="list" className="cd-public-shell__link-list cd-type-body">
            {links.map((link) => (
              <li key={`${link.href} ${link.label}`}>
                <TextLink href={link.href}>{link.label}</TextLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </About>
  ) : null;

  return (
    <div
      ref={shellRef}
      className={`cd-public-shell${embedded ? ' cd-public-shell--embedded' : ''}${firstView ? ' cd-public-shell--first-view' : ''}`}
      lang={language}
    >
      {banner ? <div className="cd-public-shell__banner">{banner}</div> : null}
      <PublicBrandHeader brand={brand} language={language} openStatus={openStatus} landmark={!embedded} nameAsHeading={!embedded} />
      <div className="cd-public-shell__body">
        <Chat className="cd-public-shell__chat">
          <div className="cd-public-shell__chat-head">
            <div className="cd-public-shell__chat-title">
              <h2 id={chatId} className="cd-public-shell__heading cd-type-section">
                {copy.chatWith(name)}
              </h2>
              {/* The AI disclosure, or while the owner is in the chat, the line that says so and that
                  Claude, an AI, is paused: either way Claude is named as an AI. */}
              <p className="cd-public-shell__disclosure cd-type-meta">
                {ownerInChat ? copy.ownerInChat(owner) : copy.disclosure(name, owner, brand.name)}
              </p>
            </div>
            {/* A vision page's Ask goes nowhere, and says so once, in the pinned head under its row.
                While the owner is in the chat there is no Ask: the owner is already here. */}
            {ownerInChat ? null : (
              <Button variant="secondary" buttonRef={askRef} onClick={inertAsk ? () => setInertAskPressed(true) : onAskForOwner}>
                {copy.askFor(owner)}
              </Button>
            )}
            {inertAsk ? <VisionInertLine shown={inertAskPressed} /> : null}
          </div>
          {/* The one part of the page that scrolls (on a short shell, it grows and the shell
              scrolls). Too narrow for the about column beside the chat, the column opens it, above
              the first message. A stop in the tab order, named by the chat's title, so a
              conversation with nothing to focus in it still scrolls from the keyboard. */}
          <div className="cd-public-shell__scroll" role="group" aria-labelledby={chatId} tabIndex={0}>
            {aboutBeside || firstView ? null : aboutColumn}
            <div className="cd-public-shell__conversation">
              {invitationShown ? (
                <div className="cd-public-shell__welcome" aria-hidden={!firstView || undefined}>
                  <h2 className="cd-public-shell__greeting cd-type-greeting">{copy.greeting(name)}</h2>
                  {starters && starters.words.length > 0 ? <p className="cd-public-shell__invitation cd-type-meta">{copy.invitation}</p> : null}
                </div>
              ) : null}
              {children}
            </div>
          </div>
          <div className="cd-public-shell__composer">
            <div className="cd-public-shell__composer-group">
              <div className="cd-public-shell__composer-lift">{composer}</div>
              {invitationShown && starters && starters.words.length > 0 ? (
                <div className="cd-public-shell__starters" data-copy="user" aria-hidden={!firstView || undefined}>
                  <SuggestionChips label={copy.suggestions} suggestions={starters.words} onPick={starters.onPick} disabled={!firstView || starters.disabled} />
                </div>
              ) : null}
            </div>
          </div>
          {embedded ? null : (
            <div className="cd-public-shell__footer">
              <ConceptFooter poweredBy />
            </div>
          )}
          {!aboutBeside && firstView ? aboutColumn : null}
        </Chat>
        {aboutBeside ? aboutColumn : null}
      </div>
    </div>
  );
}
