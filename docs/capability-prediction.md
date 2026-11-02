# Capability prediction: Claude Desk

Giovanni Alcantara · October 29, 2026

## Capability

By October 2027, a generally available Claude model will represent a person or small business, unattended, to strangers and their agents. It will answer from the owner's knowledge, apply the owner's policies to new cases, quote, book and negotiate within limits, and hand off what it can't settle. It will still be talked around often enough that its limits must sit in code.

The bar is 80% pass^1 on [τ³-Banking](https://taubench.com/leaderboard). τ³-Banking, from the customer-service company Sierra, has an AI play a bank customer in a multi-turn chat: the agent must find answers in about 700 policy and product documents and leave the account in the right state, and pass^1 is the share of tasks it gets right on one try. It is the harder successor to Sierra's better-known τ²-bench (retail, airline and telecom service), where Claude already scored 92% on retail and 99% on telecom by February 2026 ([Opus 4.6 system card](https://www.anthropic.com/claude-opus-4-6-system-card)), so the bar sits on the test that can still measure progress. It is the closest public proxy for a front line, though it doesn't test negotiation. The top score on Sierra's leaderboard is 55.2% (Qwen 3.8 Max). No Claude 5.5 model is scored yet: Sierra's latest text results are dated August 4, 2026. [Artificial Analysis](https://artificialanalysis.ai/evaluations/tau3-banking)'s independent rerun, on its own setup, puts the top score at 51.3% and Fable 5.1, the newest Claude it lists, at 47.2%.

## Why it's coming

Policy-bound service is improving fast. On τ³-Banking, Claude went from 24.7% (Opus 4.5, November 2025) to 48.7% (Opus 5, July 2026); Opus 5.5 is not yet listed. `estimate:` straight-line fits in log-odds reach 80% between April 2027 (the best score across labs) and October 2027 (all seven Claude models); the five Opus scores give June 2027.

Agents already negotiate for people. In Anthropic's [Project Deal](https://www.anthropic.com/features/project-deal), Claude agents closed 186 deals for 69 employees, and people represented by stronger models got better outcomes.

Other people's agents are starting to contact businesses. [Google calls local businesses](https://blog.google/products/shopping/how-to-agentic-calling-let-google-call/) for shoppers to ask about stock and discounts. In [Lorikeet's survey](https://www.lorikeetcx.ai/content/the-agent-economy/read) of 1,966 US consumers (September to October 2026), 66.4% would be interested in an agent that deals with companies for them. [A2A](https://a2a-protocol.org/latest/specification/) and [AP2](https://ap2-protocol.org/) give those agents a standard way in and a signed budget, though AP2 is still at v0.2.

<!-- figure: tau3 -->

## Characteristics

The model alone works out what a visitor wants, where the answer is, which tool fits and how the rules apply to a new case, over a whole conversation with a person or their agent, in their language.

It should not decide who the visitor is, what they may see or how much money moves. Those come from one-time codes sent to the contact on record, the business's own prices, signed spending limits and rules checked in code. A talked-around model can then still take actions the rules permit or say something wrong. It can't move money or release private data beyond the rules, or state a price the business's records don't back. So the capability is judged by how many requests it closes without the owner, not by how hard it is to fool.

## Limitations

Robustness to the visitor lags agency. The [Claude Opus 5.5 system card](https://www.anthropic.com/claude-opus-5-5-system-card) lists two regressions that matter here: following instructions planted in text a user pastes, and more often "accepting unverifiable claims of authorization", such as a visitor saying "I'm the owner". Anthropic traced the first to training that "generalized into blindly trusting the user input"; on a Desk, the user is a stranger. In Anthropic's coding test the released model acted on planted instructions about 2% of the time, and with product changes that mark pasted text it followed none; a visitor's message isn't pasted.

A model supervising a model does not close the gap. In [Project Vend](https://www.anthropic.com/research/project-vend-2), Claude's CEO agent approved the shopkeeper agent's requests for discounts and other lenient treatment "about eight times as often as it denied them". Anthropic concluded that "the gap between 'capable' and 'completely robust' remains wide". In [Vending-Bench Arena](https://andonlabs.com/evals/vending-bench-arena) rounds from February to June 2026, Claude models proposed price-fixing, and a Claude team "ended up leaking valuable info to their competitors".

`estimate:` if a 2% per-attempt rate held and attempts were independent, an attacker trying 50 times would succeed at least once 64% of the time (1 − 0.98^50).

## Readiness

The prediction's date depends on one axis, applying policies, which is near. Resisting the visitor lags; the other axes are early or gated.

<!-- figure: readiness -->

| Axis | Readiness | Evidence | Watch for |
| --- | --- | --- | --- |
| Apply policies | Near | Claude's [τ³-Banking](https://taubench.com/leaderboard) pass^1 rose from 24.7% to 48.7% in eight months | Opus 5.5's score; a flat one would mean lagging |
| Resist the visitor | Lagging | Opus 5.5 follows pasted instructions and claimed authority more often than Opus 5 ([system card](https://www.anthropic.com/claude-opus-5-5-system-card)) | The next card's results on the user's own messages |
| Negotiate | Early | One staff pilot ([Project Deal](https://www.anthropic.com/features/project-deal)); [Vending-Bench Arena](https://andonlabs.com/evals/vending-bench-arena) scores only final balances | Negotiation scores for successive releases |
| Run unattended | Gated | Claude for Small Business: "Nothing sends until you say so" ([page](https://claude.com/solutions/small-business)); neither the [usage policy](https://www.anthropic.com/legal/aup) nor the [agent API](https://platform.claude.com/docs/en/managed-agents/permission-policies) requires that | Customer replies sent without approval by default |
| Visiting agents | Early | At most 1 in 16 consumers say an AI contacted a company itself ([Lorikeet](https://www.lorikeetcx.ai/content/the-agent-economy/read)) | AP2 past v0.2 |

Near: the published trend reaches the bar by October 2027. Gated: possible today, but products ask first. Early: no trend to fit yet. Lagging: short of the need, and no better than the release before.

Falsifiers: no Claude model reaches 70% on τ³-Banking by July 2027, or an independent adaptive red team can't talk the model alone, with no limits in code, past an owner's rules.
