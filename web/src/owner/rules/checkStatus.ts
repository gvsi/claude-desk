/**
 * A draft's check in the owner's words (master "How proofs run"), for `ChangeReview`'s `checks`.
 * Only a full check that passed can be confirmed; anything else fails closed.
 */
import type { ProofReport } from '../../api/contracts.ts';
import { RULES_UNAVAILABLE_COPY } from '../../api/http.ts';
import type { RulesPreset } from '../../api/views.ts';

export interface CheckStatus {
  status: 'checked' | 'failed' | 'unavailable';
  lines: string[];
}

const CHECKED_LINE = 'Checked against the always-on rules and your other rules.';
/** Both presets keep the starter's own rules, so these still run without asking (N-Conn-18). */
const PRESET_KEEPS_LINE = 'Open times, leads, callbacks and identity checks still run on their own.';
const FAILED_LINE = "One of the safety checks didn't pass.";

/**
 * - No check, one that ran out of time, or the bounded fallback: unavailable, never "failed", since
 *   nothing was found wrong; it still can't be confirmed.
 * - A full check that passed every part: checked, and on a preset's review (`preset`, either one)
 *   a second line on what still runs on its own.
 * - Otherwise failed, each failed part in the kernel's plain words, or one plain line without them.
 */
export function checkStatus(proof: ProofReport | null | undefined, preset: RulesPreset | null = null): CheckStatus {
  if (proof == null || proof.timed_out === true || proof.method !== 'symcc') return { status: 'unavailable', lines: [RULES_UNAVAILABLE_COPY] };
  const failed = proof.checks.filter((check) => check.ok !== true);
  if (proof.ok === true && failed.length === 0) return { status: 'checked', lines: preset === null ? [CHECKED_LINE] : [CHECKED_LINE, PRESET_KEEPS_LINE] };
  const lines = failed.map((check) => check.counterexample_plain?.trim() ?? '').map((line) => (line === '' ? FAILED_LINE : line));
  const unique = [...new Set(lines)];
  return { status: 'failed', lines: unique.length > 0 ? unique : [FAILED_LINE] };
}
