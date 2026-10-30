import { useId } from 'react';

import type { ToolProfile } from '../../../api/contracts.ts';
import { Button } from '../Button/Button.tsx';
import { useSendOnce } from '../Button/useSendOnce.ts';
import { Card } from '../Card/Card.tsx';
import type { ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { describeEffects } from '../ConnectorSection/describeEffects.ts';
import { Notice } from '../Notice/Notice.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './ToolReviewCard.css';

/** The profile fields the review reads, so a `ToolProfile` and the API's `ToolRow` both fit. */
export type ToolRowView = Pick<
  ToolProfile,
  | 'tool'
  | 'source'
  | 'effects'
  | 'reversible'
  | 'status'
  | 'description_confirmed'
  | 'definition_sha256'
  | 'pending_definition_text'
  | 'pending_sha256'
>;

export interface ToolReviewCardProps {
  /** The tool's name: "Refund". */
  title: string;
  /** The connector whose tool changed. */
  connector: ConnectorView;
  /** The changed tool's profile, while it `needs_review`. */
  profile: ToolRowView;
  /** When the change was noticed, in the screen's words: "Noticed today at 9:14, when the tools were listed again". */
  noticed: string;
  /** Turns it back on, trusting the definition the owner reviewed: called with its `pending_sha256`. */
  onTurnBackOn: (definitionSha256: string) => void;
  /** Keeps it off: called with the same `pending_sha256`. */
  onKeepOff: (definitionSha256: string) => void;
  /** The screen is sending the answer. */
  pending?: boolean;
  /** The screen's message when the answer failed, such as the tool changing again; the answers work again. */
  error?: string;
}

/**
 * The review of a tool that a changed definition switched off: what changed, what the owner
 * confirmed before, and the connector's new definition quoted as literal text. Each answer names the
 * reviewed definition's hash, so the kernel turns on exactly what the owner saw. Without that hash,
 * or without the text to review, nothing can be answered.
 */
export function ToolReviewCard({ title, connector, profile, noticed, onTurnBackOn, onKeepOff, pending = false, error }: ToolReviewCardProps) {
  const ids = useId();
  const quoteLabelId = `${ids}-quote-label`;
  const { pressed, waiting, send } = useSendOnce<'on' | 'off'>(pending, error);
  const failed = error !== undefined && error.trim() !== '';

  const hash = typeof profile.pending_sha256 === 'string' && profile.pending_sha256.trim() !== '' ? profile.pending_sha256 : null;
  // The definition exactly as sent, quoted untouched; text that is empty or only blank space is
  // nothing to review.
  const definition =
    typeof profile.pending_definition_text === 'string' && profile.pending_definition_text.trim() !== '' ? profile.pending_definition_text : null;
  // Fail closed: an answer needs both the reviewed definition and its hash.
  const reviewable = hash !== null && definition !== null;

  const answer = (key: 'on' | 'off', call: (definitionSha256: string) => void) => {
    if (hash === null || definition === null) return;
    send(key, () => call(hash));
  };

  return (
    <Card as="section" label="Needs your review" padding={16}>
      <div className="cd-tool-review" aria-busy={waiting || undefined}>
        <div className="cd-tool-review__top">
          <h2 className="cd-tool-review__status cd-type-meta">
            <StatusDot tone="held" />
            <span>Needs your review</span>
          </h2>
          <p className="cd-tool-review__noticed cd-type-meta">{noticed}</p>
        </div>
        <p className="cd-tool-review__summary cd-type-summary">
          {`${connector.name} changed “${title}”, so it's turned off until you review it. Until you decide, it can't run at all.`}
        </p>
        <div className="cd-tool-review__part">
          <h3 className="cd-tool-review__label cd-type-caption">What you confirmed before</h3>
          <p className="cd-tool-review__confirmed cd-type-body">{profile.description_confirmed}</p>
          <p className="cd-tool-review__effects cd-type-meta">{describeEffects(profile.effects, profile.reversible)}</p>
        </div>
        {definition !== null ? (
          <div className="cd-tool-review__part">
            <h3 className="cd-tool-review__label cd-type-caption">What the connector says now</h3>
            <blockquote className="cd-tool-review__quote" aria-labelledby={quoteLabelId}>
              <p id={quoteLabelId} className="cd-tool-review__quote-label cd-type-caption">
                Quoted from the connector. Claude never sees this text; it sees only the description you confirmed.
              </p>
              {/* The connector's words exactly as sent, as text: never parsed, never markup. */}
              <p className="cd-tool-review__quote-text cd-type-quote" data-copy="user">
                {definition}
              </p>
            </blockquote>
          </div>
        ) : null}
        {reviewable ? (
          <p className="cd-tool-review__trust cd-type-meta">
            Turning it back on trusts the new definition and checks your rules again before it runs.
          </p>
        ) : (
          <Notice tone="info">This change can&apos;t be reviewed right now. Reload the page.</Notice>
        )}
        <div className="cd-tool-review__actions">
          <Button
            variant="primary"
            size="main"
            disabled={!reviewable}
            busy={reviewable && pressed === 'on'}
            waiting={reviewable && waiting && pressed !== 'on'}
            onClick={() => answer('on', onTurnBackOn)}
          >
            Turn back on
          </Button>
          <Button
            variant="secondary"
            size="main"
            disabled={!reviewable}
            busy={reviewable && pressed === 'off'}
            waiting={reviewable && waiting && pressed !== 'off'}
            onClick={() => answer('off', onKeepOff)}
          >
            Keep off
          </Button>
        </div>
        {failed && !waiting ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Card>
  );
}
