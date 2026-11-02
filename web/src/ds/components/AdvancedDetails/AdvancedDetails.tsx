import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { Icon } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { CopyResult } from '../CopyResult/CopyResult.tsx';
import { copyResultLine, useCopyText } from '../CopyField/useCopyText.ts';
import { jsonText, jsonTokens } from './detailsJson.ts';

import './AdvancedDetails.css';

/** One line of the panel's list: a label in the left column and its value. */
export interface DetailsField {
  /** "Name", "Claude sees", "Policy hash". */
  label: string;
  /** The value: the screen's words, a status label, a connector's name, or a value given as it is. */
  value: ReactNode;
  /** Machine text, such as an ID or a hash: set in mono, marked as code and never translated. */
  mono?: boolean;
}

/** The panel's code block: what it holds, and the data it shows as pretty JSON. */
export interface DetailsCode {
  /** "As your Desk lists it", "The rule as you set it". */
  label: string;
  /** The data, shown as pretty JSON (`jsonText`) and copied as the same text. */
  value: unknown;
}

export interface AdvancedDetailsProps {
  /** The panel's list, in order. */
  fields: readonly DetailsField[];
  /** A code block under the list. Leave it out when there is no data to show: no empty block is drawn. */
  code?: DetailsCode;
  /** Copies the code block's text. The screen owns the clipboard; a throw or a rejection means it couldn't. */
  onCopy: (text: string) => Promise<void> | void;
  /** The id of the words the row is about (a tool's title, a rule's sentence), so each Details reads as its own. */
  describedBy?: string;
  /** Draws the row, with the Details button where the row puts it: after a tool's title, after a rule's dot. */
  children: (toggle: ReactElement) => ReactNode;
}

/** The button's words and chevron, shared by the button and the empty slot, so both are one width. */
const TOGGLE_FACE = (
  <>
    Details
    <Icon name="chevron-right" size={14} className="cd-advanced-details__chevron" />
  </>
);

/**
 * The place a row's Details takes, left empty, for a row that has none (an always-on rule): every
 * status dot then sits in one column just left of Details (REV-RULES-D v351). It is drawn as the
 * button is but unseen, so it is never read or focused.
 */
export function DetailsSlot() {
  return (
    <span className="cd-advanced-details__toggle cd-advanced-details__slot cd-type-control" aria-hidden="true">
      {TOGGLE_FACE}
    </span>
  );
}

/** The pretty JSON, tinted by token: keys, strings, other values and punctuation; the layout stays plain text. */
function JsonBlock({ label, value, onCopy }: DetailsCode & Pick<AdvancedDetailsProps, 'onCopy'>) {
  const labelId = useId();
  const pre = useRef<HTMLPreElement>(null);
  const { state, announcement, copy } = useCopyText(onCopy);
  return (
    <div className="cd-advanced-details__code">
      <div className="cd-advanced-details__code-head">
        <p id={labelId} className="cd-advanced-details__code-label cd-type-meta">{label}</p>
        <CopyResult result={copyResultLine(state)} announcement={announcement} className="cd-advanced-details__copied cd-type-meta" />
        <Button variant="ghost" size="inline" describedBy={labelId} onClick={() => void copy(jsonText(value), pre.current)}>
          Copy
        </Button>
      </div>
      {/* Focusable, so a keyboard can scroll a long line into view. */}
      <pre ref={pre} className="cd-advanced-details__json cd-type-trace" data-copy="code" translate="no" tabIndex={0}>
        {jsonTokens(value).map((token, index) =>
          token.kind === 'space' ? token.text : (
            <span key={index} className={`cd-advanced-details__json-${token.kind}`}>{token.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}

/**
 * The advanced details of a tool or a rule, as REV-RULES-D draws them: a quiet "Details" button in
 * the row, collapsed by default, which opens a panel under the row with a label and value list and,
 * when there is data, a code block of pretty JSON with a Copy button. The screen gives the words and
 * the data; the component draws them and never words, formats or fetches anything.
 */
export function AdvancedDetails({ fields, code, onCopy, describedBy, children }: AdvancedDetailsProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const toggle = (
    <button
      type="button"
      className="cd-advanced-details__toggle cd-type-control"
      aria-expanded={open}
      aria-controls={panelId}
      aria-describedby={describedBy}
      onClick={() => setOpen((was) => !was)}
    >
      {TOGGLE_FACE}
    </button>
  );
  return (
    <>
      {children(toggle)}
      <div id={panelId} className="cd-advanced-details" hidden={!open}>
        {open ? (
          <div className="cd-advanced-details__panel">
            <dl className="cd-advanced-details__fields">
              {fields.map((field) => (
                <div key={field.label} className="cd-advanced-details__field">
                  <dt className="cd-advanced-details__label cd-type-meta">{field.label}</dt>
                  <dd className="cd-advanced-details__value cd-type-meta">
                    {field.mono === true ? (
                      <span className="cd-type-trace" data-copy="code" translate="no">{field.value}</span>
                    ) : field.value}
                  </dd>
                </div>
              ))}
            </dl>
            {code === undefined ? null : <JsonBlock {...code} onCopy={onCopy} />}
          </div>
        ) : null}
      </div>
    </>
  );
}
