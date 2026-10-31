import type { SetupState, SetupStep } from '../api/views.ts';

export function RulesStep(_: { state: SetupState; business: string; onNext: (step: SetupStep) => void }) {
  return null;
}
