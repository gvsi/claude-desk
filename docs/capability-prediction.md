# Capability prediction: Claude Desk

Giovanni Alcantara · November 2, 2026

## Capability

**By Q4 2027, a generally available Claude model will be able to act for a person or small business on its own:**

- answer strangers and the AI agents acting for them
- apply the owner's policies to new cases
- quote, book and negotiate within set limits

It will still be open to prompt injection and social engineering, so the business's limits have to be **enforced in code, outside the model**.

On its own means over a whole conversation, in the visitor's language: the model works out what the visitor wants, finds the answer in what the owner has written, picks the tool that fits, applies the rules to a case nobody wrote down, and hands off what it can't settle.

## Why it matters

A business that could trust a model this far could put it at its front desk: public, always on, answering anyone who writes in, people and their agents alike, and settling what the owner's policies allow without the owner reading each reply. Other people's agents are already starting to contact businesses.

[Google calls local businesses](https://blog.google/products/shopping/how-to-agentic-calling-let-google-call/) for shoppers to ask about stock and discounts. In [Lorikeet's survey](https://www.lorikeetcx.ai/content/the-agent-economy/read) of 1,966 US consumers (September to October 2026), 66.4% would be interested in an agent that deals with companies for them. [A2A](https://a2a-protocol.org/latest/specification/) and [AP2](https://ap2-protocol.org/) give those agents a standard way in and a signed budget, though AP2 is still at v0.2. Agents already negotiate for people, too: in Anthropic's [Project Deal](https://www.anthropic.com/features/project-deal), Claude agents closed 186 deals for 69 employees, and people represented by stronger models got better outcomes.

Claude Desk, the prototype these pages describe, is one design for that front desk; the [product proposal](product-proposal.md) covers it.

## How it's measured

The measure is [τ³-Banking](https://taubench.com/leaderboard), from the customer-service company Sierra. An AI plays a bank's customer in a multi-turn chat. The agent has to find what applies in about 700 policy and product documents, use the bank's tools, and leave the customer's accounts in the right state. Each of its 97 tasks is scored on that final state, not on how the chat reads ([Sierra's paper](https://arxiv.org/abs/2603.04370)). pass^1 is the share of tasks the agent gets right on one try.

In the paper's first example, a customer who has lost a wallet with their bank cards in it asks the agent to freeze a card. The bank's card policies and the card's recent transactions mean the right action is to cancel it instead. The request is plain; the right answer depends on rules the customer hasn't read. A front desk does that all day.

τ³-Banking is the harder successor to Sierra's better-known τ²-bench (retail, airline and telecom service), where Claude already scored 92% on retail and 99% on telecom by February 2026 ([Opus 4.6 system card](https://www.anthropic.com/claude-opus-4-6-system-card)), so it can still measure progress. The bar is 80% pass^1. It is the closest public proxy for a front desk, though it tests neither negotiation nor a visitor trying to make the agent break the rules; the limitations below cover that.

## Why it's coming

The newest models are scored on boards other than Sierra's own, and each score here names its board:

- **Sierra's leaderboard**, whose latest text results are dated August 4, 2026, stops at Claude Opus 5, at 48.7%. The top score on Sierra's leaderboard is 55.2% (Qwen 3.8 Max).
- **[Fireworks' index](https://fireworks.ai/specialized-intelligence-index/benchmarks/customer-support/tau3-banking)**, updated October 28, 2026, runs four seeded trials per task and reports the mean. It puts Gemini 4 Argon on top at 58.2% and Claude Opus 5.5 second at 56.0%.
- **[Artificial Analysis](https://artificialanalysis.ai/evaluations/tau3-banking)**'s rerun, on its own setup, puts the top score at 51.3%, Claude Fable 5.1 at 47.2% and Claude Sonnet 5 at 37.3%.

Claude Sonnet 5.5 and Haiku 5.5 aren't scored on any of the three yet. The boards don't always agree: Claude Opus 5 scores 48.7% on Sierra's, 49.1% on Fireworks' and 44.7% on Artificial Analysis', and Kimi K3 scores 37.1% on Sierra's but 51.5% on Fireworks'.

Claude went from 24.7% (Opus 4.5, November 2025, Sierra) to 56.0% (Opus 5.5, September 2026, Fireworks) in ten months.

<!-- figure: tau3 -->

`estimate:` straight-line fits in log-odds reach 80% between Q2 2027 and the start of Q4 2027: the six Opus scores and the best score across labs in Q2 2027, and all ten Claude scores in the first days of Q4 2027. A straight line in log-odds is an S-curve in percent, which flattens as it nears 100%. The exact days:

| Fit | Scores | Reaches 80% |
| --- | --- | --- |
| Opus | Sierra's five, and Opus 5.5 on Fireworks | May 31, 2027 |
| Best across labs | Each new top score on Sierra's board, then Opus 5.5 and Gemini 4 Argon on Fireworks | May 16, 2027 |
| All Claude | Sierra's seven, Opus 5.5 on Fireworks, and Fable 5.1 and Sonnet 5 on Artificial Analysis | October 3, 2027 |

The fits rest on few scores, from three boards whose setups differ, and a trend can stall. The across-labs fit mixes boards, so it counts least. The prediction says Q4 2027 because the latest fit reaches the bar as that quarter begins.

Falsifiers: no Claude model reaches 70% on τ³-Banking by the end of Q2 2027, or an independent adaptive red team, using prompt injection and social engineering, can't get the model alone, with no limits in code, to break an owner's rules.

## Limitations

Resisting the visitor lags behind applying policies. The [Claude Opus 5.5 system card](https://www.anthropic.com/claude-opus-5-5-system-card) lists two regressions that matter here. One is a form of prompt injection: following instructions planted in text a user pastes. The other is social engineering: more often "accepting unverifiable claims of authorization", such as a visitor saying "I'm the owner". Anthropic traced the first to training that "generalized into blindly trusting the user input"; at a public front desk, the user is a stranger. In Anthropic's coding test the released model acted on planted instructions about 2% of the time, and with product changes that mark pasted text it followed none; a visitor's message isn't pasted. [Anthropic's announcement](https://www.anthropic.com/claude-opus-5-5) says Opus 5.5 matches or beats Opus 5 on prompt injection in coding, tool use, computer use and web browsing; the card's regression is narrower, about what the user types or pastes.

A model supervising a model does not close the gap. In [Project Vend](https://www.anthropic.com/research/project-vend-2), Claude's CEO agent approved the shopkeeper agent's requests for discounts and other lenient treatment "about eight times as often as it denied them". Anthropic concluded that "the gap between 'capable' and 'completely robust' remains wide". In [Vending-Bench Arena](https://andonlabs.com/evals/vending-bench-arena) rounds from February to June 2026, Claude models proposed price-fixing, and a Claude team "ended up leaking valuable info to their competitors".

`estimate:` if a 2% per-attempt rate held and attempts were independent, an attacker trying 50 times would succeed at least once 64% of the time (1 − 0.98^50).

So the model alone should not decide who the visitor is, what they may see or how much money moves. Those come from one-time codes sent to the contact on record, the business's own prices, signed spending limits and rules checked in code. A manipulated model can then still take actions the rules permit or say something wrong. It can't move money or release private data beyond the rules, or state a price the business's records don't back. So the capability is judged by how many requests it closes without the owner, not by how hard it is to fool.

## Readiness

The prediction's date depends on one axis, applying policies, which is near. Resisting the visitor lags; the other axes are early or gated.

<!-- figure: readiness -->

| Axis | Readiness | Evidence | Watch for |
| --- | --- | --- | --- |
| Apply policies | Near | Claude's [τ³-Banking](https://taubench.com/leaderboard) pass^1 rose from 24.7% (Sierra) to 56.0% (Fireworks) in ten months | Sonnet 5.5's score, and the next Claude on Sierra's own board |
| Resist the visitor | Lagging | Opus 5.5 follows pasted instructions and claimed authority more often than Opus 5 ([system card](https://www.anthropic.com/claude-opus-5-5-system-card)) | The next card's results on the user's own messages |
| Negotiate | Early | One staff pilot ([Project Deal](https://www.anthropic.com/features/project-deal)); [Vending-Bench Arena](https://andonlabs.com/evals/vending-bench-arena) scores only final balances | Negotiation scores for successive releases |
| Run unattended | Gated | Claude for Small Business: "Nothing sends until you say so" ([page](https://claude.com/solutions/small-business)); neither the [usage policy](https://www.anthropic.com/legal/aup) nor the [agent API](https://platform.claude.com/docs/en/managed-agents/permission-policies) requires that | Customer replies sent without approval by default |
| Visiting agents | Early | At most 1 in 16 consumers say an AI contacted a company itself ([Lorikeet](https://www.lorikeetcx.ai/content/the-agent-economy/read)) | AP2 past v0.2 |

Near: the published trend reaches the bar by Q4 2027. Gated: possible today, but products ask first. Early: no trend to fit yet. Lagging: short of the need, and no better than the release before.

The [product proposal](product-proposal.md) describes Claude Desk, which is built for that split: the model holds the conversation, and code holds identity, money and private data.
