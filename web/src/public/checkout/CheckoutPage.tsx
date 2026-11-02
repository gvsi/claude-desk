/**
 * `/pay/:token`: the mock checkout a visitor opens from a payment link card. The page reads the
 * link and shows it in the design system's `MockCheckout`, in the link's own language: the AI
 * disclosure, the test-payment label, the amount written from the kernel's `amount_cents` (the one
 * amount a visitor page writes itself) and Pay or Cancel. Every other word is the kernel's or the
 * design system's.
 *
 * Pay and cancel are writes. A refusal that says the link's state (a 409) shows that state, so a
 * link a rule change cancelled says so; an answer that was lost may have been applied, so the page
 * reads the link again before it says the request didn't go through. The token in the address is
 * the only credential: the page sends nothing typed on it.
 *
 * Once paid or cancelled by the visitor, "Go back to the chat" links to their chat in the same tab, when
 * this browser's public chat noted it showing this link (`payChats.ts`): only that token's entry,
 * and only a public chat's own path. Otherwise the line has no link.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import type { PaymentLinkState } from '../../api/contracts.ts';
import { ApiError, isUncertain, request } from '../../api/http.ts';
import type { CancelReason, PaymentLinkOut } from '../../api/views.ts';
import { Button, ConceptFooter, DisclosureLine, MockCheckout, Notice, UNREACHABLE_COPY, type CopyLanguage } from '../../ds/index.ts';
import { formatMoneyExact } from '../../lib/format.ts';
import { browserLanguage } from '../../lib/language.ts';
import { payChatFor } from '../../lib/payChats.ts';
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { useDocumentLanguage } from '../useDocumentLanguage.ts';

import './CheckoutPage.css';

/** The page's own words before a link is read, in the browser's language. */
const PAGE_COPY = {
  en: {
    opening: 'Opening the payment page',
    notFound: "This payment link doesn't exist. Ask in the chat for a new one.",
    tryAgain: 'Try again',
  },
  es: {
    opening: 'Abriendo la página de pago',
    notFound: 'Este enlace de pago no existe. Pide uno nuevo en el chat.',
    tryAgain: 'Intentar de nuevo',
  },
} as const satisfies Record<CopyLanguage, Record<string, string>>;

type Load = { kind: 'loading' } | { kind: 'not_found' } | { kind: 'unavailable' } | { kind: 'ready'; link: PaymentLinkOut };

/**
 * The link in the state an answer reported, with its reason when a rule change cancelled it. The
 * customer's name goes once the link closes, as the kernel's view drops it.
 */
function withState(link: PaymentLinkOut, state: PaymentLinkState, cancelReason: CancelReason | null): PaymentLinkOut {
  return { ...link, state, cancel_reason: cancelReason, customer_name: state === 'issued' ? link.customer_name : null };
}

export function CheckoutPage() {
  const { token = '' } = useParams();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // The page's words before a link shows follow the browser; a link's follow the link.
  const [browser] = useState(browserLanguage);
  useDocumentLanguage(load.kind === 'ready' ? load.link.language : browser);
  // The tab says what the payment is for, as the card's title does, then the business as the card
  // names it, when the kernel sends it. Before a link shows, the app's own name stays.
  const shown = load.kind === 'ready' ? load.link : null;
  useDocumentTitle(shown === null ? null : shown.business_name ? `${shown.title} · ${shown.business_name}` : shown.title);
  // The chat this link's card was shown in, as this browser noted it: the checkout's way back.
  const chat = useMemo(() => payChatFor(token), [token]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Set while a pay or cancel is out, so a second press before the page re-renders sends nothing.
  const inFlight = useRef(false);

  const read = useCallback(async (): Promise<Load> => {
    try {
      return { kind: 'ready', link: await request('paymentLink', { params: { token } }) };
    } catch (err) {
      return { kind: err instanceof ApiError && err.kind === 'not_found' ? 'not_found' : 'unavailable' };
    }
  }, [token]);

  useEffect(() => {
    let live = true;
    setLoad({ kind: 'loading' });
    void read().then((next) => {
      if (live) setLoad(next);
    });
    return () => {
      live = false;
    };
  }, [read]);

  const act = (route: 'completePayment' | 'cancelPayment') => {
    if (inFlight.current || load.kind !== 'ready') return;
    const { link } = load;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    void (async () => {
      try {
        const result = await request(route, { params: { token } });
        setLoad({ kind: 'ready', link: withState(link, result.state, null) });
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'conflict' && err.state !== null) {
          // The link isn't open any more: show where it stands, and why when a rule change closed it.
          setLoad({ kind: 'ready', link: withState(link, err.state, err.cancelReason) });
        } else if (err instanceof ApiError && err.kind === 'not_found') {
          setLoad({ kind: 'not_found' });
        } else {
          // A lost answer may have gone through: the link as it is now says whether it did.
          const now = isUncertain(err) ? await read() : null;
          if (now?.kind === 'ready' && now.link.state !== 'issued') setLoad(now);
          else setError(true);
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  if (load.kind === 'ready') {
    const { link } = load;
    return (
      <main className="cd-checkout-page">
        {/* The business's name only as the kernel sends it. Without one, the merchant's place
            stays empty and takes no room, and the card's top holds just the Test mode badge. */}
        <MockCheckout
          merchant={link.business_name ?? ''}
          title={link.title}
          amount={formatMoneyExact(link.amount_cents)}
          state={link.state}
          cancelReason={link.cancel_reason ?? undefined}
          language={link.language}
          customerName={link.customer_name ?? undefined}
          chatHref={chat ?? undefined}
          busy={busy}
          error={error}
          onPay={() => act('completePayment')}
          onCancel={() => act('cancelPayment')}
        />
      </main>
    );
  }
  return <CheckoutState load={load} language={browser} onRetry={() => void read().then(setLoad)} />;
}

/** The page before a link shows: opening, a link that doesn't exist, or one that couldn't be read. */
function CheckoutState({ load, language, onRetry }: { load: Exclude<Load, { kind: 'ready' }>; language: CopyLanguage; onRetry: () => void }) {
  const copy = PAGE_COPY[language];
  let body: ReactNode;
  if (load.kind === 'not_found') body = <Notice tone="info">{copy.notFound}</Notice>;
  else if (load.kind === 'unavailable') {
    body = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={onRetry}>
            {copy.tryAgain}
          </Button>
        }
      >
        {UNREACHABLE_COPY[language]}
      </Notice>
    );
  } else {
    body = (
      <p className="cd-checkout-page__opening cd-type-meta" role="status">
        {copy.opening}
      </p>
    );
  }
  return (
    <main className="cd-checkout-page" lang={language}>
      <div className="cd-checkout-page__column">
        <DisclosureLine language={language} />
        {body}
        <ConceptFooter />
      </div>
    </main>
  );
}
