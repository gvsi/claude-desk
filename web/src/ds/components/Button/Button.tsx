import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';

import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';

export interface ButtonProps {
  /**
   * `primary` (inverted neutral, at most one per view), `secondary` or `ghost`; `danger` (a soft red
   * fill) and `danger-ghost` (red words only) only for answers that refuse, such as "Deny this time".
   */
  variant: ButtonVariant;
  /** `inline` is `size-control` tall (the default); `main` is `size-control-main`, a screen's main action. */
  size?: 'inline' | 'main';
  /** The button's `type`; `button` unless it submits a form. */
  type?: 'button' | 'submit' | 'reset';
  /** Renders a link with the same look, opened with `rel="noopener noreferrer"`. */
  href?: string;
  disabled?: boolean;
  /** Waiting for the result of a click: announced with `aria-busy`, and further clicks do nothing. */
  busy?: boolean;
  /**
   * Makes it a menu button: a chevron after the words, `aria-haspopup="menu"`, and `aria-expanded`
   * from this value. The screen draws the menu and moves focus into it. Leave it out for a plain button.
   */
  menuOpen?: boolean;
  /** The button's `id`, for a menu or a description that points back at it. */
  id?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  /** Keys pressed on the button, such as the arrow keys that open its menu. Not on a link. */
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** What happens, in words: "Allow this time", "Open payment page". */
  children: ReactNode;
}

export function Button({
  variant,
  size = 'inline',
  type = 'button',
  href,
  disabled = false,
  busy = false,
  menuOpen,
  id,
  onClick,
  onKeyDown,
  children,
}: ButtonProps) {
  const opensMenu = menuOpen !== undefined;
  const className = `cd-button cd-button--${variant} cd-button--${size}${opensMenu ? ' cd-button--menu' : ''} cd-type-control`;
  // Busy keeps focus where it is (aria-disabled, not disabled), so a keyboard user isn't dropped
  // to the top of the page mid-request; the handler below swallows the click instead.
  const inert = disabled || busy;
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
        rel="noopener noreferrer"
        role={inert ? 'link' : undefined}
        aria-disabled={inert || undefined}
        aria-busy={busy || undefined}
        onClick={handleClick}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      id={id}
      className={className}
      type={type}
      disabled={disabled}
      aria-haspopup={opensMenu ? 'menu' : undefined}
      aria-expanded={opensMenu ? menuOpen : undefined}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={handleClick}
      onKeyDown={onKeyDown}
    >
      {children}
      {opensMenu ? <Icon name="chevron-down" size={16} className="cd-button__chevron" /> : null}
    </button>
  );
}
