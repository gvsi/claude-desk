/** Settings › General's words: the Appearance choice, and what deleting a Desk does. */
import type { ThemeChoice } from '../../lib/theme.ts';

/** The theme chosen in this browser: its heading, what it does, and each choice in order. */
export const APPEARANCE_COPY = {
  title: 'Appearance',
  line: 'System follows your device. Your choice is saved in this browser.',
  options: [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ],
} as const satisfies { title: string; line: string; options: readonly { value: ThemeChoice; label: string }[] };

/** What deleting a Desk does, beside its button and in the dialog that asks first. */
export const DELETE_LINE = 'Its public link stops working and its chats close. Its safety record is kept.';
