import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { expectComputed } from '../../test/expectComputed.ts';
import { KnowledgeAdd } from './KnowledgeAdd.tsx';

/** The note as N-Run2-Settings-Knowledge writes it. */
const NOTE = 'We don’t service tankless water heaters older than 15 years. Suggest a replacement quote instead.';

/** The note's example, which the screen supplies on the plumbing demo only. */
const NOTE_EXAMPLE = "We don't work on gas lines or septic tanks.";

const HINT = 'Up to a few paragraphs. Only you can see it until you make it public.';
const FILES_LINE = 'Text or Markdown files, up to 100 KB.';
const ADDED_LINE = 'Added. Only you can see it until you make it public.';
const TOO_BIG = 'That file is too big. Add files up to 100 KB.';
const EMPTY_NOTE = 'Write the note first, then add it.';

const PRIMARY = 'rgba(250, 249, 245, 0.92)';
const SECONDARY = 'rgba(250, 249, 245, 0.64)';

const meta = {
  title: 'Settings/KnowledgeAdd',
  component: KnowledgeAdd,
  args: { websitePlaceholder: 'turner-plumbing.example/blog', notePlaceholder: NOTE_EXAMPLE, note: NOTE, onNoteChange: fn(), onAddNote: fn(), onAddFile: fn() },
  render: (args) => (
    <div style={{ maxWidth: 720 }}>
      <KnowledgeAdd {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Run2-Settings-Knowledge' },
} satisfies Meta<typeof KnowledgeAdd>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The hidden file input "Add a file" opens. */
function fileInput(root: HTMLElement): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  return input;
}

export const AddSomething: Story = {
  name: 'Add something',
  parameters: { canvasNote: 'The form at the Knowledge column’s 720 px, the note typed as the board writes it, before anything is added.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // knowledge_form_is_a_named_section: its heading names it; nothing was added yet.
    const heading = canvas.getByRole('heading', { level: 2, name: 'Add something' });
    canvas.getByRole('region', { name: 'Add something' });
    await expect(canvas.queryByRole('region', { name: 'Added' })).toBeNull();

    // The note: a text area named "A note", holding what was typed, described by its hint.
    const note = canvas.getByRole('textbox', { name: 'A note' });
    await expect(note.tagName).toBe('TEXTAREA');
    await expect(note).toHaveValue(NOTE);
    await expect(note).toHaveAccessibleDescription(HINT);
    // Its example, the screen's, shows once it is empty.
    await expect(note).toHaveAttribute('placeholder', NOTE_EXAMPLE);
    await expect(Math.round(note.getBoundingClientRect().top - heading.getBoundingClientRect().bottom)).toBe(12 + 21 + 6);

    // The two adds, 12 px under the hint, at a screen's main size and 8 px apart: "Add a note" the
    // view's one primary, "Add a file" secondary and described by the line about files under them.
    const addNote = canvas.getByRole('button', { name: 'Add a note' });
    const addFile = canvas.getByRole('button', { name: 'Add a file' });
    const hint = canvas.getByText(HINT);
    await expect(Math.round(addNote.getBoundingClientRect().top - hint.getBoundingClientRect().bottom)).toBe(12);
    expectComputed(addNote, { height: '40px', backgroundColor: 'rgb(239, 236, 228)', color: 'rgb(28, 27, 25)' });
    expectComputed(addFile, { height: '40px', backgroundColor: 'rgba(250, 249, 245, 0.1)', color: PRIMARY });
    await expect(Math.round(addFile.getBoundingClientRect().left - addNote.getBoundingClientRect().right)).toBe(8);
    await expect(addFile).toHaveAccessibleDescription(FILES_LINE);
    const filesLine = canvas.getByText(FILES_LINE);
    expectComputed(filesLine, { fontSize: '13px', lineHeight: '18px', color: SECONDARY });
    await expect(Math.round(filesLine.getBoundingClientRect().top - addNote.getBoundingClientRect().bottom)).toBe(12);

    // No pill of its own: the screen says the page is a mock, beside its title.
    await expect(canvasElement.querySelector('.cd-pill')).toBeNull();

    // knowledge_note_is_the_screens: typing passes the raw text up; "Add a note" asks the screen to add it.
    await userEvent.type(note, 'x');
    await expect(args.onNoteChange).toHaveBeenLastCalledWith(`${NOTE}x`);
    await userEvent.click(addNote);
    await expect(args.onAddNote).toHaveBeenCalledTimes(1);

    // knowledge_file_goes_to_the_screen: "Add a file" opens the picker for text and Markdown files,
    // and the file picked goes to the screen as it is, unread.
    const input = fileInput(canvasElement);
    await expect(input).toHaveAttribute('accept', '.txt,.md,text/plain,text/markdown');
    let opened = 0;
    input.addEventListener(
      'click',
      (event) => {
        // The test only counts the click: a real picker would open here.
        event.preventDefault();
        opened += 1;
      },
      { once: true },
    );
    await userEvent.click(addFile);
    await expect(opened).toBe(1);
    const file = new File(['# Water heaters\n\nWe service tank and tankless models.'], 'water-heaters.md', { type: 'text/markdown' });
    await userEvent.upload(input, file);
    await expect(args.onAddFile).toHaveBeenCalledTimes(1);
    await expect(args.onAddFile).toHaveBeenCalledWith(file);
    // The input is emptied, so picking the same file again adds it again.
    await expect(input.files?.length ?? 0).toBe(0);
  },
};

export const Added: Story = {
  args: { note: '', added: { readers: ['owner'], onPublicChange: fn() } },
  parameters: { canvasNote: 'The board’s “Added” card under the form, its switch off: the kernel stored the note for the owner only.' },
  play: async ({ args, canvas, userEvent }) => {
    const card = canvas.getByRole('region', { name: 'Added' });
    // 20 px under the form's last line, as the board draws it: 124 px, its words 20 px in.
    const filesLine = canvas.getByText('Claude doesn’t read websites you add in this prototype yet.');
    await expect(Math.round(card.getBoundingClientRect().top - filesLine.getBoundingClientRect().bottom)).toBe(20);
    await expect(Math.round(card.getBoundingClientRect().height)).toBe(124);
    expectComputed(card, { backgroundColor: 'rgba(250, 249, 245, 0.03)', paddingTop: '20px', paddingLeft: '20px' });
    await expect(within(card).getByRole('status')).toHaveTextContent(ADDED_LINE);

    // knowledge_switch_follows_the_returned_label: off while the returned readers are the owner's.
    const toggle = within(card).getByRole('switch', { name: 'Customers can see this' });
    await expect(toggle).toHaveAccessibleDescription('Claude can quote it to visitors when it answers.');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    // The switch's row starts 12 px under the line.
    const line = within(card).getByRole('status');
    await expect(Math.round(toggle.getBoundingClientRect().top - line.getBoundingClientRect().bottom)).toBe(12);
    // Turning it asks the screen to make the item public, and the switch stays as the readers say
    // until the screen passes back what the kernel returned.
    await userEvent.click(toggle);
    await expect(args.added?.onPublicChange).toHaveBeenCalledWith(true);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  },
};

export const AddedPublic: Story = {
  name: 'Added, customers can see it',
  args: { note: '', added: { readers: ['public'], onPublicChange: fn() } },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Settings-Knowledge’s “Added” card once the kernel returned the item with public readers: the switch on, and the line says only “Added.”, since only the owner seeing it is no longer true. The board draws only the off state.',
  },
  play: async ({ args, canvas, userEvent }) => {
    // added_line_stays_true: once customers can see it, the line no longer says only the owner can.
    await expect(canvas.getByRole('status')).toHaveTextContent(/^Added\.$/);
    const toggle = canvas.getByRole('switch', { name: 'Customers can see this' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    await expect(args.added?.onPublicChange).toHaveBeenCalledWith(false);
  },
};

/** Why the kernel kept it private, as the screen words it. */
const KEPT_PRIVATE = 'This note stays private: it includes a customer’s document.';

export const AddedWithANote: Story = {
  name: 'Added, with the screen’s note',
  args: { note: '', added: { readers: ['owner'], onPublicChange: fn(), note: KEPT_PRIVATE } },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Settings-Knowledge’s “Added” card with a line from the screen under the switch, here why the kernel kept the note private. The board draws none; the words are the screen’s.',
  },
  play: async ({ canvas }) => {
    // added_note_is_the_screens: drawn under the switch, in the card, lined up with the switch's words.
    const card = canvas.getByRole('region', { name: 'Added' });
    const note = within(card).getByText(KEPT_PRIVATE);
    const toggle = within(card).getByRole('switch', { name: 'Customers can see this' });
    await expect(Math.round(note.getBoundingClientRect().top - toggle.getBoundingClientRect().bottom)).toBe(8);
    const label = within(toggle).getByText('Customers can see this');
    const noteStart = note.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(note).paddingLeft);
    await expect(Math.round(noteStart)).toBe(Math.round(label.getBoundingClientRect().left));
    expectComputed(note, { fontSize: '14px', lineHeight: '19px', color: SECONDARY });
    // Read out when it comes: it sits in a polite live region that is there from the start.
    await expect(note.closest('[aria-live="polite"]')).not.toBeNull();
  },
};

export const ChangingWhoSeesIt: Story = {
  name: 'Changing who sees it',
  args: { note: NOTE, busy: 'switch', added: { readers: ['owner'], onPublicChange: fn() } },
  parameters: {
    canvas: 'none',
    canvasNote: 'N-Run2-Settings-Knowledge’s form while the switch’s change is being saved: the switch waits, and so do both adds.',
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // switch_waits_while_its_change_is_saved: no callback from the switch or either add, no picker.
    const toggle = canvas.getByRole('switch', { name: 'Customers can see this' });
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(toggle);
    await expect(args.added?.onPublicChange).not.toHaveBeenCalled();
    for (const name of ['Add a note', 'Add a file']) {
      const button = canvas.getByRole('button', { name });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).not.toHaveAttribute('aria-busy');
    }
    let opened = 0;
    fileInput(canvasElement).addEventListener('click', (event) => {
      event.preventDefault();
      opened += 1;
    });
    await userEvent.click(canvas.getByRole('button', { name: 'Add a file' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Add a note' }));
    await expect(opened).toBe(0);
    await expect(args.onAddNote).not.toHaveBeenCalled();
  },
};

export const AddingAFile: Story = {
  name: 'Adding a file',
  args: { note: '', busy: 'file' },
  parameters: { canvas: 'none', canvasNote: 'N-Run2-Settings-Knowledge’s form while a file is being added: “Add a file” spins and “Add a note” waits.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    const addFile = canvas.getByRole('button', { name: 'Add a file' });
    const addNote = canvas.getByRole('button', { name: 'Add a note' });
    await expect(addFile).toHaveAttribute('aria-busy', 'true');
    await expect(addNote).toHaveAttribute('aria-disabled', 'true');
    await expect(addNote).not.toHaveAttribute('aria-busy');
    // Neither does anything while it waits, and no picker opens.
    let opened = 0;
    fileInput(canvasElement).addEventListener('click', (event) => {
      event.preventDefault();
      opened += 1;
    });
    await userEvent.click(addFile);
    await userEvent.click(addNote);
    await expect(opened).toBe(0);
    await expect(args.onAddNote).not.toHaveBeenCalled();
  },
};

export const FileTooBig: Story = {
  name: 'File too big',
  args: { note: '', error: TOO_BIG },
  parameters: { canvas: 'none', canvasNote: 'N-Run2-Settings-Knowledge’s form after a file over 100 KB: the screen’s line under the line about files.' },
  play: async ({ canvas }) => {
    // The screen's words, read out at once, 12 px under the line about files.
    const alert = canvas.getByRole('alert');
    await expect(alert).toHaveTextContent(TOO_BIG);
    const filesLine = canvas.getByText('Claude doesn’t read websites you add in this prototype yet.');
    await expect(Math.round(alert.getBoundingClientRect().top - filesLine.getBoundingClientRect().bottom)).toBe(12);
  },
};

export const Phone: Story = {
  args: { added: { readers: ['owner'], onPublicChange: fn() } },
  render: (args) => (
    <div style={{ maxWidth: 358 }}>
      <KnowledgeAdd {...args} />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'none', canvasNote: 'No phone board for Knowledge yet; N-Run2-Settings-Knowledge’s form and “Added” card in the phone column, 358 px between the gutters.' },
  play: async ({ canvas }) => {
    // Both adds on one line, the switch across the card, and nothing scrolls sideways.
    const addNote = canvas.getByRole('button', { name: 'Add a note' });
    const addFile = canvas.getByRole('button', { name: 'Add a file' });
    await expect(Math.round(addFile.getBoundingClientRect().top)).toBe(Math.round(addNote.getBoundingClientRect().top));
    const toggle = canvas.getByRole('switch', { name: 'Customers can see this' });
    const card = canvas.getByRole('region', { name: 'Added' });
    await expect(Math.round(card.getBoundingClientRect().right - toggle.getBoundingClientRect().right)).toBe(21);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const NoteError: Story = {
  name: 'Note error',
  args: { note: '', noteError: EMPTY_NOTE },
  parameters: { canvas: 'none', canvasNote: 'N-Run2-Settings-Knowledge’s form with the screen’s note validation under the note. The board draws no error.' },
  play: async ({ canvas }) => {
    const note = canvas.getByRole('textbox', { name: 'A note' });
    const error = canvas.getByText(EMPTY_NOTE, { exact: true });
    const website = canvas.getByRole('textbox', { name: 'A website' });
    await expect(note).toHaveAttribute('aria-invalid', 'true');
    await expect(note).toHaveAccessibleDescription(`${EMPTY_NOTE} ${HINT}`);
    await expect(error.closest('.cd-text-field')).toBe(note.closest('.cd-text-field'));
    await expect(error.closest('[aria-live="polite"]')).not.toBeNull();
    await expect(error.getBoundingClientRect().top).toBeGreaterThan(note.getBoundingClientRect().bottom);
    await expect(error.getBoundingClientRect().bottom).toBeLessThan(website.getBoundingClientRect().top);
    await expect(website).not.toHaveAttribute('aria-invalid');
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};
