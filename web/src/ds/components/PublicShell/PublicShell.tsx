import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { CardBlock, PublicDesk, RenderedBlock } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { ReplyCard } from '../ReplyCard/ReplyCard.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';
import { VisionInertLine } from '../VisionBar/visionInert.tsx';
import { aboutLinkHref } from './guards.ts';
import { PublicBrandHeader } from './PublicBrandHeader.tsx';

import './PublicShell.css';

/** The business's look on its public page, mapped from the Desk the kernel serves (`PublicDesk`). */
export interface PublicBrand {
  /** `business_name`: "Rivera Plumbing". */
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
  /** `owner_display_name`: "Maria Rivera". */
  ownerName: string;
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
   * The owner is in the chat (a take-over): the page sets it on the stream's `owner_joined` and
   * clears it on `owner_left`. While it is set, the chat's head says so on the disclosure's line,
   * "{owner} is in this chat. Claude, an AI, is paused until {owner} hands it back.", which still
   * names Claude as an AI, and "Ask for {owner}" isn't shown. `false` by default.
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

/** The shell's own copy. The AI disclosure is part of it, in both languages, and can't be turned off. */
const COPY = {
  en: {
    chatWith: (name: ReactNode) => <>Chat with {name}</>,
    disclosure: (name: ReactNode, owner: ReactNode) => (
      <>
        You&apos;re chatting with Claude, an AI answering for {name}. Ask for {owner} anytime.
      </>
    ),
    /** In the disclosure's place while the owner is in the chat: Claude is still named as an AI. */
    ownerInChat: (owner: ReactNode) => (
      <>
        {owner} is in this chat. Claude, an AI, is paused until {owner} hands it back.
      </>
    ),
    askFor: (owner: ReactNode) => <>Ask for {owner}</>,
    about: (name: ReactNode) => <>About {name}</>,
    forAgents: 'For AI agents',
  },
  es: {
    chatWith: (name: ReactNode) => <>Chatea con {name}</>,
    disclosure: (name: ReactNode, owner: ReactNode) => (
      <>
        Estás hablando con Claude, una IA que responde por {name}. Puedes pedir hablar con {owner} cuando quieras.
      </>
    ),
    ownerInChat: (owner: ReactNode) => (
      <>
        {owner} está en este chat. Claude, una IA, está en pausa hasta que {owner} le devuelva el chat.
      </>
    ),
    askFor: (owner: ReactNode) => <>Pedir hablar con {owner}</>,
    about: (name: ReactNode) => <>Sobre {name}</>,
    forAgents: 'Para agentes de IA',
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
 * Where the visitor is reading: the first message under the chat's head, and how far under it.
 * Returns a way to put that message back at the same place, whichever element scrolls the
 * conversation by then. `null` when no message is under the chat's head.
 */
function readingPlace(shell: HTMLElement): (() => void) | null {
  const { head } = partsOf(shell);
  if (!head) return null;
  const line = head.getBoundingClientRect().bottom;
  const rows = [...shell.querySelectorAll<HTMLElement>('.cd-public-shell__conversation .cd-transcript-row')];
  const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > line);
  if (!row) return null;
  const offset = row.getBoundingClientRect().top - line;
  return () => {
    // Twice: on a short shell, scrolling moves the chat's head too until the brand header is gone.
    for (let pass = 0; pass < 2; pass += 1) {
      const scroller = scrollerOf(shell);
      const drift = row.getBoundingClientRect().top - head.getBoundingClientRect().bottom - offset;
      if (!scroller || !row.isConnected || Math.abs(drift) < 0.5) return;
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
 *
 * When the shell or a pinned part changes size, it lays out again at once, before the browser paints
 * and before the page's own observers measure the conversation. If the about column moves with
 * focus in it, focus goes to the same place in the moved column. If the shell turns short or tall,
 * the message the visitor was reading stays where it was under the chat's head, and the shell sends
 * `PUBLIC_SHELL_SCROLLER_EVENT` with the element that now scrolls the conversation.
 */
function useShellLayout(shell: RefObject<HTMLElement | null>): boolean {
  const [aboutBeside, setAboutBeside] = useState(false);
  const short = useRef(false);

  // After every render, before the page's layout effects: the short class, if the shell is short.
  useLayoutEffect(() => {
    shell.current?.classList.toggle(SHORT_CLASS, short.current);
  });

  useLayoutEffect(() => {
    const el = shell.current;
    if (!el) return undefined;
    // The chat's head's and the composer area's padding while tall, read whenever the shell is
    // tall (it always is at first), so the room the conversation would have is the same sum
    // whichever way the shell is laid out now.
    const tallPadding = { head: 0, composer: 0 };
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
      const pinned =
        heightOf(banner) +
        heightOf(header) +
        heightOf(footer) +
        heightOf(head) - verticalPadding(head) + tallPadding.head +
        heightOf(composer) - verticalPadding(composer) + tallPadding.composer;
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
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const wasShort = short.current;
      const wasBeside = beside;
      const restoreFocus = focusInAbout(el);
      const restorePlace = readingPlace(el);
      // First the about column, by width, at once; then short or tall, with the column in place.
      beside = fitsBeside();
      if (beside !== wasBeside) flushSync(() => setAboutBeside(beside));
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
    });
    const { banner, header, head, composer } = partsOf(el);
    for (const part of [el, banner, header, head, composer]) if (part) observer.observe(part);
    // The composer taking focus at the top of a short chat comes out from under the chat's head.
    const onFocusIn = () => uncoverComposer(el);
    composer?.addEventListener('focusin', onFocusIn);
    return () => {
      observer.disconnect();
      composer?.removeEventListener('focusin', onFocusIn);
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
function useVisualViewportFit(shell: RefObject<HTMLElement | null>, embedded: boolean): void {
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
  const aboutBeside = useShellLayout(shellRef);
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
  const owner = <Name>{ownerName}</Name>;

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
              <ReplyCard key={index} block={block as CardBlock} language={language} ownerName={ownerName} />
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
      className={`cd-public-shell${embedded ? ' cd-public-shell--embedded' : ''}`}
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
                {ownerInChat ? copy.ownerInChat(owner) : copy.disclosure(name, owner)}
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
            {aboutBeside ? null : aboutColumn}
            <div className="cd-public-shell__conversation">{children}</div>
          </div>
          <div className="cd-public-shell__composer">{composer}</div>
          {embedded ? null : (
            <div className="cd-public-shell__footer">
              <ConceptFooter poweredBy />
            </div>
          )}
        </Chat>
        {aboutBeside ? aboutColumn : null}
      </div>
    </div>
  );
}
