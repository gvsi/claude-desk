import type { MouseEvent, ReactNode } from 'react';

import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps {
  /** `primary` (inverted neutral, at most one per view), `secondary` or `ghost`. */
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
  onClick?: (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  /** What happens, in words: "Allow this time", "Open payment page". */
  children: ReactNode;
}

export function Button({ variant, size = 'inline', type = 'button', href, disabled = false, busy = false, onClick, children }: ButtonProps) {
  const className = `cd-button cd-button--${variant} cd-button--${size} cd-type-control`;
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
      className={className}
      type={type}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={handleClick}
    >
      {children}
    </button>
  );
}
