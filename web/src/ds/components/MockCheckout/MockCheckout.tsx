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
import { TextLink } from '../TextLink/TextLink.tsx';
import { CHECKOUT_COPY, TEST_CARD, type CheckoutCopy, type FinalPaymentState } from './checkoutCopy.ts';

import './MockCheckout.css';

/** Each final state's dot: handled once paid, held while still being confirmed, info otherwise. */
const FINAL_DOT = {
  paid: 'handled',
  expired: 'info',
  cancelled: 'info',
  unknown: 'held',
} as const satisfies Record<FinalPaymentState, StatusTone>;

/** A public chat's own path, `/d/` and a Desk's slug: the one place the return link goes. */
const CHAT_PATH = /^\/d\/[a-z0-9-]+$/;

/** True for the states with a line of their own: every known state but `issued`. */
function isFinal(state: string): state is FinalPaymentState {
  return Object.hasOwn(FINAL_DOT, state);
}

/**
 * A line under a value or a field. With the lock, it says the test card is filled in: under the
 * customer's name, or under the card when the name is the field to fill.
 */
function Hint({ text, id, lock = false }: { text: string; id?: string; lock?: boolean }) {
  return (
    <p id={id} className="cd-checkout__hint cd-type-caption">
      {lock ? <Icon name="lock" size={14} /> : null}
      {text}
    </p>
  );
}

/** The button whose request is in flight. */
type Pressed = 'pay' | 'cancel';

export interface MockCheckoutProps {
  /** The business taking the payment, shown at the card's top left: "Turner Plumbing". */
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
   * The customer's name, the kernel's `PaymentLinkView.customer_name` for a link from a verified
   * session, shown read-only as the name on the test card. Without it the name is an empty field;
   * what is typed there stays in it and never leaves the page.
   */
  customerName?: string;
  /**
   * The visitor's chat, as its own path (`/d/turner-plumbing`), when the page knows it. Paid and
   * cancelled lines link "Go back to the chat"; expired and rule-change lines link "the chat",
   * in the same tab. Anything but a public chat's path is ignored, and the line keeps its
   * original words with no link.
   */
  chatHref?: string;
  /** A request to pay or cancel is in flight. The pressed button spins; Pay does when none was pressed here. */
  busy?: boolean;
  /** The last request to pay or cancel failed: shows a line that says to reload. */
  error?: boolean;
  /** "Pay {amount}": complete the test payment. Called once until the state changes or a new error shows. */
  onPay: () => void;
  /** "Cancel payment". Called once until the state changes or a new error shows. */
  onCancel: () => void;
}

/**
 * The page a visitor opens from a payment link card: a test checkout in the design system's own
 * look. It shows a test card filled in and locked, sends nothing typed on it anywhere, and says in
 * every state that this is a test payment and that the page is part of a chat with an AI.
 */
export function MockCheckout({
  merchant,
  title,
  amount,
  state,
  cancelReason,
  language,
  customerName,
  chatHref,
  busy = false,
  error = false,
  onPay,
  onCancel,
}: MockCheckoutProps) {
  const copy: CheckoutCopy = CHECKOUT_COPY[language];
  const id = useId();
  const titleId = `${id}-title`;
  const cardLabelId = `${id}-card`;
  const nameLabelId = `${id}-name`;
  const nameFieldId = `${id}-name-field`;
  const nameHintId = `${id}-name-hint`;

  // The button pressed here, until the request ends: the link's state changes, or a new error
  // shows. Clearing an old error, as a screen does when a retry starts, ends nothing. The ref is
  // set in the click itself, so a second click that lands before the screen re-renders sends
  // nothing.
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const sent = useRef(false);
  const release = () => {
    sent.current = false;
    setPressed(null);
  };
  useEffect(release, [state]);
  const hadError = useRef(error);
  useEffect(() => {
    const failed = error && !hadError.current;
    hadError.current = error;
    if (failed) release();
  }, [error]);

  // A name typed on the page stays in this field: it is never passed to a callback.
  const [typedName, setTypedName] = useState('');

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
  // A blank name is no name: the card then asks for one.
  const nameOnCard = customerName?.trim();
  // Each line that sends the visitor to the chat uses the same validated, same-tab link.
  const lineKey = final === 'cancelled' && cancelReason === 'rules_changed' ? 'rules_changed' : final;
  const parts = copy.returnLine[lineKey];
  const back = parts !== undefined && chatHref !== undefined && CHAT_PATH.test(chatHref) ? chatHref : null;
  const finalLine =
    back !== null && parts !== undefined ? (
      <span>
        {parts.before}
        <TextLink href={back} runningText>
          {parts.back}
        </TextLink>
        {parts.after}
      </span>
    ) : lineKey === 'rules_changed' ? (
      copy.cancelledRulesChanged
    ) : (
      copy.final[lineKey]
    );

  // Whether focus is in the checkout, kept from its own focus events. Focus that leaves for
  // another element is out, and so is focus that leaves for nothing while the element it left stays
  // on the page. A focused button that the closing link takes away leaves for nothing too, but it
  // is off the page by the time that is checked, so focus still counts as in; so does focus whose
  // window went to the background, as the element keeps it.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  useEffect(() => {
    const page = rootRef.current;
    if (!page) return;
    const onFocusIn = () => {
      focusInside.current = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node) {
        focusInside.current = page.contains(next);
        return;
      }
      const left = event.target;
      queueMicrotask(() => {
        if (left instanceof Node && left.isConnected && !page.contains(page.ownerDocument.activeElement)) {
          focusInside.current = false;
        }
      });
    };
    page.addEventListener('focusin', onFocusIn);
    page.addEventListener('focusout', onFocusOut);
    return () => {
      page.removeEventListener('focusin', onFocusIn);
      page.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // When the link closes while the page is open, the buttons go with it. If focus was in the
  // checkout, it would fall to the page, so the card's title takes it instead; the result region
  // reads the new line out, so focus doesn't read it a second time. Focus anywhere else, or on
  // nothing when it wasn't in the checkout, stays where it is.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const closedHere = wasOpen.current && !open;
    wasOpen.current = open;
    const page = rootRef.current;
    if (!closedHere || !page) return;
    const active = page.ownerDocument.activeElement;
    const fellToThePage = active === null || active === page.ownerDocument.body;
    if (page.contains(active) || (fellToThePage && focusInside.current)) titleRef.current?.focus();
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
        <h1 ref={titleRef} id={titleId} className="cd-checkout__title cd-type-section" data-copy="user" tabIndex={-1}>
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
                  {/* The lock sits in the number's value, so the list holds only terms and values. */}
                  <dd className="cd-checkout__value cd-checkout__value--number">
                    <span className="cd-checkout__number">{TEST_CARD.number}</span>
                    <Icon name="lock" size={14} className="cd-checkout__lock" />
                  </dd>
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
              {/* With the name to fill, the lock's line moves here, off the one field that isn't filled in. */}
              {nameOnCard ? null : <Hint text={copy.filledIn} lock />}
            </div>
            {nameOnCard ? (
              <div className="cd-checkout__group" role="group" aria-labelledby={nameLabelId}>
                <p id={nameLabelId} className="cd-checkout__label cd-type-meta">
                  {copy.nameOnCard}
                </p>
                {/* The group's label names this one value, so it needs no name of its own. */}
                <p className="cd-checkout__field cd-checkout__field--name cd-type-body">
                  <span className="cd-checkout__value" data-copy="user">
                    {nameOnCard}
                  </span>
                </p>
                <Hint text={copy.filledIn} lock />
              </div>
            ) : (
              <div className="cd-checkout__group">
                <label htmlFor={nameFieldId} className="cd-checkout__label cd-type-meta">
                  {copy.nameOnCard}
                </label>
                {/* No form around it and no callback takes it: what is typed stays here. */}
                <input
                  id={nameFieldId}
                  className="cd-checkout__name-field cd-type-body"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={typedName}
                  aria-describedby={nameHintId}
                  onChange={(event) => setTypedName(event.target.value)}
                />
                <Hint id={nameHintId} text={copy.anyName} />
              </div>
            )}
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
        ) : null}
        {/* The result region is there in every state, so a new line is read out whenever it
            arrives: issued to paid, or still being confirmed to paid. While the link is open it
            is empty and takes no room. */}
        <div
          className={open ? 'cd-sr-only' : 'cd-checkout__result'}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {open ? null : (
            <p className="cd-checkout__state cd-type-body">
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
        </div>
        {error ? <Notice tone="error">{copy.error}</Notice> : null}
        <p className="cd-checkout__footnote cd-type-caption">{copy.testPayment}</p>
      </section>
      <ConceptFooter />
    </div>
  );
}
