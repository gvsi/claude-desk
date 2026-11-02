import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';

import { Icon } from '../../icons/index.tsx';
import { StatusDot, StatusLabel } from '../StatusDot/StatusDot.tsx';
import { OUTCOME_TONE, OUTCOME_WORDS, outcomePhrase, type RuleMode } from './outcomeWords.ts';

import './OutcomeMenu.css';

/** The menu's items, in order. */
const MODES = ['auto', 'ask', 'never'] as const satisfies readonly RuleMode[];

export interface OutcomeMenuProps {
  /** What the outcome is for, read in the button's name: the rule's reason. */
  label: string;
  /** The outcome the screen shows: the active card's mode. */
  value: RuleMode;
  /**
   * For an auto card with an amount limit, the screen's formatted amount ("$300"). No longer shown:
   * the outcome is its word alone, and the limit lives in the rule's sentence (`ruleSentence`).
   */
  limit?: string;
  /**
   * Makes the outcome a menu. Called once with the outcome the owner picked, when it differs from
   * `value`; the button keeps showing `value` until the screen passes a new one, since a change
   * applies only after its review. Without it, the outcome is words and a dot.
   */
  onChange?: (mode: RuleMode) => void;
  disabled?: boolean;
}

/** The menu that is open: where focus lands, which opening it is, and a key that may still be down. */
interface Opening {
  focus: 'first' | 'last';
  at: number;
  heldKey: 'Enter' | null;
}

/** The one outcome menu open on the page: opening another closes it. */
let pageMenu: { close: () => void } | null = null;

/**
 * A rule's outcome: its dot and its word ("Allow", "Ask me first" or "Never"). With `onChange` it is a menu
 * button that offers the three outcomes; the owner's pick goes to the screen, which drafts the
 * change and shows it in `ChangeReview` before anything applies.
 */
export function OutcomeMenu({ label, value, onChange, disabled = false }: OutcomeMenuProps) {
  const phrase = outcomePhrase(value);
  const tone = OUTCOME_TONE[value];
  const ids = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<Opening | null>(null);
  const openings = useRef(0);

  if (open !== null && (disabled || onChange === undefined)) setOpen(null);

  if (onChange === undefined) {
    return (
      <span className="cd-outcome cd-type-meta">
        <StatusLabel tone={tone}>{phrase}</StatusLabel>
      </span>
    );
  }

  const openMenu = (focus: Opening['focus'], heldKey: Opening['heldKey'] = null) => {
    openings.current += 1;
    setOpen({ focus, at: openings.current, heldKey });
  };
  // Closing from inside the menu gives focus back to the button before the menu goes, so it never
  // falls to the page.
  const closeMenu = (returnFocus: boolean) => {
    if (returnFocus) buttonRef.current?.focus();
    setOpen(null);
  };
  const choose = (mode: RuleMode) => {
    closeMenu(true);
    if (mode !== value) onChange(mode);
  };

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.repeat) return;
      if (open !== null) closeMenu(false);
      else openMenu('first', 'Enter');
      return;
    }
    if (event.key === 'Escape' && open !== null) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  // Focus that leaves the button and its menu for anything else on the page closes the menu.
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    if (next !== null && !event.currentTarget.contains(next)) setOpen(null);
  };

  const menuId = `${ids}-menu`;
  return (
    <span className="cd-outcome-menu" onBlur={onBlur}>
      <button
        ref={buttonRef}
        id={`${ids}-button`}
        type="button"
        className="cd-outcome-menu__button cd-type-control"
        aria-label={`${phrase}. Change the outcome of: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open !== null ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open !== null ? closeMenu(false) : openMenu('first'))}
        onKeyDown={onButtonKey}
      >
        <StatusDot tone={tone} />
        <span className="cd-outcome-menu__phrase">{phrase}</span>
        <Icon name="chevron-down" size={16} className="cd-outcome-menu__chevron" />
      </button>
      {open !== null ? (
        <OutcomeItems
          id={menuId}
          labelledBy={`${ids}-button`}
          value={value}
          opening={open}
          buttonRef={buttonRef}
          onChoose={choose}
          onClose={closeMenu}
        />
      ) : null}
    </span>
  );
}

interface OutcomeItemsProps {
  id: string;
  labelledBy: string;
  value: RuleMode;
  opening: Opening;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onChoose: (mode: RuleMode) => void;
  onClose: (returnFocus: boolean) => void;
}

/**
 * The three outcomes as `menuitemradio`s under the button, the current one checked. Down and Up
 * move and wrap, Home and End jump, Enter, Space or a click chooses, and Escape or Tab closes it
 * with focus back on the button. A press outside closes it and leaves focus where it went.
 */
function OutcomeItems({ id, labelledBy, value, opening, buttonRef, onChoose, onClose }: OutcomeItemsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef(opening.heldKey);
  const close = useRef(onClose);
  close.current = onClose;

  // Each opening moves focus in, and notes the key that opened it.
  useLayoutEffect(() => {
    held.current = opening.heldKey;
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    if (!items || items.length === 0) return;
    items[opening.focus === 'first' ? 0 : items.length - 1]?.focus();
  }, [opening]);

  // One outcome menu on the page.
  useLayoutEffect(() => {
    const self = { close: () => close.current(false) };
    pageMenu?.close();
    pageMenu = self;
    return () => {
      if (pageMenu === self) pageMenu = null;
    };
  }, []);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return undefined;
    const doc = menu.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || buttonRef.current?.contains(target))) return;
      close.current(false);
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    return () => doc.removeEventListener('pointerdown', onPointerDown, true);
  }, [buttonRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A held Enter or Space, or the Enter that opened the menu before it comes up, never chooses.
    if ((event.key === 'Enter' || event.key === ' ') && (event.repeat || event.key === held.current)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const index = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index <= 0 ? items.length - 1 : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-labelledby={labelledBy}
      className="cd-outcome-menu__menu"
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === held.current) held.current = null;
      }}
    >
      {MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="menuitemradio"
          aria-checked={mode === value}
          tabIndex={-1}
          className="cd-outcome-menu__item cd-type-control"
          onClick={() => onChoose(mode)}
        >
          <span className="cd-outcome-menu__check">{mode === value ? <Icon name="check" size={16} /> : null}</span>
          {OUTCOME_WORDS[mode]}
        </button>
      ))}
    </div>
  );
}
