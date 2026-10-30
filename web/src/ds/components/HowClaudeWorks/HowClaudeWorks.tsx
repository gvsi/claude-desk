import { useEffect, useRef, type ReactNode } from 'react';

import { Card } from '../Card/Card.tsx';
import { PRESET_CAPTIONS, PRESET_WORDS, type RulesPreset } from '../OutcomeMenu/outcomeWords.ts';
import { SegmentedControl } from '../SegmentedControl/SegmentedControl.tsx';

import './HowClaudeWorks.css';

export interface HowClaudeWorksProps {
  /** The active rules version's preset: Custom once any rule differs from both presets. */
  preset: RulesPreset;
  /** The owner picked a preset: the screen drafts it and opens its review. Called once per pick. */
  onPreset: (preset: 'ask_first' | 'auto') => void;
  /** A draft is in flight: the switch takes no pick. */
  disabled?: boolean;
  /** The money limit (`MoneyLimit`), under a hairline. */
  children?: ReactNode;
}

/**
 * The top of the Rules page: how Claude works on this Desk, as one of two presets or the owner's
 * own rules, and the money limit. Picking a preset only asks the screen to draft it; the switch
 * keeps showing `preset` until the screen passes a new one, after the owner confirms the change.
 */
export function HowClaudeWorks({ preset, onPreset, disabled = false, children }: HowClaudeWorksProps) {
  // One pick at a time: after a pick, the switch takes no other until the screen passes a new
  // preset or its draft (`disabled`) has come and gone. The ref is set in the pick itself, so a
  // second press before the screen re-renders sends nothing.
  const picked = useRef(false);
  const shownPreset = useRef(preset);
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (shownPreset.current !== preset) picked.current = false;
    shownPreset.current = preset;
  }, [preset]);
  useEffect(() => {
    if (wasDisabled.current && !disabled) picked.current = false;
    wasDisabled.current = disabled;
  }, [disabled]);

  const pick = (next: RulesPreset) => {
    // Custom is a state ("your rules differ from both presets"), not something to draft.
    if (next === 'custom' || next === preset || disabled || picked.current) return;
    picked.current = true;
    try {
      onPreset(next);
    } catch (thrown) {
      picked.current = false;
      throw thrown;
    }
  };

  return (
    <div className="cd-how-claude-works">
      <Card as="section" label="How Claude works" padding={0}>
        <div className="cd-how-claude-works__inner">
          <div className="cd-how-claude-works__head">
            <div className="cd-how-claude-works__text">
              <h2 className="cd-how-claude-works__title cd-type-section">How Claude works</h2>
              <p className="cd-how-claude-works__caption cd-type-meta">{PRESET_CAPTIONS[preset] ?? PRESET_CAPTIONS.custom}</p>
            </div>
            <SegmentedControl label="How Claude works" options={PRESET_WORDS} value={preset} onChange={pick} disabled={disabled} />
          </div>
          {children ? <div className="cd-how-claude-works__limit">{children}</div> : null}
        </div>
      </Card>
    </div>
  );
}
