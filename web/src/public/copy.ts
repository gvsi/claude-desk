/**
 * The public page's own words, in the visitor's language (the browser's, `browserLanguage()`).
 * Everything else a visitor reads is the kernel's (messages, cards, receipts, the open status) or
 * the design system's (the disclosure, the closed line under the open status, error lines, card
 * labels). Names are passed in as written.
 */
import type { CopyLanguage } from '../ds/index.ts';
import { afterName } from '../lib/names.ts';

export interface PublicCopy {
  /** The composer's name and placeholder. */
  message: (business: string) => string;
  /** The composer's send button. */
  send: string;
  /** The conversation's name for screen readers. */
  conversation: (business: string) => string;
  /**
   * What "Ask for {owner}" sends as the visitor's message; with no owner's name (null), it asks for
   * a person, in the owner's approved words.
   */
  askForOwner: (owner: string | null) => string;
  joined: (name: string) => string;
  /** The owner handed the chat back. */
  claudeIsBack: string;
  reconnecting: string;
  notSent: string;
  tooLong: string;
  tryAgain: string;
  cancelRequest: string;
  /**
   * Beside a request's own line above the composer, while its receipt is out of view: goes back to
   * the request and its "Cancel this request".
   */
  viewRequest: string;
  /** The line once a demo code worked; the design system adds that the verification was simulated. */
  verified: string;
  /** The Demo inbox's place, named as the design system's panel titles it. */
  demoInbox: string;
  /** When the Demo inbox couldn't be read at all while a code is awaited; shown with "Try again". */
  inboxFailed: string;
  /** While the Desk and the chat load. */
  opening: string;
  deskUnavailableTitle: string;
  deskUnavailableBody: string;
}

export const PUBLIC_COPY: Readonly<Record<CopyLanguage, PublicCopy>> = {
  en: {
    message: (business) => `Message ${business}`,
    send: 'Send',
    conversation: (business) => `Conversation with ${business}`,
    askForOwner: (owner) => (owner === null ? "I'd like to talk to a person." : `I'd like to talk to ${owner}${afterName(owner, '.')}`),
    joined: (name) => `${name} joined the chat`,
    claudeIsBack: 'Claude is helping again.',
    reconnecting: 'Reconnecting to the chat',
    notSent: "That didn't send. Your message is still here.",
    tooLong: "That's too long. Shorten it and try again.",
    tryAgain: 'Try again',
    cancelRequest: 'Cancel this request',
    viewRequest: 'View request',
    verified: 'Verified with a code',
    demoInbox: 'Demo inbox',
    inboxFailed: 'Couldn’t open the Demo inbox, where your code arrives.',
    opening: 'Opening the chat',
    deskUnavailableTitle: "This Desk isn't available",
    deskUnavailableBody: 'Check the link, or contact the business another way.',
  },
  es: {
    message: (business) => `Mensaje para ${business}`,
    send: 'Enviar',
    conversation: (business) => `Conversación con ${business}`,
    askForOwner: (owner) => (owner === null ? 'Quiero hablar con una persona.' : `Me gustaría hablar con ${owner}${afterName(owner, '.')}`),
    joined: (name) => `${name} se unió al chat`,
    claudeIsBack: 'Claude vuelve a ayudarte.',
    reconnecting: 'Reconectando con el chat',
    notSent: 'No se envió. Tu mensaje sigue aquí.',
    tooLong: 'Es demasiado largo. Acórtalo e inténtalo de nuevo.',
    tryAgain: 'Intentar de nuevo',
    cancelRequest: 'Cancelar esta solicitud',
    viewRequest: 'Ver solicitud',
    verified: 'Verificado con un código',
    demoInbox: 'Bandeja de demostración',
    inboxFailed: 'No se pudo abrir la bandeja de demostración, donde llega tu código.',
    opening: 'Abriendo el chat',
    deskUnavailableTitle: 'Este Desk no está disponible',
    deskUnavailableBody: 'Revisa el enlace o comunícate con el negocio de otra forma.',
  },
};
