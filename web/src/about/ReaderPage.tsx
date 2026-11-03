/**
 * An About this prototype reading page: the product proposal or the capability prediction, laid out as the
 * reader boards draw them. Each opens with its meta line, title and summary centred, then its hero figure: the
 * proposal's launch film under its app icon, the prediction's claim as a card. Then the
 * numbered contents list, the document in a serif column and the author, date and reading time beside it; then
 * "Read next", the next page in the About set. On a phone the contents list folds into one row and the details
 * into a line under the summary.
 *
 * It is drawn on the About set's paper (`paper.css`), the Vision article's light reading style, so the set's
 * three pages read as one. The page is static: it reads its document from `documents.ts`, which only it loads,
 * and makes no request. The film's player reads only its poster and the film's length and size, from the site's
 * own files, until a reader plays it.
 */
import { Fragment } from 'react';
import { Link } from 'react-router';

import { AUTHOR_NAME, AUTHOR_URL, Card, ConceptFooter, Icon, MarkAppIcon, TextLink } from '../ds/index.ts';
import { inApp, useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { AboutBar, useAboutNarrow } from './AboutBar.tsx';
import { Contents } from './Contents.tsx';
import { ABOUT_DOCUMENTS, readingMinutes, type AboutDocument, type Block, type HeroFigure } from './documents.ts';
import { ArchitectureFigure } from './figures/ArchitectureFigure.tsx';
import { ClaimCard } from './figures/ClaimCard.tsx';
import { LaunchFilm } from './figures/LaunchFilm.tsx';
import { MeasuresTable } from './figures/MeasuresTable.tsx';
import { ReadinessScale } from './figures/ReadinessScale.tsx';
import { Tau3Chart } from './figures/Tau3Chart.tsx';
import { Inlines } from './Inlines.tsx';
import { readNext, VISION_ARTICLE, type AboutId, type AboutPage } from './links.ts';
import { MONTHS } from './months.ts';
import { useNoIndex } from './useNoIndex.ts';
import { usePagePlace } from './usePagePlace.ts';

import './paper.css';
import './reader.css';

type Heading = Extract<Block, { kind: 'heading' }>;

/** Each document's kind, which its meta line names first, as the Vision article's names "Vision". */
const KINDS: Record<AboutId, string> = { prediction: 'Prediction', proposal: 'Proposal' };

/**
 * The byline, "Name · Month D, YYYY", as the author, the date as the boards print it, the date as the byline writes
 * it, and the date's day.
 */
function bylineOf(blocks: Block[]): { author: string; date: string; written: string; day?: string } {
  const text = blocks.find((block) => block.kind === 'byline')?.text ?? '';
  const [author = '', written = ''] = text.split(' · ');
  const [, month = '', date = '', year = ''] = /^(\w+) (\d{1,2}), (\d{4})$/.exec(written) ?? [];
  const index = MONTHS.findIndex((name) => name === month);
  if (index < 0) return { author, date: written, written };
  return {
    author,
    date: `${month.slice(0, 3)} ${date}, ${year}`,
    written,
    day: `${year}-${String(index + 1).padStart(2, '0')}-${date.padStart(2, '0')}`,
  };
}

/** The byline's author: the prototype's author links to the author's profile in a new tab, as the footer does. */
function Author({ name }: { name: string }) {
  if (name !== AUTHOR_NAME) return <>{name}</>;
  return (
    <TextLink href={AUTHOR_URL} external runningText>
      {name}
    </TextLink>
  );
}

/** A figure by its marker's name, or the launch film. */
function Figure({ name, compact }: { name: HeroFigure; compact: boolean }) {
  if (name === 'film') return <LaunchFilm compact={compact} />;
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
  /** The figure the hero draws, if any. */
  hero?: HeroFigure;
  /** Set column widths for a table, by its section's anchor (`AboutDocument.columns`). */
  columns?: Record<string, readonly number[]>;
  compact: boolean;
}

/** The anchor of the section block `index` sits in. */
function sectionOf(blocks: Block[], index: number): string | undefined {
  for (let i = index; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.kind === 'heading') return block.id;
  }
  return undefined;
}

/**
 * One block of the document. The `#` title and the byline feed the hero and the details instead; the hero's
 * own figure marker renders nothing, and so does the architecture's, which is drawn for the hero's width; the
 * readiness marker's table renders as the readiness scale.
 */
function ArticleBlock({ blocks, index, hero, columns, compact }: ArticleBlockProps) {
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
        <MeasuresTable table={block} compact={compact} block={index} widths={columns?.[sectionOf(blocks, index) ?? '']} />
      );
    case 'figure':
      if (block.name === 'readiness') {
        // The scale is drawn from the table under the marker, so the marker must have one.
        if (blocks[index + 1]?.kind !== 'table') throw new Error('the readiness marker has no table right after it');
        return null;
      }
      // The architecture's side-by-side layout needs the hero's width, which the article's column doesn't have, and
      // the launch film took its place in the proposal's hero (owner, 2026-11-02).
      return block.name === hero || block.name === 'architecture' ? null : <Figure name={block.name} compact={compact} />;
    case 'byline':
    case undefined:
      return null;
  }
}

/**
 * The document's blocks, with the pull quote, if it has one, after the first section. Its claim, if it has one, is the
 * hero's figure (`Opening`), so its blocks render there and not here.
 */
function Article({ document, compact }: { document: AboutDocument; compact: boolean }) {
  const { blocks, hero, pullQuote, claim, columns } = document;
  const headings = blocks.flatMap((block, i) => (block.kind === 'heading' && block.depth === 2 ? [i] : []));
  const quoteAt = pullQuote === undefined ? null : (headings[1] ?? blocks.length);
  const quote = (
    <blockquote key="pull-quote" className="cd-about-pull">
      <p className="cd-type-article-quote">{pullQuote}</p>
    </blockquote>
  );
  const block = (i: number) => (
    <ArticleBlock key={i} blocks={blocks} index={i} hero={hero} columns={columns} compact={compact} />
  );
  return (
    <article className={`cd-about-article ${compact ? 'cd-type-article-body-phone' : 'cd-type-article-body'}`}>
      {blocks.map((_, i) => {
        if (claim && i >= claim.first && i <= claim.last) return null;
        return (
          <Fragment key={i}>
            {i === quoteAt ? quote : null}
            {block(i)}
          </Fragment>
        );
      })}
      {quoteAt === blocks.length ? quote : null}
    </article>
  );
}

/**
 * The meta line above the title, as the Vision article opens: the document's kind, then its date and reading time,
 * the same as the details beside the article say, spaced apart by the line's gaps so they read as three.
 */
function MetaLine({ document, kind }: { document: AboutDocument; kind: string }) {
  const { written, day } = bylineOf(document.blocks);
  return (
    <p className="cd-about-hero__kicker cd-about-hero__meta cd-type-meta" data-meta="">
      <strong>{kind}</strong> {day ? <time dateTime={day}>{written}</time> : <span>{written}</span>}{' '}
      <span>{`${readingMinutes(document.blocks)} min read`}</span>
    </p>
  );
}

/**
 * How the page opens, centred: the app icon if the document has one, the meta line, the title, the summary and, on a
 * phone, the byline; then the hero figure, the document's lead figure or its claim as a card, drawn in the article's
 * type as the article would draw its blocks.
 */
function Opening({ document, kind, compact }: { document: AboutDocument; kind: string; compact: boolean }) {
  const { blocks, claim } = document;
  return (
    <div className="cd-about-hero" data-hero="">
      {document.icon ? <MarkAppIcon size={compact ? 'compact' : 'large'} /> : null}
      <MetaLine document={document} kind={kind} />
      <h1 className={`cd-about-hero__title ${compact ? 'cd-type-greeting' : 'cd-type-article-title'}`}>{document.title}</h1>
      <p
        className={`cd-about-hero__summary ${compact ? 'cd-type-article-body-phone' : 'cd-type-article-body'}`}
        data-summary=""
      >
        {document.summary}
      </p>
      {compact ? <BylineLine document={document} /> : null}
      {document.hero ? (
        <div className="cd-about-hero__figure">
          <Figure name={document.hero} compact={compact} />
        </div>
      ) : null}
      {claim ? (
        <div className={`cd-about-hero__figure ${compact ? 'cd-type-article-body-phone' : 'cd-type-article-body'}`}>
          <ClaimCard compact={compact}>
            {Array.from({ length: claim.last - claim.first + 1 }, (_, n) => (
              <ArticleBlock key={n} blocks={blocks} index={claim.first + n} compact={compact} />
            ))}
          </ClaimCard>
        </div>
      ) : null}
    </div>
  );
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
          <dd>
            <Author name={author} />
          </dd>
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

/**
 * The author, under the summary on a phone, where there are no details beside the article: the meta line above the
 * title has the date and the reading time.
 */
function BylineLine({ document }: { document: AboutDocument }) {
  const { author } = bylineOf(document.blocks);
  return (
    <p className="cd-about-hero__byline cd-type-meta" data-byline="">
      <Author name={author} />
    </p>
  );
}

/**
 * "Read next": the next page in the About set, its title and summary, the whole card one link, with an arrow
 * at its trailing edge that nudges toward the next page when the card is pointed at or focused.
 */
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
        <Icon name="arrow-right" className="cd-about-next__arrow" />
      </Card>
    </div>
  );
}

export interface ReaderPageProps {
  id: AboutId;
}

export function ReaderPage({ id }: ReaderPageProps) {
  const about = ABOUT_DOCUMENTS[id];
  const other = ABOUT_DOCUMENTS[about.next];
  const alsoRead = id === 'proposal' ? [other, VISION_ARTICLE] : [other];
  const compact = useAboutNarrow();
  const sections = about.blocks.filter((block): block is Heading => block.kind === 'heading' && block.depth === 2);
  usePagePlace(id);

  // Search engines are asked not to list the page while it is open.
  useNoIndex();

  // The tab names the document while it is open, and goes back to what it said when it closes.
  useDocumentTitle(inApp(about.title));


  return (
    <div
      className={`cd-about-paper cd-about-paper--app cd-about-set cd-about-page${compact ? ' cd-about-page--compact' : ''}`}
    >
      <AboutBar current={id} />
      <main className="cd-about-main">
        <Opening document={about} kind={KINDS[id]} compact={compact} />
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
