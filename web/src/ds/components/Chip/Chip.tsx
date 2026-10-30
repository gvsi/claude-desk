import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';

import './Chip.css';

export interface ChipProps {
  /** The suggestion or option, in words. */
  children: ReactNode;
  /** Chosen: announced as `aria-checked` (with `asRadio`) or `aria-pressed`, and drawn with a check. */
  selected?: boolean;
  /**
   * One option of a `role="radiogroup"` the consumer renders around the chips. The group then has
   * one tab stop, the chosen chip (or the first while none is), and the arrows move and choose.
   */
  asRadio?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** The radio chips of the group `chip` is in, in order; just the chip itself outside a group. */
function radiosOf(chip: HTMLButtonElement): HTMLButtonElement[] {
  const group = chip.closest('[role="radiogroup"]');
  if (group === null) return [chip];
  return [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((radio) => !radio.disabled);
}

/** How far each arrow moves through the group: Right and Down to the next, Left and Up back. */
const ARROW_STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The radio group's keyboard (WAI-ARIA radio group): an arrow moves to the next or previous chip,
 * wrapping at the ends, Home to the first and End to the last, and the chip it lands on is chosen.
 */
function onRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
  const radios = radiosOf(event.currentTarget);
  const at = radios.indexOf(event.currentTarget);
  const step = ARROW_STEPS[event.key];
  const next =
    event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1 : step === undefined ? null : (at + step + radios.length) % radios.length;
  const target = next === null ? undefined : radios[next];
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
  if (target.getAttribute('aria-checked') !== 'true') target.click();
}

export function Chip({ children, selected, asRadio = false, onClick }: ChipProps) {
  const isSelected = selected === true;
  const ref = useRef<HTMLButtonElement>(null);
  // While no chip in its group is chosen, the first one is the group's tab stop.
  const [leads, setLeads] = useState(false);
  useLayoutEffect(() => {
    const chip = ref.current;
    if (!asRadio || chip === null) return;
    const radios = radiosOf(chip);
    setLeads(radios[0] === chip && !radios.some((radio) => radio.getAttribute('aria-checked') === 'true'));
  });
  // A suggestion chip has no state; a toggle says whether it is pressed; a radio whether it is checked.
  const state = asRadio
    ? { role: 'radio', 'aria-checked': isSelected, tabIndex: isSelected || leads ? 0 : -1, onKeyDown: onRadioKeyDown }
    : selected === undefined
      ? {}
      : { 'aria-pressed': isSelected };
  return (
    <button
      ref={ref}
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
