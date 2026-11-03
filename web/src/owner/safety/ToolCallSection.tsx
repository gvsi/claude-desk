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
  const card = rules?.cards.find((candidate) => ids.includes(candidate.card_id) && candidate.applies_to === call.tool && candidate.mode === 'auto');
  const namedRule = card !== undefined && rules !== null;
  const approved = summary.outcome === 'approve' && card === undefined;
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
      {(namedRule || approved) ? (
        <div className="cd-tool-call__rule" role="group" aria-labelledby={ruleLabelId}>
          <p id={ruleLabelId} className="cd-attempt__label cd-type-caption">{approved ? 'You allowed it' : 'The rule that allowed it'}</p>
          {card !== undefined && rules !== null && meta !== null ? (
            <RuleSentence parts={ruleSentence(card, rules.words)} meta={meta} outcome="auto" />
          ) : <p className="cd-type-meta"><StatusLabel tone="handled">Allow</StatusLabel></p>}
        </div>
      ) : null}
    </div>
  );
}
