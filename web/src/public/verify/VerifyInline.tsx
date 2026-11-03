/**
 * Under the latest message with the kernel's verify card: the design system's code form until the
 * visitor confirms it's them, then the verified line in its place, which says the verification was
 * simulated. The card above carries the kernel's message, so nothing here repeats it. The code goes
 * only to the verify route (`VisitorChat.verify`), never into the chat.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefCallback, type RefObject } from 'react';

import type { Assurance } from '../../api/contracts.ts';
import { Notice, UNREACHABLE_COPY, VerifiedLine, VerifyCodeForm, type CopyLanguage } from '../../ds/index.ts';
import { PUBLIC_COPY } from '../copy.ts';
import type { VerifyStatus } from '../PublicChatProvider.tsx';

import './VerifyInline.css';

export interface VerifyInlineProps {
  status: VerifyStatus;
  /** The session as the kernel last answered: verified, and how. */
  verified: boolean;
  assurance: Assurance;
  /** Page chrome's language: the browser's. */
  language: CopyLanguage;
  onSubmit: (code: string) => void;
  /** "I can't get the code": the visitor asks for the owner, as the page's own button does. */
  onAskForOwner: () => void;
  /** A reply is on its way: "I can't get the code" waits, as Send does. */
  askWaits?: boolean;
  /** Its verify card arrived while the page was open, rather than read on a reload: the field may take focus. */
  arrived?: boolean;
}

/**
 * Focus the code form held when the code worked, handed on to the verified line in the form's place,
 * so it doesn't fall to the page and a screen reader keeps its place. The line comes first: the
 * document the visitor asked for comes in a later message, under it, and the next Tab reaches it.
 * As with the chat's other hand-offs, only focus that the form held moves, and only to a line, which
 * raises no phone keyboard and, with `tabindex="-1"`, draws no focus edge. A wrong code keeps the
 * form, and the form keeps its focus.
 */
function useVerifiedFocus(): { formRef: RefCallback<HTMLDivElement>; lineRef: RefObject<HTMLDivElement> } {
  const form = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const leftWithFocus = useRef(false);
  // React lets go of the form's ref before it takes the form out of the page, so focus is still in it.
  const formRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null && form.current?.contains(document.activeElement)) leftWithFocus.current = true;
    form.current = node;
  }, []);
  useLayoutEffect(() => {
    const handOff = leftWithFocus.current;
    leftWithFocus.current = false;
    const line = lineRef.current;
    const fell = document.activeElement === null || document.activeElement === document.body;
    if (!handOff || !line || !fell) return;
    line.tabIndex = -1;
    line.focus({ preventScroll: true });
  });
  return { formRef, lineRef };
}

/** How long the field waits to be shown in a reply still coming in before it gives up on focus. */
const LONGEST_WAIT_MS = 8_000;

/**
 * Where focus rests when the visitor isn't doing anything else: nowhere, or the chat's composer
 * with nothing typed in it (the message just sent, by Enter or by Send).
 */
function idle(active: Element | null): boolean {
  if (active === null || active === document.body) return true;
  const composer = active.closest('.cd-public-shell__composer');
  const box = composer?.querySelector('textarea');
  return composer !== null && composer !== undefined && (box === null || box === undefined || box.value === '');
}

/** The field can be seen: shown, and no longer fully see-through at the start of its fade. */
function seen(field: HTMLInputElement): boolean {
  if (typeof field.checkVisibility === 'function') return field.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  // Older Safari has no checkVisibility: its own visibility, and no see-through box around it.
  if (getComputedStyle(field).visibility !== 'visible') return false;
  for (let node: Element | null = field; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).opacity === '0') return false;
  }
  return true;
}

/**
 * The code field takes focus once it can be seen, when its card arrived while the page was open
 * (owner, 2026-11-02), so the visitor can type the code from the Demo inbox at once. Only from an
 * idle place: nowhere, or the composer with nothing typed in it. Focus the visitor moved anywhere
 * else, before or while the form waits, stays where it is. Not a form read on a reload, and not on
 * a touch screen, where it would raise the keyboard over the inbox, as the chat's other moves
 * don't. In a reply still coming in the form waits unseen, so the field takes focus once it can,
 * for up to 8 s.
 */
function useFocusOnArrival(arrived: boolean): RefCallback<HTMLDivElement> {
  const place = useRef<HTMLDivElement | null>(null);
  const arrivedAtFirst = useRef(arrived);
  useEffect(() => {
    if (!arrivedAtFirst.current || window.matchMedia('(pointer: coarse)').matches) return undefined;
    const started = performance.now();
    const from = document.activeElement;
    let frame = 0;
    const tryFocus = () => {
      const field = place.current?.querySelector<HTMLInputElement>('input');
      if (!field || document.activeElement !== from || !idle(from)) return;
      if (seen(field)) {
        field.focus({ preventScroll: true });
        return;
      }
      if (performance.now() - started < LONGEST_WAIT_MS) frame = requestAnimationFrame(tryFocus);
    };
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, []);
  return useCallback((node: HTMLDivElement | null) => {
    place.current = node;
  }, []);
}

export function VerifyInline({ status, verified, assurance, language, onSubmit, onAskForOwner, askWaits = false, arrived = false }: VerifyInlineProps) {
  const { formRef, lineRef } = useVerifiedFocus();
  const placeRef = useFocusOnArrival(arrived);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      formRef(node);
      placeRef(node);
    },
    [formRef, placeRef],
  );
  if (verified) return <VerifiedLine text={PUBLIC_COPY[language].verified} assurance={assurance} language={language} lineRef={lineRef} />;
  // A failed code is the form's own line; no answer at all is the page's.
  const state = status === 'checking' || status === 'failed' ? status : 'idle';
  return (
    <div ref={ref} className="cd-verify-inline">
      <VerifyCodeForm state={state} onSubmit={onSubmit} onAskForOwner={onAskForOwner} askWaits={askWaits} language={language} hint={PUBLIC_COPY[language].codeArrives} />
      {status === 'unreachable' ? <Notice tone="error">{UNREACHABLE_COPY[language]}</Notice> : null}
    </div>
  );
}
