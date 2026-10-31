/**
 * An About this prototype reading page: the product proposal or the capability prediction, laid out as the
 * reader boards draw them. A centered title, its summary and the lead figure; then the numbered contents
 * list, the document in a serif column and the author, date and reading time beside it; then "Read next", the
 * other document. On a phone the contents list folds into one row and the details into a line under the
 * summary.
 *
 * The page is static: it reads its document from `documents.ts`, which only it loads, and makes no request.
 */
import { Fragment, useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Link, UNSAFE_NavigationContext, useLocation, useNavigationType } from 'react-router';

import { Card, ConceptFooter, Icon, Mark, MarkAppIcon, Wordmark } from '../ds/index.ts';
import { inApp, useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { ABOUT_DOCUMENTS, readingMinutes, type AboutDocument, type Block, type FigureName } from './documents.ts';
import { ArchitectureFigure } from './figures/ArchitectureFigure.tsx';
import { MeasuresTable } from './figures/MeasuresTable.tsx';
import { ReadinessScale } from './figures/ReadinessScale.tsx';
import { Tau3Chart } from './figures/Tau3Chart.tsx';
import { Inlines } from './Inlines.tsx';
import { ABOUT_LINKS, type AboutId } from './links.ts';
import { MONTHS } from './months.ts';
import { PrototypeLink } from './PrototypeLink.tsx';
import { useNoIndex } from './useNoIndex.ts';

import './reader.css';

/** Below this width the page takes its phone layout: one column, the contents list folded into one row. */
const NARROW = '(max-width: 1099.98px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

type Heading = Extract<Block, { kind: 'heading' }>;

/** The byline, "Name · Month D, YYYY", as the author, the date as the boards print it, and the date's day. */
function bylineOf(blocks: Block[]): { author: string; date: string; day?: string } {
  const text = blocks.find((block) => block.kind === 'byline')?.text ?? '';
  const [author = '', written = ''] = text.split(' · ');
  const [, month = '', date = '', year = ''] = /^(\w+) (\d{1,2}), (\d{4})$/.exec(written) ?? [];
  const index = MONTHS.findIndex((name) => name === month);
  if (index < 0) return { author, date: written };
  return {
    author,
    date: `${month.slice(0, 3)} ${date}, ${year}`,
    day: `${year}-${String(index + 1).padStart(2, '0')}-${date.padStart(2, '0')}`,
  };
}

/**
 * The section an address's fragment names, decoded, or null when it names none. A fragment that isn't valid
 * percent-encoding, such as a percent sign with no two hex digits after it, names no section, so the page
 * opens at its top.
 */
function sectionAnchor(hash: string): string | null {
  if (hash.length <= 1) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

/** What one router's reading pages remember: whether one has drawn yet, and where the window last was in each. */
interface Reading {
  drawn: boolean;
  places: Partial<Record<AboutId, number>>;
}

/** By router, which the app makes once per window, so each window, and each test's router, starts afresh. */
const READING = new WeakMap<object, Reading>();

/** What the reader does that means they have moved on from where the page put them, Back and Forward included. */
const READER_ACTIONS = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'popstate'] as const;

/**
 * Keeps the window at the section an address opened until the reading type's web font has loaded, and returns what
 * cancels it. On a cold load the font swaps in after the page has opened there and moves the page under the window,
 * and the browser's scroll anchoring holds the window to some other element than the heading (about 2 px off on the
 * prediction). Once the type has loaded, the heading is followed once more, unless the reader has acted first.
 */
function keepSectionWhileTypeLoads(heading: HTMLElement): () => void {
  const { fonts } = document;
  if (!fonts || fonts.status !== 'loading') return () => {};
  let done = false;
  const stop = () => {
    done = true;
    for (const kind of READER_ACTIONS) window.removeEventListener(kind, stop);
  };
  for (const kind of READER_ACTIONS) window.addEventListener(kind, stop, { passive: true });
  void fonts.ready.then(() => {
    if (done || !heading.isConnected) return;
    stop();
    const margin = parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
    if (Math.abs(heading.getBoundingClientRect().top - margin) > 1) heading.scrollIntoView();
  });
  return stop;
}

/**
 * Where the window goes when a document draws. Opened by a link or in place of the current page, it starts at
 * its top, or at the section its address names, whose anchor exists only once the page has drawn. Back and
 * Forward return to where the reader last was in that document: the browser's own restoring races the router's
 * drawing of the page, and loses when the page it leaves is shorter. The router counts the address a window
 * loads as a move back, so its first page opens as the address says. This runs only when a document draws, not
 * on every hash: the contents list's links move within the page by themselves. A section the address opened is kept
 * in place while the reading type loads, until the document goes.
 */
function useReadingPlace(id: AboutId, hash: string) {
  // The router's navigator: one object for as long as the router lives.
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const navigationType = useNavigationType();
  const { pathname } = useLocation();
  // The window's address while the router shows this page, taken again when the same document's address
  // changes, as when the page's own link drops a trailing slash.
  const own = useRef('');
  useLayoutEffect(() => {
    own.current = window.location.pathname;
  }, [pathname]);
  // How this document opened, decided once for it: React's StrictMode runs the effect below twice for one opening,
  // and the second run must open it the same way, not take the first run's drawing for a move back.
  const opening = useRef<{ id: AboutId; back: boolean } | null>(null);
  useLayoutEffect(() => {
    const reading = READING.get(navigator) ?? { drawn: false, places: {} };
    READING.set(navigator, reading);
    if (opening.current?.id !== id) opening.current = { id, back: navigationType === 'POP' && reading.drawn };
    let stopKeeping = () => {};
    if (opening.current.back) {
      window.scrollTo(0, reading.places[id] ?? 0);
    } else {
      const anchor = sectionAnchor(hash);
      const section = anchor ? document.getElementById(anchor) : null;
      if (section) {
        section.scrollIntoView();
        stopKeeping = keepSectionWhileTypeLoads(section);
      } else {
        window.scrollTo(0, 0);
      }
    }
    reading.drawn = true;
    // Back changes the window's address, and the browser restores the next page's place, before the router
    // draws that page; a scroll heard after the address moved on is the next page's, not the reader's.
    const remember = () => {
      if (window.location.pathname === own.current) reading.places[id] = window.scrollY;
    };
    remember();
    window.addEventListener('scroll', remember, { passive: true });
    return () => {
      window.removeEventListener('scroll', remember);
      stopKeeping();
    };
  }, [id]);
}

/** A figure by its marker's name. */
function Figure({ name, compact }: { name: FigureName; compact: boolean }) {
  if (name === 'architecture') return <ArchitectureFigure compact={compact} />;
  if (name === 'tau3') return <Tau3Chart compact={compact} />;
  return null;
}

/** `data-doc-text` for a piece of the document's text: its block's place in the document, then its own. */
function docText(block: number, piece = 0) {
  return { 'data-doc-text': `${block}.${piece}` };
}

interface ArticleBlockProps {
  blocks: Block[];
  /** The block's place in the document. */
  index: number;
  /** The figure the hero draws. */
  hero: FigureName;
  compact: boolean;
}

/**
 * One block of the document. The `#` title and the byline feed the hero and the details instead; the hero's
 * own figure marker renders nothing; the readiness marker's table renders as the readiness scale.
 */
function ArticleBlock({ blocks, index, hero, compact }: ArticleBlockProps) {
  const block = blocks[index];
  const previous = blocks[index - 1];
  switch (block?.kind) {
    case 'heading':
      if (block.depth === 1) return null;
      return (
        <h2
          id={block.id}
          className={compact ? 'cd-type-article-heading-phone' : 'cd-type-article-heading'}
          {...docText(index)}
        >
          {block.text}
        </h2>
      );
    case 'paragraph':
      return (
        <p {...docText(index)}>
          <Inlines inlines={block.children} />
        </p>
      );
    case 'list':
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i} {...docText(index, i)}>
              <Inlines inlines={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return previous?.kind === 'figure' && previous.name === 'readiness' ? (
        <ReadinessScale table={block} compact={compact} block={index} />
      ) : (
        <MeasuresTable table={block} compact={compact} block={index} />
      );
    case 'figure':
      if (block.name === 'readiness') {
        // The scale is drawn from the table under the marker, so the marker must have one.
        if (blocks[index + 1]?.kind !== 'table') throw new Error('the readiness marker has no table right after it');
        return null;
      }
      return block.name === hero ? null : <Figure name={block.name} compact={compact} />;
    case 'byline':
    case undefined:
      return null;
  }
}

/** The document's blocks, with the pull quote after the first section. */
function Article({ document, compact }: { document: AboutDocument; compact: boolean }) {
  const { blocks, hero, pullQuote } = document;
  const headings = blocks.flatMap((block, i) => (block.kind === 'heading' && block.depth === 2 ? [i] : []));
  const quoteAt = headings[1] ?? blocks.length;
  const quote = (
    <blockquote key="pull-quote" className="cd-about-pull">
      <p className="cd-type-article-quote">{pullQuote}</p>
    </blockquote>
  );
  return (
    <article className={`cd-about-article ${compact ? 'cd-type-article-body-phone' : 'cd-type-article-body'}`}>
      {blocks.map((_, i) => (
        <Fragment key={i}>
          {i === quoteAt ? quote : null}
          <ArticleBlock blocks={blocks} index={i} hero={hero} compact={compact} />
        </Fragment>
      ))}
      {quoteAt === blocks.length ? quote : null}
    </article>
  );
}

/** The numbered contents list: a column beside the article, or one row that opens on a phone. */
function Contents({ sections, compact }: { sections: Heading[]; compact: boolean }) {
  const list = (
    <ol className="cd-about-contents__list">
      {sections.map((section, i) => (
        <li key={section.id}>
          <a className="cd-about-contents__link cd-type-body" href={`#${section.id}`}>
            {/* The list numbers its items for a screen reader; the page draws the number. */}
            <span className="cd-about-contents__number cd-type-caption" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span>{section.text}</span>
          </a>
        </li>
      ))}
    </ol>
  );
  if (compact) {
    return (
      <nav className="cd-about-contents cd-about-contents--compact" aria-label="On this page">
        <details className="cd-about-contents__fold">
          <summary className="cd-about-contents__row cd-type-control">
            On this page{' '}
            <span className="cd-about-contents__count">
              {`${sections.length} ${sections.length === 1 ? 'section' : 'sections'}`}
            </span>
            <Icon name="chevron-down" size={16} className="cd-about-contents__chevron" />
          </summary>
          {list}
        </details>
      </nav>
    );
  }
  return (
    <nav className="cd-about-contents" aria-label="On this page">
      <p className="cd-about-side-label cd-type-caption">On this page</p>
      {list}
    </nav>
  );
}

/** The author, the date, the reading time and the other document, beside the article. */
function Details({ document, other }: { document: AboutDocument; other: AboutDocument }) {
  const { author, date, day } = bylineOf(document.blocks);
  const minutes = readingMinutes(document.blocks);
  return (
    <aside className="cd-about-meta" aria-label="About this document">
      <dl className="cd-type-meta">
        <div>
          <dt>Written by</dt>
          <dd>{author}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{day ? <time dateTime={day}>{date}</time> : date}</dd>
        </div>
        <div>
          <dt>Reading time</dt>
          <dd>{`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`}</dd>
        </div>
        <div>
          <dt>Also read</dt>
          <dd>
            <Link className="cd-text-link" to={other.route}>
              {other.title}
            </Link>
          </dd>
        </div>
      </dl>
    </aside>
  );
}

/** The same details as one line under the summary, on a phone. */
function BylineLine({ document }: { document: AboutDocument }) {
  const { author, date, day } = bylineOf(document.blocks);
  return (
    <p className="cd-about-hero__byline cd-type-meta" data-byline="">
      {author} · {day ? <time dateTime={day}>{date}</time> : date} · {`${readingMinutes(document.blocks)} min read`}
    </p>
  );
}

/** "Read next": the other document, its title and summary, the whole card one link. */
function ReadNext({ other, compact }: { other: AboutDocument; compact: boolean }) {
  return (
    <div className="cd-about-next">
      <Card>
        <p className="cd-about-next__label cd-about-side-label cd-type-caption" data-next-label="">
          Read next
        </p>
        <Link
          className={`cd-about-next__link ${compact ? 'cd-type-page-title' : 'cd-type-intro-title'}`}
          to={other.route}
        >
          {other.title}
        </Link>
        <p className="cd-about-next__summary cd-type-body">{other.summary}</p>
      </Card>
    </div>
  );
}

/** The two documents as links, the one on show marked as the current page. */
function DocumentSwitch({ current, compact }: { current: AboutId; compact: boolean }) {
  return (
    <nav className={`cd-about-switch${compact ? ' cd-about-switch--compact' : ''}`} aria-label="Documents">
      {ABOUT_LINKS.links.map((link) => (
        <Link
          key={link.id}
          className="cd-about-switch__link cd-type-control"
          to={link.href}
          aria-current={link.id === current ? 'page' : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The app's lockup (owner, 2026-10-30): the bell with no tile and the wordmark, 36 px with the Preview
 * badge on the desktop bar. A phone's top bar carries no badge, so the phone bar shows a 32 px bell
 * and the name alone, on one line at a phone's width. The white tile is the article's app icon.
 */
function Brand({ compact }: { compact: boolean }) {
  return (
    <span className="cd-about-brand">
      <Mark size={compact ? 32 : 36} />
      <Wordmark preview={!compact} />
    </span>
  );
}

/** The bar across the top, which stays while the page scrolls: the product's name, the two documents and the link into the prototype. */
function TopBar({ current, compact }: { current: AboutId; compact: boolean }) {
  if (compact) {
    return (
      <>
        <header className="cd-about-top cd-about-top--compact">
          <PrototypeLink compact />
          <Brand compact />
        </header>
        <DocumentSwitch current={current} compact />
      </>
    );
  }
  return (
    <header className="cd-about-top">
      <Brand compact={false} />
      <DocumentSwitch current={current} compact={false} />
      <PrototypeLink />
    </header>
  );
}

export interface ReaderPageProps {
  id: AboutId;
}

export function ReaderPage({ id }: ReaderPageProps) {
  const about = ABOUT_DOCUMENTS[id];
  const other = ABOUT_DOCUMENTS[about.next];
  const compact = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const sections = about.blocks.filter((block): block is Heading => block.kind === 'heading' && block.depth === 2);
  const { hash } = useLocation();
  useReadingPlace(id, hash);

  // Search engines are asked not to list the page while it is open.
  useNoIndex();

  // The tab names the document while it is open, and goes back to what it said when it closes.
  useDocumentTitle(inApp(about.title));

  return (
    <div className={`cd-about-page${compact ? ' cd-about-page--compact' : ''}`}>
      <TopBar current={id} compact={compact} />
      <main className="cd-about-main">
        <div className="cd-about-hero" data-hero="">
          <MarkAppIcon size={compact ? 'compact' : 'large'} />
          <p className="cd-about-hero__kicker cd-type-meta">About this prototype</p>
          <h1 className={`cd-about-hero__title ${compact ? 'cd-type-greeting' : 'cd-type-article-title'}`}>
            {about.title}
          </h1>
          <p
            className={`cd-about-hero__summary ${compact ? 'cd-type-article-body-phone' : 'cd-type-article-body'}`}
            data-summary=""
          >
            {about.summary}
          </p>
          {compact ? <BylineLine document={about} /> : null}
          <div className="cd-about-hero__figure">
            <Figure name={about.hero} compact={compact} />
          </div>
        </div>
        <div className="cd-about-body">
          <Contents sections={sections} compact={compact} />
          <div className="cd-about-column">
            <Article document={about} compact={compact} />
            <ReadNext other={other} compact={compact} />
          </div>
          {compact ? null : <Details document={about} other={other} />}
        </div>
      </main>
      <footer className="cd-about-footer">
        <ConceptFooter />
      </footer>
    </div>
  );
}
