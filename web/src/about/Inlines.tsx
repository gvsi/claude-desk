/**
 * A document's inline text as React elements: bold, code spans, links and placeholders. No HTML passes
 * through; every piece is a typed `Inline` from the parser. A link to the other document stays in the app as a
 * router link styled like `TextLink`; every other link is `https://` and opens in a new tab.
 */
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';

import { Pill, TextLink } from '../ds/index.ts';
import type { Inline } from './documents.ts';

import './reader.css';

function Piece({ inline }: { inline: Inline }) {
  switch (inline.kind) {
    case 'text':
      return inline.text;
    case 'strong':
      return (
        <strong>
          <Inlines inlines={inline.children} />
        </strong>
      );
    case 'code':
      return <code className="cd-about-code">{inline.text}</code>;
    case 'placeholder':
      // Kept visible, with its words, until the document is filled.
      return <Pill>{inline.text}</Pill>;
    case 'link':
      return inline.internal ? (
        <Link className="cd-text-link" to={inline.href}>
          <Inlines inlines={inline.children} />
        </Link>
      ) : (
        <TextLink href={inline.href} external>
          <Inlines inlines={inline.children} />
        </TextLink>
      );
  }
}

/** Punctuation that closes a phrase, which never starts a line. */
const CLOSING = /^[.,;:!?)\]]+/;

export function Inlines({ inlines }: { inlines: Inline[] }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < inlines.length; i += 1) {
    const inline = inlines[i];
    if (!inline) continue;
    const next = inlines[i + 1];
    const after = inline.kind === 'placeholder' && next?.kind === 'text' ? next.text : '';
    const closing = CLOSING.exec(after)?.[0];
    if (closing) {
      // A pill is one box on its line, so a line could break right after it; the punctuation stays with it.
      out.push(
        <Fragment key={i}>
          <span className="cd-about-nowrap">
            <Piece inline={inline} />
            {closing}
          </span>
          {after.slice(closing.length)}
        </Fragment>,
      );
      i += 1;
    } else {
      out.push(<Piece key={i} inline={inline} />);
    }
  }
  return out;
}

/** The words of a run of inlines, as a person reads them. */
export function inlinesText(inlines: Inline[]): string {
  return inlines.map((inline) => ('children' in inline ? inlinesText(inline.children) : inline.text)).join('');
}
