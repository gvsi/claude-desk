/**
 * An About this prototype reading page: the product proposal or the capability prediction, laid out as the
 * reader boards draw them. A centered title, its summary and the lead figure; then the numbered contents
 * list, the document in a serif column and the author, date and reading time beside it; then "Read next", the
 * next page in the About set. On a phone the contents list folds into one row and the details into a line
 * under the summary.
 *
 * It is drawn on the About set's paper (`paper.css`), the Vision article's light reading style, so the set's
 * three pages read as one. The page is static: it reads its document from `documents.ts`, which only it loads,
 * and makes no request.
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type RefObject,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { Card, ConceptFooter, Icon, Mark, MarkAppIcon, Wordmark } from '../ds/index.ts';
import { inApp, useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { ABOUT_DOCUMENTS, readingMinutes, type AboutDocument, type Block, type FigureName } from './documents.ts';
import { ArchitectureFigure } from './figures/ArchitectureFigure.tsx';
import { MeasuresTable } from './figures/MeasuresTable.tsx';
import { ReadinessScale } from './figures/ReadinessScale.tsx';
import { Tau3Chart } from './figures/Tau3Chart.tsx';
import { Inlines } from './Inlines.tsx';
import { AboutSwitch } from './AboutSwitch.tsx';
import { readNext, VISION_ARTICLE, type AboutId, type AboutPage } from './links.ts';
import { MONTHS } from './months.ts';
import { prefersReducedMotion } from './motion.ts';
import { PrototypeLink } from './PrototypeLink.tsx';
import { moveToSection, useCurrentSection } from './useCurrentSection.ts';
import { useNoIndex } from './useNoIndex.ts';
import { usePagePlace } from './usePagePlace.ts';

import './paper.css';
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
      // Focusable from the contents list's links, not by Tab.
      return (
        <h2
          id={block.id}
          className={compact ? 'cd-type-article-heading-phone' : 'cd-type-article-heading'}
          tabIndex={-1}
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

interface ContentsListProps {
  sections: Heading[];
  /** The section being read, which the list marks; null marks none. */
  current: string | null;
  /** Told of each link followed, as the jump to its section starts. */
  onFollow?: (id: string) => void;
}

/**
 * Follows a contents link within the page, in place of the browser's jump: the address names the section, the
 * window scrolls to its heading, smoothly unless the reader asked for reduced motion, and focus moves to the
 * heading, so the next Tab goes on from the section. A click that opens the link elsewhere (a new tab or window),
 * or that something else has handled, is left to the browser.
 */
function useFollowSection(onFollow?: (id: string) => void): (event: MouseEvent<HTMLAnchorElement>, id: string) => void {
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();
  // The last move's watch, and the address it moved to. Navigation that changes the reading place (Back to where
  // the reader was, the other document) cancels it, so a correction still waiting on the type can't take the window
  // back to the section; so does the list going away.
  const moved = useRef<{ at: string; cancel: () => void } | null>(null);
  const here = `${pathname}${search}${hash}`;
  useEffect(() => {
    if (moved.current && moved.current.at !== here) {
      moved.current.cancel();
      moved.current = null;
    }
  }, [here]);
  useEffect(() => () => moved.current?.cancel(), []);
  return (event, id) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const heading = document.getElementById(id);
    if (!heading) return;
    event.preventDefault();
    onFollow?.(id);
    // The address first, as the browser's own jump does: the entry being left keeps the reader's place for Back. A
    // link to the section the address already names replaces it, as the browser's would.
    navigate({ pathname, search, hash: `#${id}` }, { replace: hash === `#${id}` });
    // Only this scroll glides: the page's own (opening a document, Back and Forward) stay instant. The heading's
    // scroll margin keeps it clear of the pinned bar.
    moved.current?.cancel();
    moved.current = { at: `${pathname}${search}#${id}`, cancel: moveToSection(heading, prefersReducedMotion() ? 'instant' : 'smooth') };
    heading.focus({ preventScroll: true });
  };
}

/** The numbered list of the document's sections. */
function ContentsList({ sections, current, onFollow }: ContentsListProps) {
  const follow = useFollowSection(onFollow);
  return (
    <ol className="cd-about-contents__list">
      {sections.map((section, i) => (
        <li key={section.id}>
          <a
            className="cd-about-contents__link cd-type-body"
            href={`#${section.id}`}
            aria-current={section.id === current ? 'location' : undefined}
            onClick={(event) => follow(event, section.id)}
          >
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
}

/** Where the bar beside the current row's words goes, from the top of the list's column. */
interface BarPlace {
  top: number;
  height: number;
}

/**
 * Where the bar goes for the section `current` names, measured from its row's words, which may wrap; measured
 * again when the column changes size. Null when no section is current, so the bar isn't drawn. A bar drawn afresh
 * starts on its row; one already drawn slides to the next (reader.css).
 */
function useBarPlace(column: RefObject<HTMLElement>, current: string | null): BarPlace | null {
  const [place, setPlace] = useState<BarPlace | null>(null);
  useLayoutEffect(() => {
    const root = column.current;
    if (!root || current === null) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const words = root.querySelector(`a[href="#${CSS.escape(current)}"] > span:last-child`);
      if (!words) return setPlace(null);
      const box = words.getBoundingClientRect();
      const next = { top: box.top - root.getBoundingClientRect().top, height: box.height };
      setPlace((was) => (was && was.top === next.top && was.height === next.height ? was : next));
    };
    measure();
    if (typeof window.ResizeObserver !== 'function') return;
    const resized = new ResizeObserver(measure);
    resized.observe(root);
    return () => resized.disconnect();
  }, [column, current]);
  return place;
}

/** The list as a column beside the article, which marks the section being read. */
function SideContents({ sections }: { sections: Heading[] }) {
  const [current, follow] = useCurrentSection(sections.map((section) => section.id));
  const column = useRef<HTMLElement>(null);
  const bar = useBarPlace(column, current);
  return (
    <nav ref={column} className="cd-about-contents cd-about-contents--side" aria-label="On this page">
      <p className="cd-about-side-label cd-type-caption">On this page</p>
      <ContentsList sections={sections} current={current} onFollow={follow} />
      {bar ? (
        <span
          className="cd-about-contents__bar"
          data-contents-bar=""
          aria-hidden="true"
          style={{ height: `${bar.height}px`, transform: `translateY(${bar.top}px)` }}
        />
      ) : null}
    </nav>
  );
}

/** The list folded into one row that opens, on a phone. It marks nothing. */
function FoldedContents({ sections }: { sections: Heading[] }) {
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
        <ContentsList sections={sections} current={null} />
      </details>
    </nav>
  );
}

/** The numbered contents list: a column beside the article, or one row that opens on a phone. */
function Contents({ sections, compact }: { sections: Heading[]; compact: boolean }) {
  return compact ? <FoldedContents sections={sections} /> : <SideContents sections={sections} />;
}

/** The author, the date, the reading time and related About pages, beside the article. */
function Details({ document, alsoRead }: { document: AboutDocument; alsoRead: AboutPage[] }) {
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
          <dd className="cd-about-meta__links">
            {alsoRead.map((other) => (
              <Link key={other.route} className="cd-text-link" to={other.route}>
                {other.title}
              </Link>
            ))}
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

/** "Read next": the next page in the About set, its title and summary, the whole card one link. */
function ReadNext({ next, compact }: { next: AboutPage; compact: boolean }) {
  return (
    <div className="cd-about-next">
      <Card>
        <p className="cd-about-next__label cd-about-side-label cd-type-caption" data-next-label="">
          Read next
        </p>
        <Link
          className={`cd-about-next__link ${compact ? 'cd-type-page-title' : 'cd-type-intro-title'}`}
          to={next.route}
        >
          {next.title}
        </Link>
        <p className="cd-about-next__summary cd-type-body">{next.summary}</p>
      </Card>
    </div>
  );
}

/** The About set's three pages as links, the one on show marked as the current page. */
function DocumentSwitch({ current, compact }: { current: AboutId; compact: boolean }) {
  return (
    <AboutSwitch
      current={current}
      className={`cd-about-switch${compact ? ' cd-about-switch--compact' : ''}`}
      linkClassName="cd-about-switch__link cd-type-control"
    />
  );
}

/**
 * The app's lockup (owner, 2026-10-30): the bell with no tile and the wordmark, 36 px with the Preview
 * badge on the desktop bar. A phone's top bar carries no badge, so the phone bar shows a 32 px bell
 * and the name alone, on one line at a phone's width. The white tile is the article's app icon. The
 * bell is on the page's paper, so it keeps the drawing's dark ink.
 */
function Brand({ compact }: { compact: boolean }) {
  return (
    <span className="cd-about-brand">
      <Mark size={compact ? 32 : 36} ground="light" />
      <Wordmark preview={!compact} />
    </span>
  );
}

/** The bar across the top, which stays while the page scrolls: the product's name, the About set's switch and the link into the prototype. */
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
  const alsoRead = id === 'proposal' ? [other, VISION_ARTICLE] : [other];
  const compact = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const sections = about.blocks.filter((block): block is Heading => block.kind === 'heading' && block.depth === 2);
  usePagePlace(id);

  // Search engines are asked not to list the page while it is open.
  useNoIndex();

  // The tab names the document while it is open, and goes back to what it said when it closes.
  useDocumentTitle(inApp(about.title));

  return (
    <div className={`cd-about-paper cd-about-paper--app cd-about-page${compact ? ' cd-about-page--compact' : ''}`}>
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
            <ReadNext next={readNext(id)} compact={compact} />
          </div>
          {compact ? null : <Details document={about} alsoRead={alsoRead} />}
        </div>
      </main>
      <footer className="cd-about-footer">
        <ConceptFooter />
      </footer>
    </div>
  );
}
