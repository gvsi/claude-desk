import { useRef, type KeyboardEvent } from 'react';

import './SegmentedControl.css';

export interface SegmentedOption<T extends string> {
  value: T;
  /** The option in words: "Attempts", "Every entry". */
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  /** What is being chosen, read as the group's name: "Mode for this Desk". */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  /** Called with the newly chosen value; the control shows whatever `value` the screen passes back. */
  onChange: (value: T) => void;
}

/** Where each key moves from option `i` of `n`, wrapping at both ends; null for other keys. */
function target(key: string, i: number, n: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (i + 1) % n;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (i - 1 + n) % n;
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    default:
      return null;
  }
}

/**
 * One choice out of a few, as a radio group on a faint track: one tab stop (the chosen option), and
 * the arrow keys move to the next option and choose it.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex((option) => option.value === value);
  // With no option chosen, the first one is the group's tab stop.
  const tabStop = chosen === -1 ? 0 : chosen;

  const choose = (option: SegmentedOption<T>) => {
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = target(event.key, i, options.length);
    const option = next === null ? undefined : options[next];
    if (next === null || option === undefined) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    choose(option);
  };

  return (
    <div role="radiogroup" aria-label={label} className="cd-segmented">
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          className="cd-segmented__option cd-type-meta"
          onClick={() => choose(option)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
