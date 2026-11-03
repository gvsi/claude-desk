/**
 * Setup's start transition, in one place: how the press of "Start" turns the start page into
 * setup's chat (StartingChat), and how the interview, once made, takes the chat's place
 * (QuestionsStep's `opening`). Its motion is here and in SetupStartTransition.css, with the
 * design system's motion tokens only, and every part of it is at its end at once under reduced
 * motion.
 *
 * On the press, the start page fades out while setup's chat fades in; a box travels from the
 * description's field to the owner's first message, behind its words, which rise in as it lands
 * (a FLIP: the message is drawn in place at once, and the box moves with a transform only). Then
 * Claude's writing dots rise in where its first message will be. When the interview opens, the dots
 * fade out, the business's name fades into the bar, and the memory question rises into the dock.
 */
import { useEffect, useLayoutEffect, useRef, useState, type AnimationEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { VisitorMessage, WritingIndicator } from '../ds/index.ts';
import './SetupStartTransition.css';

/** The reader asks for reduced motion: every part of the transition is at its end at once. */
function reducesMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A motion token's duration in ms, as the page computes it, whether it is written in ms or s. */
function tokenMs(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const amount = parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  return value.endsWith('ms') ? amount : amount * 1000;
}

/** A token's value (an easing, a length), as the page computes it. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Ends a part of the transition once its motion has run, at the latest: its `animationend` ends it
 * first whenever the motion plays, and this ends it should the motion never end (a tab in the
 * background, or animations turned off), a motion-fast after it was due. `durationMs` is how long
 * the motion runs.
 */
function useEndsBy(active: boolean, durationMs: () => number, end: () => void): void {
  const ending = useRef(end);
  ending.current = end;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => ending.current(), durationMs() + tokenMs('--motion-fast'));
    return () => clearTimeout(timer);
    // Once, from when the part starts.
  }, [active]);
}

/** The start page as it looked when "Start" was pressed: what leaves, and where the description's field was. */
export interface StartScreen {
  /** The start page's form, copied, without ids, to fade out where it was. */
  screen: HTMLElement;
  /** Where the form was on screen. */
  screenRect: DOMRect;
  /** Where the description's field was on screen, with its edge and fill. */
  field: DOMRect;
  fieldBorder: string;
  fieldFill: string;
}

/**
 * The start page as it is, taken as "Start" sends it, for the chat's entrance; null under reduced
 * motion, or when the page isn't there to take.
 */
export function takeStartScreen(form: HTMLElement | null, field: HTMLElement | null): StartScreen | null {
  if (form === null || field === null || reducesMotion()) return null;
  const screen = form.cloneNode(true) as HTMLElement;
  // The copy is only to look at: no ids to collide with the page's, nothing to reach.
  for (const el of [screen, ...screen.querySelectorAll('*')]) {
    el.removeAttribute('id');
    el.removeAttribute('for');
    el.removeAttribute('aria-labelledby');
    el.removeAttribute('aria-describedby');
  }
  const look = getComputedStyle(field);
  return { screen, screenRect: form.getBoundingClientRect(), field: field.getBoundingClientRect(), fieldBorder: look.borderTopColor, fieldFill: look.backgroundColor };
}

/** The start page fading out where it was, over the chat coming in; gone once it has. */
function LeavingScreen({ from }: { from: StartScreen }) {
  const holder = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  useEndsBy(true, () => tokenMs('--motion-fast'), () => setGone(true));
  useLayoutEffect(() => {
    // The pinned React types have no `inert` prop, so the copy takes it as an attribute.
    holder.current?.setAttribute('inert', '');
    holder.current?.replaceChildren(from.screen);
  }, [from]);
  if (gone) return null;
  const place: CSSProperties = { left: from.screenRect.left, top: from.screenRect.top, width: from.screenRect.width };
  return createPortal(
    <div
      ref={holder}
      className="cd-setup-start-leaving-screen"
      style={place}
      aria-hidden="true"
      onAnimationEnd={(event) => event.target === event.currentTarget && setGone(true)}
    />,
    document.body,
  );
}

/**
 * The owner's own words, their first message in setup's chat. Given the start page as it left
 * (`from`), the move: the message drawn in place with its fill clear, and behind it a box with the
 * message's corners that travels from the description's field, its edge and fill becoming the
 * message's, while the words rise in; then the box goes and the message takes its own fill. The
 * interview draws the same row, still, so the message never moves at the hand-off.
 */
export function OwnerWords({ words, from = null }: { words: string; from?: StartScreen | null }) {
  const row = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState(from !== null);
  useEndsBy(moving, () => 2 * tokenMs('--motion-base'), () => setMoving(false));
  useLayoutEffect(() => {
    const bubble = row.current?.querySelector('.cd-visitor-message__bubble');
    const el = box.current;
    if (!moving || from === null || !bubble || !el || !row.current) return;
    const at = bubble.getBoundingClientRect();
    const within = row.current.getBoundingClientRect();
    Object.assign(el.style, { left: `${at.left - within.left}px`, top: `${at.top - within.top}px`, width: `${at.width}px`, height: `${at.height}px` });
    const scaleX = at.width === 0 ? 1 : from.field.width / at.width;
    const scaleY = at.height === 0 ? 1 : from.field.height / at.height;
    el.style.setProperty('--setup-start-from-transform', `translate(${from.field.left - at.left}px, ${from.field.top - at.top}px) scale(${scaleX}, ${scaleY})`);
    el.style.setProperty('--setup-start-from-border', from.fieldBorder);
    el.style.setProperty('--setup-start-from-fill', from.fieldFill);
    el.classList.add('cd-setup-start-words__box--moving');
    // Once, as the chat comes in: the move never starts again.
  }, []);
  const landed = (event: AnimationEvent) => {
    if (event.target === box.current) setMoving(false);
  };
  return (
    <>
      {from !== null ? <LeavingScreen from={from} /> : null}
      <div ref={row} className={`cd-setup-start-words${moving ? ' cd-setup-start-words--moving' : ''}`}>
        {moving ? <div ref={box} className="cd-setup-start-words__box" aria-hidden="true" onAnimationEnd={landed} /> : null}
        <VisitorMessage text={words} />
      </div>
    </>
  );
}

/**
 * Whether the writing dots of the last start shown had come in before its interview opened: only
 * then do they fade out as it opens. A start answered before them (only the mock answers that fast)
 * opens with nothing to fade.
 */
let dotsCameIn = false;

/**
 * Claude's writing dots while the start runs, where its first message will be, rising in; after the
 * words' move when the chat has just come in (`afterMove`, which the chat's
 * `cd-setup-start-transition--entering` times).
 */
export function StartingDots({ afterMove }: { afterMove: boolean }) {
  useLayoutEffect(() => {
    dotsCameIn = reducesMotion() || !afterMove;
  }, [afterMove]);
  return (
    <div
      className="cd-setup-start-dots"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) dotsCameIn = true;
      }}
    >
      <WritingIndicator language="en" />
    </div>
  );
}

export interface StartedOpeningProps {
  /** The owner's own description, as the start sent it. */
  words: string;
  /** The start on this page has just opened the interview: its hand-off plays, once. */
  arrived: boolean;
}

/**
 * The opening of an interview the start on this page made: the owner's words, their first message.
 * Just opened (`arrived`), the hand-off from setup's chat: the dots fade out, the business's name
 * fades into the bar when it comes, and the docked question rises in.
 */
export function StartedOpening({ words, arrived }: StartedOpeningProps) {
  const [moving] = useState(() => arrived && !reducesMotion());
  const [leaving, setLeaving] = useState(() => moving && dotsCameIn);
  useEndsBy(leaving, () => tokenMs('--motion-fast'), () => setLeaving(false));
  useLayoutEffect(() => {
    if (!moving) return undefined;
    const base = tokenMs('--motion-base');
    const ease = token('--motion-ease');
    // The docked question rises into the dock once the dots have gone.
    const panel = document.querySelector('.cd-setup-dock .cd-setup-question-panel');
    panel?.animate([{ opacity: 0, transform: `translateY(${token('--space-12')})` }, { opacity: 1, transform: 'none' }], {
      duration: base,
      delay: tokenMs('--motion-settle'),
      easing: ease,
      fill: 'backwards',
    });
    // The business's name fades into the bar as it comes (a read of the Desks brings it).
    const name = document.querySelector('.cd-setup__bar .cd-setup__business');
    if (name === null) return undefined;
    const fadeIn = () => name.animate([{ opacity: 0 }, { opacity: 1 }], { duration: base, easing: ease });
    if ((name.textContent ?? '') !== '') {
      fadeIn();
      return undefined;
    }
    const observer = new MutationObserver(() => {
      if ((name.textContent ?? '') === '') return;
      observer.disconnect();
      fadeIn();
    });
    observer.observe(name, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [moving]);
  return (
    <>
      <OwnerWords words={words} />
      {/* The dots, as setup's chat left them, fade out; then they are gone. */}
      {leaving ? (
        <div className="cd-setup-start-dots cd-setup-start-leaving" aria-hidden="true" onAnimationEnd={(event) => event.target === event.currentTarget && setLeaving(false)}>
          <WritingIndicator language="en" />
        </div>
      ) : null}
    </>
  );
}
