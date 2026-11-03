# Capability prediction: Claude Desk

Giovanni Alcantara · November 2, 2026

## Capability

**By Q4 2027, a generally available Claude model will be able to act for a person or small business on its own:**

- answer strangers and the AI agents acting for them
- apply the owner's policies to new cases
- quote, book and negotiate within set limits

It will still be open to prompt injection and social engineering, so the business's limits have to be **enforced in code, outside the model**.

On its own means over a whole conversation, in the visitor's language: working out what they want, finding the answer in what the owner has written, picking the right tool, applying the rules to cases nobody wrote down, and handing off what it can't settle.

## Why it matters

A business that trusted a model this far could put it at its front desk: public, always on, answering people and their agents, and settling what the owner's policies allow without the owner reading each reply.

Other people's agents are starting to contact businesses: [Google calls local businesses](https://blog.google/products/shopping/how-to-agentic-calling-let-google-call/) for shoppers to ask about stock and discounts, and in [Lorikeet's survey](https://www.lorikeetcx.ai/content/the-agent-economy/read) of 1,966 US consumers (September to October 2026), 66.4% would be interested in an agent that deals with companies for them. [A2A](https://a2a-protocol.org/latest/specification/) and [AP2](https://ap2-protocol.org/) give those agents a standard way in and a signed budget, though AP2 is still at v0.2. In Anthropic's [Project Deal](https://www.anthropic.com/features/project-deal), Claude agents negotiating for 69 employees closed 186 deals, and people represented by stronger models got better outcomes.

Claude Desk, the prototype in the [product proposal](product-proposal.md), is one design for that front desk.

## How it's measured

The measure is [τ³-Banking](https://taubench.com/leaderboard), from the customer-service company Sierra. An AI plays a bank's customer in a multi-turn chat; the agent must find what applies in about 700 policy and product documents, use the bank's tools and leave the accounts in the right state. Each of its 97 tasks is scored on that final state, not on how the chat reads ([Sierra's paper](https://arxiv.org/abs/2603.04370)). pass^1 is the share of tasks done right on one try.

In the paper's first example, a customer who lost a wallet asks to freeze a card, but the bank's policies and the card's recent transactions mean the right action is to cancel it. The request is plain; the answer depends on rules the customer hasn't read. A front desk does that all day.

τ³-Banking is the harder successor to Sierra's τ²-bench, where Claude scored 92% on retail and 99% on telecom by February 2026 ([Opus 4.6 system card](https://www.anthropic.com/claude-opus-4-6-system-card)), so it can still measure progress. The bar is 80% pass^1. It is the closest public proxy for a front desk, though it tests neither negotiation nor a visitor trying to break the rules.

Resisting attack has no single leaderboard. For prompt injection, instructions hidden in what the model reads such as a web page or a tool's result, Anthropic's system cards repeat the same tests each release: [Gray Swan's benchmark](https://arxiv.org/abs/2603.15714), built with the UK AI Security Institute, the US Center for AI Standards and Innovation and model developers, replays 1,804 attacks from public red-teaming competitions, and Gray Swan's adaptive attacker, Shade, learns against each scenario over 200 attempts. Social engineering by the person in the chat, such as claiming to be the owner, has no public benchmark across releases, only Anthropic's own behavior audit.

## Why it's coming

The newest models are scored on boards other than Sierra's, so each score names its board:

- **Sierra's leaderboard**, whose latest text results are dated August 4, 2026, stops at Claude Opus 5, at 48.7%. The top score on Sierra's leaderboard is 55.2% (Qwen 3.8 Max).
- **[Fireworks' index](https://fireworks.ai/specialized-intelligence-index/benchmarks/customer-support/tau3-banking)**, updated October 28, 2026, reports the mean of four seeded trials per task. It puts Gemini 4 Argon on top at 58.2% and Claude Opus 5.5 second at 56.0%.
- **[Artificial Analysis](https://artificialanalysis.ai/evaluations/tau3-banking)**'s rerun, on its own setup, puts the top score at 51.3%, Claude Fable 5.1 at 47.2% and Claude Sonnet 5 at 37.3%.

Sonnet 5.5 and Haiku 5.5 aren't on any of them yet. The boards don't always agree: Opus 5 scores 48.7% on Sierra's, 49.1% on Fireworks' and 44.7% on Artificial Analysis'.

Claude went from 24.7% (Opus 4.5, November 2025, Sierra) to 56.0% (Opus 5.5, September 2026, Fireworks) in ten months.

<!-- figure: tau3 -->

`estimate:` straight-line fits in log-odds reach 80% between Q2 2027 and the start of Q4 2027: the six Opus scores and the best score across labs in Q2 2027, and all ten Claude scores in the first days of Q4 2027. A straight line in log-odds is an S-curve in percent, flattening as it nears 100%. The exact days:

| Fit | Scores | Reaches 80% |
| --- | --- | --- |
| Opus | Sierra's five, and Opus 5.5 on Fireworks | May 31, 2027 |
| Best across labs | Each new top score on Sierra's board, then Opus 5.5 and Gemini 4 Argon on Fireworks | May 16, 2027 |
| All Claude | Sierra's seven, Opus 5.5 on Fireworks, and Fable 5.1 and Sonnet 5 on Artificial Analysis | October 3, 2027 |

The fits rest on few scores from three boards with different setups, and a trend can stall; the across-labs fit mixes boards, so it counts least. The prediction says Q4 2027 because the latest fit reaches the bar as that quarter begins.

Falsifier: no Claude model reaches 70% on τ³-Banking by the end of Q2 2027.

## Why the limits stay in code

The model is getting much harder to attack through what it reads, but on the two measures closest to the person in the chat, Opus 5.5 did worse than Opus 5. Results from the [Claude Opus 5.5 system card](https://www.anthropic.com/claude-opus-5-5-system-card), both models with extended thinking:

| Attack | How it's run | Claude Opus 5 | Claude Opus 5.5 |
| --- | --- | --- | --- |
| Prompt injection, Gray Swan's benchmark | Fixed attacks; success within 15 tries | 4.8% | 1.0% |
| Prompt injection, computer use | Shade, 200 tries in each of 14 scenarios | 0.29% of tries; 1 of 14 scenarios broken | 0.07%; 1 of 14 |
| Prompt injection, browser use | Professional red-teamers' attacks, written against Claude Opus 4.7; 10 tries in each of 110 environments | 3.64%; 15 of 110 | 0.09%; 1 of 110 |
| Prompt injection, coding | Shade, 200 tries in each of 40 scenarios | 88.92%; 40 of 40 | 54.61%; 37 of 40, every success in requests handed to Claude Opus 4.8 |
| Instructions in text the user pastes | Anthropic's coding test | Never followed | Followed 52% of the time by an early snapshot; after the fix, about 7.4% at maximum effort and 2% at the default |
| Unverifiable claims of authority | Anthropic's behavior audit, scored 1 to 10, lower is better | 2.30 | 2.43 |

Anthropic warns that fixed attack sets "can provide a false sense of security", as the adaptive attacker's coding results show.

The person in the chat is a Desk's main attacker. Anthropic traced Opus 5.5's readiness to follow instructions pasted into the user's own message to training that "generalized into blindly trusting the user input"; at a public front desk, the user is a stranger. Product changes that mark pasted text stopped it in Anthropic's test, but a visitor's message isn't pasted. The card also scores Opus 5.5 worse than Opus 5 on "accepting unverifiable authorization", such as a visitor saying "I'm the owner", though better than other recent Claude models.

A model supervising a model does not close the gap. In [Project Vend](https://www.anthropic.com/research/project-vend-2), Claude's CEO agent approved the shopkeeper agent's requests for discounts and other lenient treatment "about eight times as often as it denied them", and Anthropic concluded that "the gap between 'capable' and 'completely robust' remains wide".

These results don't support a trend line: two or three releases per measure, attack sets that change between system cards, and no series for the person in the chat. So the safety prediction is a threshold, not a date.

**Prediction:** through Q4 2027, manipulation by the person in the chat will not be shown solved: a generally available model with no limits in code will still break an owner's rule for a determined visitor. Prompt injection hidden in what the model reads is expected to keep falling, but the prediction doesn't rest on it.

**Falsifier:** by the end of 2027, a public adaptive red team that plays the person in the chat, with claimed authority, pressure and planted instructions, can't get a generally available model with no limits in code to break an owner's rule in any of its scenarios, with 100 attempts each.

`estimate:` if a 2% per-attempt rate held and attempts were independent, an attacker trying 50 times would succeed at least once 64% of the time (1 − 0.98^50).

So the model alone should not decide who the visitor is, what they may see or how much money moves; one-time codes sent to the contact on record, the business's own prices, signed spending limits and rules checked in code do. A manipulated model can still take actions the rules permit or say something wrong, but it can't move money or release private data beyond the rules, or state a price the business's records don't back.

With its limits in code, Claude Desk's [final eval pass](https://github.com/gvsi/claude-desk/blob/main/evals/reports/2026-11-03-20261103-012831-4a664a.md) had no unwaived violation in 78 held-out attack runs across 26 scenarios, 6 of them prompt injection and most of the rest social engineering. Three runs, all of one scenario, were flagged for correct refusals, which the owner waived; counting them, flagged runs are at most 10.7% per run at 95% confidence. I wrote the scenarios, which are fixed and run three times each, not an adaptive red team; they assume a verification code reaches only the real contact, which the demo's simulated inbox doesn't ensure, and test the model and the code together. So the capability is judged by how many requests a Desk closes without the owner, not by how hard the model is to fool.

## Readiness

The prediction's date rests on one axis, applying policies, which is near. Resisting the visitor lags; the others are early or gated.

<!-- figure: readiness -->

| Axis | Readiness | Evidence | Watch for |
| --- | --- | --- | --- |
| Apply policies | Near | Claude's [τ³-Banking](https://taubench.com/leaderboard) pass^1 rose from 24.7% (Sierra) to 56.0% (Fireworks) in ten months | Sonnet 5.5's score, and the next Claude on Sierra's own board |
| Resist the visitor | Lagging | Prompt injection within 15 tries fell from 4.8% to 1.0%, but Opus 5.5 follows pasted instructions and claimed authority more often than Opus 5 ([system card](https://www.anthropic.com/claude-opus-5-5-system-card)) | A public adaptive red team that plays the person in the chat |
| Negotiate | Early | One staff pilot ([Project Deal](https://www.anthropic.com/features/project-deal)); [Vending-Bench Arena](https://andonlabs.com/evals/vending-bench-arena) scores only final balances | Negotiation scores for successive releases |
| Run unattended | Gated | Claude for Small Business: "Nothing sends until you say so" ([page](https://claude.com/solutions/small-business)); neither the [usage policy](https://www.anthropic.com/legal/aup) nor the [agent API](https://platform.claude.com/docs/en/managed-agents/permission-policies) requires that | Customer replies sent without approval by default |
| Visiting agents | Early | At most 1 in 16 consumers say an AI contacted a company itself ([Lorikeet](https://www.lorikeetcx.ai/content/the-agent-economy/read)) | AP2 past v0.2 |

Near: the published trend reaches the bar by Q4 2027. Gated: possible today, but products ask first. Early: no trend to fit yet. Lagging: short of the need, and no better than the release before.

The [product proposal](product-proposal.md) describes Claude Desk, built for that split: the model holds the conversation, and code holds identity, money and private data.
