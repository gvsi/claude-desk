# EffectTags

`EffectTags` is a tool's small fixed tags, "Money", "Private data" and "Can't be undone", drawn after its title.

## When to use

- Wherever a tool shows its name: Your tools, setup's connector review. They replace the effect sentences ("Changes something. Can be undone.").

## What it shows

- `effectTags(effects, reversible)` gives the words: the tool's weightiest effect, "Money" when it charges or pays out, else "Private data" when it touches private data; then "Can't be undone" when it changes something (or has no effect this build knows) and can't be undone. A tool that only reads, or whose change can be undone, gets none for that.
- Each tag is a `Pill`, 4 px apart, 8 px after the title it follows on the same line (`margin-inline-start`); together they wrap under the title when the line is too narrow. A tool with no tag draws nothing.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `effects` | `readonly Effect[]` | Required. The tool's effects, from its profile. |
| `reversible` | `boolean` | Required. Whether what it does can be undone. |
