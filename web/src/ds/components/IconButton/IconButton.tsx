import type { MouseEvent } from 'react';

import { Icon, type IconName } from '../../icons/index.tsx';

import './IconButton.css';

export interface IconButtonProps {
  /** What the button does, read as its name: "Send", "Add a photo or file". */
  label: string;
  icon: IconName;
  /** `ghost` (the default) or `primary`, the inverted neutral, as on the composer's send button. */
  variant?: 'ghost' | 'primary';
  /** `square` (the default, `radius-control`) or `round`. */
  shape?: 'square' | 'round';
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}

export function IconButton({ label, icon, variant = 'ghost', shape = 'square', onClick, disabled = false }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`cd-icon-button cd-icon-button--${variant} cd-icon-button--${shape}`}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {/* As on the canvas: 18 px in a square ghost button, 16 px on the round send button. */}
      <Icon name={icon} size={shape === 'round' ? 16 : 18} />
    </button>
  );
}
