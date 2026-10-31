/**
 * Setup's own words, in the plan's and the signed setup boards' words (N-R2-Setup-01 to 16). The
 * owner UI is English and plain. Words that come from the shared rules helpers (`ruleWords`,
 * `moneyLimitLine`, `checkStatus`, `RuleDraftReview`) aren't repeated here.
 */
import type { QuestionKey, SetupStep } from '../api/views.ts';
import { UNREACHABLE_COPY } from '../ds/index.ts';

/**
 * What setup says when its checking ran out of time on this side (the proving give-up) and the
 * interview hasn't moved on: the outcome is unknown, and pressing again joins the work still
 * running, so it never says the step wasn't done. It is the design system's `UNREACHABLE_COPY`,
 * the closest line the design system has: it asks the owner to try again in a moment.
 */
export function stillCheckingLine(): string {
  return UNREACHABLE_COPY.en;
}

/** The steps, as the bar lists them. */
export const STEP_NAMES = ['Questions', 'Tools', 'Rules', 'Safety check', 'Live'] as const;

/** Where each interview step sits in the bar. */
export const STEP_INDEX: Readonly<Record<SetupStep, number>> = {
  questions: 0,
  tools: 1,
  rules: 2,
  situations: 2,
  safety_check: 3,
  preview: 4,
  live: 4,
};

/** The interview's questions in the order the API asks them (plan 02b Task 6, `QUESTION_KEYS`). */
export const QUESTION_ORDER: readonly QuestionKey[] = [
  'what_you_do',
  'hours_and_area',
  'quote_limit',
  'discounts',
  'documents_and_payments',
  'money_limit',
  'contact_and_after_hours',
];

export const SETUP_COPY = {
  stepsLabel: 'Set up your Desk',
  /** Stands in for the business's name until the API names it. */
  yourBusiness: 'your business',
  saveAndExit: 'Save and exit',

  start: {
    title: 'Tell me about your business',
    subtitle: "A few sentences is enough. You'll see everything before anything goes live.",
    field: 'Your business',
    hint: 'Include your first name as customers should see it.',
    empty: 'Write a few sentences about your business first.',
    action: 'Start',
  },

  questions: {
    title: 'A few questions',
    beforeConsent: "About seven. Answer in your own words; I'll turn them into rules you can check.",
    counter: (n: number, of: number) => `Question ${n} of ${of}`,
    allow: 'Yes, use it',
    decline: "No, I'll type it",
    composerLabel: 'Your answer',
    placeholder: 'Answer in your own words',
    failed: "I couldn't answer just now. Your answer is still here; try again.",
    tryAgain: 'Try again',
    conversation: 'Setup questions',
    loading: 'Opening your setup',
  },

  tools: {
    title: 'What Claude can use',
    /** Around the business's name, which is the owner's own words. */
    subtitle: [
      'Built-in connectors are part of Claude Desk. Add the ones that fit ',
      '; each tool starts at Ask me first unless one of your rules covers it, and you review it before it turns on.',
    ],
    on: 'On',
    alwaysOn: 'Always on',
    continue: 'Continue',
    loading: 'Reading your tools',
    empty: 'No tools to add yet',
    emptyBody: 'Continue to your rules. You can add connectors later from Connectors.',
    turnOnTitle: (connector: string) => `Turn on ${connector}`,
    turnOnSubtitle: "Here's exactly what changes on your Desk. Nothing changes until you confirm.",
    changedSince: 'Your rules changed since this was drafted. Check the new version.',
    connecting: 'Connecting Stripe',
  },

  rules: {
    title: 'Your rules',
    subtitle: "What I'll do on my own, what I'll ask you about, and what I never do.",
    loading: 'Drafting your rules',
    empty: 'No rules yet',
    emptyBody: 'Until you add rules, Claude asks you before it does anything.',
    checkSituations: 'Check real situations',
    /** The signed line for rules that can't be checked (N-R2-Setup-10), shown with only "Save and exit". */
    cantCheck: "I can't check these rules right now, so they can't go live yet. Your answers are saved; come back from Today and I'll check them again.",
  },

  situations: {
    title: 'Real situations',
    /** Around the business's name, which is the owner's own words. */
    subtitle: ['How your draft rules handle things that really happen at ', '. Nothing here is real.'],
    loading: 'Trying real situations on your draft rules',
    empty: 'No situations to show',
    emptyBody: 'Your draft rules are still checked against tricks people use in the next step.',
    label: 'Real situations',
    looksRight: 'Looks right',
    who: {
      public: 'A visitor, not verified',
      verified: 'A customer, verified',
      agent: 'Someone’s agent, signed limit',
      after_hours: 'A visitor, after hours',
    },
  },

  safety: {
    title: 'Safety check',
    loading: 'Trying tricks people use on your draft rules',
    blocked: (blocked: number, total: number) => `${blocked} of ${total} blocked`,
    lead: (total: number) => `I tried ${total} tricks people really use, on your draft rules. Nothing was real, and no one was contacted.`,
    label: 'Tricks tried',
    empty: 'No tricks to show',
    emptyBody: 'Run the check again to try them on your draft rules.',
    confirm: 'Confirm rules',
    runAgain: 'Run again',
    conflictSubtitle: 'Confirming your rules.',
    back: 'Back',
    changedSince: 'Your rules changed since this was drafted. Check the new version.',
  },

  live: {
    previewTitle: 'Try it as a customer before anyone else can',
    previewSubtitle: 'Answering stays off until you go live. Only you can see this preview.',
    goLive: 'Go live',
    /** After the business's name. */
    isLive: ' is live',
    yourDeskIsLive: 'Your Desk is live',
    liveSubtitle: 'Customers and their agents can reach your Desk at this link, day or night.',
    open: 'Open',
    goToToday: 'Go to Today',
    shareIt: 'Share it',
    shareLoading: 'Loading the card and ready-made words',
    tryAgain: 'Try again',
  },
} as const;
