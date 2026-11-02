/**
 * Knowledge (N-Run2-Settings-Knowledge): what Claude answers from, which never changes
 * the owner's rules. "What Claude knows" lists what the owner may see, each item with when it was
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
import type { KnowledgeRow } from '../../api/views.ts';
import { Button, KnowledgeAdd, KnowledgeList, LoadingLine, NAV_LABELS, Notice, PageHeader, errorCopy, type KnowledgeRowView } from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { formatDate } from '../../lib/format.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { startingDeskFor } from '../arrival/keptCopy.ts';
import { VisionNote } from '../settings/VisionNote.tsx';
import { MOCK_SOURCES, MORE_SOURCES, SAMPLE_QUESTIONS } from './previewSources.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { useDesks } from '../useDesks.ts';

import '../settings/Settings.css';
import './Knowledge.css';

export const KNOWLEDGE_SUMMARY = 'What Claude answers from. It never changes your rules.';

/** The largest file "Add a file" takes: 100 KB. */
export const MAX_FILE_BYTES = 100 * 1024;

/** The files "Add a file" takes, by name: text and Markdown. */
const TEXT_FILE = /\.(?:txt|md)$/i;

/** The maximum title length, including an ellipsis when shortened. */
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
 * The list's rows in API order, each with when it was added on the business's clock. An item whose
 * title or text the kernel withheld is drawn as the design system draws one it keeps to the owner:
 * no title, no words, "Only you".
 */
function rowsOf(items: readonly KnowledgeRow[], timeZone: string): KnowledgeRowView[] {
  return items.map((item) => {
    const date = item.created_at === null ? '' : formatDate(item.created_at, timeZone);
    const kind = item.source === 'website' || item.source === 'web_search' ? 'globe' : item.source === 'upload' ? 'document' : item.item_id === 'kn-price-list' ? 'list' : 'note';
    const label = kind === 'globe' ? 'Website' : kind === 'document' ? 'File' : kind === 'list' ? 'Price list' : 'Note';
    const fileTag = kind === 'document' && /\.pdf$/i.test(item.title ?? '') ? 'PDF' : kind === 'document' && /\.docx$/i.test(item.title ?? '') ? 'DOCX' : undefined;
    return {
      id: item.item_id,
      kind,
      ...(fileTag === undefined ? {} : { fileTag }),
      title: item.title === null || item.text === null ? null : item.title,
      detail: [label, ...(item.source === 'website' ? ['Read during setup'] : []), ...(date === '' ? [] : [`Added ${date}`])].join(' · '),
      readers: item.readers,
    };
  });
}

/** "What Claude knows": the list once read, the loading line while it is, and a failed read with Try again over it. */
function WhatIKnow({ deskId, timeZone }: { deskId: string; timeZone: string }) {
  const list = useQuery(knowledgeQuery(deskId));
  const failure = useReadFailure(list);
  const desks = useDesks(deskId, { passive: true });
  const queryClient = useQueryClient();
  const samples = desks.data !== undefined && startingDeskFor(queryClient, desks.data) === deskId ? MOCK_SOURCES : [];
  const rows = [...rowsOf(list.data ?? [], timeZone), ...samples];
  const publicCount = rows.filter((item) => item.title !== null && item.readers.includes('public')).length;
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
        <KnowledgeList items={rows} caption={`${rows.length} ${rows.length === 1 ? 'source' : 'sources'}. Customers can see ${publicCount}.`} />
      )}
    </>
  );
}

/** What a shortened title drops from its end before the ellipsis: spaces, sentence punctuation and dashes. */
const TITLE_CUT_END = /[\s.,;:!?\-–—]+$/u;

/**
 * A title within `TITLE_LENGTH` characters: text that fits is kept whole; longer text is shortened at
 * a word when possible and ends in "…", without the punctuation or dash its last word ended with.
 */
function titleOf(text: string): string {
  const characters = [...text];
  if (characters.length <= TITLE_LENGTH) return text;
  const prefix = characters.slice(0, TITLE_LENGTH - 1);
  const space = prefix.lastIndexOf(' ');
  const cut = (space === -1 ? prefix : prefix.slice(0, space)).join('');
  return `${cut.replace(TITLE_CUT_END, '')}…`;
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
  useDocumentTitle(inApp(NAV_LABELS.knowledge));
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const queryClient = useQueryClient();
  /** The list is read again after anything is added or changed. */
  const listChanged = async () => {
    await queryClient.cancelQueries({ queryKey: knowledgeKey(deskId) });
    void queryClient.invalidateQueries({ queryKey: knowledgeKey(deskId) });
  };
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<Busy | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // The item as the kernel last returned it: what the "Added" card and its switch show.
  const [added, setAdded] = useState<KnowledgeItem | null>(null);
  const [switchLine, setSwitchLine] = useState<string | undefined>(undefined);
  // An unconfirmed item keeps its id for a retry. A confirmed add clears it, so deliberately
  // adding the same words again creates a new item and cannot change the first item's readers.
  const [posted, setPosted] = useState<KnowledgeItem | null>(null);
  // A write is out, or being read back: one at a time, so no answer lands on another's card.
  const writing = useRef(false);

  const post = (item: KnowledgeItem) => request('addKnowledge', { params: { desk_id: deskId }, body: { item } });

  /**
   * After a write whose answer was lost: the item as a fresh read of the list has it, `missing` when
   * the list doesn't, or null when it can't be read either, so the outcome stays unknown. A read
   * already in flight may have left before the write landed, so it is cancelled and a new one sent.
   */
  const readBack = async (itemId: string): Promise<KnowledgeRow | 'missing' | null> => {
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
   * and change waits, the switch included, until the write and any read back finish.
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
      setPosted(null);
      setAdded(stored);
      if (kind === 'note') setNote((current) => (current.trim() === item.text ? '' : current));
      setSwitchLine(undefined);
      await listChanged();
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
        setPosted(null);
        setAdded({ ...item, label: { readers: now.readers } });
        if (kind === 'note') setNote((current) => (current.trim() === item.text ? '' : current));
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
    if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
      setError(errorCopy('invalid'));
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
        text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        setError(KNOWLEDGE_COPY.unreadable);
        return;
      }
      if (text.includes('\0')) {
        setError(KNOWLEDGE_COPY.unreadable);
        return;
      }
      if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
        setError(KNOWLEDGE_COPY.tooBig);
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
        await listChanged();
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
        const label = { readers: now.readers };
        show(label);
        setSwitchLine(makePublic && !now.readers.includes('public') && now.title !== null ? errorCopy('invalid') : lineFor(label));
      }
    });
  };

  return (
    <>
      <PageHeader title={NAV_LABELS.knowledge} subtitle={KNOWLEDGE_SUMMARY} />
      <div className="cd-knowledge">
        <div className="cd-knowledge__known"><WhatIKnow deskId={deskId} timeZone={business.timezone} /></div>
        <div className="cd-knowledge__add">
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
        </div>
        <KnowledgePreviews />
      </div>
    </>
  );
}

/** Static examples share the real source list’s card and row markup. */
export function KnowledgePreviews() {
  return <div className="cd-knowledge__previews">
    <KnowledgeList title="Questions Claude couldn’t answer" items={SAMPLE_QUESTIONS} note={<VisionNote>Sample questions, to show what this will do. It doesn’t work in this prototype yet.</VisionNote>} />
    <KnowledgeList title="More sources" items={MORE_SOURCES} note={<VisionNote>Connecting these doesn’t work in this prototype yet.</VisionNote>} />
  </div>;
}
