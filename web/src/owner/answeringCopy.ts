/** Both owner switches ask the same question before sending their existing save. */
export const ANSWERING_CONFIRM_COPY = {
  on: {
    title: 'Let Claude act for you again?',
    body: 'Claude can use your tools again, under your rules. Anything a rule holds still waits for you.',
    cancelLabel: 'Not now',
    confirmLabel: 'Let Claude act',
  },
  off: {
    title: 'Take messages only?',
    body: 'Claude keeps replying to visitors and their agents, but only takes messages and callback requests. Everything else is handed to you.',
    cancelLabel: 'Keep acting for me',
    confirmLabel: 'Take messages only',
  },
} as const;

export const answeringSaveFailed = (on: boolean) =>
  on ? "That didn’t save, so Claude is still acting for you." : "That didn’t save, so Claude is still taking messages only.";

export const answeringSaveUnconfirmed = (on: boolean) =>
  on
    ? "We couldn’t confirm that Claude is now acting for you. Reload to see where it stands."
    : "We couldn’t confirm that Claude now takes messages only. Reload to see where it stands.";
