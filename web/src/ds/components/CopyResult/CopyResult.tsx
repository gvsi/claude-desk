export interface CopyResultProps {
  /** The line from `copyResultLine`, empty before a press or after a newer copy elsewhere. */
  result: string;
  /** A fresh key from `useCopyText` for each completed press, even when the words repeat. */
  announcement: number;
  /** The control's result-line styles. */
  className?: string;
}

/** A copy control's persistent live region, with fresh contents for each announcement. */
export function CopyResult({ result, announcement, className }: CopyResultProps) {
  return (
    <p role="status" className={className}>
      {result === '' ? null : <span key={announcement}>{result}</span>}
    </p>
  );
}
