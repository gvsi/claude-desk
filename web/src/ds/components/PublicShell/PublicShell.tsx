import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { CardBlock, PublicDesk, RenderedBlock } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { ReplyCard } from '../ReplyCard/ReplyCard.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';
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
    askFor: (owner: ReactNode) => <>Pedir hablar con {owner}</>,
    about: (name: ReactNode) => <>Sobre {name}</>,
    forAgents: 'Para agentes de IA',
  },
} satisfies Record<CopyLanguage, unknown>;

/** From this width up, the about column stands at the right of the chat. */
const ABOUT_BESIDE_FROM = 900;

/**
 * Whether the shell is wide enough for the about column beside the chat, or `null` until it has
 * measured itself. The shell lays out by its own width (inside an owner's panel as on a page of its
 * own), so it watches itself, not the window.
 *
 * It measures before the first paint, and until then the column is drawn in neither place: the
 * chat takes the shell's whole width, as it will on a phone, so nothing in it (the composer sizing
 * its text box) measures itself at a width the visitor never sees. When the shell crosses the
 * width, the column moves at once, before the browser paints and before the page's own observers
 * measure the conversation (the page keeps the newest message above the composer as the shell
 * resizes).
 */
function useAboutBeside(shell: RefObject<HTMLElement | null>): boolean | null {
  const [beside, setBeside] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = shell.current;
    if (!el) return undefined;
    const fits = () => el.offsetWidth >= ABOUT_BESIDE_FROM;
    setBeside(fits());
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => flushSync(() => setBeside(fits())));
    observer.observe(el);
    return () => observer.disconnect();
  }, [shell]);
  return beside;
}

/**
 * The public page around a conversation, the window's height: the business's brand header (with
 * the kernel's open status when the Desk has hours) and the chat's head with its title, the AI
 * disclosure and "Ask for {owner}" at the top; the composer with the concept footer under it at the
 * bottom; and only the conversation's scroll region scrolling between them, so the disclosure never
 * leaves the screen. The business's charter is an about column at the right, or, when the page is
 * too narrow for it, the start of the conversation's scroll region.
 */
export function PublicShell({
  brand,
  ownerName,
  language,
  openStatus,
  onAskForOwner,
  about,
  aboutLinks,
  footer = true,
  composer,
  children,
}: PublicShellProps) {
  const copy = COPY[language] ?? COPY.en;
  const embedded = footer === false;
  const aboutId = useId();
  const chatId = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const aboutBeside = useAboutBeside(shellRef);
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
    <About className="cd-public-shell__about" aria-labelledby={aboutId}>
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
    <div ref={shellRef} className={`cd-public-shell${embedded ? ' cd-public-shell--embedded' : ''}`} lang={language}>
      <PublicBrandHeader brand={brand} language={language} openStatus={openStatus} landmark={!embedded} nameAsHeading={!embedded} />
      <div className="cd-public-shell__body">
        <Chat className="cd-public-shell__chat">
          <div className="cd-public-shell__chat-head">
            <div className="cd-public-shell__chat-title">
              <h2 id={chatId} className="cd-public-shell__heading cd-type-section">
                {copy.chatWith(name)}
              </h2>
              <p className="cd-public-shell__disclosure cd-type-meta">{copy.disclosure(name, owner)}</p>
            </div>
            <Button variant="secondary" onClick={onAskForOwner}>
              {copy.askFor(owner)}
            </Button>
          </div>
          {/* The one part of the page that scrolls. Too narrow for the about column beside the chat,
              the column opens it, above the first message. A stop in the tab order, named by the
              chat's title, so a conversation with nothing to focus in it still scrolls from the
              keyboard. */}
          <div className="cd-public-shell__scroll" role="group" aria-labelledby={chatId} tabIndex={0}>
            {aboutBeside === false ? aboutColumn : null}
            <div className="cd-public-shell__conversation">{children}</div>
          </div>
          <div className="cd-public-shell__composer">
            {composer}
            {embedded ? null : <ConceptFooter poweredBy />}
          </div>
        </Chat>
        {aboutBeside === true ? aboutColumn : null}
      </div>
    </div>
  );
}
