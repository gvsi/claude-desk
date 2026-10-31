import type { Choice } from '../api/views.ts';
import { Chip } from '../ds/index.ts';
import { SETUP_COPY } from './copy.ts';

/** Earlier rows stay visible with the owner's exact pick checked. Only the current row can answer. */
export function SetupChoices({
  choices,
  picked,
  disabled,
  onChoose,
}: {
  choices: Choice[];
  picked?: string | undefined;
  disabled: boolean;
  onChoose: (text: string) => void;
}) {
  return (
    <div className="cd-setup-choices" role="group" aria-label={SETUP_COPY.questions.choices}>
      {choices.map((choice) => (
        <Chip key={choice.text} selected={picked === choice.text} disabled={disabled} onClick={() => onChoose(choice.text)}>
          <span>{choice.text}</span>
          {choice.recommended ? <span className="cd-setup-choices__rec">{SETUP_COPY.questions.recommended}</span> : null}
        </Chip>
      ))}
    </div>
  );
}
