/**
 * The About pages' "On this page" list, which the two reading pages and the Vision article share: the page's
 * sections, numbered, each a link to its heading. Beside the article on a laptop it stays pinned below the top bar
 * and marks the section being read (`useCurrentSection`); on a phone it folds into one row that opens. Following a
 * link moves the window to the section and focus to its heading, and names the section in the address, so Back
 * returns to the reader's place. Its styles are `contents.css`, on any page whose root carries `cd-about-set`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { Icon } from '../ds/index.ts';
import { prefersReducedMotion } from './motion.ts';
import { moveToSection, useCurrentSection } from './useCurrentSection.ts';

import './contents.css';

/**
 * A section the list links to: its heading's words and the anchor the heading carries. The heading is focusable from
 * the list (`tabIndex={-1}`) and stops clear of the pinned bar (its scroll margin), as the pages draw it.
 */
export interface ContentsSection {
  id: string;
  text: string;
}

interface ContentsListProps {
  sections: readonly ContentsSection[];
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
export function SideContents({ sections }: { sections: readonly ContentsSection[] }) {
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
export function FoldedContents({ sections }: { sections: readonly ContentsSection[] }) {
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
export function Contents({ sections, compact }: { sections: readonly ContentsSection[]; compact: boolean }) {
  return compact ? <FoldedContents sections={sections} /> : <SideContents sections={sections} />;
}
