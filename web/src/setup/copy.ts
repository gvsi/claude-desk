/**
 * Setup's own words, in the plan's and the signed setup boards' words (N-R2-Setup-01 to 16). The
 * owner UI is English and plain. Words that come from the shared rules helpers (`ruleWords`,
 * `moneyLimitLine`, `checkStatus`, `RuleDraftReview`) aren't repeated here.
 */
import type { SetupStep } from '../api/views.ts';
import { SETUP_START_RETRY_COPY, SETUP_START_SLOW_COPY, UNREACHABLE_COPY, type CopyLanguage } from '../ds/index.ts';

/**
 * What setup says when its checking ran out of time on this side (the proving give-up) and the
 * interview hasn't moved on: the outcome is unknown, and pressing again joins the work still
 * running, so it never says the step wasn't done. It is the design system's `UNREACHABLE_COPY`,
 * the closest line the design system has: it asks the owner to try again in a moment.
 */
export function stillCheckingLine(): string {
  return UNREACHABLE_COPY.en;
}

/**
 * What the start page says when the answer to "Start" was lost: setup may have started, and "Try
 * again" sends the same start with the same key, which goes on to the interview if it did. The
 * design system's retry-safe line.
 */
export function setupStartLostLine(): string {
  return SETUP_START_RETRY_COPY;
}

/**
 * What the start page says when the API still answered that the start is under way after the
 * page's own retries (409 `in_progress`): "Try again" asks once more, with the same key.
 */
export function setupStartSlowLine(): string {
  return SETUP_START_SLOW_COPY;
}

/**
 * What the start page says when the API answers that the start's key can't start anything again
 * (409 `key_spent`): setup didn't start, and "Start" starts anew with a new key.
 */
export function setupStartSpentLine(): string {
  // pending: the design system's SETUP_START_SPENT_COPY, once its wording is approved
  return UNREACHABLE_COPY.en;
}

/**
 * Setup's language. The owner app is English (`index.html` sets it), and setup has no language of
 * its own yet, so every step reads English; copy kept in both languages, such as the start step's
 * examples, is ready for when it has one.
 */
export const SETUP_LANGUAGE: CopyLanguage = 'en';

/** One example the start step offers: its chip, and the description it puts in the box. */
export interface StartExample {
  /** What kind of business it is, as the chip says it. */
  chip: string;
  /**
   * A description the way an owner writes one: the business's name, the owner's name as the
   * box's hint asks, and the work, in the first person. The owner can change every word.
   */
  description: string;
}

/**
 * The start step's examples: the line, the chips and the descriptions they put in the box.
 */
export interface StartExamples {
  /** The line over the chips. */
  line: string;
  /** The chips' group, for screen readers. */
  label: string;
  examples: readonly StartExample[];
}

/** The four starter businesses by language, in their signed order and words. */
export const START_EXAMPLES: Readonly<Record<CopyLanguage, StartExamples>> = {
  en: {
    line: 'Or start from an example. You can change every word.',
    label: 'Examples',
    examples: [
      {
        chip: 'A hair salon in Oakland',
        description:
          'I’m Priya Shah. Juniper Hair Studio is a four-chair salon in Oakland doing cuts, color and balayage, open Tuesday to Saturday. Clients book their own appointments, color takes a $40 deposit by secure link, and many of our clients write in Spanish.',
      },
      {
        chip: 'A plumber in Oakland',
        description:
          'I’m Mike Turner. Turner Plumbing fixes leaks, water heaters and drains around Oakland and Berkeley. A service call is $129, you can take up to 10% off without asking me, and I want to hear about burst pipes and flooding right away, day or night.',
      },
      {
        chip: 'Apartments in Sacramento',
        description:
          'I’m Sam Okafor. Maple Street Rentals manages 14 apartments in two buildings in Sacramento. People book viewings of open units and pay the $45 application fee by secure link, and tenants report maintenance problems; a leak or a lockout should reach me at once.',
      },
      {
        chip: 'A CPA firm in San Jose',
        description:
          'I’m Linda Chen. Chen & Co. is a two-person CPA firm in San Jose doing tax returns and bookkeeping. New clients book a free 20-minute consult, a personal return is $350, and each engagement starts with a $500 retainer by secure link. A client’s AI assistant can book and pay for them, within a limit the client signs.',
      },
    ],
  },
  es: {
    line: 'O empieza con un ejemplo. Puedes cambiar cada palabra.',
    label: 'Ejemplos',
    examples: [
      {
        chip: 'Una peluquería en Oakland',
        description:
          'Soy Priya Shah. Juniper Hair Studio es una peluquería de cuatro sillas en Oakland: hacemos cortes, color y balayage, de martes a sábado. Los clientes agendan su propia cita, el color lleva un depósito de $40 con un enlace seguro, y atendemos a clientes en español y en inglés.',
      },
      {
        chip: 'Un plomero en Oakland',
        description:
          'Soy Mike Turner. Turner Plumbing arregla fugas, calentadores de agua y drenajes en Oakland y Berkeley. La visita de servicio cuesta $129, puedes descontar hasta un 10% sin preguntarme, y quiero saber de inmediato de tuberías reventadas o inundaciones, de día o de noche.',
      },
      {
        chip: 'Departamentos en Sacramento',
        description:
          'Soy Sam Okafor. Maple Street Rentals administra 14 departamentos en dos edificios de Sacramento. La gente agenda visitas a unidades disponibles y paga la cuota de solicitud de $45 con un enlace seguro, y los inquilinos reportan problemas de mantenimiento; una fuga o alguien que se quedó sin llaves me tiene que llegar de inmediato.',
      },
      {
        chip: 'Un despacho contable en San José',
        description:
          'Soy Linda Chen. Chen & Co. es un despacho contable de dos personas en San José que prepara declaraciones de impuestos y lleva contabilidad. Los clientes nuevos agendan una consulta gratis de 20 minutos, una declaración personal cuesta $350 y cada trabajo empieza con un anticipo de $500 con un enlace seguro. El asistente de IA de un cliente también puede agendar y pagar por él, dentro del límite que el cliente firme.',
      },
    ],
  },
};

/** The steps, as the bar lists them. */
export const STEP_NAMES = ['Questions', 'Tools', 'Rules', 'Safety check', 'Live'] as const;

/** The public About panel's charter claims, in setup's signed order. Labels come from cardChrome. */
export { SETUP_PUBLIC_LINE_KEYS as PUBLIC_LINE_KEYS } from '../api/views.ts';

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

export const SETUP_COPY = {
  stepsLabel: 'Set up your Desk',
  /** Stands in for the business's name until the API names it. */
  yourBusiness: 'your business',
  saveAndExit: 'Save and exit',
  /** Back to the chat with Claude from Real situations or the closing plan, to change what setup drafted. */
  changeSomething: 'Change something',
  /** The bar's lockup, a link that leaves as "Save and exit" does: the product's name, then what it does. */
  brandHome: 'Claude Desk, save and exit',

  start: {
    title: 'Tell me about your business',
    subtitle: "A few sentences is enough. You'll see everything before anything goes live.",
    field: 'Your business',
    hint: 'Include your first name as customers should see it.',
    empty: 'Write a few sentences about your business first.',
    action: 'Start',
  },

  questions: {
    title: "Let's set up your Desk",
    suggestions: 'Use your suggestions',
    suggestionsLine: 'Skip the rest. I’ll fill it in from what I’ve proposed, and every limit asks you first.',
    dismiss: 'Dismiss', other: 'Something else…',
    upArrow: 'Up arrow', downArrow: 'Down arrow',
    move: 'to move', pick: 'to pick', send: 'to send', typeInstead: 'to type instead',
    allow: 'Yes, use it',
    decline: "No, I'll type it",
    composerLabel: 'Your answer',
    placeholder: 'Answer in your own words',
    failed: "I couldn't answer just now. Your answer is still here; try again.",
    tryAgain: 'Try again',
    conversation: 'Setup questions',
    putting: 'Putting together what I’d have your Desk do. This can take a minute or so.',
    loading: 'Opening your setup',
  },

  proposal: {
    changed: 'Changed below',
    connect: 'Connect', connected: 'Connected',
    setItUp: 'Set it up', setUp: 'Set up',
    amount: 'Amount', amountHint: 'In dollars. The payment link asks for this amount.', amountError: 'Enter an amount to accept this.',
    failed: 'I couldn’t save that just now. Try again.', tryAgain: 'Try again',
    decline: 'Not now', later: 'Coming later',
    who: 'Who', usesLabel: 'Uses', nextLabel: 'Next for you', asks: 'Asks',
    uses: { schedule: 'Your opening hours', payment: 'Stripe', price: 'Your prices', urgent: 'Alerts you right away' },
    next: {
      schedule: { auto: 'The booking shows in Today, with their answers', ask: 'You approve each request in Needs you' },
      intake: 'Their answers show on the booking', payment: 'Each payment shows in Today',
    },
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
    /**
     * A setup booking job's review, under the job, when the owner chose on its card to let it run on
     * its own: it still asks first, since its own rule comes from the card they confirm at the Rules step.
     */
    chosenOnItsOwn: 'You chose to let it run on its own. Until you confirm your rules in the next step, it asks you first.',
    turnOnTitle: (connector: string) => `Turn on ${connector}`,
    turnOnSubtitle: "Here's exactly what changes on your Desk. Nothing changes until you confirm.",
    changedSince: 'Your rules changed since this was drafted. Check the new version.',
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
    subtitle: ['How your rules will handle things that really happen at ', '. Nothing here is real.'],
    loading: 'Trying real situations on your draft rules',
    empty: 'No situations to show',
    emptyBody: 'Your draft rules are still checked against tricks people use in the next step.',
    label: 'Real situations',
    looksRight: 'Looks right',
    who: {
      public: 'A visitor, not verified',
      verified: 'A customer, verified',
      agent: "Someone's agent, signed limit",
      after_hours: 'A visitor, after hours',
    },
  },

  safety: {
    title: 'Safety check',
    loading: 'Trying tricks people use on your draft rules',
    stopped: (stopped: number, total: number) => `${stopped} of ${total} stopped`,
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

  publicLines: {
    suggestedTitle: 'Suggested by Claude, please check',
    suggestedIntro: 'Claude found these in your memory and online. Customers see them only once you choose “Looks right”.',
    remove: 'Remove',
    hours: 'Hours',
    prices: 'Price list',
    title: 'What customers will read',
    subtitle: 'Your Desk answers customers from these. Check them before the safety check.',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    refused: "This line can't state a price, a time or a promise. Prices come from your price list, and times from your opening hours.",
  },

  live: {
    previewTitle: 'Try it as a customer before anyone else can',
    /** The launch bar's two lines under the preview, the first after an info dot. */
    previewAnsweringOff: 'Claude takes messages only until you go live.',
    previewOnlyYou: 'Only you can see this preview.',
    goLive: 'Go live',
    /** After the business's name. */
    isLive: ' is live',
    yourDeskIsLive: 'Your Desk is live',
    liveSubtitle: 'Customers and their agents can reach your Desk at this link, day or night.',
    answeringNow: 'Acting for you now',
    open: 'Open',
    goToToday: 'Go to Today',
    shareIt: 'Share it',
    comingLater: 'Coming later',
    moreChannels: 'More channels',
  },
} as const;
