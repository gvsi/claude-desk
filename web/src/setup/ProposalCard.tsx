import { useEffect, useRef, useState } from 'react';
import type { JobKind, JobProposal, ProposalCard as Proposal, SetupProposalBody } from '../api/views.ts';
import { Button, Card, ConnectorIcon, type ConnectorIconName, ConnectorName, Pill, TextField } from '../ds/index.ts';
import { Icon, type IconName } from '../ds/icons/index.tsx';
import { SETUP_COPY } from './copy.ts';
import { decisionBody } from './conversation.ts';

const copy = SETUP_COPY.proposal;
/** Job vocabulary stays local to setup; tiles use the design system's own glyphs. */
const JOB_GLYPH: Record<JobKind, IconName> = {
  schedule: 'calendar', intake: 'person', payment: 'card', status: 'document',
  price: 'quote', documents: 'document', answer: 'conversations', urgent: 'clock',
};
export type CardAction = 'accept' | 'decline';
export interface CardDecision {
  proposal_id: string;
  action: CardAction;
  body: SetupProposalBody;
}
export interface ProposalCardProps {
  proposal: Proposal;
  live: boolean;
  failed: boolean;
  amountRequired: boolean;
  onRetry: () => void;
  disabled: boolean;
  busyAction: CardAction | null;
  onDecision: (decision: CardDecision) => void;
}

function DecisionLine({ accepted, connector = false }: { accepted: boolean; connector?: boolean }) {
  return <p className={`cd-setup-c3__decision cd-type-meta${accepted ? ' cd-setup-c3__decision--accepted' : ''}`}>
    {accepted ? <Icon name="check" size={16} /> : null}
    {accepted ? connector ? copy.connected : copy.setUp : copy.decline}
  </p>;
}

/** The error and retry stay attached to the card and retry its exact decision. */
function FailedDecision({ disabled, onRetry }: Pick<ProposalCardProps, 'disabled' | 'onRetry'>) {
  return <div className="cd-setup-c3__failed cd-setup-c3__indent">
    <p className="cd-setup-c3__error cd-type-meta" role="alert">{copy.failed}</p>
    <div className="cd-setup-c3__actions"><Button variant="secondary" disabled={disabled} onClick={onRetry}>{copy.tryAgain}</Button></div>
  </div>;
}

function ConnectorCard({ proposal, live, disabled, busyAction, failed, onRetry, onDecision }: ProposalCardProps) {
  const connector = proposal.connector!;
  const connected = proposal.state === 'accepted' && connector.connected === true;
  const view = { id: connector.app, name: connector.label, icon: connector.app as ConnectorIconName, description: '', source: { kind: 'external' as const, mock: true as const } };
  const decide = (action: CardAction) => {
    if (disabled || !live || !connector.connectable || proposal.state !== 'proposed') return;
    onDecision({ proposal_id: proposal.proposal_id, action, body: { accept: action === 'accept' } });
  };
  return <Card as="article" label={connector.label} padding={16}>
    <div className={`cd-setup-c3${proposal.state === 'accepted' ? ' cd-setup-c3--set' : ''}${proposal.state === 'declined' ? ' cd-setup-c3--declined' : ''}`}>
      <div className="cd-setup-c3__head">
        <ConnectorIcon icon={view.icon} size="section" {...(connector.app === 'stripe' || connector.app === 'google_calendar' ? {} : { glyph: 'connectors' as const })} />
        <div className="cd-setup-c3__titles">
          <h3 className="cd-setup-c3__title cd-type-body"><ConnectorName connector={view} size="inline" />{!connector.connectable ? <Pill>{copy.later}</Pill> : null}</h3>
          {!connector.connectable || proposal.state === 'proposed' ? <p className="cd-setup-c3__line cd-type-body">{connector.why}</p> : null}
        </div>
        {connected || proposal.state === 'declined' ? <DecisionLine accepted={connected} connector /> : null}
      </div>
      {connector.connectable && live && proposal.state === 'proposed' ? failed ? <FailedDecision disabled={disabled} onRetry={onRetry} /> : <div className="cd-setup-c3__actions cd-setup-c3__indent">
        <Button variant="primary" waiting={disabled && busyAction !== 'accept'} busy={busyAction === 'accept'} onClick={() => decide('accept')}>{copy.connect}</Button>
        <Button variant="ghost" waiting={disabled && busyAction !== 'decline'} busy={busyAction === 'decline'} onClick={() => decide('decline')}>{copy.decline}</Button>
      </div> : null}
    </div>
  </Card>;
}

/** Row sources are deliberately closed: model text supplies Who and Asks, never these fixed claims. */
function jobRows(job: JobProposal): [string, string][] {
  const uses: Partial<Record<JobKind, string>> = copy.uses;
  const next = job.job === 'schedule' ? copy.next.schedule[job.autonomy]
    : job.job === 'intake' ? copy.next.intake : job.job === 'payment' ? copy.next.payment : null;
  return [
    ...(job.who?.trim() ? [[copy.who, job.who] as [string, string]] : []),
    ...(uses[job.job] ? [[copy.usesLabel, uses[job.job]!] as [string, string]] : []),
    ...(job.config?.block === 'intake' ? [[copy.asks, job.config.questions.join(' ')] as [string, string]] : []),
    ...(next ? [[copy.nextLabel, next] as [string, string]] : []),
  ];
}

function JobCard({ proposal, live, disabled, busyAction, failed, amountRequired, onRetry, onDecision }: ProposalCardProps) {
  const job = proposal.job!;
  const payment = job.job === 'payment';
  const initialCents = job.config?.block === 'purpose_payment' ? job.config.amount_cents : null;
  const [amount, setAmount] = useState(initialCents == null ? '' : (initialCents / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  // A press that fails the check moves focus to Amount, so its label and the message are read out every time.
  const amountRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => { if (amountRequired) setError(copy.amountError); }, [amountRequired]);
  const accepted = proposal.state === 'accepted';
  const collapsed = accepted || proposal.state === 'declined';
  const rows = jobRows(job);
  const decide = (action: CardAction) => {
    if (disabled || !live || proposal.state !== 'proposed') return;
    const dollars = amount.trim().replace(/^\$/, '').trim();
    const cents = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(dollars)
      ? Math.round(Number(dollars.replace(/,/g, '')) * 100) : NaN;
    const decision = decisionBody({ action, proposal, ...(payment && action === 'accept' ? { amount_cents: cents } : {}) });
    if (!decision.ok) { setError(copy.amountError); amountRef.current?.focus(); return; }
    onDecision({ proposal_id: proposal.proposal_id, action, body: decision.body });
  };
  return <Card as="article" label={job.title} padding={16}>
    <div className={`cd-setup-c3${accepted ? ' cd-setup-c3--set' : ''}${proposal.state === 'declined' ? ' cd-setup-c3--declined' : ''}`}>
      <div className="cd-setup-c3__head">
        <ConnectorIcon icon="quotes" glyph={JOB_GLYPH[job.job]} size="section" />
        <div className="cd-setup-c3__titles">
          <h3 className="cd-setup-c3__title cd-type-body">{job.title}{!job.can_do_today && proposal.state === 'proposed' ? <Pill>{copy.later}</Pill> : null}</h3>
          {!collapsed ? <p className="cd-setup-c3__line cd-type-body">{job.how}</p> : null}
        </div>
        {proposal.state === 'accepted' || proposal.state === 'declined' ? <DecisionLine accepted={accepted} /> : null}
      </div>
      {!collapsed && rows.length ? <dl className="cd-setup-c3__rows">
        {rows.map(([label, value]) => <div className="cd-setup-c3__row" key={label}><dt className="cd-type-meta">{label}</dt><dd className="cd-type-body">{value}</dd></div>)}
      </dl> : null}
      {payment && proposal.state === 'proposed' ? <div className="cd-setup-c3__amount cd-setup-c3__indent">
        <TextField label={copy.amount} value={amount} onChange={(value) => { setAmount(value); setError(null); }} hint={copy.amountHint} readOnly={disabled || !live || failed} fieldRef={amountRef} {...(error ? { error } : {})} />
      </div> : null}
      {live && proposal.state === 'proposed' ? failed ? <FailedDecision disabled={disabled} onRetry={onRetry} /> : <div className="cd-setup-c3__actions cd-setup-c3__indent">
        {/* Pressed with no amount, it says why under Amount and sends nothing (`decisionBody`). */}
        <Button variant="primary" waiting={disabled && busyAction !== 'accept'} busy={busyAction === 'accept'} onClick={() => decide('accept')}>{copy.setItUp}</Button>
        <Button variant="ghost" waiting={disabled && busyAction !== 'decline'} busy={busyAction === 'decline'} onClick={() => decide('decline')}>{copy.decline}</Button>
      </div> : null}
    </div>
  </Card>;
}

/** Proposals stay in the transcript; changed versions become a quiet reference to the new card. */
export function ProposalCard(props: ProposalCardProps) {
  const { proposal } = props;
  if (proposal.state === 'changed') return <p className="cd-setup-superseded cd-type-meta">
    <Icon name="history" size={16} /><span className="cd-setup-superseded__title">{proposal.job?.title ?? proposal.connector?.label}</span><span>{copy.changed}</span>
  </p>;
  if (proposal.kind === 'connector' && proposal.connector) return <ConnectorCard {...props} />;
  if (proposal.kind === 'job' && proposal.job) return <JobCard {...props} />;
  return null;
}
