import type { KnowledgeRowView } from '../../ds/index.ts';
import { BUSINESS_WORDS, type BusinessWords } from '../businessWords.ts';

/**
 * Display samples shared by the live app and mock API screens. They never enter the knowledge API.
 * They carry no pill: the page's one "Mock", beside its title, says what they are, and their line
 * already says who can see each.
 */
export const MOCK_SOURCES: readonly KnowledgeRowView[] = [
  {
    id: 'mock-maintenance',
    kind: 'document',
    fileTag: 'PDF',
    title: 'Maintenance plan.pdf',
    detail: 'PDF · 2 pages · Added Oct 28 · Customers can see this',
    readers: ['public'],
    pill: null,
  },
  {
    id: 'mock-warranty',
    kind: 'document',
    fileTag: 'DOCX',
    title: 'Warranty terms.docx',
    detail: 'Word document · 3 pages · Added Oct 28 · Only you',
    readers: ['owner'],
    pill: null,
  },
  {
    id: 'mock-map',
    kind: 'document',
    fileTag: 'PDF',
    title: 'Service area map.pdf',
    detail: 'PDF · 1 page · Added Oct 30 · Customers can see this',
    readers: ['public'],
    pill: null,
  },
  {
    id: 'mock-faq',
    kind: 'globe',
    title: 'turner-plumbing.example/faq',
    detail: 'Website page · Read again every week · Customers can see this',
    readers: ['public'],
    pill: null,
  },
];

/** A business’s sample "Questions Claude couldn’t answer", as rows: how often each was asked is the same for every business. */
export function sampleQuestions({ questions: [first, second, third] }: BusinessWords): readonly KnowledgeRowView[] {
  return [
    { id: 'question-1', title: first, detail: 'Asked 3 times this week', readers: [], pill: null },
    { id: 'question-2', title: second, detail: 'Asked twice this week', readers: [], pill: null },
    { id: 'question-3', title: third, detail: 'Asked once, on Friday', readers: [], pill: null },
  ];
}

/** Turner Plumbing’s, as the Knowledge board shows them. */
export const SAMPLE_QUESTIONS: readonly KnowledgeRowView[] = sampleQuestions(BUSINESS_WORDS.rivera);

export const MORE_SOURCES: readonly KnowledgeRowView[] = [
  { id: 'drive', title: 'Google Drive', detail: 'Docs and PDFs you pick, read again when they change.', readers: [], pill: 'Coming later' },
  { id: 'notion', title: 'Notion', detail: 'Pages you share with your Desk.', readers: [], pill: 'Coming later' },
  {
    id: 'fresh-website',
    title: 'Your website, kept fresh',
    detail: 'Read again every week, so new prices and hours reach Claude.',
    readers: [],
    pill: 'Coming later',
  },
];
