import type { SetupState } from '../api/views.ts';

export function SafetyStep(_: { state: SetupState; onConfirmed: () => void }) {
  return null;
}
