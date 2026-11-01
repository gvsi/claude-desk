import { useEffect, useRef, useState } from 'react';

import { Chip } from '../Chip/Chip.tsx';
import { VisionInertLine } from '../VisionBar/visionInert.tsx';

import './SuggestionChips.css';

export interface SuggestionChipsProps {
  /** The group's name, read by screen readers: "Suggestions". */
  label: string;
  /** Things to ask, in the person's words. At most `max` show (three by default). */
  suggestions: readonly string[];
  /** The most suggestions shown, three by default. Only setup's start step raises it, to four starters. */
  max?: number;
  /** Called with the picked suggestion's words. */
  onPick: (suggestion: string) => void;
  /**
   * Vision pages only, which make no requests: the chips keep their look, focus and tab order, but
   * picking one does nothing (`onPick` is never called), and the first pick shows the vision line
   * under them. Never on a real page.
   */
  inertSuggestions?: boolean;
  /**
   * Every chip off, while what a pick would change can't change: setup's examples while a start is
   * being settled. They stay in place, dimmed, and `onPick` is never called.
   */
  disabled?: boolean;
}

/** A row of at most `max` suggestion chips (three by default), handed to the screen when picked. */
export function SuggestionChips({ label, suggestions, max = 3, onPick, inertSuggestions = false, disabled = false }: SuggestionChipsProps) {
  const [inertPressed, setInertPressed] = useState(false);
  const lineRef = useRef<HTMLParagraphElement>(null);
  // The chips can end a scroll region, as they end the conversation on a public page, so the line
  // the first pick shows under them could land out of view. Once it shows, it is brought into the
  // nearest scroller's view; the focus stays on the chip.
  useEffect(() => {
    if (inertPressed) lineRef.current?.scrollIntoView({ block: 'nearest' });
  }, [inertPressed]);
  const pick = (suggestion: string) => {
    // A vision page's suggestions: the pick goes nowhere, and says so once.
    if (inertSuggestions) {
      setInertPressed(true);
      return;
    }
    onPick(suggestion);
  };
  const group = (
    <div role="group" aria-label={label} className="cd-suggestion-chips">
      {suggestions.slice(0, max).map((suggestion) => (
        <Chip key={suggestion} disabled={disabled} onClick={() => pick(suggestion)}>
          {suggestion}
        </Chip>
      ))}
    </div>
  );
  if (!inertSuggestions) return group;
  return (
    <>
      {group}
      <VisionInertLine ref={lineRef} shown={inertPressed} />
    </>
  );
}
