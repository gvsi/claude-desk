import { useState } from 'react';

import { Chip } from '../Chip/Chip.tsx';
import { VisionInertLine } from '../VisionBar/visionInert.tsx';

import './SuggestionChips.css';

/** The most suggestions a row shows. */
const MAX_SUGGESTIONS = 3;

export interface SuggestionChipsProps {
  /** The group's name, read by screen readers: "Suggestions". */
  label: string;
  /** Things to ask, in the person's words. Only the first three show. */
  suggestions: readonly string[];
  /** Called with the picked suggestion's words. */
  onPick: (suggestion: string) => void;
  /**
   * Vision pages only, which make no requests: the chips keep their look, focus and tab order, but
   * picking one does nothing (`onPick` is never called), and the first pick shows the vision line
   * under them. Never on a real page.
   */
  inertSuggestions?: boolean;
}

/** A row of at most three suggestion chips, each a thing to ask, handed to the screen when picked. */
export function SuggestionChips({ label, suggestions, onPick, inertSuggestions = false }: SuggestionChipsProps) {
  const [inertPressed, setInertPressed] = useState(false);
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
      {suggestions.slice(0, MAX_SUGGESTIONS).map((suggestion) => (
        <Chip key={suggestion} onClick={() => pick(suggestion)}>
          {suggestion}
        </Chip>
      ))}
    </div>
  );
  if (!inertSuggestions) return group;
  return (
    <>
      {group}
      <VisionInertLine shown={inertPressed} />
    </>
  );
}
