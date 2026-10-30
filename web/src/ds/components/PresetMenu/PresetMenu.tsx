import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { Button } from '../Button/Button.tsx';
import { PRESET_WORDS, type RulesPreset } from '../OutcomeMenu/outcomeWords.ts';

import './PresetMenu.css';

export interface PresetMenuProps {
  /** The owner picked a preset: the screen drafts it and opens its review. Called once per pick. */
  onPick: (preset: RulesPreset) => void;
  /** The picked preset's draft is in flight: the button keeps its label under the busy spinner, and the menu stays shut. */
  pending?: boolean;
}

/** The open menu: where focus lands, which opening it is, and a key that may still be down. */
interface Opening {
  focus: 'first' | 'last';
  at: number;
  heldKey: 'Enter' | null;
}

const LABEL = 'Start from a preset';

/**
 * "Start from a preset": a menu button for the Rules page's header that offers the two presets,
 * each with what it does. Picking one only asks the screen to draft it; the review shows the
 * change before anything applies. Nothing in it is selected: the Desk's rules are its own.
 */
export function PresetMenu({ onPick, pending = false }: PresetMenuProps) {
  const ids = useId();
  const buttonId = `${ids}-button`;
  const [open, setOpen] = useState<Opening | null>(null);
  const openings = useRef(0);

  if (open !== null && pending) setOpen(null);

  const openMenu = (focus: Opening['focus'], heldKey: Opening['heldKey'] = null) => {
    if (pending) return;
    openings.current += 1;
    setOpen({ focus, at: openings.current, heldKey });
  };
  const closeMenu = () => setOpen(null);
  const choose = (preset: RulesPreset) => {
    if (open === null || pending) return;
    closeMenu();
    onPick(preset);
  };

  // Enter opens or closes the menu as it goes down, so the menu knows that key may still be held;
  // Down and Up open it on its first or last item; Escape closes it and leaves focus on the button.
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (pending) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.repeat) return;
      if (open !== null) closeMenu();
      else openMenu('first', 'Enter');
      return;
    }
    if (event.key === 'Escape' && open !== null) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  // Focus that leaves the button and its menu for anything else on the page closes the menu.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next !== null && !event.currentTarget.contains(next)) closeMenu();
  };

  return (
    <div className="cd-preset-menu" onBlur={onBlur}>
      <Button
        id={buttonId}
        variant="secondary"
        size="main"
        busy={pending}
        menuOpen={open !== null}
        onClick={() => (open !== null ? closeMenu() : openMenu('first'))}
        onKeyDown={onButtonKey}
      >
        {LABEL}
      </Button>
      {open !== null ? <PresetItems id={`${ids}-menu`} labelledBy={buttonId} opening={open} onChoose={choose} onClose={closeMenu} /> : null}
    </div>
  );
}

interface PresetItemsProps {
  id: string;
  labelledBy: string;
  opening: Opening;
  onChoose: (preset: RulesPreset) => void;
  onClose: () => void;
}

/**
 * The presets as `menuitem`s under the button, each named by its title and described by its line.
 * Down and Up move and wrap, Home and End jump, Enter, Space or a click chooses, and Escape or Tab
 * closes it with focus back on the button. A press outside closes it and leaves focus where it went.
 */
function PresetItems({ id, labelledBy, opening, onChoose, onClose }: PresetItemsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef(opening.heldKey);
  const close = useRef(onClose);
  close.current = onClose;

  // Each opening moves focus in, and notes the key that opened it.
  useLayoutEffect(() => {
    held.current = opening.heldKey;
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    items[opening.focus === 'first' ? 0 : items.length - 1]?.focus();
  }, [opening]);

  // However it closes, focus that was in it goes back to its button while the menu is still on
  // the page, so it never falls to the page itself.
  useLayoutEffect(() => {
    const menu = ref.current;
    return () => {
      const doc = menu?.ownerDocument;
      if (menu && doc && menu.contains(doc.activeElement)) doc.getElementById(labelledBy)?.focus();
    };
  }, [labelledBy]);

  // A press outside the menu and its button closes it.
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return undefined;
    const doc = menu.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || doc.getElementById(labelledBy)?.contains(target))) return;
      close.current();
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    return () => doc.removeEventListener('pointerdown', onPointerDown, true);
  }, [labelledBy]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A held Enter or Space, or the Enter that opened the menu before it comes up, never chooses.
    if ((event.key === 'Enter' || event.key === ' ') && (event.repeat || event.key === held.current)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
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
      className="cd-preset-menu__menu"
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === held.current) held.current = null;
      }}
    >
      {PRESET_WORDS.map((preset) => (
        // Named by its title alone; its line is its description, read once, after the name.
        <button
          key={preset.value}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-describedby={`${id}-${preset.value}-line`}
          className="cd-preset-menu__item"
          onClick={() => onChoose(preset.value)}
        >
          <span className="cd-preset-menu__title cd-type-control">{preset.label}</span>
          <span id={`${id}-${preset.value}-line`} aria-hidden="true" className="cd-preset-menu__line cd-type-caption">
            {preset.description}
          </span>
        </button>
      ))}
    </div>
  );
}
