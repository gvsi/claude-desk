/**
 * The Vision article: a long-form page under About this prototype on where a Desk could go next, with four phone
 * screens drawn inline. It is the named exception to the design system, on the About set's light paper
 * (`paper.css`, which the reading pages share) and its own type scale (`VisionArticle.css`, every rule under
 * `.vision-article`), and it says on the page that it is vision, not the prototype.
 *
 * The phone screens are pictures made of live text: each is read by its label, with its caption under it. The
 * cover band under the headline peeks at the same four screens and is decoration only, as are their tops on the
 * picture cards that end the article, each a link to its idea's vision page. As one of the About set, it carries
 * the reading pages' switch and their way into the prototype in its own bar, and "Read next" at its end. The page
 * is static: its words come from `text.ts`, nothing on it moves, and it makes no request.
 */
import { Fragment, useId, useSyncExternalStore } from 'react';
import { Link } from 'react-router';

import { ConceptFooter } from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { AboutSwitch } from '../AboutSwitch.tsx';
import { readNext } from '../links.ts';
import { PrototypeLink } from '../PrototypeLink.tsx';
import { useNoIndex } from '../useNoIndex.ts';
import { usePagePlace } from '../usePagePlace.ts';
import {
  ARTICLE,
  PICTURE_CARDS,
  READ_MINUTES,
  SCREENS,
  SECTIONS,
  type ChatPart,
  type ChatScreen,
  type Figure,
  type OwnerScreen,
  type Screen,
  type Section,
} from './text.ts';

import '../paper.css';
import './VisionArticle.css';

/** The article's phone layout (VisionArticle.css): the switch leaves the bar for a row under it. */
const NARROW = '(max-width: 720px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW).matches;
}

/** What happened, under the message it belongs to, with a dot in its tone. */
function Receipt({ tone, text }: { tone: 'done' | 'held' | 'declined'; text: string }) {
  return (
    <div className="ph-receipt" data-part="receipt" data-tone={tone}>
      <span className={`ph-dot ph-dot--${tone}`} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

/** Two choices drawn as buttons. They are part of the picture, so they are not buttons anyone can press. */
function Choices({ primary, other }: { primary: string; other: string }) {
  return (
    <div className="ph-btns">
      <span className="ph-btn ph-btn--primary">{primary}</span>
      <span className="ph-btn">{other}</span>
    </div>
  );
}

function Part({ part }: { part: ChatPart }) {
  switch (part.kind) {
    case 'visitor':
      return (
        <div className="ph-you" data-part="visitor">
          {part.text}
        </div>
      );
    case 'claude':
      return (
        <p className="ph-claude" data-part="claude">
          {part.text}
        </p>
      );
    case 'system':
      return (
        <div className="ph-system" data-part="system">
          {part.text}
        </div>
      );
    case 'card':
      return (
        <div className="ph-card" data-part="card">
          <div className="ph-card__label">{part.label}</div>
          <div className="ph-card__head">{part.head}</div>
          {part.lines.map((line) => (
            <div key={line} className="ph-card__line">
              {line}
            </div>
          ))}
        </div>
      );
    case 'receipt':
      return <Receipt tone={part.tone} text={part.text} />;
    case 'choices':
      return <Choices primary={part.primary} other={part.other} />;
  }
}

/** A chat with a Desk: the business's header with the line that says Claude, an AI, is answering, then the chat. */
function Chat({ screen }: { screen: ChatScreen }) {
  return (
    <>
      <div className={`ph-head ph-head--${screen.field}`} data-screen-head="">
        <div className="ph-row">
          <span className="ph-mono" aria-hidden="true">
            {screen.monogram}
          </span>
          <div>
            <div className="ph-name">{screen.name}</div>
            <div className="ph-sub">{screen.sub}</div>
          </div>
        </div>
        <p className="ph-ai">{screen.ai}</p>
      </div>
      <div className="ph-body">
        {screen.parts.map((part, i) => (
          <Part key={i} part={part} />
        ))}
      </div>
      <div className="ph-compose">{screen.composer}</div>
    </>
  );
}

/** The owner's app on Today: the request held for her answer, who's live now, the night's count and the tabs. */
function Owner({ screen }: { screen: OwnerScreen }) {
  const { held, live } = screen;
  return (
    <>
      <div className="ph-today">
        <div className="ph-today__business">{screen.business}</div>
        <p className="ph-greet">{screen.greeting}</p>
      </div>
      <div className="ph-body">
        <div className="ph-card" data-part="card">
          <div className="ph-card__label">
            <span className="ph-dot ph-dot--held" aria-hidden="true" />
            {held.label}
          </div>
          <div className="ph-card__ask">{held.ask}</div>
          <div className="ph-card__line ph-card__rule">{held.rule}</div>
          <Choices primary={held.allow} other={held.deny} />
        </div>
        <div className="ph-card" data-part="card">
          <div className="ph-card__label">{live.label}</div>
          <div className="ph-card__lines">
            {live.lines.map((line) => (
              <div key={line} className="ph-card__line">
                {line}
              </div>
            ))}
          </div>
        </div>
        <Receipt tone="done" text={screen.receipt} />
      </div>
      <div className="ph-tabs">
        {screen.tabs.map((tab) => (tab === screen.tab ? <b key={tab}>{tab}</b> : <span key={tab}>{tab}</span>))}
      </div>
    </>
  );
}

/**
 * A phone holding a screen. In the article it is a picture, read by its label; in the cover band and at the top
 * of a picture card, both hidden from screen readers, it is decoration with no label of its own.
 */
function Phone({ screen, decorative = false }: { screen: Screen; decorative?: boolean }) {
  const picture = decorative ? {} : { role: 'img', 'aria-label': screen.label };
  return (
    <div className="va-phone" {...picture}>
      <div className="va-screen">{screen.kind === 'chat' ? <Chat screen={screen} /> : <Owner screen={screen} />}</div>
    </div>
  );
}

/** A screen and its caption: the phone on its side at a laptop's width, above the caption on a phone. */
function ArticleFigure({ figure }: { figure: Figure }) {
  return (
    <figure className={`va-fig${figure.side === 'right' ? ' va-fig--right' : ''}`}>
      <Phone screen={figure.screen} />
      <figcaption className="va-cap">
        <b>{figure.lead}</b> {figure.caption}
      </figcaption>
    </figure>
  );
}

/** A section's text: its heading, then its paragraphs and the pull quote where it falls. */
function SectionText({ heading, passages }: Pick<Section, 'heading' | 'passages'>) {
  return (
    <div className="va-body">
      <h2 className="va-h2">{heading}</h2>
      {passages.map((passage) =>
        typeof passage === 'string' ? (
          <p key={passage} className="va-p">
            {passage}
          </p>
        ) : (
          <blockquote key={passage.quote} className="va-quote">
            <p>{passage.quote}</p>
          </blockquote>
        ),
      )}
    </div>
  );
}

/**
 * "See each one up close": a card for each idea, two by two at every width. Each card is one link to the idea's
 * vision page, named by the idea and its line; the top of the idea's phone above them is decoration.
 */
function PictureCards() {
  const headingId = useId();
  const { heading, lead, cards } = PICTURE_CARDS;
  return (
    <section className="va-body va-cards" aria-labelledby={headingId}>
      <h2 className="va-h2" id={headingId}>
        {heading}
      </h2>
      <p className="va-cards__lead">{lead}</p>
      <ul className="va-cards__grid">
        {cards.map(({ screen, name, line, href }) => (
          <li key={href} className="va-cards__item">
            <Link className="va-card" to={href}>
              <div className="va-card__top" aria-hidden="true">
                <Phone screen={screen} decorative />
              </div>
              <span className="va-card__words">
                <span className="va-card__name">{name}</span> <span className="va-card__line">{line}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Read next" at the end: the next page in the About set, its title and summary, the whole card one link. */
function ReadNext() {
  const next = readNext('vision');
  return (
    <div className="va-next">
      <p className="va-next__label" data-next-label="">
        Read next
      </p>
      <Link className="va-next__link" to={next.route}>
        {next.title}
      </Link>
      <p className="va-next__summary">{next.summary}</p>
    </div>
  );
}

export function VisionArticle() {
  // The tab names the page while it is open; search engines are asked not to list it, as the other About pages.
  useDocumentTitle(inApp(ARTICLE.kicker));
  useNoIndex();
  usePagePlace('vision');
  const compact = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  // The About set's switch, the article marked as the page on show: in the bar, or under it on a phone, where it
  // scrolls away with the page as the reading pages' does.
  const about = <AboutSwitch current="vision" className="va-switch" linkClassName="va-switch__link" />;

  return (
    <div className="vision-article cd-about-paper">
      <header className="va-bar">
        <span className="va-bar__brand">Claude Desk</span>
        {compact ? null : about}
        <PrototypeLink />
      </header>
      {compact ? about : null}
      <main>
        <article>
          <header className="va-hero">
            {/* Spaces between the three, which the line's gaps draw, so they read as three. */}
            <p className="va-meta" data-meta="">
              <strong>{ARTICLE.kicker}</strong> <time dateTime={ARTICLE.date.iso}>{ARTICLE.date.text}</time>{' '}
              <span>{`${READ_MINUTES} min read`}</span>
            </p>
            <h1 className="va-h1">{ARTICLE.title}</h1>
            <p className="va-dek">{ARTICLE.dek}</p>
            <p className="va-note">{ARTICLE.note}</p>
          </header>
          <div className="va-band" aria-hidden="true" data-cover="">
            <div className="va-trio">
              {SCREENS.map((screen) => (
                <Phone key={screen.label} screen={screen} decorative />
              ))}
            </div>
          </div>
          <div className="va-body va-body--intro">
            {ARTICLE.intro.map((paragraph) => (
              <p key={paragraph} className="va-p">
                {paragraph}
              </p>
            ))}
          </div>
          {SECTIONS.map(({ heading, passages, figure }) => (
            <Fragment key={heading}>
              <SectionText heading={heading} passages={passages} />
              {figure ? <ArticleFigure figure={figure} /> : null}
            </Fragment>
          ))}
          <PictureCards />
        </article>
      </main>
      <footer className="va-end">
        <hr className="va-end__rule" />
        <p>{ARTICLE.end}</p>
        <ReadNext />
        <ConceptFooter />
      </footer>
    </div>
  );
}
