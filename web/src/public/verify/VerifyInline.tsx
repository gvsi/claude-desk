/**
 * Under the latest message with the kernel's verify card: the design system's code form until the
 * visitor confirms it's them, then the verified line in its place, which says the verification was
 * simulated. The card above carries the kernel's message, so nothing here repeats it. The code goes
 * only to the verify route (`VisitorChat.verify`), never into the chat.
 */
import type { Assurance } from '../../api/contracts.ts';
import { Notice, UNREACHABLE_COPY, VerifiedLine, VerifyCodeForm, type CopyLanguage } from '../../ds/index.ts';
import { PUBLIC_COPY } from '../copy.ts';
import type { VerifyStatus } from '../PublicChatProvider.tsx';

import './VerifyInline.css';

export interface VerifyInlineProps {
  status: VerifyStatus;
  /** The session as the kernel last answered: verified, and how. */
  verified: boolean;
  assurance: Assurance;
  /** Page chrome's language: the browser's. */
  language: CopyLanguage;
  onSubmit: (code: string) => void;
  /** "I can't get the code": the visitor asks for the owner, as the page's own button does. */
  onAskForOwner: () => void;
  /** A reply is on its way: "I can't get the code" waits, as Send does. */
  askWaits?: boolean;
}

export function VerifyInline({ status, verified, assurance, language, onSubmit, onAskForOwner, askWaits = false }: VerifyInlineProps) {
  if (verified) return <VerifiedLine text={PUBLIC_COPY[language].verified} assurance={assurance} language={language} />;
  // A failed code is the form's own line; no answer at all is the page's.
  const state = status === 'checking' || status === 'failed' ? status : 'idle';
  return (
    <div className="cd-verify-inline">
      <VerifyCodeForm state={state} onSubmit={onSubmit} onAskForOwner={onAskForOwner} askWaits={askWaits} language={language} />
      {status === 'unreachable' ? <Notice tone="error">{UNREACHABLE_COPY[language]}</Notice> : null}
    </div>
  );
}
