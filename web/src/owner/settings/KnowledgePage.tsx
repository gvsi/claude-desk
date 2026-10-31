/**
 * Settings › Knowledge (N-Run2-Settings-Knowledge): what Claude answers from, which never changes
 * the owner's rules. "What I know now" lists what the owner may see, each item with when it was
 * added and who can see it; one the kernel forces owner-only comes with its title and text withheld
 * and reads "A note only you can see". Under it, a note or a text file is added for the owner only,
 * then the "Added" card's "Customers can see this" switch posts it again for customers or for the
 * owner alone, and shows the readers the kernel returned, never the ones asked for, so an item the
 * kernel keeps to the owner stays off.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { KnowledgeItem } from '../../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import type { KnowledgeListItem } from '../../api/views.ts';
import { Button, KnowledgeAdd, KnowledgeList, LoadingLine, Notice, type KnowledgeRowView } from '../../ds/index.ts';
import { formatDate } from '../../lib/format.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { useReadFailure } from '../useReadFailure.ts';

const LEAD = 'Knowledge is what I answer from. It never changes your rules.';

/** The largest file "Add a file" takes: 100 KB. */
export const MAX_FILE_BYTES = 100 * 1024;

/** The files "Add a file" takes, by name: text and Markdown. */
const TEXT_FILE = /\.(?:txt|md)$/i;

/** An item's title: its first 60 characters. */
const TITLE_LENGTH = 60;

export const KNOWLEDGE_COPY = {
  emptyNote: 'Write the note first, then add it.',
  notText: 'Add a text or Markdown file, one ending in .txt or .md.',
  tooBig: 'That file is too big. Add files up to 100 KB.',
  emptyFile: 'That file is empty. Add one with some text in it.',
  /** An add whose answer was lost may have gone through: adding it again posts the same item, which replaces it. */
  unconfirmed: "We couldn't confirm that it was added. Add it again: it won't be added twice.",
  /** Asked to be public, answered owner-only: the kernel keeps it to the owner. */
  keptPrivate: 'This stays private. Only you can see it.',
  switchUnconfirmed: "We couldn't confirm that change. Turn it again to make sure.",
} as const;

type Busy = 'note' | 'file' | 'switch';

/** A Desk's knowledge, as the owner may see it. Query keys start with the route key. */
const knowledgeKey = (deskId: string) => ['knowledge', deskId] as const;

/**
 * The list's rows, oldest first, each with when it was added on the business's clock. An item whose
 * title or text the kernel withheld is drawn as the design system draws one it keeps to the owner:
 * no title, no words, "Only you".
 */
function rowsOf(items: readonly KnowledgeListItem[], timeZone: string): KnowledgeRowView[] {
  return [...items]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((item) => ({
      id: item.item_id,
      title: item.title === null || item.text === null ? null : item.title,
      detail: `Added ${formatDate(item.created_at, timeZone)}`,
      readers: item.label.readers ?? [],
    }));
}

/** "What I know now": the list once read, the loading line while it is, and a failed read with Try again over it. */
function WhatIKnow({ deskId, timeZone }: { deskId: string; timeZone: string }) {
  const list = useQuery({ queryKey: knowledgeKey(deskId), queryFn: () => request('knowledge', { params: { desk_id: deskId } }) });
  const failure = useReadFailure(list);
  return (
    <>
      {failure === null ? null : (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
              Try again
            </Button>
          }
        >
          {failure.line}
        </Notice>
      )}
      {list.data === undefined ? (
        failure === null ? (
          <LoadingLine>Loading what I know</LoadingLine>
        ) : null
      ) : (
        // With nothing known yet, no list: the board never draws it empty. A failed read says so
        // over the list read before.
        <KnowledgeList items={rowsOf(list.data, timeZone)} />
      )}
    </>
  );
}

/** The first `TITLE_LENGTH` characters of `text`, by character rather than code unit. */
function titleOf(text: string): string {
  return [...text].slice(0, TITLE_LENGTH).join('');
}

/** A fresh id for an item: `note-<uuid>` or `file-<uuid>`. */
function newId(kind: 'note' | 'file'): string {
  return `${kind}-${crypto.randomUUID()}`;
}

/** Whether `a` and `b` are the same thing to add: the same source, title and words. */
function sameItem(a: KnowledgeItem, b: Omit<KnowledgeItem, 'item_id'>): boolean {
  return a.source === b.source && a.title === b.title && a.text === b.text;
}

export function KnowledgePage() {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const queryClient = useQueryClient();
  /** The list is read again after anything is added or changed. */
  const listChanged = () => void queryClient.invalidateQueries({ queryKey: knowledgeKey(deskId) });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<Busy | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // The item as the kernel last returned it: what the "Added" card and its switch show.
  const [added, setAdded] = useState<KnowledgeItem | null>(null);
  const [switchLine, setSwitchLine] = useState<string | undefined>(undefined);
  // The last item posted, so adding the same thing again posts it under the same id and replaces
  // it rather than adding a second copy, whether or not the first answer arrived.
  const [posted, setPosted] = useState<KnowledgeItem | null>(null);

  const post = (item: KnowledgeItem) => request('addKnowledge', { params: { desk_id: deskId }, body: { item } });

  /** Adds `fields` for the owner only, under the id it was posted with before if it is the same. */
  const add = async (kind: 'note' | 'file', fields: Omit<KnowledgeItem, 'item_id' | 'label'>) => {
    const ownerOnly = { ...fields, label: { readers: ['owner'] } };
    const item: KnowledgeItem = { item_id: posted !== null && sameItem(posted, ownerOnly) ? posted.item_id : newId(kind), ...ownerOnly };
    setPosted(item);
    setBusy(kind);
    setError(undefined);
    try {
      const stored = await post(item);
      setAdded(stored);
      setSwitchLine(undefined);
      listChanged();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      setError(isUncertain(err) ? KNOWLEDGE_COPY.unconfirmed : ownerErrorCopy(err));
    } finally {
      setBusy(undefined);
    }
  };

  const addNote = () => {
    const text = note.trim();
    if (text === '') {
      setError(KNOWLEDGE_COPY.emptyNote);
      return;
    }
    void add('note', { source: 'setup', title: titleOf(text), text });
  };

  const addFile = async (file: File) => {
    if (!TEXT_FILE.test(file.name)) {
      setError(KNOWLEDGE_COPY.notText);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(KNOWLEDGE_COPY.tooBig);
      return;
    }
    setBusy('file');
    const text = await file.text().catch(() => '');
    if (text.trim() === '') {
      setBusy(undefined);
      setError(KNOWLEDGE_COPY.emptyFile);
      return;
    }
    await add('file', { source: 'upload', title: titleOf(file.name), text });
  };

  /** The switch: the item posted again for customers or for the owner alone; it shows what comes back. */
  const changeReaders = async (makePublic: boolean) => {
    if (added === null) return;
    setBusy('switch');
    setSwitchLine(undefined);
    try {
      const stored = await post({ ...added, label: { ...added.label, readers: makePublic ? ['public'] : ['owner'] } });
      setAdded(stored);
      listChanged();
      if (makePublic && !(stored.label.readers ?? []).includes('public')) setSwitchLine(KNOWLEDGE_COPY.keptPrivate);
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      setSwitchLine(isUncertain(err) ? KNOWLEDGE_COPY.switchUnconfirmed : ownerErrorCopy(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <p className="cd-type-summary">{LEAD}</p>
      <WhatIKnow deskId={deskId} timeZone={business.timezone} />
      <KnowledgeAdd
        note={note}
        onNoteChange={setNote}
        onAddNote={addNote}
        onAddFile={(file) => void addFile(file)}
        {...(busy === undefined ? {} : { busy })}
        {...(error === undefined ? {} : { error })}
        {...(added === null
          ? {}
          : {
              added: {
                readers: added.label.readers ?? [],
                onPublicChange: (makePublic: boolean) => void changeReaders(makePublic),
                ...(switchLine === undefined ? {} : { note: switchLine }),
              },
            })}
      />
    </>
  );
}
