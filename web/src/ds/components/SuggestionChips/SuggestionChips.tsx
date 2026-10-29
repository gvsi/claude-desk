import { Chip } from '../Chip/Chip.tsx';

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
}

/** A row of at most three suggestion chips, each a thing to ask, handed to the screen when picked. */
export function SuggestionChips({ label, suggestions, onPick }: SuggestionChipsProps) {
  return (
    <div role="group" aria-label={label} className="cd-suggestion-chips">
      {suggestions.slice(0, MAX_SUGGESTIONS).map((suggestion) => (
        <Chip key={suggestion} onClick={() => onPick(suggestion)}>
          {suggestion}
        </Chip>
      ))}
    </div>
  );
}
