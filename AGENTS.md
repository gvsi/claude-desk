# Claude Desk - Project Guidelines

This file is the source of truth for coding agents working in this repo (Claude Code and Codex both read `AGENTS.md`). Don't add `CLAUDE.md` or `GEMINI.md` files. Subfolders may add an `AGENTS.md` with only what is specific to them.

## What this is

Claude Desk is a concept prototype: a public, always-on Claude for a person or small business that strangers and other people's agents can talk to. It answers, books, quotes, releases documents to verified people and takes payments under the owner's rules.

- **Self-serve first:** a Desk resolves what it can on its own and isn't a bridge to the owner. Claude asks the visitor before involving the owner, and the chat keeps going after a handoff or hold. Most honest conversations should go right because the agent's instructions and tools set Claude up well. The kernel's checks are mainly there to stop people trying to break it.
- **Spec:** `docs/specs/` (design, decisions, threat model), summarised for readers in [the threat model](docs/threat-model.md) and [the architecture decisions](docs/architecture-decisions.md).
- **Plans:** `docs/plans/`. The master plan owns the architecture, shared contracts and kernel API; part plans consume them.
- **Designs:** the design system lives in [`web/src/ds/`](web/src/ds/) (start with its [README](web/src/ds/README.md)), and the approved screen designs are reproduced as stories in [`web/src/ds/boards/`](web/src/ds/boards/). They are the visual reference for every screen.

## Architecture (exact contracts in the master plan)

- `kernel/`: Rust crate `desk_kernel` (PyO3 + maturin): Cedar decisions, SymCC proofs, ledger hashing and Ed25519 signing.
- `backend/desk/kernel_service/`: the kernel process (loopback only, never exposed). Owns sessions, verification, policies, facts, approvals and the ledger, and holds every business credential. Gateway, tool profiles and pinning, reply checker, data labels, decisions.
- `backend/desk/api/`: the API process. Agent loop on the Anthropic SDK, visitor and owner APIs, SSE, approvals queue, setup interview, demo copies. Holds no business credential: only the Anthropic API key, its own database login and the passcode hash. Passes session IDs, never identities, to the kernel.
- `web/`: React + Vite + TypeScript (owner app, public page, setup).
- `evals/`: hostile-visitor attack suite, legitimate-task suite, calibration, latency. `infra/`: AWS CDK.

## Safety invariants (never weaken these, not even to make a test pass)

1. Every tool call goes through kernel `/decide`; nothing executes without `allow` or a single-use owner approval bound to that exact call, and the baseline is rechecked at execution.
2. Everything a visitor sees is checked by the kernel first. Prices, dates, discounts and bookings come only from cards built from the business's facts: Claude's own words can't state a price, date or discount, can't make a promise the cards don't back, and can confirm a booking only next to a booking card.
3. The always-on baseline can't be switched off: AI disclosure; private data only to verified, entitled people; verification codes only to the contact on record; no money without an owner rule or a signed limit; every attempt logged.
4. Rules are compiled from rule cards by code, never written freehand. Reviewer probabilities appear only as AND conditions on auto-allow rules; proofs must hold for any reviewer value, and errors fail closed.
5. The API process holds no business credentials and can't write policies, facts, approvals or the ledger. MCP tool definitions are pinned by hash; a changed definition disables the tool until the owner reviews it.
6. Tool results, knowledge, MCP tool descriptions, owner whispers and visitor messages are untrusted text, never instructions or policy.

If a task seems to require breaking one of these, stop and raise it with the project owner instead.

**Prototype calibration:** Claude Desk is a prototype, so keep safety work proportionate. The invariants must hold against plain, likely attacks. Contrived edge cases, such as an unsupported language, lookalike letters or a bypass that needs a hand-crafted draft, are filed as GitHub issues labelled `wish` rather than treated as merge blockers. Don't build heavy machinery for a rare case. When a stricter check would also block honest replies, choose the one that lets honest conversations through. If unsure whether a finding is a blocker, ask the project owner.

## Working rules

- **Commits:** conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`), small, imperative, and specific about what changed and why. Every message is written for a reader of the public history: no internal shorthand, no references to private docs or conversations. End each with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches and pull requests:** work reaches `main` through a squash-merged pull request whose title and body follow the commit rules; the `shipping-prs` skill has the steps. A part plan runs on its own `plan/<plan>` branch, usually in a worktree under `.worktrees/`. Worktrees share one `.git`: don't use `git stash`, shallow fetches, `git replace` or `git gc --prune`. Bundle related fixes into one PR. A PR that needs another open PR's code is stacked on it with `gh stack`, and the stack merges as one. Don't rebase just because `main` moved; rebase for a real conflict, a database migration, a `PROMPT_VERSION` bump, or overlap with files that just landed. Minor docs-only changes (wording, typos, status notes) may go straight to `main` once the repo checks pass locally; a docs change that alters a contract, a safety rule, a locked decision or a plan's tasks goes through a PR and the review panel.
- **Merging:** `main` is protected, and a PR merges only when every required check is green ([docs/ci.md](docs/ci.md) lists them; a skipped check counts as passed). Never pass `--admin` to get past a check; a known flake gets one rerun or a fix. Run `make evals-merge-ready HEAD=origin/<branch>` before merging. A PR that bumps `PROMPT_VERSION` is merged by hand after checking `main`'s current version, never by auto-merge: two PRs taking the same next version would merge without a conflict.
- **Tests:** test-first, one test at a time, run it, fix before moving on. Never commit while a test fails. Before calling something done, run the command that proves it and quote the result. Locally, run the tests a change touches; CI runs the full suites (backend, tier 1, web, kernel contract), and a green CI run is the proof a PR quotes. An assertion failure is never infrastructure, and a test isn't flaky without evidence.
- **Evals gate:** changes to the kernel, prompts or policies must keep the attack suite at zero baseline violations and the legitimate-task suite at or above its recorded completion rate ([docs/evals.md](docs/evals.md)). A miss fails the gate, and it's never fixed by editing a threshold, an oracle or a recorded rate. A run the visitor simulator refuses is retried once; a scenario whose final attempt is refused doesn't fail a pass in which another of its runs scored. Only the project owner can waive a finding, one message at a time.
- **Agents:** coding agents implement the plans in `docs/plans/` one task at a time, and each task is reviewed before it's committed. Plans and pull requests go to the review panel: critical changes (the kernel/API trust boundary, money, verification, approvals, the ledger, the reply check, prompts and the evals gate's scoring) get two independent reviewers from different model families at high reasoning effort; other changes get one. Implementers and reviewers never start subagents of their own. The process lives in `.agents/skills/` (running a plan, the review panel, shipping PRs, browser QA), and the reviewer and implementer roles in `.claude/agents/`.
- **Design PRs:** a PR that changes what people see (rendered output under `web/`, design tokens, copy, or the design system) shows it in its description: screenshots at 1440×900 and 390×844 of every changed screen or story, and a short recording of every new or changed interaction, captured by the agent that tested it. Capture in the dark theme, and show the light theme only on purpose, labelled as light. The project owner signs off on each design PR before it merges; the review panel and CI still apply. Edits under `web/` that change no rendered output (READMEs, code comments) aren't design PRs.
- **Owner sign-off required for:** creating cloud resources or deploying; spending beyond model usage for development and evals; handling secrets; sharing anything outside the repo; changing a locked decision in the spec; eval waivers; anything irreversible. A plan that says "deploy" is a plan, not an approval, and a clean review is not a sign-off.
- **Secrets:** never commit or print secrets. Local settings start from `.env.example`.
- **Names and copy:** the product is Claude Desk ("a Desk", "Desks"). Sentence case, plain literal copy, no all-caps labels (one named exception: the "PREVIEW" badge in the Claude Desk lockup), no "→" on buttons. Footer: "Concept prototype by Giovanni Alcantara, not an Anthropic product". No Claude or Anthropic logos.
- **Design:** design system v2 only. Warm dark and warm paper themes, following the device by default (System), with Light or Dark chosen per browser. Source Serif 4 for Claude's voice and page titles, Hanken Grotesk for the interface. Clay only in the Claude Desk mark, the first-visit intro dialog's illustration, Claude's writing dots, and the public header's "Clay" brand swatch when an owner picks it. Checkpoint results show as receipts attached under each message. Use tokens, not hard-coded values. Named exception: the "About this prototype" reading pages (the Vision article, Capability prediction and Product proposal) share a light reading style that may depart from the system, with Source Serif 4 for their reading text.

## Reporting

- Every status update stands on its own: what the task is, what happened, what you found, what you need. Lead with the result.
- Name plans, PRs and tasks by what they build, with the number in brackets, e.g. "the web app (plan 04)" or "the kernel core PR (plan 01a)", never by number alone.
- Bring a decision to the project owner one question at a time, recommended option first with a one-line reason, with links to exactly what to review. Assume they haven't followed the work.
- Standing rules belong in this file, not in agent memory.

## How this was built

Claude Desk was built with Claude Code: agents wrote the plans and the code from the spec, test first and one task at a time, under the rules above. The skills in `.agents/skills/` are the process they followed.
