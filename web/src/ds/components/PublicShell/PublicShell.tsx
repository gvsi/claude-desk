import { useId, type CSSProperties, type ReactNode } from 'react';

import type { CardBlock, RenderedBlock } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { ReplyCard } from '../ReplyCard/ReplyCard.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';
import { TextLink } from '../TextLink/TextLink.tsx';
import { aboutLinkHref, brandColor, openStatusLine } from './guards.ts';

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
 * The generated contracts don't carry the kernel's `OpenStatus` yet. Until they do, this alias
 * stands in for it with only the two fields the shell reads; then it becomes
 * `PublicDesk['open_status']`, the one line to change.
 */
export type PublicOpenStatus = { text: string; open: boolean } | null;

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
    stillHelps: 'Claude can still help.',
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
    stillHelps: 'Claude puede ayudarte igual.',
  },
} satisfies Record<CopyLanguage, unknown>;

/**
 * The public page around a conversation: the business's brand header (with the kernel's open
 * status when the Desk has hours), the chat with its title, the AI disclosure and "Ask for
 * {owner}", the conversation and the composer with the concept footer under it, and the
 * business's charter in an about column at the right (under the chat when the page is narrow).
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
  const name = <Name>{brand.name}</Name>;
  const owner = <Name>{ownerName}</Name>;

  const style = {
    '--brand-field': brandColor(brand.field, 'var(--bg-panel)'),
    '--brand-ink': brandColor(brand.ink, 'var(--text-primary)'),
    '--brand-ink-secondary': brandColor(brand.inkSecondary, 'var(--text-secondary)'),
    '--brand-accent': brandColor(brand.accent, 'var(--line-hairline)'),
  } as CSSProperties;

  // Standalone, the shell is the page: a banner, the main region and a complementary column.
  // Embedded in an owner screen, the same parts as plain blocks and a named region.
  const Header = embedded ? 'div' : 'header';
  const Chat = embedded ? 'div' : 'main';
  const About = embedded ? 'section' : 'aside';
  const BrandName = embedded ? 'p' : 'h1';
  // Only links to a path on this site; anything else is left out.
  const links = (aboutLinks ?? []).flatMap((link) => {
    const href = aboutLinkHref(link.href);
    return href === null ? [] : [{ label: link.label, href }];
  });
  const blocks = about ?? [];
  const hasAbout = blocks.length > 0 || links.length > 0;
  const status = openStatusLine(openStatus);

  return (
    <div className={`cd-public-shell${embedded ? ' cd-public-shell--embedded' : ''}`} lang={language} style={style}>
      <Header className={`cd-public-shell__brand${status ? ' cd-public-shell__brand--open-status' : ''}`}>
        <span className="cd-public-shell__monogram cd-type-page-title" aria-hidden="true">
          {brand.monogram}
        </span>
        <div className="cd-public-shell__brand-text" data-copy="user">
          <BrandName className="cd-public-shell__brand-name cd-type-brand-name">{brand.name}</BrandName>
          <p className="cd-public-shell__tagline cd-type-meta">{brand.tagline}</p>
        </div>
        {status ? (
          <div className="cd-public-shell__open-status">
            <StatusDot tone={status.open ? 'handled' : 'info'} />
            <div className="cd-public-shell__open-status-lines">
              {/* The kernel's words, as written. */}
              <p className="cd-public-shell__open-status-text cd-type-meta" data-copy="user">
                {status.text}
              </p>
              {status.open ? null : <p className="cd-public-shell__still-helps cd-type-meta">{copy.stillHelps}</p>}
            </div>
          </div>
        ) : null}
      </Header>
      <div className="cd-public-shell__body">
        <Chat className="cd-public-shell__chat">
          <div className="cd-public-shell__column">
            <div className="cd-public-shell__chat-head">
              <div className="cd-public-shell__chat-title">
                <h2 className="cd-public-shell__heading cd-type-section">{copy.chatWith(name)}</h2>
                <p className="cd-public-shell__disclosure cd-type-meta">{copy.disclosure(name, owner)}</p>
              </div>
              <Button variant="secondary" onClick={onAskForOwner}>
                {/* One span, so the button's gap doesn't open up between the words and the name. */}
                <span>{copy.askFor(owner)}</span>
              </Button>
            </div>
            <div className="cd-public-shell__conversation">{children}</div>
            <div className="cd-public-shell__composer">
              {composer}
              {embedded ? null : <ConceptFooter poweredBy />}
            </div>
          </div>
        </Chat>
        {hasAbout ? (
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
                <ul className="cd-public-shell__link-list cd-type-body">
                  {links.map((link) => (
                    <li key={`${link.href} ${link.label}`}>
                      <TextLink href={link.href}>{link.label}</TextLink>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </About>
        ) : null}
      </div>
    </div>
  );
}
