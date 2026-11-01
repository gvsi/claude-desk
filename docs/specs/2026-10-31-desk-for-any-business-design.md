# A Desk worth wanting, for any business

2026-10-31 · design for Giovanni's approval · decisions marked **(Giovanni)** are his; **(my call)** marks what I settled.

## Why

Giovanni tested setup live with a CPA firm (Fenster & Fenster). His verdict: the setup agent felt "very mechanic and dumb", and "a lot of our current system and prototype generalizes very poorly to different vertical and business types". The question he put: how do we make sure people across verticals *want* to use it, and that it gives their business enough value that they badly want a Desk? He called it existential and the top priority. The Monday 2026-11-02 deadline holds **(Giovanni)**.

Two independent maps of the code (GPT-6.1 Sol and Opus 5.5) agree on why. The spec designs for a trade, a CPA office and a landlord equally ("Owners"), but the build follows Turner Plumbing:
- Setup asks every business the same seven plumber-first questions, reads Mike Turner's memory for every Desk (#303) and quotes him in every safety check (#305).
- The visitor agent is never told what the business does: setup publishes only the contact and the service area (`setup.py` `seed_parts`); the owner's description and after-hours answer are dropped.
- The tools follow a trade's flow: prices only from a fixed menu, money only against a quote made in the same chat, bookings as anonymous untyped slots, documents sent but never collected, no status, no urgent routing.
- On a Desk made by setup nobody is on record, so verification and document release can't succeed.
- The evals and demo data are Turner-only.

## The framing (Giovanni accepted it)

A Desk sells as **a front desk that already knows how your business works and takes the repetitive back-and-forth off you**, never dropping a lead and never talked into something you'd regret. Safety is why you trust it, not why you buy it.

Every small business's front desk does the same eight jobs, in different mixes:

| # | Job | Today |
|---|---|---|
| 1 | Answer questions about services, prices, policies | Partly: no business description reaches the agent |
| 2 | Take in a new request, qualify it, collect what the owner needs | Partly: a 200-character note |
| 3 | Schedule a visit, consult, viewing or appointment | Partly: untyped slots, never refreshed |
| 4 | Price it: fixed menu, "from", or after a consult | Fixed menu only |
| 5 | Documents: send to verified people, and collect | Send only, and not on a setup Desk |
| 6 | Tell a known customer where things stand | Barely |
| 7 | Payment for a named purpose: deposit, retainer, invoice, rent | Only as a same-chat quote |
| 8 | Route urgent things | No |

A plumber leans on 3, 4, 7 and 8; a CPA on 2, 5, 6 and 3; a landlord on 3, 8, 5 and 7; a salon on 3, 4 and 7.

## Goals for Monday

1. **Setup is a consultant** (Giovanni: "act like a forward deployed engineer / consultant: works strategically to provide the most business value, works to understand the business deeply, can communicate technical concepts clearly to non technical people").
2. **Setup shapes the Desk to the business**: it builds the business's own tools from kernel-owned building blocks and drafts rules for them, and proposes the apps the owner already connected to Claude.
3. **The visitor agent knows how this business works** and handles its customers' common asks well, saying plainly what it can't do yet and offering the right next step.
4. **Any business a tester types in feels smart**, and four starter businesses are one click away for reviewers.
5. Everything that works for Turner keeps working; the safety invariants are untouched.

**Non-goals for Monday:** case or work-order status, client document upload, invoices or rent bound to a person, recurring payments, staff or unit on a booking, ranged or hourly pricing as a card, a vertical-specific eval world. For those jobs the Desk takes the details and promises a reply from a person, and setup's plan lists the job as coming later: no vision mocks **(Giovanni)**.

**Anti-goals:** setup that feels like a longer form; a consultant that promises what the Desk can't do; anything that lets website, memory or connector text set a limit or a rule; a Desk that says something the reply check would block for Turner.

## Part A: setup as a consultant

Length: as long as it's useful **(Giovanni)**, and the owner can accept Claude's suggestions at any point to finish fast **(my call)**.

1. **Homework first.** It reads the owner's description, their sample memory and their website, and searches the web for how this kind of business works (up to three keyword queries, never the business by name; Giovanni), before asking anything. The search is an owner-only kernel read like the website read; its results are untrusted text, shown as an inline label, and never reach a limit question.
2. **It says back how it understands the business**: what it does, who its customers are, how it likely works with them, and what customers most often reach out about. The owner corrects it.
3. **It proposes the two or three jobs worth the most to this business**, in the owner's terms (hours back, leads not lost after hours), and how the Desk would handle each. It says plainly what the Desk can't do yet. For a CPA firm: book a free intro consult (no price list), take in new-client requests with the firm's own questions, collect a retainer, and take a message for "where's my return" with a reply promised by a person.
4. **It asks only what those jobs need, one thing at a time**, and skips what doesn't fit: no price list unless the business has fixed prices; payments introduced by purpose ("clients often pay a retainer before you start; want me to send a secure payment link for that?") or skipped.
5. **It explains the technical and safety parts plainly when they come up**: a payment link, verification, "asks you first".
6. **Opinionated defaults with reasons** ("I'd start payments at ask-first"), which the owner accepts or changes.
6a. **Multiple choice when it helps (Giovanni):** a question can come with two to four choices as buttons, the recommended one first, and the owner can still type their own answer. On a limit question the choices are written by code (for example "Always ask me first", "Up to $250"), never by the model, so no website or memory text can suggest an amount.
7. **It ends with a plan**: what the Desk will handle, with example conversations from this business's own customers, then the review screens, the safety check and the preview.

**Flow (Giovanni: both):** the conversation proposes each tool, rule and connector inline as a card the owner accepts or changes; the Tools and Rules screens stay as the review of everything it built before the safety check. A redesign of setup's screens: canvas boards and Giovanni's sign-off before code.

**Sample memory (#303) (Giovanni: presented as a real memory):** the start model call writes memory items from the owner's description (topics include setup's query words), the API writes them through the kernel's owner-only `PUT /desks/{id}/memory` route, then the consent read returns them. A failed write means an empty memory, never Turner's. The memory also names the apps the owner "already connected" to Claude, picked from a fixed catalog that fits the business; setup keeps that list on its side.

**Connectors (Giovanni: propose, connect the mocks):** setup proposes the connected apps that fit the jobs. Ones with a working mock connect and run (payments today); the rest appear in the plan and the Tools step as coming later. First cut if time runs short: no new connector mocks **(Giovanni)**.

**What stays fixed (safety):**
- Each limit comes only from the owner's own words on that limit's own question, in an isolated turn that never sees website, memory or connector text (invariants 4 and 6, `LIMIT_QUESTIONS`). The consultant may introduce and explain a limit; the limit question and its turn stay isolated. A skipped money topic leaves its limit at 0, ask first.
- Rules are compiled from rule cards by code; the consultant proposes cards, never Cedar.

**How it's built (my call, confirmed in the plan):** the interview moves from "fixed question, Claude acknowledges" to "Claude leads, code keeps the topics". Code still tracks which topics are covered and owns the limit turns; Claude chooses order, wording, follow-ups and which fact topics to skip. #295's follow-up context is the base.

## Part B: the business's own tools, from building blocks

**(Giovanni: build from blocks; all four blocks.)** A model never writes an executable tool: that would break invariants 1 and 5. Instead the kernel offers four configurable building blocks. Setup proposes a business-shaped tool on one of them; the kernel derives its effects and resource from the block's own profile, pins its configuration by hash, and it starts `needs_review` until the owner turns it on, as connector tools do. Rules cover it through cards like any tool.

| Block | Built on | Configured by setup | Example |
|---|---|---|---|
| Intake | `native.capture_lead` | a name and up to a few questions the business needs | "New client intake": personal or business, which tax years |
| Typed booking | `native.find_slots` / `native.book` | an appointment type and its length | "Book a free consult", "Book a viewing", "Book a cut and color" |
| Payment for a purpose | `native.payment_link` | a name and an owner-set amount (a price item the kernel prices) | "Pay a retainer", "Pay the application fee", "Pay a booking deposit" |
| Urgent request | `native.request_callback` | what this business calls urgent | "Report an emergency": takes the details and alerts the owner now |

The exact kernel contract (how a configured tool is stored, pinned, reviewed and named in Cedar) belongs to the kernel and is defined in the implementation plan; the reply cards these tools need (a typed booking's confirmation, a purpose payment) reuse today's templates where they fit. If time runs short, this part falls back to words only: setup writes how each job works as policy and the agent follows it on today's tools **(my call; second cut after connector mocks)**.

## Part C: the visitor agent knows the business

- Setup publishes text claims to the Desk's charter as `policy:` keys, so the policy card can cite them: `policy:about`, `policy:pricing` ("Pricing is discussed after we understand the work."), `policy:intake`, `policy:after_hours`, `policy:urgent`, and `policy:service_area` (shown as "Service area", #307). They reach the agent through `<desk_context>` and stay untrusted text.
- The visitor prompt gains a short business-aware section: use the Desk's own words; when there's no price for a request, offer the business's next step (book a consult, take the details) instead of a dead end; qualify a new request with the intake questions; treat what the business calls urgent as urgent. The API owns this prompt change, which must pass the evals gate.
- The reply check's word list blocks "Your appointment is confirmed." but lets "Your viewing is confirmed." through: the kernel owns this reply-check change under invariant 2, alongside typed bookings.
- The demo agent's tasks ask every Desk for a water heater visit: draw them from the Desk's own tools and catalog.

## Part D: make today's tools work on any new Desk

- **People on record:** setup offers to add the owner as a test client with their own contact, so a tester can verify and receive a sample document.
- **Slots refresh:** a setup Desk's calendar is generated once for 14 days and never refreshed.
- The API and web app fixes in flight: #295, #304 to #311, and the web app's receipt change.

## Part E: starter businesses for reviewers

**(Giovanni: all four.)** The setup start screen offers four one-click descriptions; a tester can still type their own. Ranked by the strength of the use case:
1. **A hair salon** (new name to choose): bookings, a fixed menu, deposits, no-shows. Fits today's tools best.
2. **Turner Plumbing**: urgent after-hours calls, quotes, deposits.
3. **Maple Street Rentals**: viewings, applications, after-hours maintenance.
4. **Chen & Co. CPA**: consults, intake, retainers; status and document collection shown as coming later.

A web change to setup's screens: a design PR with Giovanni's sign-off.

## Cost, ownership and cuts

| Part | Size | Owner |
|---|---|---|
| A. Setup consultant, inline proposals | L, setup code and prompts; setup web redesign | Setup API; setup web app |
| A. Sample memory and connected apps | M | Kernel memory route; setup API |
| B. Building blocks | L | Kernel; setup API |
| C. Business-aware visitor prompt, reply-check gap, demo tasks | M | Visitor prompt; kernel; demo-agent API |
| D. Test client, slot refresh | S to M | Setup API; kernel |
| E. Starter businesses | S, design PR | Setup web app |

**Cut order if time runs short:** new connector mocks first **(Giovanni)**, then building blocks fall back to words only, then Part D **(my call)**. The consultant, the visitor agent and the starters stay.

**Evals:** every gated change (prompts, kernel, setup templates) needs a fresh results file for its inputs. While every tier 2 scenario is pending, that file costs $0; once scenarios run, a pass costs real model calls and follows the shipping-prs rule (spending needs Giovanni's go).
