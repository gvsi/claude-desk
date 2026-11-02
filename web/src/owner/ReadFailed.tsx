import { Button, Notice } from '../ds/index.ts';
import type { ReadFailure } from './useReadFailure.ts';

/** The latest read failed: what went wrong and the way to read it again, said over what was read before. */
export function ReadFailed({ failure }: { failure: ReadFailure | null }) {
  if (failure === null) return null;
  return (
    <Notice
      tone="error"
      action={
        <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
          Try again
        </Button>
      }
    >
      {failure.line}
    </Notice>
  );
}
