# ConceptFooter

`ConceptFooter` is the quiet line every surface carries: "Concept prototype by Giovanni Alcantara, not an Anthropic product".

## When to use

- Once per surface, at the bottom: the owner app, the public page, setup and the checkout.
- `poweredBy` on the public page, where a visitor may want to know what answers for the business.

## What the consumer provides

- Nothing but `poweredBy`: the text is fixed. The author's name is a `TextLink` to the author's LinkedIn profile (`AUTHOR_URL`), opening in a new tab; the words stay the same, and the About pages' bylines link the name the same way. The copy check reads `[data-ds="concept-footer"]` against its own copy of the line, so a stray edit fails every story that shows it.
- Nothing for the language either: both lines are English on every page, a Spanish visitor's too, and the footer says so with `lang="en"`, so a screen reader doesn't read it with the page's Spanish voice.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `poweredBy` | `boolean` | Adds "Powered by Claude Desk" with the 16 px mark, to the right of the line or under it on a narrow screen. |

Both lines are `.cd-type-caption` in `text-secondary`; "Claude Desk" is in serif, `text-primary`.
