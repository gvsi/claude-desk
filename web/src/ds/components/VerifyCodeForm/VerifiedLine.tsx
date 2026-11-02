import type { Ref } from 'react';

import type { Assurance } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { SystemLine } from '../SystemLine/SystemLine.tsx';
import { VERIFY_COPY } from './verifyCopy.ts';

export interface VerifiedLineProps {
  /** What happened, in the visitor's language: "Verified with a code sent to •••• 0142". */
  text: string;
  /** The session's assurance once verified; anything but `owner_session` adds the simulated label. */
  assurance: Assurance;
  /** The visitor's language, for the label and the line's `lang`. */
  language: CopyLanguage;
  /** The line's own element, for a screen that moves focus to it once the code form it replaces goes. */
  lineRef?: Ref<HTMLDivElement>;
}

/** Ends a sentence before the label: with a space after a full stop, else with one. */
function withLabel(text: string, label: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]$/.test(trimmed) ? `${trimmed} ${label}` : `${trimmed}. ${label}`;
}

/**
 * The chat line once a visitor confirms it's them. A code from the Demo inbox shows the code went
 * to the contact on record, not that the visitor holds that contact, so the line also says the
 * verification was simulated. It fails toward saying so: only the owner's own session goes without
 * the label, and every other assurance, `demo_code`, `none` or one this build doesn't know, has it.
 */
export function VerifiedLine({ text, assurance, language, lineRef }: VerifiedLineProps) {
  const line = assurance === 'owner_session' ? text : withLabel(text, VERIFY_COPY[language].simulated);
  return (
    <div ref={lineRef} className="cd-verified-line" lang={language}>
      <SystemLine text={line} />
    </div>
  );
}
