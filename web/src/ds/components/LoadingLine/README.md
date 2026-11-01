# LoadingLine

`LoadingLine` is one quiet line while a page or a list loads: the busy spinner, then words that say what is on its way.

## When to use

- Where a page's content will appear while it is fetched, on the loaders that don't draw a skeleton (`SkeletonScreen`), which is how the main screens load:
  - a customer's page;
  - All rules;
  - a rule draft and its change;
  - the Demo inbox's open sheet (not the aside's button, which Today's skeleton draws);
  - the connector review inside setup's tools step;
  - setup's "Connecting Stripe";
  - setup's live step on a reload, while the Desks it names the business from are read ("Opening your setup");
  - the agents page's run panel, whose line is an action at work, not a page loading.
- Not for a button whose click is in flight, which shows its own spinner in place of its label (`Button` `busy`), and not for someone typing (`WritingIndicator`).
- Not for something that may take a while or needs the reader to wait on purpose ("Reconnecting to the chat"), which is a `waiting` `Notice`.

## What the consumer provides

- The words, in the reader's language, saying what is loading: "Loading this customer", "Cargando este cliente". Never "Loading…" alone.
- Render it while the request is in flight and replace it with the content, an `EmptyState` or an error `Notice`.

## What it shows

- The 16 px busy spinner (`size-spinner`), the same faint ring and quarter arc a busy `Button` shows, in `text-secondary`, turning once every `motion-spin` at an even speed. It holds still under reduced motion.
- The words in `meta` type and `text-secondary`, 10 px after the spinner and centered on it.
- No fill and no border. It sits where the content will be.

## Accessibility

- A `status` (`role="status"`), so a screen reader hears the words once. The spinner is `aria-hidden`.
- The spinner's arc reads 7.3:1 on the page, where a graphic needs 3:1; the ring behind it is decoration.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Required. What is loading, in words. |
