import { useEffect, useState } from 'react';
import type { JobKind, ProposalCard as Proposal, SetupProposalBody } from '../api/views.ts';
import {
  Button,
  Card,
  Chip,
  ConnectorIcon,
  type ConnectorIconName,
  ConnectorName,
  ConnectorOfferCard,
  OUTCOME_GROUP_WORDS,
  OUTCOME_WORDS,
  Pill,
  StatusDot,
  TextField,
} from '../ds/index.ts';
import { Icon, type IconName } from '../ds/icons/index.tsx';
import { SETUP_COPY } from './copy.ts';
import { decisionBody } from './conversation.ts';

const copy = SETUP_COPY.proposal;
/** Job vocabulary stays local to setup; tiles use the design system's own glyphs. */
const JOB_GLYPH: Record<JobKind, IconName> = {
  schedule: 'calendar',
  intake: 'person',
  payment: 'card',
  status: 'document',
  price: 'quote',
  documents: 'document',
  answer: 'conversations',
  urgent: 'clock',
};
export type CardAction = 'accept' | 'decline' | 'change';
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

function DecisionLine({ state }: { state: Proposal['state'] }) {
  if (state === 'proposed') return null;
  return (
    <p className={`cd-setup-job__decision cd-setup-job__decision--${state} cd-type-meta`}>
      {state === 'accepted' ? <Icon name="check" size={16} /> : null}
      {state === 'accepted' ? copy.accepted : copy.decline}
    </p>
  );
}

/** A proposal is a transcript item, with actions only while it is the current question. */
export function ProposalCard({ proposal, live, disabled, busyAction, failed, amountRequired, onRetry, onDecision }: ProposalCardProps) {
  const { job, connector } = proposal;
  const [accepting, setAccepting] = useState(false);
  const payment = job?.config?.block === 'purpose_payment' ? job.config : null;
  const [amount, setAmount] = useState(payment?.amount_cents == null ? '' : (payment.amount_cents / 100).toFixed(2));
  const [changing, setChanging] = useState(false);
  const [name, setName] = useState(job?.title ?? '');
  const [autonomy, setAutonomy] = useState(job?.autonomy ?? 'ask');
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<'title' | 'amount_cents' | 'autonomy' | null>(null);
  useEffect(() => {
    if (amountRequired) {
      setAccepting(true);
      setErrorField('amount_cents');
      setError(copy.amountError);
    }
  }, [amountRequired]);
  const editing = live && !failed && (changing || accepting);
  const connectorView = connector
    ? {
        id: connector.app,
        name: connector.label,
        icon: connector.app as ConnectorIconName,
        description: '',
        source: { kind: 'external' as const, mock: true as const },
      }
    : null;
  if (connector && !connector.connectable && connectorView)
    return <ConnectorOfferCard connector={connectorView} toolsLine={connector.why} action="coming_soon" onReview={() => {}} />;
  const title = job ? (
    changing && editing ? (
      name
    ) : (
      job.title
    )
  ) : proposal.state === 'proposed' ? (
    copy.connect(connector!.label)
  ) : (
    <ConnectorName connector={connectorView!} size="inline" />
  );
  const config = job?.config;
  const detail =
    config?.block === 'typed_booking'
      ? { label: copy.appointment, value: `${config.appointment_type}, ${config.minutes} ${copy.minutes}` }
      : config?.block === 'intake'
        ? {
            label: copy.questions,
            value: (
              <ol className="cd-setup-job__questions">
                {config.questions.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ol>
            ),
          }
        : config?.block === 'purpose_payment'
          ? {
              label: copy.payment,
              value:
                config.amount_cents === null
                  ? copy.unpriced(config.purpose)
                  : `${config.purpose}, ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(config.amount_cents / 100)}`,
            }
          : config?.block === 'urgent'
            ? { label: copy.urgent, value: config.urgent_when }
            : null;
  const decide = (action: CardAction) => {
    if (disabled) return;
    if (action === 'accept' && payment?.amount_cents === null && !editing) {
      setAccepting(true);
      return;
    }
    if (action !== 'decline' && payment && editing && amount.trim() === '') {
      setErrorField('amount_cents');
      setError(copy.amountError);
      return;
    }
    const cents = /^\d+(?:\.\d{1,2})?$/.test(amount.trim()) ? Math.round(Number(amount) * 100) : NaN;
    const decision = decisionBody({
      action,
      proposal,
      ...(action === 'change' ? { title: name, autonomy } : {}),
      ...(payment && editing && action !== 'decline' ? { amount_cents: cents } : {}),
    });
    if (!decision.ok) {
      setErrorField(decision.field);
      setError(decision.field === 'amount_cents' && decision.code === 'amount_required' ? copy.amountError : decision.message);
      return;
    }
    onDecision({ proposal_id: proposal.proposal_id, action, body: decision.body });
  };
  return (
    <Card as="article" label={job?.title ?? connector!.label} padding={16}>
      <div className={`cd-setup-job${proposal.state === 'declined' ? ' cd-setup-job--declined' : ''}`}>
        <div className="cd-setup-job__identity">
          {job ? (
            <ConnectorIcon icon="quotes" glyph={JOB_GLYPH[job.job]} size="section" />
          ) : (
            <ConnectorIcon icon={connectorView!.icon} size="section" />
          )}
          <div className="cd-setup-job__text">
            <h3 className="cd-setup-job__title cd-type-body">
              {title}
              {job && !job.can_do_today ? <Pill>{copy.later}</Pill> : null}
            </h3>
            <p className="cd-setup-job__why cd-type-meta">{job?.why ?? connector!.why}</p>
          </div>
        </div>
        {job ? (
          <p className="cd-setup-job__how cd-type-body">{job.how}</p>
        ) : proposal.state === 'accepted' ? (
          <p className="cd-setup-job__how cd-type-meta">{copy.connected}</p>
        ) : null}
        {!editing && detail ? (
          <div className="cd-setup-job__detail cd-type-meta">
            <span className="cd-setup-job__detail-label">{detail.label}</span>
            <div className="cd-setup-job__detail-value">{detail.value}</div>
          </div>
        ) : null}
        {!editing && job?.can_do_today ? (
          <p className="cd-setup-job__autonomy cd-type-meta">
            <StatusDot tone={job.autonomy === 'auto' ? 'handled' : 'held'} />
            {OUTCOME_GROUP_WORDS[job.autonomy]}
          </p>
        ) : null}
        {live && failed ? (
          <div className="cd-setup-job__failed">
            <p className="cd-setup-job__failed-line cd-type-meta" role="alert">
              {copy.failed}
            </p>
            <Button variant="secondary" disabled={disabled} onClick={onRetry}>
              {copy.tryAgain}
            </Button>
          </div>
        ) : editing ? (
          <div className="cd-setup-job__edit">
            {changing ? (
              <TextField
                label={copy.name}
                value={name}
                onChange={setName}
                maxLength={60}
                hint={copy.nameHint}
                readOnly={disabled}
                {...(errorField === 'title' && error ? { error } : {})}
              />
            ) : null}
            {payment ? (
              <TextField
                label={copy.amount}
                value={amount}
                onChange={setAmount}
                hint={copy.amountHint}
                readOnly={disabled}
                {...(errorField === 'amount_cents' && error ? { error } : {})}
              />
            ) : null}
            {changing ? (
              <fieldset className="cd-setup-job__autonomy-choice">
                <legend className="cd-type-control">{copy.outcome}</legend>
                <div role="radiogroup" aria-label={copy.outcome} className="cd-setup-job__chips">
                  {(['auto', 'ask'] as const).map((value) => (
                    <Chip key={value} asRadio selected={autonomy === value} disabled={disabled} onClick={() => setAutonomy(value)}>
                      {OUTCOME_WORDS[value]}
                    </Chip>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <div className="cd-setup-job__actions">
              <Button
                variant="primary"
                busy={busyAction === (changing ? 'change' : 'accept')}
                disabled={disabled}
                onClick={() => decide(changing ? 'change' : 'accept')}
              >
                {changing ? copy.save : copy.accept}
              </Button>
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  setChanging(false);
                  setAccepting(false);
                  setName(job?.title ?? '');
                  setAutonomy(job?.autonomy ?? 'ask');
                  setAmount(payment?.amount_cents == null ? '' : (payment.amount_cents / 100).toFixed(2));
                  setError(null);
                  setErrorField(null);
                }}
              >
                {copy.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <div className="cd-setup-job__end">
            <DecisionLine state={proposal.state} />
            {live ? (
              <div className="cd-setup-job__actions">
                <Button variant="primary" busy={busyAction === 'accept'} disabled={disabled} onClick={() => decide('accept')}>
                  {copy.accept}
                </Button>
                {job ? (
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => {
                      setName(job.title);
                      setAutonomy(job.autonomy);
                      setChanging(true);
                    }}
                  >
                    {copy.change}
                  </Button>
                ) : null}
                <Button variant="ghost" busy={busyAction === 'decline'} disabled={disabled} onClick={() => decide('decline')}>
                  {copy.decline}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Card>
  );
}
