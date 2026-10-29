import './CountPill.css';

export interface CountPillProps {
  /** The number shown. */
  count: number;
  /** What the number means, read instead of it: "2 need you", "2 blocked". */
  label: string;
}

export function CountPill({ count, label }: CountPillProps) {
  // role="img" makes the label the pill's name: a screen reader says "2 need you", not "2".
  return (
    <span className="cd-count-pill cd-type-count" role="img" aria-label={label}>
      {count}
    </span>
  );
}
