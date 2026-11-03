/**
 * The verification form's own words, in the two languages a visitor reads. They are fixed at build
 * time: the kernel's uniform message is on the verify card above the form, and the form repeats
 * none of it. No line shows a code, and a failure reads the same whatever went wrong.
 */
import type { CopyLanguage } from '../Notice/errorCopy.ts';

export interface VerifyCopy {
  /** The field's label. */
  label: string;
  /** What the empty field asks for: the code, which is always six digits. */
  placeholder: string;
  /** The button that sends the code. It keeps these words while the code is checked. */
  confirm: string;
  /** Why the last code didn't work, alike for a wrong, expired or used-up code. */
  failed: string;
  /** The way out for someone the code doesn't reach: it asks for the owner. */
  cantGetCode: string;
  /** Added to the verified line unless the session is the owner's own: the code came from the Demo inbox. */
  simulated: string;
}

export const VERIFY_COPY = {
  en: {
    label: '6-digit code',
    placeholder: 'Enter the 6-digit code',
    confirm: 'Confirm',
    failed: 'That code didn’t work. Check the newest code, or ask me for a new one.',
    cantGetCode: 'I can’t get the code',
    simulated: 'Simulated verification',
  },
  es: {
    label: 'Código de 6 dígitos',
    placeholder: 'Escribe el código de 6 dígitos',
    confirm: 'Confirmar',
    failed: 'Ese código no funcionó. Revisa el más reciente o pídeme uno nuevo.',
    cantGetCode: 'No me llega el código',
    simulated: 'Verificación simulada',
  },
} as const satisfies Record<CopyLanguage, VerifyCopy>;
