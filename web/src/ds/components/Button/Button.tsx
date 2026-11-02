import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react';

import { Icon } from '../../icons/index.tsx';
import { Spinner } from './Spinner.tsx';

import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';

/**
 * A spinner in place of the label while busy, drawn only: the label still names the button. A
 * faint ring with a quarter arc on it, both in the busy label color, turned by the stylesheet.
 */
const BUSY_SPINNER = <Spinner className="cd-button__spinner" />;

interface ButtonBaseProps {
  /**
   * `primary` (inverted neutral, at most one per view), `secondary` or `ghost`; `danger` (a soft red
   * fill) for refusals ("Deny this time") and deletes that cannot be undone ("Delete this Desk",
   * "Delete Desk"); `danger-ghost` (red words only) for quieter refusals. The owner decision of
   * 2026-11-02 replaces the earlier neutral-delete rule.
   */
  variant: ButtonVariant;
  /** `inline` is `size-control` tall (the default); `main` is `size-control-main`, a screen's main action. */
  size?: 'inline' | 'main';
  /** The button's `type`; `button` unless it submits a form. */
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  /**
   * Waiting for the result of a click: a small spinner in the busy colors takes the label's place,
   * at the same width, the label still names it with `aria-busy`, and further clicks do nothing.
   */
  busy?: boolean;
  /**
   * Waiting while another button's request is in flight, such as the answer a held request's owner
   * didn't choose: the busy colors without the spinner, its words still shown, and clicks do nothing.
   */
  waiting?: boolean;
  /** The element's `id`, for a menu or a description that points back at it. */
  id?: string;
  /** The `id` of the words that tell this button apart from others named alike (`aria-describedby`). */
  describedBy?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  /** What happens, in words: "Allow this time", "Open payment page". */
  children: ReactNode;
}

/** A button, which may open a menu. */
interface ButtonAsButton extends ButtonBaseProps {
  href?: undefined;
  external?: undefined;
  /**
   * Makes it a menu button: a chevron after the words, `aria-haspopup="menu"`, and `aria-expanded`
   * from this value. The screen draws the menu and moves focus into it. Leave it out for a plain button.
   */
  menuOpen?: boolean;
  /** Keys pressed on the button, such as the arrow keys that open its menu. */
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /**
   * The `<button>`, for a screen that has to know about it: React lets go of it (a callback gets
   * `null`) before the button leaves the page, so whether it had focus can still be read then.
   */
  buttonRef?: Ref<HTMLButtonElement>;
}

/** A link with a button's look. It never opens a menu. */
interface ButtonAsLink extends ButtonBaseProps {
  /** Renders a link with the same look, opened with `rel="noopener noreferrer"`. */
  href: string;
  /** Opens the link in a new tab (`target="_blank"`), as `TextLink`'s `external` does. */
  external?: boolean;
  menuOpen?: undefined;
  onKeyDown?: undefined;
  buttonRef?: undefined;
}

export type ButtonProps = ButtonAsButton | ButtonAsLink;

export function Button({
  variant,
  size = 'inline',
  type = 'button',
  href,
  external = false,
  disabled = false,
  busy = false,
  waiting = false,
  menuOpen,
  id,
  describedBy,
  onClick,
  onKeyDown,
  buttonRef,
  children,
}: ButtonProps) {
  // A busy button is the one in flight; only the others wait.
  const waitingClass = waiting && !busy ? ' cd-button--waiting' : '';
  const className = `cd-button cd-button--${variant} cd-button--${size} cd-type-control${waitingClass}`;
  // Busy and waiting keep focus where it is (aria-disabled, not disabled), so a keyboard user isn't
  // dropped to the top of the page mid-request; the handler below swallows the click instead.
  const inert = disabled || busy || waiting;
  const handleClick = (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (inert) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  if (href !== undefined) {
    // A link can't be disabled, so an inert one loses its href and says it is disabled.
    return (
      <a
        id={id}
        className={className}
        href={inert ? undefined : href}
        target={external && !inert ? '_blank' : undefined}
        rel="noopener noreferrer"
        role={inert ? 'link' : undefined}
        aria-describedby={describedBy}
        aria-disabled={inert || undefined}
        aria-busy={busy || undefined}
        onClick={handleClick}
      >
        <span className="cd-button__label">{children}</span>
        {busy ? BUSY_SPINNER : null}
      </a>
    );
  }

  // Only a button opens a menu.
  const opensMenu = menuOpen !== undefined;
  return (
    <button
      ref={buttonRef}
      id={id}
      className={opensMenu ? `${className} cd-button--menu` : className}
      type={type}
      disabled={disabled}
      aria-haspopup={opensMenu ? 'menu' : undefined}
      aria-expanded={opensMenu ? menuOpen : undefined}
      aria-describedby={describedBy}
      aria-disabled={busy || waiting || undefined}
      aria-busy={busy || undefined}
      onClick={handleClick}
      onKeyDown={onKeyDown}
    >
      <span className="cd-button__label">{children}</span>
      {opensMenu ? <Icon name="chevron-down" size={16} className="cd-button__chevron" /> : null}
      {busy ? BUSY_SPINNER : null}
    </button>
  );
}
