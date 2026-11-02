import { useState } from 'react';
import { Pill } from '../Pill/Pill.tsx';
import { useId, useRef, type ChangeEvent, type ReactNode } from 'react';

import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { SectionHeader } from '../SectionHeader/SectionHeader.tsx';
import { Switch } from '../Switch/Switch.tsx';
import { TextField } from '../TextField/TextField.tsx';

import './KnowledgeAdd.css';

/** The item just added, as the kernel's answer returned it. */
export interface KnowledgeAddedView {
  /**
   * The returned item's `label.readers`, never the ones asked for: the switch is on only when they
   * include "public", so an item the kernel keeps to the owner stays off.
   */
  readers: readonly string[];
  /**
   * The switch was turned: `true` to let customers see the item, `false` to keep it to the owner.
   * The screen re-posts the item with readers `["public"]` or `["owner"]` and passes back the
   * readers the answer returns.
   */
  onPublicChange: (makePublic: boolean) => void;
  /**
   * A line from the screen under the switch, in its own words: why the kernel kept the item to the
   * owner ("This note stays private: it includes a customer’s document."), or why a change didn't
   * go through. The design system writes none of it.
   */
  note?: ReactNode;
}

export interface KnowledgeAddProps {
  /** The note, as typed. */
  note: string;
  /** Each change to the note, with the raw text. */
  onNoteChange: (note: string) => void;
  /** "Add a note": the screen checks the note it holds and adds it for the owner only. */
  onAddNote: () => void;
  /**
   * A file picked with "Add a file", as the browser gives it: the screen checks it (text or
   * Markdown, up to 100 KB), reads it and adds it for the owner only.
   */
  onAddFile: (file: File) => void;
  /**
   * What is in flight: an add (its button spins and the other waits), or the switch's change (the
   * switch waits, and so do both adds).
   */
  busy?: 'note' | 'file' | 'switch';
  /** What went wrong, in the screen's plain words, never a code: "That file is too big. Add files up to 100 KB." */
  error?: string;
  /** The item just added: the "Added" card with its "Customers can see this" switch. */
  added?: KnowledgeAddedView;
}

/** The files "Add a file" offers: text and Markdown. */
const FILE_TYPES = '.txt,.md,text/plain,text/markdown';

/**
 * "Add something" on Knowledge: a note to type and add, or a text or Markdown file to
 * pick, and once the kernel has stored it, an "Added" card whose switch lets customers see it. The
 * switch, and the line above it, show the readers the kernel returned. Nothing here reads, checks or
 * sends anything: the screen does, and passes back what came of it.
 */
export function KnowledgeAdd({ note, onNoteChange, onAddNote, onAddFile, busy, error, added }: KnowledgeAddProps) {
  const [website, setWebsite] = useState('');
  const ids = useId();
  const headingId = `${ids}-heading`;
  const filesId = `${ids}-files`;
  const picker = useRef<HTMLInputElement>(null);
  const inFlight = busy !== undefined;

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Emptied, so picking the same file again is a new pick.
    event.target.value = '';
    if (file !== undefined) onAddFile(file);
  };

  return (
    <div className="cd-knowledge-add">
      <section className="cd-knowledge-add__form" aria-labelledby={headingId}>
        <SectionHeader id={headingId} title="Add something" />
        <TextField label="A note" value={note} onChange={onNoteChange} multiline hint="Up to a few paragraphs. Only you can see it until you make it public." />
        <div className="cd-knowledge-add__actions">
          <Button variant="primary" size="main" busy={busy === 'note'} waiting={inFlight} onClick={() => onAddNote()}>
            Add a note
          </Button>
          <Button variant="secondary" size="main" busy={busy === 'file'} waiting={inFlight} describedBy={filesId} onClick={() => picker.current?.click()}>
            Add a file
          </Button>
          <input ref={picker} type="file" accept={FILE_TYPES} hidden tabIndex={-1} onChange={picked} />
        </div>
        <p id={filesId} className="cd-knowledge-add__files cd-type-caption">
          Text or Markdown files, up to 100 KB.
        </p>
        <TextField label="A website" placeholder="turner-plumbing.example/blog" value={website} onChange={setWebsite} />
        <div className="cd-knowledge-add__actions">
          <Button variant="secondary" size="main">Add a website</Button>
          <Pill>Mock</Pill>
        </div>
        <p className="cd-knowledge-add__files cd-type-caption">Claude doesn’t read websites you add in this prototype yet.</p>
        {error !== undefined && error !== '' ? <Notice tone="error">{error}</Notice> : null}
      </section>
      {added !== undefined ? (
        <Card as="section" label="Added">
          {/* Only while it is the owner's alone does the line say so. */}
          <Notice tone="info">{added.readers.includes('public') ? 'Added.' : 'Added. Only you can see it until you make it public.'}</Notice>
          <div className="cd-knowledge-add__switch">
            <Switch
              label="Customers can see this"
              description="Claude can quote it to visitors when it answers."
              checked={added.readers.includes('public')}
              onChange={(next) => added.onPublicChange(next)}
              waiting={busy === 'switch'}
              disabled={inFlight}
            />
          </div>
          {/* Always there, so the screen's line is read out when it comes. */}
          <div className="cd-knowledge-add__note cd-type-meta" aria-live="polite">
            {added.note}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
