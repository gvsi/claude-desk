/** Chen & Co. CPA's own tools, as the kernel lists them for setup and the owner's rules. */
import type { ToolRow } from '../api/views.ts';

export const chenBusinessTools: readonly ToolRow[] = [
  {
    tool: 'desk.intro-call',
    source: 'business',
    status: 'needs_review',
    effects: ['change'],
    reversible: true,
    description_confirmed: 'Books a free 20-minute intro call with Linda for a new client.',
    definition_sha256: 'a'.repeat(64),
    pending_definition_text: null,
    pending_sha256: null,
    review_reason: 'new',
    cards: [],
    business: {
      title: 'Book a free intro call',
      description: 'Books a free 20-minute intro call with Linda for a new client.',
      config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 },
    },
  },
  {
    tool: 'desk.new-client-intake',
    source: 'business',
    status: 'enabled',
    effects: ['change', 'private_data'],
    reversible: true,
    description_confirmed: 'Asks a new client a few questions before their first call and saves the answers for Linda.',
    definition_sha256: 'b'.repeat(64),
    pending_definition_text: null,
    pending_sha256: null,
    review_reason: null,
    cards: [],
    business: {
      title: 'New client intake',
      description: 'Asks a new client a few questions before their first call and saves the answers for Linda.',
      config: {
        block: 'intake',
        questions: ['Is this for you or for a business?', 'Which tax years do you need help with?', 'Do you already have a bookkeeper?'],
      },
    },
  },
];
