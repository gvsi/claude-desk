import type { Assurance } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { SystemLine } from '../SystemLine/SystemLine.tsx';
import { VERIFY_COPY } from './verifyCopy.ts';

export interface VerifiedLineProps {
  /** What happened, in the visitor's language: "Verified with a code sent to •••• 0142". */
  text: string;
  /** The session's assurance once verified; `demo_code` adds the simulated label. */
  assurance: Assurance;
  /** The visitor's language, for the label and the line's `lang`. */
  language: CopyLanguage;
}

/** Ends a sentence before the label: with a space after a full stop, else with one. */
function withLabel(text: string, label: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]$/.test(trimmed) ? `${trimmed} ${label}` : `${trimmed}. ${label}`;
}

/**
 * The chat line once a visitor confirms it's them. A code from the Demo inbox shows the code went
 * to the contact on record, not that the visitor holds that contact, so with assurance `demo_code`
 * the line also says the verification was simulated.
 */
export function VerifiedLine({ text, assurance, language }: VerifiedLineProps) {
  const line = assurance === 'demo_code' ? withLabel(text, VERIFY_COPY[language].simulated) : text;
  return (
    <div className="cd-verified-line" lang={language}>
      <SystemLine text={line} />
    </div>
  );
}
