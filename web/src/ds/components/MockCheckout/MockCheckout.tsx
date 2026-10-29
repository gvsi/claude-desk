import { useEffect, useId, useRef, useState } from 'react';

import type { PaymentLinkState } from '../../../api/contracts.ts';
import { Icon } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { ConceptFooter } from '../ConceptFooter/ConceptFooter.tsx';
import { DisclosureLine } from '../DisclosureLine/DisclosureLine.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Notice } from '../Notice/Notice.tsx';
import { Pill } from '../Pill/Pill.tsx';
import { StatusDot, type StatusTone } from '../StatusDot/StatusDot.tsx';
import { CHECKOUT_COPY, TEST_CARD, type FinalPaymentState } from './checkoutCopy.ts';

import './MockCheckout.css';

/** Each final state's dot: handled once paid, held while still being confirmed, info otherwise. */
const FINAL_DOT = {
  paid: 'handled',
  expired: 'info',
  cancelled: 'info',
  unknown: 'held',
} as const satisfies Record<FinalPaymentState, StatusTone>;

/** True for the states with a line of their own: every known state but `issued`. */
function isFinal(state: string): state is FinalPaymentState {
  return Object.hasOwn(FINAL_DOT, state);
}

/** The button whose request is in flight. */
type Pressed = 'pay' | 'cancel';

export interface MockCheckoutProps {
  /** The business taking the payment, shown at the card's top left: "Rivera Plumbing". */
  merchant: string;
  /** What the payment is for: the link's own title (`PaymentLinkView.title`). */
  title: string;
  /** The amount, exactly as the page shows it, made from `PaymentLinkView.amount_cents`. */
  amount: string;
  /** The link's state (`PaymentLinkView.state`). Only `issued` can be paid. */
  state: PaymentLinkState;
  /** `rules_changed` when a change to the business's rules cancelled the link (`PaymentLinkView.cancel_reason`). */
  cancelReason?: 'rules_changed';
  /** The link's language (`PaymentLinkView.language`). */
  language: CopyLanguage;
  /**
   * The name on the test card. The page opens for anyone who holds the link, so pass a name only
   * when the link's own view carries one; without it the card reads "Test customer".
   */
  cardName?: string;
  /** A request to pay or cancel is in flight. The pressed button spins; Pay does when none was pressed here. */
  busy?: boolean;
  /** The last request to pay or cancel failed: shows a line that says to reload. */
  error?: boolean;
  /** "Pay {amount}": complete the test payment. Called once until the state changes or an error shows. */
  onPay: () => void;
  /** "Cancel payment". Called once until the state changes or an error shows. */
  onCancel: () => void;
}

/**
 * The page a visitor opens from a payment link card: a test checkout in the design system's own
 * look. It shows a test card filled in and locked, so it collects nothing, and says in every state
 * that this is a test payment and that the page is part of a chat with an AI.
 */
export function MockCheckout({
  merchant,
  title,
  amount,
  state,
  cancelReason,
  language,
  cardName,
  busy = false,
  error = false,
  onPay,
  onCancel,
}: MockCheckoutProps) {
  const copy = CHECKOUT_COPY[language];
  const id = useId();
  const titleId = `${id}-title`;
  const cardLabelId = `${id}-card`;
  const nameLabelId = `${id}-name`;

  // The button pressed here, until the link's state changes or an error shows. The ref is set in
  // the click itself, so a second click that lands before the screen re-renders sends nothing.
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const sent = useRef(false);
  useEffect(() => {
    sent.current = false;
    setPressed(null);
  }, [state, error]);

  const press = (which: Pressed) => {
    if (sent.current || busy) return;
    sent.current = true;
    setPressed(which);
    if (which === 'pay') onPay();
    else onCancel();
  };

  // Only `issued` can be paid. Any other state, one this build doesn't know included, shows its
  // line and no buttons.
  const open = state === 'issued';
  const inFlight: Pressed | null = pressed ?? (busy ? 'pay' : null);
  // A state this build doesn't know reads as still being confirmed: the chat has the result.
  const final: FinalPaymentState = isFinal(state) ? state : 'unknown';
  // A blank name is no name: the test card then carries its own.
  const nameOnCard = cardName?.trim();
  const finalLine = final === 'cancelled' && cancelReason === 'rules_changed' ? copy.cancelledRulesChanged : copy.final[final];

  // When the link closes while the page is open, the buttons go with it. If focus was on one of
  // them, it would fall to the page, so the line that says what happened takes it instead and is
  // read out. Focus anywhere else on the page stays where it is.
  const rootRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const closedHere = wasOpen.current && !open;
    wasOpen.current = open;
    const page = rootRef.current;
    if (!closedHere || !page) return;
    const active = page.ownerDocument.activeElement;
    if (active === null || active === page.ownerDocument.body || page.contains(active)) lineRef.current?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className="cd-checkout" lang={language}>
      <DisclosureLine language={language} />
      <section className="cd-checkout__card" aria-labelledby={titleId}>
        <div className="cd-checkout__top">
          <span className="cd-checkout__merchant cd-type-meta" data-copy="user">
            {merchant}
          </span>
          <Pill>
            <StatusDot tone="held" />
            {copy.testMode}
          </Pill>
        </div>
        <h1 id={titleId} className="cd-checkout__title cd-type-section" data-copy="user">
          {title}
        </h1>
        {open ? (
          <>
            <div className="cd-checkout__amount">
              <p className="cd-checkout__amount-value cd-type-amount">{amount}</p>
              <p className="cd-checkout__once cd-type-meta">{copy.worksOnce}</p>
            </div>
            <div className="cd-checkout__group" role="group" aria-labelledby={cardLabelId}>
              <p id={cardLabelId} className="cd-checkout__label cd-type-meta">
                {copy.cardInformation}
              </p>
              <dl className="cd-checkout__card-fields cd-type-body">
                <div className="cd-checkout__field cd-checkout__field--number">
                  <dt className="cd-sr-only">{copy.cardNumber}</dt>
                  <dd className="cd-checkout__value">{TEST_CARD.number}</dd>
                  <Icon name="lock" size={14} className="cd-checkout__lock" />
                </div>
                <div className="cd-checkout__field">
                  <dt className="cd-sr-only">{copy.expiry}</dt>
                  <dd className="cd-checkout__value">{TEST_CARD.expiry}</dd>
                </div>
                <div className="cd-checkout__field">
                  <dt className="cd-sr-only">{copy.securityCode}</dt>
                  <dd className="cd-checkout__value">{TEST_CARD.securityCode}</dd>
                </div>
              </dl>
            </div>
            <div className="cd-checkout__group" role="group" aria-labelledby={nameLabelId}>
              <p id={nameLabelId} className="cd-checkout__label cd-type-meta">
                {copy.nameOnCard}
              </p>
              {/* The group's label names this one value, so it needs no name of its own. */}
              <p className="cd-checkout__field cd-checkout__field--name cd-type-body">
                <span className="cd-checkout__value" data-copy={nameOnCard ? 'user' : undefined}>
                  {nameOnCard || copy.testName}
                </span>
              </p>
              <p className="cd-checkout__hint cd-type-caption">
                <Icon name="lock" size={14} />
                {copy.filledIn}
              </p>
            </div>
            <div className="cd-checkout__actions">
              <Button
                variant="primary"
                size="main"
                busy={inFlight === 'pay'}
                waiting={inFlight === 'cancel'}
                onClick={() => press('pay')}
              >
                {copy.pay(amount)}
              </Button>
              <Button
                variant="secondary"
                size="main"
                busy={inFlight === 'cancel'}
                waiting={inFlight === 'pay'}
                onClick={() => press('cancel')}
              >
                {copy.cancel}
              </Button>
            </div>
          </>
        ) : (
          <p ref={lineRef} className="cd-checkout__state cd-type-body" tabIndex={-1}>
            <span className="cd-checkout__state-mark">
              <StatusDot tone={FINAL_DOT[final]} />
            </span>
            <span className="cd-checkout__state-words">
              {final === 'paid' ? (
                <span className="cd-checkout__state-mark">
                  <Icon name="check" size={14} className="cd-checkout__check" />
                </span>
              ) : null}
              {finalLine}
            </span>
          </p>
        )}
        {error ? <Notice tone="error">{copy.error}</Notice> : null}
        <p className="cd-checkout__footnote cd-type-caption">{copy.testPayment}</p>
      </section>
      <ConceptFooter />
    </div>
  );
}
