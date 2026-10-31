/**
 * The mock's setup interview, driven the way its handlers drive it: the business's name it reads
 * from the owner's description, the way a reader would, and the slug and first question that follow.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { SetupState } from '../api/views.ts';
import { mockStore } from './store.ts';

/** A new interview from `description`, with what the new Desk is called and Claude's first words. */
async function started(description: string): Promise<{ business: string | undefined; slug: string; first: string | undefined }> {
  const answer = await mockStore.dispatch('startSetup', { body: { description, timezone: 'America/Los_Angeles' } });
  if ('network' in answer || answer.status !== 201) throw new Error('the mock starts a setup');
  const state = answer.body as SetupState;
  const desk = mockStore.world.desks.find((d) => d.summary.desk_id === state.desk_id);
  return { business: desk?.summary.business_name, slug: state.slug, first: state.messages[0]?.text };
}

beforeEach(() => {
  mockStore.reset('rivera');
});

describe("the business's name, from the description", () => {
  it('a_phrase_like_i_run_names_the_business', async () => {
    // The owner introduces themselves first: the business is the one they say they run, not "I'm Ana".
    const ana = await started("I'm Ana. I run Ana's Bakery in Oakland. Sourdough and cakes to order.");
    expect(ana.business).toBe("Ana's Bakery");
    expect(ana.slug).toBe('ana-s-bakery-setup1');
    expect(ana.first).toMatch(/^Thanks, Ana\. .* about Ana's Bakery\?/);

    // "We run" and "I own" name it too, up to a comma, " on " or the sentence's end.
    expect((await started("We run Rivera Plumbing, a two-van crew. I'm Maria.")).business).toBe('Rivera Plumbing');
    expect((await started("I'm Lee and I own Acme Bakery on Main Street.")).business).toBe('Acme Bakery');
    expect((await started('Hello, I am Sam and I own Kernel Plumbing')).business).toBe('Kernel Plumbing');

    // Still cut to 60 characters.
    const long = await started("I'm Maria. I run Rivera Plumbing, Heating and Emergency Drain Services of the East Bay.");
    expect(long.business).toBe('Rivera Plumbing');
    const longer = await started("I'm Maria. I run Rivera Plumbing Heating and Emergency Drain Services of the East Bay.");
    expect(longer.business).toBe('Rivera Plumbing Heating and Emergency Drain Services of the');
  });

  it('a_phrase_like_is_my_shop_names_the_business', async () => {
    const ana = await started("Hi, I'm Ana. Ana's Bakery is my shop in Oakland.");
    expect(ana.business).toBe("Ana's Bakery");
    expect(ana.slug).toBe('ana-s-bakery-setup1');
    expect(ana.first).toMatch(/^Thanks, Ana\. .* about Ana's Bakery\?/);
    // Any of the words for a business, mine or ours; a curly apostrophe stays the owner's.
    expect((await started('My name is Maria. Rivera Plumbing is our business.')).business).toBe('Rivera Plumbing');
    expect((await started('I’m Lee. Lee’s Café is my café, on Main Street.')).business).toBe('Lee’s Café');
    // Not every "is my …": a day off names nothing, so the first sentence does.
    expect((await started('Acme Bakery. Sunday is my day off.')).business).toBe('Acme Bakery');
  });

  it('else_the_first_sentence_that_is_not_an_introduction', async () => {
    const rivera = await started("Rivera Plumbing. I'm Maria, a licensed plumber in Oakland. We fix leaks, clear drains and replace water heaters.");
    expect(rivera.business).toBe('Rivera Plumbing');
    expect(rivera.slug).toBe('rivera-plumbing-setup1');
    expect(rivera.first).toMatch(/^Thanks, Maria\. .* about Rivera Plumbing\?/);
    // "We run a small crew", "Monday to Friday" or "3 vans" is no name, so the first sentence still is.
    expect((await started("Rivera Plumbing. I'm Maria. We run a small crew in Oakland.")).business).toBe('Rivera Plumbing');
    expect((await started('Rivera Plumbing. We run Monday to Friday, and I own 3 vans.')).business).toBe('Rivera Plumbing');

    // The owner's introduction is passed over, however it's put.
    for (const intro of ["I'm Lee.", 'I’m Lee.', 'I am Lee.', 'My name is Lee.', "Hi, I'm Lee.", "Hi! I'm Lee.", 'Hello, my name is Lee.']) {
      expect((await started(`${intro} Acme Bakery. Sourdough and cakes to order.`)).business, intro).toBe('Acme Bakery');
    }
  });

  it('else_your_business_when_the_owner_only_introduces_themselves', async () => {
    const ana = await started("I'm Ana.");
    expect(ana.business).toBe('Your business');
    expect(ana.slug).toBe('your-business-setup1');
    // The owner is still greeted by name.
    expect(ana.first).toMatch(/^Thanks, Ana\. .* about Your business\?/);
    expect((await started("Hi! I'm Ana")).business).toBe('Your business');
  });
});
