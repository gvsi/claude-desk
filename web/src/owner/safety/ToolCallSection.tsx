import { useId } from 'react';

import type { LedgerEntry } from '../../api/contracts.ts';
import { RuleSentence, StatusLabel, type StatusTone } from '../../ds/index.ts';
import { ruleMeta, ruleSentence } from '../rules/ruleSentence.ts';
import type { RequestRules } from '../rules/useRequestRules.ts';
import type { ToolCall } from './toolCall.ts';

import './ToolCallSection.css';

/** Only the recorded execution state names the result; an unfamiliar state claims no result. */
const OUTCOMES: Readonly<Record<string, { text: string; tone: StatusTone }>> = {
  executed: { text: 'Ran', tone: 'handled' },
  failed: { text: "Didn't run", tone: 'refused' },
  expired: { text: "Didn't run", tone: 'refused' },
  refused_at_execution: { text: 'Stopped at the last check', tone: 'refused' },
  unknown: { text: 'Result unknown', tone: 'held' },
};

/** The loaded decision's tool and allowing rule, above the execution's untouched signed fields. */
export function ToolCallSection({ call, entry, rules }: { call: ToolCall; entry: LedgerEntry; rules: RequestRules | null }) {
  const labelId = useId();
  const ruleLabelId = useId();
  const summary = call.decision.event.summary;
  const ids = Array.isArray(summary.card_ids) ? summary.card_ids : [];
  const approved = call.approved;
  // Only the version the decision ran under explains it: an edited card keeps its ID, so a newer
  // version's sentence (a lowered limit, say) never stands in for the rule that allowed this call.
  const sameVersion = rules !== null && rules.version != null && call.policyVersion === rules.version;
  const card = approved || !sameVersion ? undefined : rules?.cards.find((candidate) => ids.includes(candidate.card_id)
    && candidate.applies_to === call.tool && candidate.mode === 'auto');
  const namedRule = card !== undefined && rules !== null;
  const meta = card !== undefined && rules !== null ? ruleMeta(card, rules.words) : null;
  if (meta !== null && summary.reviewed === true) meta.who += ' · Checked by the reviewer';
  const state = entry.event.summary.state;
  const outcome = typeof state === 'string' && Object.hasOwn(OUTCOMES, state) ? OUTCOMES[state]! : OUTCOMES.unknown!;

  return (
    <div className="cd-tool-call" role="group" aria-labelledby={labelId}>
      <p id={labelId} className="cd-attempt__label cd-type-caption">Tool call</p>
      <dl className="cd-full-trace__fields">
        <div className="cd-full-trace__field">
          <dt className="cd-full-trace__label cd-type-caption">Tool</dt>
          <dd className={`cd-full-trace__value ${call.mono ? 'cd-type-trace' : 'cd-type-body'}`} data-copy="user">{call.name}</dd>
        </div>
        <div className="cd-full-trace__field">
          <dt className="cd-full-trace__label cd-type-caption">Source</dt>
          <dd className="cd-full-trace__value cd-type-body">{call.source}</dd>
        </div>
        <div className="cd-full-trace__field">
          <dt className="cd-full-trace__label cd-type-caption">Outcome</dt>
          <dd className="cd-full-trace__value cd-type-body"><StatusLabel tone={outcome.tone}>{outcome.text}</StatusLabel></dd>
        </div>
      </dl>
      {namedRule && meta !== null ? (
        <div className="cd-tool-call__rule" role="group" aria-labelledby={ruleLabelId}>
          <p id={ruleLabelId} className="cd-attempt__label cd-type-caption">The rule that allowed it</p>
          <RuleSentence parts={ruleSentence(card!, rules!.words)} meta={meta} outcome="auto" />
        </div>
      ) : approved ? (
        // The owner's own yes, said once: a handled dot and the words, with no rule outcome beside them.
        <p className="cd-tool-call__approved cd-type-body"><StatusLabel tone="handled">You allowed it</StatusLabel></p>
      ) : null}
    </div>
  );
}
