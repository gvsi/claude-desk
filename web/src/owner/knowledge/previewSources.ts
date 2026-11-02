import type { KnowledgeRowView } from '../../ds/index.ts';

/** Display samples shared by the live app and mock API screens. They never enter the knowledge API. */
export const MOCK_SOURCES: readonly KnowledgeRowView[] = [
  {
    id: 'mock-maintenance',
    kind: 'document',
    fileTag: 'PDF',
    title: 'Maintenance plan.pdf',
    detail: 'PDF · 2 pages · Added Oct 28 · Customers can see this',
    readers: ['public'],
    pill: 'Mock',
  },
  {
    id: 'mock-warranty',
    kind: 'document',
    fileTag: 'DOCX',
    title: 'Warranty terms.docx',
    detail: 'Word document · 3 pages · Added Oct 28 · Only you',
    readers: ['owner'],
    pill: 'Mock',
  },
  {
    id: 'mock-map',
    kind: 'document',
    fileTag: 'PDF',
    title: 'Service area map.pdf',
    detail: 'PDF · 1 page · Added Oct 30 · Customers can see this',
    readers: ['public'],
    pill: 'Mock',
  },
  {
    id: 'mock-faq',
    kind: 'globe',
    title: 'turner-plumbing.example/faq',
    detail: 'Website page · Read again every week · Customers can see this',
    readers: ['public'],
    pill: 'Mock',
  },
];

export const SAMPLE_QUESTIONS: readonly KnowledgeRowView[] = [
  { id: 'softeners', title: 'Do you install water softeners?', detail: 'Asked 3 times this week', readers: [], pill: null },
  { id: 'sunday', title: 'Can you come out on a Sunday for a burst pipe?', detail: 'Asked twice this week', readers: [], pill: null },
  { id: 'cards', title: 'Do you take credit cards on site?', detail: 'Asked once, on Friday', readers: [], pill: null },
];

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
