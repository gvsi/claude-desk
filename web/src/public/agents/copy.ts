/**
 * The agents page's own words, in the visitor's language (the browser's, `browserLanguage()`).
 * Everything else on the page is the kernel's (what agents can do here, the Desk's replies and
 * receipts), the API's code-built Agent Card (the address, how requests are signed, the example
 * request), the design system's (the disclosure, error lines) or the public page's own (`PUBLIC_COPY`:
 * a Desk that isn't there, "Try again"). Names are passed in as written.
 *
 * The spending limit is static copy, never formatted from a number: `limit` holds the signed limit
 * panel's words for the Rivera seed's demo mandate ($20 a charge, $100 in total, for one hour), and
 * `copy.test.ts` ties the amounts to it.
 */
import { Fragment, createElement, type ReactNode } from 'react';

import type { DemoTaskSet } from '../../api/views.ts';
import { AGENT_START_RETRY_COPY, type CopyLanguage } from '../../ds/index.ts';

/** The built-in agent's tasks, as the API names them (`send_agent {task}`). */
export const DEMO_TASKS = ['book_visit', 'quote_and_deposit', 'push_the_limit'] as const;

export type DemoTask = (typeof DEMO_TASKS)[number];

export type { DemoTaskSet };

/** The set whose words the panel shows when the Desk's set can't be read: plain words for any business. */
export const FALLBACK_TASK_SET: DemoTaskSet = 'other';

/**
 * Each task's chip in each set, and the title of the agent's first request once it is sent. The sets
 * are the API's (`agent_tasks {task_set}`, plan 09, C2): Rivera's seed keeps its own, and every other
 * Desk takes its setup business type's. A set the API adds has no words here, and fails to compile.
 */
export const DEMO_TASK_COPY: Readonly<Record<CopyLanguage, Readonly<Record<DemoTaskSet, Readonly<Record<DemoTask, string>>>>>> = {
  en: {
    rivera: {
      book_visit: 'Book the earliest visit',
      quote_and_deposit: 'Get a quote and pay the service call deposit',
      push_the_limit: 'Try to pay more than its limit',
    },
    trade: {
      book_visit: 'Book the earliest visit',
      quote_and_deposit: 'Pay up front, within its limit',
      push_the_limit: 'Try to pay more than its limit',
    },
    office: {
      book_visit: 'Book the earliest consult',
      quote_and_deposit: 'Pay up front, within its limit',
      push_the_limit: 'Try to pay more than its limit',
    },
    landlord: {
      book_visit: 'Book the earliest viewing',
      quote_and_deposit: 'Pay up front, within its limit',
      push_the_limit: 'Try to pay more than its limit',
    },
    other: {
      book_visit: 'Book the earliest appointment',
      quote_and_deposit: 'Pay up front, within its limit',
      push_the_limit: 'Try to pay more than its limit',
    },
  },
  es: {
    rivera: {
      book_visit: 'Reservar la primera visita libre',
      quote_and_deposit: 'Pedir un presupuesto y pagar el depósito de la visita',
      push_the_limit: 'Intentar pagar más de su límite',
    },
    trade: {
      book_visit: 'Reservar la primera visita libre',
      quote_and_deposit: 'Pagar por adelantado, dentro de su límite',
      push_the_limit: 'Intentar pagar más de su límite',
    },
    office: {
      book_visit: 'Reservar la primera consulta libre',
      quote_and_deposit: 'Pagar por adelantado, dentro de su límite',
      push_the_limit: 'Intentar pagar más de su límite',
    },
    landlord: {
      book_visit: 'Reservar la primera visita libre a un departamento',
      quote_and_deposit: 'Pagar por adelantado, dentro de su límite',
      push_the_limit: 'Intentar pagar más de su límite',
    },
    other: {
      book_visit: 'Reservar la primera cita libre',
      quote_and_deposit: 'Pagar por adelantado, dentro de su límite',
      push_the_limit: 'Intentar pagar más de su límite',
    },
  },
};

/** The sets the page has words for: every set the API names. */
export const DEMO_TASK_SETS = Object.keys(DEMO_TASK_COPY.en) as readonly DemoTaskSet[];

export function isDemoTaskSet(value: unknown): value is DemoTaskSet {
  return typeof value === 'string' && (DEMO_TASK_SETS as readonly string[]).includes(value);
}

/** How a request is signed, one line each, with the API's values as written. */
export interface SigningLabels {
  headers: string;
  payloadFields: string;
  canonical: string;
  algorithm: string;
  encoding: string;
  timeWindow: string;
}

export interface AgentsCopy {
  /** The page's title, after the business's name. */
  forAgents: string;
  backToChat: string;
  opening: string;

  canDoTitle: string;
  /** When the Desk lists nothing yet. */
  canDoEmpty: string;

  proveTitle: string;
  proveLines: readonly string[];

  connectTitle: string;
  connectLead: string;
  copyAddress: string;
  signing: SigningLabels;
  /** The time window's words: whole minutes, else seconds. */
  window: (seconds: number) => string;
  exampleRequest: string;

  demoKeyTitle: string;
  /** Under the demo key card's title: both keys stand in for someone else's. */
  simulated: string;
  getDemoKey: string;
  keyId: string;
  privateKey: string;
  copyKey: string;
  shownOnce: string;

  sendTitle: string;
  /**
   * The panel's lead before a run: who the agent visits, and for whom. The chosen task replaces it.
   * `business` is the business's name, marked as its own words by the caller.
   */
  sendLead: (business: ReactNode) => ReactNode;
  /** The agent's signed spending limit, in `SignedLimitPanel`'s props. Static: the only amounts on the page. */
  limit: { perCharge: string; total: string; duration: string; source: string };
  tasksLabel: string;
  agentName: string;
  signedRequest: string;
  request: (n: number) => string;
  /** The run's name for screen readers. */
  conversation: string;
  working: string;
  finished: string;
  stopped: string;
  busy: string;
}

export const AGENTS_COPY: Readonly<Record<CopyLanguage, AgentsCopy>> = {
  en: {
    forAgents: 'for AI agents',
    backToChat: 'Back to the chat',
    opening: 'Opening the page for AI agents',

    canDoTitle: 'What agents can do here',
    canDoEmpty: 'Nothing is listed here yet. An agent can still ask what this Desk can help with.',

    proveTitle: 'How agents prove who they are',
    proveLines: [
      'Every request is signed with the agent’s own key and checked before anything else.',
      'Agents get what a public visitor gets, and pay only within a limit their owner’s wallet signed.',
      'To act for a customer on record, the agent asks for a code and sends it back as verify_code.',
      'No refunds go to agents.',
      'Every answer says it comes from Claude, an AI.',
    ],

    connectTitle: 'Connect your own agent',
    connectLead: 'Connecting your own Claude means pointing an A2A client at this address. It isn’t a ready-made connector.',
    copyAddress: 'Copy address',
    signing: {
      headers: 'Headers',
      payloadFields: 'Payload fields',
      canonical: 'Canonical form',
      algorithm: 'Algorithm',
      encoding: 'Encoding',
      timeWindow: 'Time window',
    },
    window: (seconds) => {
      if (seconds % 60 !== 0) return seconds === 1 ? '1 second' : `${seconds} seconds`;
      const minutes = seconds / 60;
      return minutes === 1 ? '1 minute' : `${minutes} minutes`;
    },
    exampleRequest: 'Example request',

    demoKeyTitle: 'Try it with a demo key',
    simulated: 'Simulated in this demo: the built-in agent and its wallet stand in for someone else’s. Neither key is a business credential.',
    getDemoKey: 'Get a demo key',
    keyId: 'Key id',
    privateKey: 'Private key',
    copyKey: 'Copy key',
    shownOnce: 'Shown once. It’s a demo key for this Desk, not a business credential.',

    sendTitle: 'Send an agent',
    sendLead: (business) => createElement(Fragment, null, 'A built-in agent visits ', business, ' for Alex Kim. It’s simulated.'),
    limit: { perCharge: '$20', total: '$100', duration: 'One hour', source: 'Signed limit from Alex Kim’s demo wallet' },
    tasksLabel: 'Tasks for the agent',
    agentName: 'Alex Kim’s assistant',
    signedRequest: 'Signed request',
    request: (n) => `Request ${n}`,
    conversation: 'Alex Kim’s assistant’s visit',
    working: 'Alex Kim’s assistant is at work',
    finished: 'The agent finished.',
    stopped: 'The agent stopped before finishing. Try again.',
    busy: 'The demo agent is busy. Try again in a minute.',
  },
  es: {
    forAgents: 'para agentes de IA',
    backToChat: 'Volver al chat',
    opening: 'Abriendo la página para agentes de IA',

    canDoTitle: 'Qué pueden hacer los agentes aquí',
    canDoEmpty: 'Todavía no hay nada en esta lista. Un agente puede preguntar en qué ayuda este Desk.',

    proveTitle: 'Cómo demuestran los agentes quiénes son',
    proveLines: [
      'Cada solicitud va firmada con la clave propia del agente y se revisa antes que nada.',
      'Los agentes reciben lo mismo que un visitante público y solo pagan dentro de un límite que firmó la billetera de su dueño.',
      'Para actuar por un cliente registrado, el agente pide un código y lo devuelve como verify_code.',
      'Los agentes no reciben reembolsos.',
      'Cada respuesta dice que viene de Claude, una IA.',
    ],

    connectTitle: 'Conecta tu propio agente',
    connectLead: 'Conectar tu propio Claude es apuntar un cliente A2A a esta dirección. No es un conector listo para usar.',
    copyAddress: 'Copiar dirección',
    signing: {
      headers: 'Encabezados',
      payloadFields: 'Campos firmados',
      canonical: 'Forma canónica',
      algorithm: 'Algoritmo',
      encoding: 'Codificación',
      timeWindow: 'Ventana de tiempo',
    },
    window: (seconds) => {
      if (seconds % 60 !== 0) return seconds === 1 ? '1 segundo' : `${seconds} segundos`;
      const minutes = seconds / 60;
      return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
    },
    exampleRequest: 'Ejemplo de solicitud',

    demoKeyTitle: 'Pruébalo con una clave de demostración',
    simulated: 'Simulado en esta demostración: el agente integrado y su billetera hacen las veces de los de otra persona. Ninguna de las claves es una credencial del negocio.',
    getDemoKey: 'Obtener una clave de demostración',
    keyId: 'Id de la clave',
    privateKey: 'Clave privada',
    copyKey: 'Copiar clave',
    shownOnce: 'Se muestra una sola vez. Es una clave de demostración para este Desk, no una credencial del negocio.',

    sendTitle: 'Enviar un agente',
    sendLead: (business) => createElement(Fragment, null, 'Un agente integrado visita ', business, ' en nombre de Alex Kim. Es simulado.'),
    limit: { perCharge: '$20', total: '$100', duration: 'Una hora', source: 'Límite firmado por la billetera de demostración de Alex Kim' },
    tasksLabel: 'Tareas para el agente',
    agentName: 'Asistente de Alex Kim',
    signedRequest: 'Solicitud firmada',
    request: (n) => `Solicitud ${n}`,
    conversation: 'La visita del asistente de Alex Kim',
    working: 'El asistente de Alex Kim está trabajando',
    finished: 'El agente terminó.',
    stopped: 'El agente se detuvo antes de terminar. Inténtalo de nuevo.',
    busy: 'El agente de demostración está ocupado. Inténtalo de nuevo en un minuto.',
  },
};

/**
 * The line beside "Try again" when the answer to sending the agent was lost: the send may have
 * started it, and "Try again" sends it again with the same key, which finds the run if it did. The
 * design system's retry-safe line; `AGENT_START_LOST_COPY` stays the reload fallback's.
 */
export function agentStartLostLine(language: CopyLanguage): string {
  return AGENT_START_RETRY_COPY[language];
}
