import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from 'react';

import { Icon, type IconName } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import { Mark, Wordmark } from '../Mark/Mark.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { INTRO_ERROR_COPY, type IntroErrorCode } from './introCopy.ts';

import './IntroDialog.css';

export type { IntroErrorCode } from './introCopy.ts';

/** One thing to try in the demo: a short title, an optional line under it and a line icon. */
export interface IntroThing {
  title: string;
  detail?: string;
  icon?: IconName;
}

export interface IntroDialogProps {
  /** The title in Claude's voice: "A Claude front desk for your business". */
  title: string;
  /** The paragraph under the title: who you are today and what to try. */
  intro: string;
  /** The things to try, in order: four on the board. */
  thingsToTry: IntroThing[];
  /** The button that starts the demo: "Start the demo". */
  submitLabel: string;
  /** Called once with the trimmed passcode. A rejection is ignored; report failures through `error`. */
  onSubmit: (passcode: string) => Promise<void>;
  /** The demo is starting: the button shows the busy spinner, a status line says so, and nothing more is submitted. */
  busy?: boolean;
  /** Why the last try failed, shown as a line under the field. */
  error?: IntroErrorCode;
  /**
   * The passcode worked and the next page is ready: the dialog leaves, still starting the demo, and
   * closes. Once set, it stays set.
   */
  leaving?: boolean;
  /** Called once, when the dialog has closed after `leaving`. */
  onClosed?: () => void;
}

/** What the status line says while the demo starts; the button itself only shows the busy spinner. */
const STARTING_LINE = 'Starting the demo';

/** What a keyboard can reach, before leaving out what is disabled, hidden or decorative. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dialog's own controls in Tab order: enabled, shown, and not inside the hidden illustration.
 * Only hiding inside the dialog counts: a modal dialog escapes an inert page around it.
 */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    const hidden = el.closest('[aria-hidden="true"], [inert]');
    return (hidden === null || !root.contains(hidden)) && el.getClientRects().length > 0;
  });
}

/** The line for `code`; a code this build doesn't know reads as unreachable, never as nothing. */
function errorLine(code: IntroErrorCode): string {
  return Object.hasOwn(INTRO_ERROR_COPY, code) ? INTRO_ERROR_COPY[code] : INTRO_ERROR_COPY.unreachable;
}

/** A CSS time as the browser computes it, in seconds or milliseconds, as milliseconds; 0 when there is none. */
function millis(time: string): number {
  const value = Number.parseFloat(time);
  if (!Number.isFinite(value)) return 0;
  return time.trim().endsWith('ms') ? value : value * 1000;
}

/** The browser asks before it closes a modal dialog (a `cancel` event); the answer is always no. */
function keepOpen(event: SyntheticEvent): void {
  event.preventDefault();
}

/**
 * The first visit's front door: a modal dialog over a dimmed page that says what Claude Desk is,
 * lists what to try and takes the demo passcode, beside a clay illustration of a booked visit.
 * It can't be dismissed: the only way on is the passcode.
 */
export function IntroDialog({
  title,
  intro,
  thingsToTry,
  submitLabel,
  onSubmit,
  busy = false,
  error,
  leaving = false,
  onClosed,
}: IntroDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  // Set from a submit until its promise settles, so a second Enter before `busy` arrives sends nothing.
  const sending = useRef(false);
  // Set once the dialog has closed after leaving, so `onClosed` is called once.
  const closed = useRef(false);
  const onClosedRef = useRef(onClosed);
  const [passcode, setPasscode] = useState('');
  // Set once the illustration's story has played to its end, so it never plays again.
  const [played, setPlayed] = useState(false);

  // While it leaves, the demo is still starting: the spinner stays and nothing more is sent.
  const starting = busy || leaving;
  const code = passcode.trim();
  const canSubmit = code !== '' && !starting;
  // Empty: truly disabled. Busy: the Button stays focusable and inert (aria-disabled), so a person
  // who pressed it keeps their place while the demo starts.
  const empty = code === '' && !starting;
  // No error while a try is out, so the next failure is a new alert and is announced, even when the
  // page leaves `error` set to the same code throughout.
  const shownError = starting ? undefined : error;

  const titleId = `${id}-title`;
  const introId = `${id}-intro`;
  const fieldId = `${id}-passcode`;
  const errorId = `${id}-error`;

  // A native modal: the page behind is inert, and the dialog sits above everything else.
  // `closedby="none"` also turns off the browser's own ways to close it, where it is supported.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', 'none');
    if (!dialog.open) dialog.showModal();
    fieldRef.current?.focus();
  }, []);

  // Keep this before the leaving effect: with no exit to run, that effect closes the dialog at once,
  // and must call the `onClosed` of the render that set `leaving`, not an earlier one.
  useLayoutEffect(() => {
    onClosedRef.current = onClosed;
  });

  // Leaving: the dialog closes when its exit animation ends. With no exit to run (reduced motion)
  // it closes at once, and if the animation's end never reaches it, a timer closes it no later than
  // the exit's length plus motion-instant, so it can never stay open over the page.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!leaving || !dialog) return;
    const close = () => {
      if (closed.current) return;
      closed.current = true;
      dialog.close();
      onClosedRef.current?.();
    };
    const style = getComputedStyle(dialog);
    const lasts = millis(style.animationDuration) + millis(style.animationDelay);
    if (style.animationName === 'none' || lasts <= 0) {
      close();
      return;
    }
    const onEnd = (event: AnimationEvent) => {
      if (event.target === dialog) close();
    };
    dialog.addEventListener('animationend', onEnd);
    const fallback = window.setTimeout(close, lasts + millis(style.getPropertyValue('--motion-instant')));
    return () => {
      dialog.removeEventListener('animationend', onEnd);
      window.clearTimeout(fallback);
    };
  }, [leaving]);

  // When a try fails, the field takes focus with its text selected, ready to type over.
  useEffect(() => {
    if (shownError === undefined) return;
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, [shownError]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || sending.current) return;
    sending.current = true;
    const settle = () => {
      sending.current = false;
    };
    // A rejection is the page's to report, through `error`; here it only ends the send.
    try {
      Promise.resolve(onSubmit(code)).then(settle, settle);
    } catch {
      settle();
    }
  };

  // Escape does nothing, and Tab and Shift+Tab go round the dialog's own controls only.
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const order = tabbables(event.currentTarget);
    const at = order.indexOf(document.activeElement as HTMLElement);
    const last = order.length - 1;
    const next = event.shiftKey ? order[at <= 0 ? last : at - 1] : order[at === -1 || at === last ? 0 : at + 1];
    next?.focus();
  };

  // A press on the scrim itself does nothing, not even moving focus off the field.
  const onMouseDown = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) event.preventDefault();
  };

  return (
    <dialog
      ref={dialogRef}
      className={leaving ? 'cd-intro cd-intro--leaving' : 'cd-intro'}
      aria-labelledby={titleId}
      aria-describedby={introId}
      onCancel={keepOpen}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
    >
      <div className="cd-intro__panel">
        <div className="cd-intro__content">
          <div className="cd-intro__brand">
            <Mark />
            <Wordmark preview />
          </div>

          <div className="cd-intro__lede">
            <h2 id={titleId} className="cd-intro__title cd-type-intro-title">
              {title}
            </h2>
            <p id={introId} className="cd-intro__text cd-type-body">
              {intro}
            </p>
          </div>

          <div className="cd-intro__things">
            <h3 className="cd-intro__heading cd-type-meta">Things to try</h3>
            <ul role="list" className="cd-intro__list">
              {thingsToTry.map((thing, index) => (
                <li key={`${index}-${thing.title}`} className="cd-intro__thing">
                  {thing.icon ? <Icon name={thing.icon} className="cd-intro__thing-icon" /> : null}
                  <span className="cd-intro__thing-text">
                    <span className="cd-intro__thing-title">{thing.title}</span>
                    {thing.detail ? <span className="cd-intro__thing-detail cd-type-meta">{thing.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="cd-intro__foot">
            <form className="cd-intro__form" aria-busy={starting || undefined} noValidate onSubmit={submit}>
              <label htmlFor={fieldId} className="cd-intro__label cd-type-meta">
                Passcode
              </label>
              <div className="cd-intro__row">
                <input
                  ref={fieldRef}
                  id={fieldId}
                  className="cd-intro__field cd-type-message"
                  type="password"
                  autoComplete="off"
                  placeholder="Enter the passcode"
                  value={passcode}
                  aria-invalid={shownError !== undefined || undefined}
                  aria-describedby={shownError !== undefined ? errorId : undefined}
                  onChange={(event) => setPasscode(event.target.value)}
                />
                <Button variant="primary" size="main" type="submit" disabled={empty} busy={starting}>
                  {submitLabel}
                </Button>
              </div>
              {/* Always on the page and empty until the demo starts, so the change is announced. */}
              <p className="cd-sr-only" role="status">
                {starting ? STARTING_LINE : null}
              </p>
              {shownError !== undefined ? (
                <div id={errorId}>
                  <Notice tone="error">{errorLine(shownError)}</Notice>
                </div>
              ) : null}
            </form>
            <ConceptFooter />
          </div>
        </div>

        <Illustration played={played} onPlayed={() => setPlayed(true)} />
      </div>
    </dialog>
  );
}

interface IllustrationProps {
  /** Its story has played to the end: it rests there and never plays again. */
  played: boolean;
  /** Called as the story ends, when the last receipt has ticked in. */
  onPlayed: () => void;
}

/**
 * The clay half: Dana asks for a visit on Turner's public page, and Claude books it within Mike's
 * rules. Decoration only, so it is `aria-hidden` and holds nothing focusable.
 */
function Illustration({ played, onPlayed }: IllustrationProps) {
  return (
    <div className={played ? 'cd-intro__illustration cd-intro__illustration--played' : 'cd-intro__illustration'} aria-hidden="true">
      <svg className="cd-intro__arcs" width="420" height="600" viewBox="0 0 420 600" fill="none" focusable="false">
        <path d="M-60 150 C 80 60, 260 40, 480 -40" />
        <path d="M-40 640 C 120 520, 300 520, 470 430" />
      </svg>

      <div className="cd-intro__card cd-intro__card--asked">
        <span className="cd-intro__avatar">DW</span>
        <div className="cd-intro__card-body">
          <p className="cd-intro__who cd-type-body">
            Dana Whitfield <span className="cd-intro__where cd-type-caption">on Turner’s public page</span>
          </p>
          <p className="cd-intro__said cd-type-message">My water heater is leaking. Can someone come Tuesday?</p>
        </div>
      </div>

      <div className="cd-intro__card cd-intro__card--answered">
        {/* The mark alone in an avatar's place: no tile and no frame, in its dark ink on the light card. */}
        <Mark size={32} ground="light" />
        <div className="cd-intro__card-body cd-intro__card-body--reply">
          <p className="cd-intro__who cd-type-body">
            Turner Plumbing <span className="cd-intro__where cd-type-caption">Claude, an AI</span>
          </p>
          <p className="cd-intro__reply cd-type-illustration-reply">You’re booked, Dana. Mike will text you when he’s on his way.</p>
          <div className="cd-intro__booked">
            <p className="cd-intro__booked-label cd-type-caption">
              <Icon name="check" size={14} className="cd-intro__check" />
              Booked
            </p>
            <p className="cd-intro__booked-when cd-type-body">Tuesday, November 3</p>
            <p className="cd-intro__booked-with cd-type-meta">2:00 pm to 4:00 pm</p>
            <p className="cd-intro__booked-with cd-type-meta">With Mike Turner</p>
          </div>
          <div className="cd-intro__receipts cd-type-caption">
            <p className="cd-intro__receipt">
              <span className="cd-intro__dot" />
              Reply checked against Mike Turner’s rules
            </p>
            {/* The story ends as this last receipt ticks in. */}
            <p
              className="cd-intro__receipt"
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) onPlayed();
              }}
            >
              <span className="cd-intro__dot" />
              Booked on Mike Turner’s calendar
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
