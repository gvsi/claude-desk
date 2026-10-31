/**
 * Settings › Knowledge (N-Run2-Settings-Knowledge): what Claude answers from, which never changes
 * the owner's rules. "What I know now" lists what the owner may see, each item with when it was
 * added and who can see it; one the kernel forces owner-only comes with its title and text withheld
 * and reads "A note only you can see". Under it, a note or a text file is added for the owner only,
 * then the "Added" card's "Customers can see this" switch posts it again for customers or for the
 * owner alone, and shows the readers the kernel returned, never the ones asked for, so an item the
 * kernel keeps to the owner stays off.
 */
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import type { KnowledgeItem } from '../../api/contracts.ts';
import { ApiError, isUncertain, newIdempotencyKey, ownerErrorCopy, request } from '../../api/http.ts';
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
  /** The browser couldn't read the file: never called empty. */
  unreadable: "We couldn't read that file. Pick it again.",
  /** An add whose answer was lost, and the list read back doesn't have it: it didn't go through. */
  notAdded: "That wasn't added. Add it again.",
  /**
   * An add whose answer was lost, and the list couldn't be read either: it may have gone through.
   * Adding it again posts the same item, which replaces it.
   */
  unconfirmed: "We couldn't confirm that it was added. Add it again: it won't be added twice.",
  /** Asked to be public, answered owner-only: the kernel keeps it to the owner. */
  keptPrivate: 'This stays private. Only you can see it.',
  /** Asked to be the owner's alone, still public when read back: the change didn't go through. */
  stillPublic: "That change didn't go through. Customers can still see this.",
  /** A change whose answer was lost, and the list couldn't be read either: the switch stays as it was. */
  switchUnconfirmed: "We couldn't confirm that change. Turn it again to make sure.",
} as const;

type Busy = 'note' | 'file' | 'switch';

/** A Desk's knowledge, as the owner may see it. Query keys start with the route key. */
const knowledgeKey = (deskId: string) => ['knowledge', deskId] as const;
const knowledgeQuery = (deskId: string) =>
  queryOptions({ queryKey: knowledgeKey(deskId), queryFn: () => request('knowledge', { params: { desk_id: deskId } }) });

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
  const list = useQuery(knowledgeQuery(deskId));
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

/**
 * A fresh id for an item: `note-<uuid>` or `file-<uuid>`, a random UUID even on a page not served
 * securely, which has no `crypto.randomUUID`.
 */
function newId(kind: 'note' | 'file'): string {
  return `${kind}-${newIdempotencyKey()}`;
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
  // A write is out, or being read back: one at a time, so no answer lands on another's card.
  const writing = useRef(false);

  const post = (item: KnowledgeItem) => request('addKnowledge', { params: { desk_id: deskId }, body: { item } });

  /**
   * After a write whose answer was lost: the item as a fresh read of the list has it, `missing` when
   * the list doesn't, or null when it can't be read either, so the outcome stays unknown. A read
   * already in flight may have left before the write landed, so it is cancelled and a new one sent.
   */
  const readBack = async (itemId: string): Promise<KnowledgeListItem | 'missing' | null> => {
    try {
      await queryClient.cancelQueries({ queryKey: knowledgeKey(deskId) });
      const items = await queryClient.fetchQuery({ ...knowledgeQuery(deskId), staleTime: 0 });
      return items.find((item) => item.item_id === itemId) ?? 'missing';
    } catch {
      return null;
    }
  };

  /**
   * Runs one write, `kind` busy until it and any read back are done; while it runs, every other add
   * and change is ignored, the switch's included, which the design system doesn't hold during an add.
   */
  const exclusive = async (kind: Busy, write: () => Promise<void>) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(kind);
    try {
      await write();
    } finally {
      writing.current = false;
      setBusy(undefined);
    }
  };

  /** Adds `fields` for the owner only, under the id it was posted with before if it is the same. */
  const add = async (kind: 'note' | 'file', fields: Omit<KnowledgeItem, 'item_id' | 'label'>) => {
    const ownerOnly = { ...fields, label: { readers: ['owner'] } };
    const item: KnowledgeItem = { item_id: posted !== null && sameItem(posted, ownerOnly) ? posted.item_id : newId(kind), ...ownerOnly };
    setPosted(item);
    setError(undefined);
    try {
      const stored = await post(item);
      setAdded(stored);
      setSwitchLine(undefined);
      listChanged();
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      if (!isUncertain(err)) {
        setError(ownerErrorCopy(err));
        return;
      }
      // It may have gone through: the list, read again, says whether it did and how it's labelled.
      const now = await readBack(item.item_id);
      if (now === null) setError(KNOWLEDGE_COPY.unconfirmed);
      else if (now === 'missing') setError(KNOWLEDGE_COPY.notAdded);
      else {
        // The list may withhold its words; the card keeps the ones posted, with the label read back.
        setAdded({ ...item, label: now.label });
        setSwitchLine(undefined);
      }
    }
  };

  const addNote = () => {
    const text = note.trim();
    if (text === '') {
      setError(KNOWLEDGE_COPY.emptyNote);
      return;
    }
    void exclusive('note', () => add('note', { source: 'setup', title: titleOf(text), text }));
  };

  const addFile = (file: File) => {
    if (!TEXT_FILE.test(file.name)) {
      setError(KNOWLEDGE_COPY.notText);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(KNOWLEDGE_COPY.tooBig);
      return;
    }
    void exclusive('file', async () => {
      let text: string;
      try {
        text = await file.text();
      } catch {
        setError(KNOWLEDGE_COPY.unreadable);
        return;
      }
      if (text.trim() === '') {
        setError(KNOWLEDGE_COPY.emptyFile);
        return;
      }
      await add('file', { source: 'upload', title: titleOf(file.name), text });
    });
  };

  /** The switch: the item posted again for customers or for the owner alone; it shows what comes back. */
  const changeReaders = (makePublic: boolean) => {
    const card = added;
    if (card === null) return;
    void exclusive('switch', async () => {
      setSwitchLine(undefined);
      /** The card's label, as an answer or a read back gave it, if the card still shows this item. */
      const show = (label: KnowledgeItem['label']) => setAdded((now) => (now?.item_id === card.item_id ? { ...now, label } : now));
      /** What the label says against what was asked: nothing when they agree. */
      const lineFor = (label: KnowledgeItem['label']) => {
        const isPublic = (label.readers ?? []).includes('public');
        if (isPublic === makePublic) return undefined;
        return makePublic ? KNOWLEDGE_COPY.keptPrivate : KNOWLEDGE_COPY.stillPublic;
      };
      try {
        const stored = await post({ ...card, label: { ...card.label, readers: makePublic ? ['public'] : ['owner'] } });
        show(stored.label);
        setSwitchLine(lineFor(stored.label));
        listChanged();
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'unauthorized') return;
        if (!isUncertain(err)) {
          setSwitchLine(ownerErrorCopy(err));
          return;
        }
        // It may have gone through: the list, read again, says how the item is labelled now. If it
        // can't be read, the switch stays where it was and says it couldn't confirm the change.
        const now = await readBack(card.item_id);
        if (now === null || now === 'missing') {
          setSwitchLine(KNOWLEDGE_COPY.switchUnconfirmed);
          return;
        }
        show(now.label);
        setSwitchLine(lineFor(now.label));
      }
    });
  };

  return (
    <>
      <p className="cd-type-summary">{LEAD}</p>
      <WhatIKnow deskId={deskId} timeZone={business.timezone} />
      <KnowledgeAdd
        note={note}
        onNoteChange={setNote}
        onAddNote={addNote}
        onAddFile={addFile}
        {...(busy === undefined ? {} : { busy })}
        {...(error === undefined ? {} : { error })}
        {...(added === null
          ? {}
          : {
              added: {
                readers: added.label.readers ?? [],
                onPublicChange: changeReaders,
                ...(switchLine === undefined ? {} : { note: switchLine }),
              },
            })}
      />
    </>
  );
}
