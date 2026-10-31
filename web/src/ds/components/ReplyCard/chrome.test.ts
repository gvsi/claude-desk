import { describe, expect, it } from 'vitest';

import { CLAUSE_TEMPLATES } from '../../../api/contracts.ts';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { CARD_CHROME, MONEY_TEMPLATES, cardChrome } from './chrome.ts';

const LANGUAGES = ['en', 'es'] as const satisfies readonly CopyLanguage[];

/** The note every card about money moving carries, word for word. */
const TEST_PAYMENT = { en: 'Test payment, no money moves', es: 'Pago de prueba, no se mueve dinero' } as const;

describe('CARD_CHROME', () => {
  it('money_cards_say_test_payment', () => {
    // A payment link, a paid link, an agent's charge and a refund all move money.
    expect([...MONEY_TEMPLATES].sort()).toEqual(['charge_confirmed', 'payment_confirmed', 'payment_link', 'refund_issued']);
    for (const template of MONEY_TEMPLATES) {
      for (const language of LANGUAGES) {
        expect(CARD_CHROME[template][language].note, `${template} ${language}`).toBe(TEST_PAYMENT[language]);
      }
    }
  });

  it('only_money_cards_say_test_payment', () => {
    // A card that carries the note is about money moving, so it belongs in MONEY_TEMPLATES.
    for (const template of CLAUSE_TEMPLATES) {
      if (MONEY_TEMPLATES.includes(template)) continue;
      for (const language of LANGUAGES) {
        expect(CARD_CHROME[template][language].note, `${template} ${language}`).not.toBe(TEST_PAYMENT[language]);
      }
    }
  });

  it('a_cancelled_link_moves_no_money', () => {
    // The link_cancelled card has a label in both languages and no note or button: no money moved,
    // so it doesn't say "Test payment", the link is gone, and its label has no amount, date or promise.
    expect(MONEY_TEMPLATES).not.toContain('link_cancelled');
    expect(CARD_CHROME.link_cancelled).toEqual({
      en: { label: 'Payment link cancelled' },
      es: { label: 'Enlace de pago cancelado' },
    });
    for (const language of LANGUAGES) expect(CARD_CHROME.link_cancelled[language].label).not.toMatch(/[0-9$€]/);
  });
});

describe('cardChrome', () => {
  it('service_area_policy_says_service_area', () => {
    // The owner's decision: the policy card for the Desk's service area (the charter claim
    // `policy:service_area`, fact `charter:policy:service_area`) says what it is. Every other policy
    // card stays "Policy", and the other templates are as they were.
    expect(cardChrome('policy', 'en', 'charter:policy:service_area')?.label).toBe('Service area');
    expect(cardChrome('policy', 'es', 'charter:policy:service_area')?.label).toBe('Zona de servicio');
    expect(cardChrome('policy', 'en', 'charter:policy:first_visit')?.label).toBe('Policy');
    expect(cardChrome('policy', 'es', 'charter:policy:arrival')?.label).toBe('Política');
    expect(cardChrome('policy', 'en', null)?.label).toBe('Policy');
    expect(cardChrome('policy', 'en')?.label).toBe('Policy');
    expect(cardChrome('hours', 'en', 'charter:policy:service_area')?.label).toBe('Hours');
  });
});
