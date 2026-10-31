/**
 * Settings › Knowledge (N-Run2-Settings-Knowledge): what Claude answers from, which never changes
 * the owner's rules. A note or a text file is added for the owner only, then the "Added" card's
 * "Customers can see this" switch posts it again for customers or for the owner alone, and shows
 * the readers the kernel returned, never the ones asked for, so an item the kernel keeps to the
 * owner stays off.
 *
 * "What I know now" (`KnowledgeList`) waits on an API that lists a Desk's knowledge to its owner
 * (Open question 1): until it lands, no list is drawn. It goes above "Add something", as the board
 * draws it.
 */
import { useState } from 'react';

import type { KnowledgeItem } from '../../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import { KnowledgeAdd } from '../../ds/index.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';

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
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
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
