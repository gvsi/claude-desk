import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { placeBands } from './Skeleton.tsx';

import './Skeleton.css';

/** How long a load runs before its skeleton shows, so a fast load goes straight to the page. */
export const SKELETON_DELAY_MS = 200;

export interface SkeletonScreenProps {
  /** True while a read the part's first view depends on is out: no data and no failure yet. */
  loading: boolean;
  /** The existing loading words, in the reader's language. */
  status: string;
  /** The part's shapes, built from its own components' sizes. */
  skeleton: ReactNode;
  /** The part itself, drawn once `loading` is false: its content, its empty state or its error. */
  children?: ReactNode;
  /** Places the region in the screen's layout. */
  className?: string;
  /** The status's language, when it differs from the page's (the public chat in setup's preview). */
  lang?: string;
}

/**
 * What the skeleton layer is doing: laid out but invisible while the load is young, shown, fading
 * over the part that arrived, or gone.
 */
type Phase = 'waiting' | 'shown' | 'leaving' | 'none';

/** The layer's fade, which its own listener waits for; the shapes' sweeps bubble past it too. */
const LEAVE = 'cd-skeleton-leave';

/**
 * How long a leaving layer stays at most, should its fade never end or be cancelled (a tab in the
 * background): well past motion-fast, so the fade ends first whenever it runs. The layer rests at
 * opacity 0 meanwhile, so it is invisible whether or not the fade runs.
 */
const LEAVE_FALLBACK_MS = 1000;

/**
 * The phase of the region around this one. A region that mounts while the one around it shows or
 * fades its shapes continues them at once (a hand-off), so no frame goes without shapes.
 */
const AroundPhase = createContext<Phase>('none');

/** True when the reader asks for reduced motion: no fade, the part replaces the shapes at once. */
function reducesMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The phase when `loading` changes: back to the wait, or out. Only shapes that showed fade out, and
 * not under reduced motion.
 */
function nextPhase(phase: Phase, loading: boolean): Phase {
  if (loading) return 'waiting';
  return (phase === 'shown' || phase === 'leaving') && !reducesMotion() ? 'leaving' : 'none';
}

/**
 * The region that waits, sweeps, speaks and fades while a part of a page loads. For its first
 * `SKELETON_DELAY_MS` it holds the part's space with its shapes laid out but invisible, so a fast
 * load goes straight to the part. Then the shapes show and the status says the loading words.
 */
export function SkeletonScreen({ loading, status, skeleton, children, className, lang }: SkeletonScreenProps) {
  const around = useContext(AroundPhase);
  const [phase, setPhase] = useState<Phase>(() => {
    if (!loading) return 'none';
    return around === 'shown' || around === 'leaving' ? 'shown' : 'waiting';
  });
  // The phase follows `loading` in the same render it changes in, so no commit ever draws the part
  // and a layer that no longer belongs to it.
  const [wasLoading, setWasLoading] = useState(loading);
  // Shapes that showed and went at once, under reduced motion, still hand off: a region that mounts
  // in the part in that same commit continues them, as it would during the fade.
  const [handingOff, setHandingOff] = useState(false);
  if (loading !== wasLoading) {
    const next = nextPhase(phase, loading);
    setWasLoading(loading);
    setPhase(next);
    setHandingOff(next === 'none' && (phase === 'shown' || phase === 'leaving'));
  } else if (!loading ? phase === 'waiting' || phase === 'shown' : phase === 'leaving' || phase === 'none') {
    // An update made in one state can land in the other: the wait coming due just as the part
    // lands, which React may replay after the render that ended the load. A part that has landed
    // never waits or shows its shapes again, and a part loading again waits afresh.
    setPhase(loading ? 'waiting' : 'none');
  }
  const region = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const hasLayer = phase !== 'none';

  // The pinned React types have no `inert` prop, so the layer takes it as an attribute.
  useLayoutEffect(() => {
    layer.current?.setAttribute('inert', '');
  }, [hasLayer]);

  // Each shape places the band as it mounts. When the region resizes, or the window does (which can
  // move the region without resizing it), every shape is placed again.
  useLayoutEffect(() => {
    const box = region.current;
    const shapes = layer.current;
    if (!box || !shapes) return;
    const placeAll = () => placeBands([...shapes.querySelectorAll<HTMLElement>('.cd-skeleton')]);
    let frame: number | undefined;
    const refresh = () => {
      placeAll();
      // A responsive render can move shapes after resize callbacks without resizing this region.
      if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; placeAll(); });
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
    observer?.observe(box);
    window.addEventListener('resize', refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [hasLayer]);

  // The hand-off lasts for the commit the part lands in; a region that mounts later waits as usual.
  useEffect(() => {
    if (handingOff) setHandingOff(false);
  }, [handingOff]);

  useEffect(() => {
    if (phase !== 'waiting') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Start after the mount's mutation observers have run. A timer can fire just before its
    // requested fractional deadline, so check the clock rather than showing a frame early. React
    // cleans this effect up after the commit that ends the wait, so the timer can still fire after
    // the part has landed: it shows the shapes only while the region is still waiting.
    queueMicrotask(() => {
      const deadline = performance.now() + SKELETON_DELAY_MS;
      const showWhenDue = () => {
        if (!live) return;
        const remaining = deadline - performance.now();
        if (remaining > 0) timer = setTimeout(showWhenDue, remaining);
        else setPhase((now) => (now === 'waiting' ? 'shown' : now));
      };
      if (live) timer = setTimeout(showWhenDue, SKELETON_DELAY_MS);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [phase]);

  // A leaving layer goes when its own fade ends or is cancelled, or at the latest after the fallback.
  useLayoutEffect(() => {
    const element = layer.current;
    if (phase !== 'leaving' || !element) return;
    const done = (event: AnimationEvent) => {
      if (event.target === element && event.animationName === LEAVE) setPhase('none');
    };
    element.addEventListener('animationend', done);
    element.addEventListener('animationcancel', done);
    const fallback = setTimeout(() => setPhase('none'), LEAVE_FALLBACK_MS);
    return () => {
      element.removeEventListener('animationend', done);
      element.removeEventListener('animationcancel', done);
      clearTimeout(fallback);
    };
  }, [phase]);

  const regionClass = ['cd-skeleton-screen', phase === 'leaving' ? 'cd-skeleton-screen--leaving' : undefined, className];
  return (
    <AroundPhase.Provider value={handingOff ? 'shown' : phase}>
      <div ref={region} className={regionClass.filter(Boolean).join(' ')}>
        <p role="status" className="cd-sr-only" lang={lang}>
          {phase === 'shown' ? status : ''}
        </p>
        <div className="cd-skeleton-screen__body" aria-busy={loading ? 'true' : undefined}>
          {hasLayer ? (
            <div ref={layer} className="cd-skeleton-screen__layer" aria-hidden="true" data-state={phase}>
              {skeleton}
            </div>
          ) : null}
          {loading ? null : children}
        </div>
      </div>
    </AroundPhase.Provider>
  );
}
