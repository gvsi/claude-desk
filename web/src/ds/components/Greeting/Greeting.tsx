import type { ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';

import './Greeting.css';

/** Someone talking to the Desk right now, drawn as a small glyph beside the presence line. */
export interface PresenceGlyph {
  kind: 'person' | 'agent';
  /** A person's initials, shown in place of the person glyph. */
  initials?: string;
}

export interface GreetingProps {
  /** The greeting, from the screen: "Good morning, Mike". It is Today's `h1`. */
  text: string;
  /**
   * Who is here right now: the line says it in words ("Two people are talking to your Desk right
   * now."), and the first three `people` are drawn beside it as glyphs that breathe.
   */
  presence?: { line: string; people: PresenceGlyph[] };
  /**
   * The public link as the screen shows it, and a button that copies it. `copied` is true for a
   * short while after a copy that worked: the pill says "Copied" with a check, at the same width.
   */
  link?: { label: string; onCopy: () => void; copied?: boolean };
  /**
   * The screen's own controls, after the link pill at the right of the greeting's line: usually one
   * `Button`, such as Today's "Chat as a customer".
   */
  actions?: ReactNode;
  /** Additional screen content below the presence line, inside the greeting's text column. */
  children?: ReactNode;
}

/** At most this many glyphs: the line carries the count, the glyphs only the feeling of company. */
const MAX_GLYPHS = 3;

/**
 * The top of Today: a greeting in Claude's serif voice, one quiet line about who is talking to the
 * Desk right now, and at the right of its line the public link with a button to copy it, then the
 * screen's own actions. On a phone the link and the actions go under the presence line.
 */
export function Greeting({ text, presence, link, actions, children }: GreetingProps) {
  const glyphs = presence?.people.slice(0, MAX_GLYPHS) ?? [];
  return (
    <header className="cd-greeting">
      <div className="cd-greeting__text">
        <h1 className="cd-greeting__title cd-type-greeting">{text}</h1>
        {presence ? (
          <p className="cd-greeting__presence cd-type-body">
            {glyphs.length > 0 ? (
              <span className="cd-greeting__glyphs" aria-hidden="true">
                {glyphs.map((glyph, index) => (
                  <span key={index} className="cd-greeting__glyph">
                    {glyph.kind === 'person' && glyph.initials ? (
                      <span className="cd-greeting__initials cd-type-count">{glyph.initials}</span>
                    ) : (
                      <Icon name={glyph.kind === 'agent' ? 'agent' : 'person'} size={14} />
                    )}
                  </span>
                ))}
              </span>
            ) : null}
            <span>{presence.line}</span>
          </p>
        ) : null}
        {children}
      </div>
      {link || actions ? (
        <div className="cd-greeting__actions">
          {link ? (
            <div className={`cd-greeting__link cd-type-meta${link.copied ? ' cd-greeting__link--copied' : ''}`}>
              {/* "Copied" is laid over the link's words, so the pill keeps its width. It and the check are
                  for sighted owners: the screen says it to screen readers in its own status line. */}
              <span className="cd-greeting__link-words">
                <span className="cd-greeting__link-label" title={link.label}>{link.label}</span>
                <span className="cd-greeting__copied" aria-hidden="true">
                  Copied
                </span>
              </span>
              <span className="cd-greeting__copy">
                <IconButton label="Copy your Desk link" icon="copy" shape="round" onClick={link.onCopy} />
                <span className="cd-greeting__check" aria-hidden="true">
                  <Icon name="check" size={16} />
                </span>
              </span>
            </div>
          ) : null}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
