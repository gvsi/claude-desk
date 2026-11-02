import { useId, useRef, useState, type Ref } from 'react';

import type { LedgerPage } from '../../api/contracts.ts';
import type { Attempt } from '../../api/views.ts';
import { Card, CheckpointMeter, FullTrace, Icon, OWNER_STATE_WORDS, RuleSentence, StatusLabel, TextLink } from '../../ds/index.ts';
import { formatWhen } from '../../lib/format.ts';
import { NO_BUSINESS_TOOLS } from '../connectors/catalog.ts';
import { conversationPath } from '../conversations/status.ts';
import { ReadFailed } from '../ReadFailed.tsx';
import { turnedDownRule } from '../rules/requestRule.ts';
import type { RequestRules } from '../rules/useRequestRules.ts';
import type { ReadFailure } from '../useReadFailure.ts';
import { REPLAYED_LABEL, attemptTime, categoryLabel, entryFor, originCopy, replayedOf, stoppedBy, triageOf } from './copy.ts';
import { focusTrace, useSideBySide } from './focusTrace.ts';

export interface AttemptDetailProps {
  attempt: Attempt;
  /** The record, once read: the attempt's entry, its chain's check and the session it names come from it. */
  page: LedgerPage | undefined;
  /** `Health.dev_signing_key`, for the trace. */
  devKey: boolean;
  deskId: string;
  /** The business's time zone, which the time is read in. */
  timezone: string;
  /** The active rules, once read (`useRequestRules`), which name the owner's rule that turned a request down. */
  rules: RequestRules | null;
  /** The rules' latest read failed: said in the rule's place for a request the owner's own rule turned down. */
  rulesFailure: ReadFailure | null;
}

/** The label over the rule that turned a request down. */
const TURNED_DOWN_BY = 'The rule that turned it down';

/** What the stop itself means, and only for the stopped item: earlier actions in the chat keep their own receipts. */
const CLAIMS: Record<Attempt['kind'], string | null> = {
  refused: "This action didn't run.",
  reply_blocked: 'This reply was never shown.',
  // A held request may still be allowed, so it claims nothing.
  held: null,
};

interface ToggleProps {
  label: string;
  open: boolean;
  /** The part it shows or hides. */
  controls: string;
  onToggle: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}

/** A button that shows or hides the part under it, its chevron pointing down while it is open. */
function Toggle({ label, open, controls, onToggle, buttonRef }: ToggleProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="cd-attempt__toggle cd-type-control"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Icon name="chevron-down" size={16} className="cd-attempt__chevron" />
      {label}
    </button>
  );
}

/**
 * One attempt open beside the list, in tiers: what was stopped and why, in plain words, where its
 * entry came from and when; for a request turned down by a rule the page can name (`turnedDownRule`),
 * that rule in a box of its own, as REV-RULES-B5 draws it; for a refused request, the visitor's words
 * that made it, quoted; Claude's summary, labelled as written by Claude; then, on request, the
 * checkpoints it went through and the signed entry it is kept in; and its conversation.
 */
export function AttemptDetail({ attempt, page, devKey, deskId, timezone, rules, rulesFailure }: AttemptDetailProps) {
  const [showHow, setShowHow] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const traceButton = useRef<HTMLButtonElement>(null);
  const traceBox = useRef<HTMLDivElement>(null);
  const howId = useId();
  const traceId = useId();
  // Beside the list the card scrolls inside itself, so Tab reaches it (Safety.css).
  const scrollsItself = useSideBySide();

  const entry = entryFor(attempt, page);
  const triage = triageOf(attempt);
  const held = attempt.kind === 'held';
  const claim = CLAIMS[attempt.kind] ?? null;
  const replayed = entry !== null && replayedOf(entry) !== null;
  const sessionId = entry?.event.session_id ?? null;
  // An always-on rule needs no read of the rules; the owner's own Never rule does.
  const rule = turnedDownRule(attempt, rules?.cards ?? [], rules?.words ?? { business: NO_BUSINESS_TOOLS });
  const ruleUnread = rule === null && attempt.kind === 'refused' && attempt.cause === 'owner_rule' && rules === null;
  const ruleLabelId = useId();

  const toggleTrace = () => {
    const opening = !showTrace;
    setShowTrace(opening);
    if (opening) requestAnimationFrame(() => focusTrace(traceBox.current));
  };
  const closeTrace = () => {
    setShowTrace(false);
    traceButton.current?.focus();
  };

  /** The signed entry the attempt is kept in, or why it can't be shown yet. */
  const trace =
    entry !== null ? (
      <FullTrace
        entry={entry}
        chain={page ? { chain_ok: page.chain_ok, first_bad_seq: page.first_bad_seq } : null}
        devKey={devKey}
        onClose={closeTrace}
      />
    ) : (
      <p className="cd-attempt__missing cd-type-meta" role="status">
        This entry isn't in the record yet. Try again in a moment.
      </p>
    );

  return (
    <Card as="section" label="Details" tabIndex={scrollsItself ? 0 : undefined}>
      <div className="cd-attempt">
        <p className="cd-attempt__status cd-type-meta">
          {/* The owner's words for what the kernel decided, as the receipt in the conversation names it. */}
          <StatusLabel tone={held ? 'held' : 'refused'}>{OWNER_STATE_WORDS[held ? 'held' : 'refused']}</StatusLabel>
          <span className="cd-attempt__category">{categoryLabel(attempt)}</span>
          <span className="cd-attempt__when">{formatWhen(attemptTime(attempt, page), timezone, new Date())}</span>
        </p>
        <div className="cd-attempt__what">
          <p className="cd-attempt__reason cd-type-summary">{attempt.reason_plain}</p>
          {claim !== null ? <p className="cd-attempt__claim cd-type-body">{claim}</p> : null}
          <p className="cd-attempt__origin cd-type-caption">{originCopy(attempt.origin)}</p>
          {replayed ? <p className="cd-attempt__origin cd-type-caption">{REPLAYED_LABEL}</p> : null}
        </div>
        {rule !== null ? (
          <div role="group" aria-labelledby={ruleLabelId} className="cd-attempt__rule">
            <p id={ruleLabelId} className="cd-attempt__rule-label cd-type-caption">
              {TURNED_DOWN_BY}
            </p>
            <RuleSentence parts={rule.parts} meta={rule.meta} outcome={rule.outcome} />
          </div>
        ) : ruleUnread ? (
          <ReadFailed failure={rulesFailure} />
        ) : null}
        {/* The visitor's own untrusted words that made the request, from the chat, not the signed
            record: a part of their own, labelled as Claude's summary below is, and text only. An
            agent's words are labelled the same. An older API sends no field at all, so any
            missing or empty value shows nothing. */}
        {attempt.from_the_visitor ? (
          <div className="cd-attempt__part">
            <p className="cd-attempt__label cd-type-caption">From the visitor</p>
            <p className="cd-attempt__visitor cd-type-body">
              “<span data-copy="user">{attempt.from_the_visitor}</span>”
            </p>
          </div>
        ) : null}
        {triage !== null ? (
          <div className="cd-attempt__part">
            <p className="cd-attempt__label cd-type-caption">Summary written by Claude</p>
            <p className="cd-attempt__summary cd-type-body">{triage.summary}</p>
          </div>
        ) : null}
        <div className="cd-attempt__part">
          <Toggle label="See how it was stopped" open={showHow} controls={howId} onToggle={() => setShowHow((open) => !open)} />
          <div id={howId} className="cd-attempt__more" hidden={!showHow}>
            {showHow ? <CheckpointMeter stoppedBy={stoppedBy(attempt)} /> : null}
          </div>
          <Toggle buttonRef={traceButton} label="Full trace" open={showTrace} controls={traceId} onToggle={toggleTrace} />
          <div id={traceId} ref={traceBox} className="cd-attempt__more cd-attempt__more--trace" hidden={!showTrace}>
            {showTrace ? trace : null}
          </div>
        </div>
        {sessionId !== null ? (
          <p className="cd-attempt__conversation cd-type-meta">
            <TextLink href={conversationPath(deskId, sessionId)}>Open conversation</TextLink>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
