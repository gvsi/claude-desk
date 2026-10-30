import { useId } from 'react';

import { Button } from '../Button/Button.tsx';
import { useSendOnce } from '../Button/useSendOnce.ts';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorPromise } from '../ConnectorHeader/ConnectorPromise.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { useModalDialog } from '../Dialog/useModalDialog.ts';
import { Notice } from '../Notice/Notice.tsx';
import { Steps, type StepsProps } from '../Steps/Steps.tsx';

import './ConnectorSignIn.css';

/** One account choice in the mock sign-in: its name and one line about it. */
export interface SignInChoice {
  id: string;
  label: string;
  detail: string;
}

export interface ConnectorSignInProps {
  /** The app being connected, always a mock in the demo. */
  connector: ConnectorView;
  /** Whose accounts the mock stands in for: "Google". */
  provider: string;
  /** The connector's promise about what Claude can't see. */
  promise: { title: string; detail?: string };
  /** The one question it asks, which names the choices: "Which calendar shows when you're busy?" */
  question: string;
  choices: readonly SignInChoice[];
  /** The choice the screen holds; "" before one is made. */
  value: string;
  onChange: (id: string) => void;
  /** Called with the chosen `id`. */
  onContinue: (id: string) => void;
  /** Called by Cancel, Escape and a close by the browser. */
  onCancel: () => void;
  /** Where this is in the add flow. */
  steps: StepsProps;
  /** The screen is connecting the chosen account. */
  pending?: boolean;
  /** The screen's message when connecting failed; Continue works again. */
  error?: string;
}

/**
 * The mock sign-in for an app connected from outside: a modal dialog that says no real account is
 * used, shows the connector's promise, and asks one question with a choice of accounts. It asks
 * for no account details: no text field and no password.
 */
export function ConnectorSignIn({
  connector,
  provider,
  promise,
  question,
  choices,
  value,
  onChange,
  onContinue,
  onCancel,
  steps,
  pending = false,
  error,
}: ConnectorSignInProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const questionId = `${ids}-question`;
  // Focus starts on the chosen account, or the first one.
  const modal = useModalDialog(onCancel, (dialog) =>
    dialog.querySelector<HTMLElement>('input[type="radio"]:checked') ?? dialog.querySelector<HTMLElement>('input[type="radio"]'),
  );
  const chosen = choices.some((choice) => choice.id === value);
  // One press of Continue sends once and spins until the screen answers (`useSendOnce`).
  const { waiting, send } = useSendOnce<'continue'>(pending, error);
  const failed = error !== undefined && error.trim() !== '';

  return (
    <dialog {...modal} aria-labelledby={titleId} className="cd-connector-sign-in">
      <Steps {...steps} />
      <div className="cd-connector-sign-in__header">
        <ConnectorIcon icon={connector.icon} size="page" />
        <div className="cd-connector-sign-in__heading">
          <h2 id={titleId} className="cd-connector-sign-in__title cd-type-page-title">
            Connect <ConnectorName connector={connector} size="inline" />
          </h2>
          <p className="cd-connector-sign-in__mock cd-type-meta">
            A mock sign-in. No {provider} account is used, and nothing is read from or sent to {provider}.
          </p>
        </div>
      </div>
      <ConnectorPromise title={promise.title} detail={promise.detail} />
      <div className="cd-connector-sign-in__choices" role="radiogroup" aria-labelledby={questionId}>
        <p id={questionId} className="cd-connector-sign-in__question cd-type-body">
          {question}
        </p>
        {choices.map((choice) => (
          <label key={choice.id} className="cd-connector-sign-in__choice">
            <input
              type="radio"
              name={`${ids}-choice`}
              className="cd-connector-sign-in__radio"
              value={choice.id}
              checked={choice.id === value}
              onChange={() => onChange(choice.id)}
            />
            <span className="cd-connector-sign-in__choice-text">
              <span className="cd-connector-sign-in__choice-label cd-type-body">{choice.label}</span>{' '}
              <span className="cd-connector-sign-in__choice-detail cd-type-meta">{choice.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="cd-connector-sign-in__actions">
        <Button variant="secondary" size="main" onClick={() => onCancel()}>
          Cancel
        </Button>
        <Button variant="primary" size="main" disabled={!chosen} busy={chosen && waiting} onClick={() => send('continue', () => onContinue(value))}>
          Continue
        </Button>
      </div>
      {failed && !waiting ? <Notice tone="error">{error}</Notice> : null}
    </dialog>
  );
}
