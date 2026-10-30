import type { ReactNode } from 'react';

import { Spinner } from '../Button/Spinner.tsx';

import './LoadingLine.css';

export interface LoadingLineProps {
  /** What is on its way, in the reader's language: "Loading your customers". */
  children: ReactNode;
}

/**
 * One quiet line while a page or a list loads: the busy spinner, then words that say what is on its
 * way. A `status`, so a screen reader hears the words once; the spinner is drawn only.
 */
export function LoadingLine({ children }: LoadingLineProps) {
  return (
    <p role="status" className="cd-loading-line cd-type-meta">
      <Spinner className="cd-loading-line__spinner" />
      <span className="cd-loading-line__words">{children}</span>
    </p>
  );
}
