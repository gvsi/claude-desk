import type { MouseEvent, ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';

import './Chip.css';

export interface ChipProps {
  /** The suggestion or option, in words. */
  children: ReactNode;
  /** Chosen: announced as `aria-checked` (with `asRadio`) or `aria-pressed`, and drawn with a check. */
  selected?: boolean;
  /** One option of a `role="radiogroup"` the consumer renders around the chips. */
  asRadio?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function Chip({ children, selected, asRadio = false, onClick }: ChipProps) {
  const isSelected = selected === true;
  // A suggestion chip has no state; a toggle says whether it is pressed; a radio whether it is checked.
  const state = asRadio
    ? { role: 'radio', 'aria-checked': isSelected }
    : selected === undefined
      ? {}
      : { 'aria-pressed': isSelected };
  return (
    <button
      type="button"
      className={`cd-chip cd-type-pill${isSelected ? ' cd-chip--selected' : ''}`}
      onClick={onClick}
      {...state}
    >
      {/* Chosen is shown by a check as well as the fill, never by the fill alone. */}
      {isSelected ? <Icon name="check" size={14} className="cd-chip__check" /> : null}
      {children}
    </button>
  );
}
