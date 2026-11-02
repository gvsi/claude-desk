import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { KnowledgePreviews, KNOWLEDGE_SUMMARY } from '../../owner/knowledge/KnowledgePage.tsx';
import { MOCK_SOURCES } from '../../owner/knowledge/previewSources.ts';
import { KnowledgeAdd } from '../components/KnowledgeAdd/KnowledgeAdd.tsx';
import { KnowledgeList, type KnowledgeRowView } from '../components/KnowledgeList/KnowledgeList.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { RiveraFrame } from './parts.tsx';
import '../../owner/knowledge/Knowledge.css';

const ITEMS: KnowledgeRowView[] = [
  { id: 'website', kind: 'globe', title: 'Your website', detail: 'Website · Read during setup · Added Nov 1', readers: ['public'] },
  { id: 'price-list', kind: 'list', title: 'Price list', detail: 'Price list · From your answers in setup · Added Nov 1', readers: ['public'] },
  ...MOCK_SOURCES,
];

function KnowledgeBoard() {
  return <RiveraFrame current="knowledge" counts={{}}>
    <PageHeader title="Knowledge" subtitle={KNOWLEDGE_SUMMARY} />
    <div className="cd-knowledge">
      <div className="cd-knowledge__known"><KnowledgeList items={ITEMS} caption="6 sources. Customers can see 5." /></div>
      <div className="cd-knowledge__add"><KnowledgeAdd note="" onNoteChange={fn()} onAddNote={fn()} onAddFile={fn()} /></div>
      <KnowledgePreviews />
    </div>
  </RiveraFrame>;
}

const meta = {
  title: 'Boards/Knowledge',
  render: () => <KnowledgeBoard />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { layout: 'fullscreen', canvas: 'N-Run2-Settings-Knowledge', canvasNote: 'Knowledge is a main sidebar page. The source list and previews sit beside Add something on desktop and above and below it on phone.' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeVisible();
    const list = canvas.getByRole('list', { name: 'What Claude knows' });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    await expect(canvas.getByText('6 sources. Customers can see 5.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Add a website' })).toBeVisible();
  },
};
