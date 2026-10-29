# Claude Desk Prototype — Plan 01c: Kernel payments, agents and setup

> **For agentic workers:** Execute with the repo's `executing-implementation-plans` skill (`.agents/skills/`): a fresh implementer and a task review per task, in this plan's worktree, landing through the PRs in "Landing" after the two-reviewer panel. Steps use checkbox (`- [ ]`) syntax for tracking. This plan builds on Plans 01a and 01b as merged.

**Goal:** The kernel's money, agent and setup surfaces: mock payments over MCP with pinned, drift-checked tools; single-use payment links with a signed `payment_confirmed`; charges and refunds through trusted adapters; signed visiting agents (`AgentAuth`, the kernel side of A2A, Agent Card blocks), demo agents and mandates with reserve, commit and release; the setup tools and safety probes; the Rivera seed rows marked 01c. Lands by the Friday 18:00 gate.

**Architecture:** The kernel runs the mock payments server (`backend/desk/mockpay/`, MCP streamable HTTP on 127.0.0.1:8702) as its supervised child and only client. New tools are trusted adapters on Plan 01a's "Kernel internals" seam: every call goes `/decide` → `/execute` with intent first, mandate spend is reserved in `prepare` with the intent, and MCP tools are re-listed and hash-checked in the execution re-check on both paths. Agent signatures and mandates are checked on every agent call.

**Tech Stack:** Plan 01a's stack plus `mcp==2.3.0` (v2 API: `mcp.Client`, low-level `mcp.server.lowlevel.Server`; [migration guide](https://py.sdk.modelcontextprotocol.io/v2/migration/)), `httpx2==2.13.1` (already required by `mcp`; the `sni_hostname` [extension](https://www.python-httpx.org/advanced/extensions/)), `uvicorn==0.54.0`, `cryptography==50.0.2` ([Ed25519](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/ed25519/)), stdlib `ipaddress` and `html.parser`. Every new pin is at least two weeks old.

**Spec / master plan:** `docs/specs/2026-10-28-claude-desk-design.md`; `docs/plans/2026-10-28-00-master-plan.md` (cited by section); `docs/plans/2026-10-28-01a-safety-kernel-core.md`, `docs/plans/2026-10-28-01b-kernel-verification-owner-data.md`. Background: `docs/research/policy-best-practices.md` (tool pinning; [Invariant Labs](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks), [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/)); [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html); [AP2](https://ap2-protocol.org/) (mandates).

## Global Constraints

The master plan's "Global Constraints" apply as written, and so do Plan 01a's plan-specific constraints. Specific to this plan:

- **Plans 01a and 01b** change only where a task names them, never weakening a check, test or fixture.
- **Deadlines** (below the API client's 6 s timeout): MCP re-list and calls `MCP_DEADLINE_S = 2.0`; provider writes `PROVIDER_DEADLINE_S = 2.0`; provider reads at normalize `READ_DEADLINE_S = 1.0` (normalize plus the 4 s reviewer stays under 6 s); website fetch `FETCH_TOTAL_TIMEOUT_S = 4.0`. An execution path stays within 5 s (re-normalize, re-list, call).
- **Execution outcomes** (01a's seam): a spend reservation is written in `prepare`. `AdapterFailure` only when the request never reached the provider, the provider refused it (4xx, MCP `isError`), or the tool only reads; any other exception after the intent row is `unknown`. Reconciliation never trusts a lookup miss: it settles the key at the provider (`void`, or `cancel` for a checkout), so a delayed request fails instead of landing after a release.
- **Payment-link tokens** follow Plan 01b's link-token rule (24 hours, only in `kernel.payment_links`, redacted from the access log); facts name the `link_id`; a visitor sees the token only in the card's `href` (`href_for`).
- **Claude never sees server text.** Every MCP tool carries the adapter's `description_confirmed` and `input_schema`; the server's description reaches only the owner, as quoted untrusted `pending_definition_text`; charge titles come from kernel data, never the server.
- **Clients:** the MCP client builds `mcp.Client(..., cache=None)` (the v2 SDK caches `tools/list` by default, which would hide drift) over `streamable_http_client(url, http_client=httpx2.AsyncClient(headers=..., trust_env=False))`, fresh per call, with `X-Mockpay-Key` and `X-Desk-Copy`; `ProviderClient` also sets `trust_env=False`. Provider bodies and MCP results parse through `strict=True, extra="forbid"` models with money as `StrictInt` in 0..1_000_000.
- **Tests** run the mock server in-thread on an ephemeral port (a session fixture in `tests/kernel/conftest.py`, passed to `create_app`) and the fetch on an injected resolver and `httpx2.MockTransport`: no money, no network. Test hooks (the delay switch) answer 404 with `DESK_ENV=production`.
- **The Desk's money cap** (Plan 01b's Task 3b; master "Charter money cap"). A Desk made with `POST /desks` starts at a cap of 0, so a test that drafts an auto money card on one sets its cap first, through `draft_and_confirm(..., auto_money_cap_cents=50_000)`; Rivera copies start at $500, so `rv-link` ($300), `rv-mandate` ($20) and Plan 05a's money rows keep their numbers. Task 4's `/tools/confirm` draft starts from the active cards passed through Plan 01b's `desk.money_cap.lower_to_cap` at the Desk's cap, so after a lowering the owner kept, it carries the money cards at the cap instead of failing with 422.
- **Owner-facing text** (drift alerts, probe `reason_plain`) is plain, with no Cedar, MCP or policy words.
- **Evals gate** (master "Evals gate"): tier 1 rows are `requires("01c")` for Tasks 1–7 and `requires("01c-setup")` for Tasks 8–9; `01c` joins `evals/tier1/landed.toml` with Tasks 1–7, `01c-setup` with Tasks 8–9; the PR gated by the money and agent rows; tier 2 as Task 10 says.

## What this plan serves

- The acting is real: a visitor pays at a labelled test checkout and sees it confirmed in the chat; a verified customer sees and refunds their own charges; another person's agent pays within its signed limit and no further.
- A changed tool definition turns the tool off until the owner looks; one demo action shows it.
- Setup reads the owner's website through a checked fetch and tries draft rules on hypothetical visitors before going live.
- A first-time visitor sees a "Test payment, no money moves" checkout, an agent refused over its limit, a "tool changed" review, and setup reading a website.

## Interfaces consumed / produced

**Consumed:**
- Contracts and `kernel_api.py` models as the tasks name them: `AgentAuth`, `Mandate`, `A2ARequest`, `DemoAgentIssued`, `DeskSeed.connections`, `ToolProfile`, `Probe`, `ProbeResult`, `RenderedBlock`, `ReplyVerdict`, `Decision.inbox`, the `Tools*`, `PaymentLink*`, `DemoAgent*` and `PolicyProbe*` models, `WhoAmI`, `PublicDesk`, `KernelError`.
- Plan 01a's "Kernel internals": `adapters.base.Adapter` (`normalize`, `prepare`, `execute`, `on_failed`, `reconcile`), `AdapterRefusal`, `AdapterFailure`, `AdapterUnknown`, `ADAPTERS`, `registered_profiles(source=None)`; `labels.new_fact_label`; `activation.draft`, `confirm`, `current_hashes`, `activate_shipped`; `compiler.desk_schema`; `decide.tools_given`, `cedar_request`, `evaluate`; `execute.recheck`, `ORPHAN_AFTER`; `approvals.answer`; `reply_check.finalize`; `demo_inbox.deliver`; `ledger.append`; `desks.create_desk`; `public.public_desk`; `seed.RIVERA_CARDS`; `scripts/prove_presets.py`; `draft_and_confirm`. Plan 01b: `render.register_template(..., href_for=)`, `labels.combine`, `labels.store_knowledge`, `desks.ON_DELETE`, the `GET /demo_inbox?session_id=` handler, the access-log token redaction.
- Environment (Plan 06b's "Deploy and runtime" seam): `MOCKPAY_KEY`, `MOCKPAY_DATABASE_URL` (kernel container only), `MOCKPAY_URL` (default `http://127.0.0.1:8702`), `DESK_ENV`.

**Produced:**
- Kernel routes as in "Kernel HTTP API v2": `POST /tools/connect`, `POST /tools/confirm`, `POST /tools/simulate_change`, `GET /payment_links/{token}`, `POST /payment_links/{token}/complete`, `POST /payment_links/{token}/cancel`, `POST /agents/demo`, `POST /policy/{version}/probe`; the agent branches of `POST /sessions` and `GET /whoami?session_id=`, and signature auth on every `kind="agent"` session call.
- Adapters `native.payment_link`, `native.charge_mandate`, `payments.list_charges`, `payments.create_refund`, `native.fetch_website`, `native.read_memory`; renderers `payment_link`, `charges`, `refund_issued`, `charge_confirmed`, `payment_confirmed`; `PublicDesk.agent_card` blocks.
- Plan 02: nonce and opening-retry rules (409 `replayed`; a resent opening request returns the bound session), `PaymentLinkStateResult.verdict`, drift notices in the refused decision's `inbox`, `simulate_change` returning `needs_review`, probe semantics (Task 9). Plan 04: `PaymentLinkView`, `pending_definition_text`, `pending_sha256`. Plan 05a: Task 10's cases, `fetch_guard.guarded_fetch`, `FetchRefused`, `payments.ProviderClient`, `ProviderTimeout`, `POST /provider/seed`, `POST /provider/test/delay`, `MOCKPAY_SPAWN=1` (or the in-thread server) for `KernelTarget`. Plan 06b: `python -m desk.kernel_service` supervises the mock server and refuses to start in production without a valid `MOCKPAY_KEY` (Task 1).

## Review Focus owned

| Master Review Focus line (01c part) | Task | Tests |
|---|---|---|
| Agent sessions, regenerates and resent turns | 6 | `test_signed_request_for_another_agents_session_is_refused`, `test_regenerate_after_a_violation_uses_the_same_nonce`, `test_nonce_rules`, `test_resent_opening_request_recovers_its_session` |
| Mandates and the built-in agent's deposit | 7 | `test_agent_without_a_mandate_is_refused_for_both`, `test_mandate_oracle`, `test_charge_above_per_charge_is_refused_at_decide`, `test_expired_mandate_refuses`, `test_refund_under_a_mandate_is_refused`, `test_race_for_the_last_twenty`, `test_demo_agent_pays_the_rivera_deposit` |
| Payment links, restarts, `payment_confirmed` | 3, 7 | `test_complete_pays_once`, `test_concurrent_completes_pay_once`, `test_late_completion_is_refused`, `test_cancelled_link_cannot_be_paid`, `test_restart_mid_completion_pays_at_most_once`, `test_completion_returns_a_signed_payment_confirmed_verdict`, `test_restart_between_intent_and_result` |
| Rule cards, end-to-end money rows | 2, 5 | `test_charge_ask_with_person_auto_link`, `test_effect_auto_100_with_dana_link_auto_20`, `test_money_without_a_card_holds`, `test_eight_hundred_dollar_link_offers_no_allow_person`, `test_joint_pay_out_and_private_data_hold_a_large_refund` |
| Tool change, unpinned operation, cross-copy refund | 4, 5 | `test_drift_disables_the_tool`, `test_simulate_change_shows_review_at_once`, `test_extra_listed_tool_is_never_profiled`, `test_confirm_names_the_reviewed_hash`, `test_drift_refuses_the_call`, `test_cross_copy_refund_is_refused` |
| Dana's charges; unverified; Dana refunding Bob | 5 | `test_dana_lists_only_her_charges`, `test_unverified_list_is_refused`, `test_refund_of_someone_elses_charge_is_refused` |
| Setup fetch: private address, redirect, rebinding | 8 | `test_private_target_refused`, `test_redirect_to_private_is_refused`, `test_rebinding_resolves_once_and_connects_to_the_checked_address`, `test_any_private_answer_refuses` |

## Columns this plan adds

Revisions use `ADD COLUMN IF NOT EXISTS` and set `down_revision` to `main`'s head at merge (one head, "Shared seams"); no `kernel_ro` view changes.

| Table | Columns | Task |
|---|---|---|
| `mockpay.*` (only `MOCKPAY_TABLES`; test delays live in server memory) | `checkouts` (checkout_id, copy_id, idempotency_key, amount_cents, title, customer_id, state, charge_id); `charges` (charge_id, copy_id, owner_person_id (for `person:` customers), customer_id, amount_cents, description, idempotency_key, state, refunded_cents, created_at); `refunds` (refund_id, copy_id, charge_id, amount_cents, idempotency_key, state); `tool_definitions` (copy_id, name, definition jsonb); keys unique per copy and table; `state` may be `voided` | 1 |
| `kernel.payment_links` | link_id, copy_id, desk_id, session_id, action_id (unique), quote_id, title, amount_cents, state, token (unique), provider_checkout_id, customer_id, mandate_id, completion_started_at, expires_at, created_at, updated_at | 2, 3 |
| `kernel.policy_versions` | enables jsonb (`[{tool, definition_sha256}]`: the profiles a tool-confirm draft turns on) | 4 |
| `kernel.agent_keys` / `agent_nonces` | agent_key_id, copy_id, desk_id, public_key_hex, source, minted_by (a session_id or `owner`), created_at / copy_id, agent_key_id, nonce, session_id, body_sha256, first_used_at, check_replies, spent_at; unique (agent_key_id, nonce) | 6 |
| `kernel.demo_wallet_keys` / `mandates` | copy_id, key_id, public_key_hex, private_key_hex / mandate_id, copy_id, desk_id, session_id, issuer, agent_key_id, per_charge_cents, total_cents, expires_at (text), nonce (unique), envelope jsonb; the master's `committed_cents` and `reserved_cents` kept in step by Task 7 | 6, 7 |
| `kernel.mandate_reservations` | reservation_id, copy_id, mandate_id, action_id (unique), amount_cents, state (`reserved`, `committed`, `released`), created_at, updated_at | 7 |

## Landing

Tasks 1–7 and Task 10's money and agent rows are the Friday-gate content. If 18:00 arrives first, they land as PR 1 on `plan/01c`, and Tasks 8–9 with their rows follow on Saturday morning as PR 2 (setup is third in Saturday's order); within PR 2, Task 9 is cut before Task 8. PR 1 adds `01c` to `landed.toml`, PR 2 adds `01c-setup`, and a single PR adds both.

---

### Task 1: Mock payments server

**Files:**
- Create: `backend/desk/mockpay/{__init__,server,store,definitions}.py`, `backend/tests/mockpay/{conftest,test_server}.py` (fixture `mockpay_url`: uvicorn on a free port in a thread, fresh key), a migration for the `mockpay.*` columns
- Modify: `backend/pyproject.toml` (`mcp==2.3.0`, `httpx2==2.13.1`, `cryptography==50.0.2`), `kernel_service/app.py` (`KernelSettings.mockpay_url`, `mockpay_key`, `mockpay_spawn`; spawn, supervise, stop), `kernel_service/__main__.py` (serves with spawning on), `backend/tests/kernel/conftest.py` (the session-scoped mock server passed to `create_app`), `.env.example` (`MOCKPAY_KEY`, `MOCKPAY_URL`)

**Interfaces:**
- Produces:
  - `create_app(database_url, key, *, env) -> Starlette`, raising `ValueError` for a key under 32 characters: a low-level `Server("mock-payments", on_list_tools=..., on_call_tool=...)` served by `server.streamable_http_app(stateless_http=True, json_response=True, custom_starlette_routes=[...])`, behind middleware answering 401 unless `X-Mockpay-Key` matches (`hmac.compare_digest`) and 400 without `X-Desk-Copy`. `python -m desk.mockpay.server --host 127.0.0.1 --port <port>`.
  - MCP tools (per-copy rows in `tool_definitions`, defaults in `definitions.py`): `list_charges` (input `{customer_id}`; `readOnlyHint`; structured `{charges: [{charge_id, amount_cents, description, created_at, refunded_cents}]}`) and `create_refund` (input `{charge_id, amount_cents, idempotency_key}`; `destructiveHint`, `idempotentHint`; structured `{refund_id, charge_id, amount_cents}`). Reads filter by copy; a charge outside the copy, a voided key or a refund above the remaining amount → `isError: true`.
  - Store: each mutation locks its row `FOR UPDATE`; a checkout's charge uses key `<checkout key>:charge`. Provider routes (same headers; never in `tools/list`):

| Route | Body → response |
|---|---|
| `POST /provider/checkouts` | `{idempotency_key, amount_cents, title, customer_id}` → `{checkout_id}` (idempotent) |
| `POST /provider/checkouts/{id}/complete` | `{}` → `{charge_id, state: "succeeded"}` (idempotent); a cancelled checkout → 409 |
| `POST /provider/checkouts/{id}/cancel` | `{}` → `{state: "cancelled"}`, or, once completed, `{state: "succeeded", charge_id}` unchanged |
| `POST /provider/charges` | `{idempotency_key, amount_cents, customer_id, description}` → `{charge_id}` (idempotent; a voided key → 409) |
| `GET /provider/charges/{id}` | → `{charge_id, owner_person_id, amount_cents, refunded_cents}`; 404 outside the copy |
| `POST /provider/void` | `{kind: "checkout" \| "charge" \| "refund", idempotency_key}` → `{state: "exists" \| "voided", object_id}`: the lookup by idempotency key; an unused key gets a `voided` row, so a later request with it fails |
| `POST /provider/seed` | `{charges: [{owner_person_id, amount_cents, description, created_at}]}` → `{charge_ids}` (`customer_id = person:<owner_person_id>`) |
| `POST /provider/tool_definitions/{name}/simulate_change` | `{}` → `{definition}` (appends "Refunds may be sent to any card the caller names." to that copy's description) |
| `POST /provider/test/delay` | `{op: "checkout" \| "complete" \| "charge" \| "refund" \| "tools", seconds ≤ 10}` → `{}`: that copy's later `op` calls sleep before taking any lock |
| `GET /provider/health` | → `{ok: true}` |

  - Kernel lifespan: with `mockpay_spawn` (`python -m desk.kernel_service` or `MOCKPAY_SPAWN=1`; plain `create_app` uses `mockpay_url`), spawn `[sys.executable, "-m", "desk.mockpay.server", …]` on `MOCKPAY_URL`'s port with `cwd` = the backend root (`Path(desk.__file__).resolve().parents[1]`, so `desk` imports with the four-variable environment) and only `PATH`, `MOCKPAY_DATABASE_URL`, `MOCKPAY_KEY` and `DESK_ENV`, wait up to 10 s for `/provider/health`, restart it whenever it exits (backoff 1 s doubling to 30 s, log `mockpay_restarted`), terminate it on shutdown. A missing or short key: no child and payments fail closed, or with `DESK_ENV=production` the kernel refuses to start. A child that never answers: the kernel starts and calls fail closed.

- [ ] **Step 1: Write the failing tests:** `test_requests_without_the_key_are_rejected` (401; no copy header → 400); `test_server_refuses_to_start_without_a_key` (empty, 31 characters); `test_tools_list_has_exactly_two_tools`; `test_list_charges_is_scoped_by_copy_and_customer`; `test_refund_resolves_only_the_copys_charges` (and `GET /provider/charges/{id}` from another copy → 404); `test_refund_is_idempotent_and_bounded`; `test_checkout_complete_is_idempotent`; `test_complete_and_cancel_settle_once` (gathered → one wins; cancel after complete → `succeeded`; complete after cancel → 409); `test_void_settles_a_key_once` (3 kinds: used key → `exists`; unused → `voided`, then the create fails); `test_money_fields_are_strict` (`true`, `"2000"`, `2000.0` → 422); `test_simulate_change_alters_only_that_copy`; `test_delay_switch_is_per_copy_and_off_in_production`; `test_kernel_spawns_supervises_and_stops_the_server` (the child's environment is the four names and its cwd the backend root; killed → back within 5 s; gone after shutdown); `test_test_apps_do_not_spawn`.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/mockpay/test_server.py -v` → FAIL (`desk.mockpay` missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (14 functions, 17 cases).
- [ ] **Step 5: Commit** `git commit -m "feat(mockpay): add the supervised mock payments MCP server with copy-scoped charges and settled idempotency keys"`.

### Task 2: Payment links

**Files:**
- Create: `backend/desk/kernel_service/{payments.py,adapters/payment_link.py}`, a migration for the `kernel.payment_links` columns
- Modify: `adapters/__init__.py`, `render/{en,es}.py` (`payment_link`), `seed.py` (`rv-link`), `kernel/cedar/proofs/*.json` (regenerated), `backend/tests/kernel/test_context.py` (the unverified set gains `native.payment_link`)
- Test: `backend/tests/kernel/test_payment_links.py`, `backend/tests/kernel/test_money_rows.py`

**Interfaces:**
- Produces (`payments.py`): `ProviderClient(copy_id)` (`create_checkout`, `complete`, `cancel`, `charge`, `read_charge` (`READ_DEADLINE_S`), `void`, `seed`, `simulate_change`; the rest `PROVIDER_DEADLINE_S`; strict response models), raising `ProviderError` only when the request never arrived or got a 4xx, else `ProviderTimeout` (timeout, reset, 5xx, a body failing validation).
- Adapter: `Args{quote_id}` (closed). `normalize`: the quote must be in the session's copy and Desk, readable by the session, `available` and unexpired, else `AdapterRefusal`; `ResourceRef(kind="quote")`; prices from the quote row; effect `charge`. `execute`: `create_checkout` (key `action_id`; `customer_id` `person:<id>` when verified, else `session:<id>`), the link row (`issued`, `action_id`, token `secrets.token_urlsafe(32)`, 24 h) and a `payment_link:<link_id>` fact (claims title, total, ref = link_id; label `combine` of the quote's and the session's; `expires_at` the link's); `model_view {fact_id, title, amount_cents}`; `ProviderError` → `AdapterFailure`, `ProviderTimeout` → `AdapterUnknown`. `reconcile`: `void("checkout", action_id)`: `exists` → the link row and fact written as above (fresh token) → result; `voided` → None. Card: `register_template("payment_link", ..., href_for=)` returns `/pay/{token}` by `link_id`.
- Seed (01c row): `RIVERA_CARDS` gains `rv-link` (`native.payment_link` auto, anyone, `max_amount_cents=30_000`, `review=True`).

- [ ] **Step 1: Write the failing tests** in `test_payment_links.py` (cards via `draft_and_confirm`: auto `native.quote` with `max_discount_bp=1_000`, auto `native.payment_link` up to $500): `test_input_schema_takes_only_a_quote` (adding `amount_cents` → refuse); `test_link_amount_is_the_quotes_server_price`; `test_another_sessions_quote_is_refused`; `test_checkout_errors_map_to_outcomes` (2 cases: server stopped → `failed`, no link; a 3 s `checkout` delay → `unknown`, and once it lands, reconcile → `executed` with one link and one checkout); `test_link_clause_renders_title_and_path` (en and es; `href == "/pay/<token>"`; the token in no claim, block `text`, `model_view` or ledger summary).
- [ ] **Step 2: Write the money rows** in `test_money_rows.py` (cards via `draft_and_confirm`, then `/decide` on `native.payment_link`): `test_charge_ask_with_person_auto_link` (`effect:charge` ask + a Dana `native.payment_link` auto up to $100 → verified Dana `allow`, another verified visitor `hold`); `test_effect_auto_100_with_dana_link_auto_20` (Dana's $80 link `hold`; another visitor's $80 link `allow`); `test_money_without_a_card_holds` (default ask → `hold`; the draft's `money_needs_card` check is `ok`); `test_eight_hundred_dollar_link_offers_no_allow_person` (an $800 item under `effect:charge` auto $100 → `hold`, `answers` without `allow_person`).
- [ ] **Step 3: Run** `cd backend && uv run pytest tests/kernel/test_payment_links.py tests/kernel/test_money_rows.py -v` → FAIL.
- [ ] **Step 4: Implement**; run `make proofs`.
- [ ] **Step 5: Run** → PASS (9 functions, 11 cases).
- [ ] **Step 6: Commit** `git commit -m "feat(kernel): issue single-use payment links for quotes through the mock checkout"`.

### Task 3: Link completion and reconciliation

**Files:**
- Modify: `payments.py` (`link_view`, `complete_link`, `cancel_link`, `reconcile_links`; `cancel_desk_links` appended to `desks.ON_DELETE`), `app.py` (`/payment_links/{token}` routes; startup reconciliation), `repo.py` (`unsettled_links()`, a cross-copy lookup for startup reconciliation only, added to 01a's copy-scoping exceptions), `render/{en,es}.py` (`payment_confirmed`)
- Test: `backend/tests/kernel/test_link_completion.py`

**Interfaces:**
- Produces: `link_view(token) -> PaymentLinkView` (`language`: the session's last; reconciles first), `complete_link` and `cancel_link` → `PaymentLinkStateResult`; unknown token → 404 `not_found`. Completion follows 01a's execution shape:

| Step | Effect |
|---|---|
| C1: lock the link `FOR UPDATE` | needs `issued`, unexpired, `completion_started_at` null, else 409 `conflict`, ledgered; set `completion_started_at`; commit |
| C2: lock the link `FOR UPDATE` | provider `complete` (the checkout); `paid`, a `charge:<charge_id>` fact (title and total from the link, `new_fact_label` for the link's session, plus the person when verified), the link's fact `expired`, the verdict; commit |
| C3: after an exception in C2 (rolled back) | `ProviderError` → `issued`, marker cleared, 502 `internal`; anything else → `unknown`, marker kept |

| Link state | Event | Next |
|---|---|---|
| issued | 24 h pass (lazily) / `cancel` with no marker | `expired` / `cancelled` |
| issued, marker set | `cancel` or `complete` | unchanged, 409 `conflict` |
| issued, marker older than `ORPHAN_AFTER`, row not locked (`SKIP LOCKED`; startup or read) | — | `unknown` |
| unknown | `reconcile_links` (on read and at startup): provider `cancel`, atomic at the provider | `paid` (the charge fact, no verdict) on `succeeded`; `expired` on `cancelled`; `unknown` while unreachable |
| paid, expired, cancelled | `complete` or `cancel` | unchanged, 409 `conflict` |

  Every transition is ledgered `payment`; leaving `issued` sets the link's fact `expired` (a later citation is `stale_fact`). Completion returns `verdict` = `reply_check.finalize(..., blocks=[payment_confirmed], violations=[], language=<session's last>, author="desk")`, signed at the current generation and ledgered `reply`, in any session mode (`deliver()` decides visibility); a reconciliation returns none (Claude cites the fact with `charge_confirmed`). `cancel_desk_links(ctx, desk_id)` has Plan 01b's `ON_DELETE` signature (inside the delete transaction, no provider call; an exception rolls the delete back): the Desk's `issued` links without a marker → `cancelled`, a transition as above; marked and `unknown` ones stay for reconciliation.

- [ ] **Step 1: Write the failing tests:** `test_complete_pays_once` (one `mockpay.charges` row; again → 409, ledgered); `test_concurrent_completes_pay_once` (one `paid`, one 409; one charge, fact and verdict); `test_cancel_during_completion_is_refused` (409; the link ends `paid`); `test_read_during_completion_leaves_it_alone`; `test_late_completion_is_refused`; `test_cancelled_link_cannot_be_paid`; `test_provider_timeout_settles_once` (2 cases, a 3 s `complete` delay → `unknown`: read after it lands → `paid`, one charge; read before → `expired`, the late completion refused, no charge); `test_provider_error_returns_the_link_to_issued` (the next complete pays); `test_restart_mid_completion_pays_at_most_once` (the `paid` write raises after the provider returned; startup reconciliation → `paid`; one charge); `test_completion_returns_a_signed_payment_confirmed_verdict` (one block, current generation, signature verifies, a `charge` fact the session reads; cancel → `verdict` None); `test_link_fact_follows_the_link` (citing a paid or cancelled link → `stale_fact`); `test_deleting_the_desk_cancels_issued_links`.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/kernel/test_link_completion.py -v` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (12 functions, 13 cases).
- [ ] **Step 5: Commit** `git commit -m "feat(kernel): complete payment links once under a row lock and settle unknown outcomes at the provider"`.

### Task 4: MCP connection, pins and drift

**Files:**
- Create: `backend/desk/kernel_service/{mcp_client,mcp_pins}.py`, `adapters/payments_mcp.py` (profiles only; Task 5 adds behavior), a migration for `policy_versions.enables`
- Modify: `app.py` (`/tools/*` routes), `adapters/__init__.py`, `copies.py` (connect and seed before `activate_shipped`), `seed.py` (`connections=["mock_payments"]`, `RIVERA_MOCKPAY_CHARGES`, `rv-charges`, `rv-refund`), `compiler.desk_schema` (MCP actions), `activation.confirm` and `current_hashes` (`enables`), `backend/scripts/prove_presets.py`, `kernel/cedar/proofs/rivera.json` (re-proved), `backend/tests/kernel/test_context.py` (a verified session on a Rivera copy gains `payments.list_charges` and `payments.create_refund`; a new Desk doesn't)
- Test: `backend/tests/kernel/test_mcp_pins.py`

**Interfaces:**
- Produces:
  - `list_tools_raw(copy_id) -> dict[str, dict]` (name → `tool.model_dump(mode="json", by_alias=True, exclude_unset=True)`, all pages, within `MCP_DEADLINE_S`; any failure → `McpUnavailable`); `call_tool(copy_id, name, arguments)` (`McpUnavailable` only when `tools/call` was never sent; `McpTimeout` past the deadline; other errors propagate); `pin_sha256(entry)` = sha256 of `canonical_json_any(json.dumps(entry))` (the master's `definition_sha256`: every field of the parsed `tools/list` entry; fields `mcp.types.Tool` drops reach no one); `seed_pins()`, the same over `definitions.py`, so `make proofs` needs no server.
  - `MCP_OPERATIONS = {"payments.list_charges": "list_charges", "payments.create_refund": "create_refund"}`; nothing else listed is ever profiled. Both adapters register normally; `create_desk` writes only `registered_profiles(source="native")` rows, so only connect writes `payments.*` rows (safety invariant 5).
  - Profile parts: `payments.list_charges` (effects `["private_data"]`, reversible, resource `charge`, "Shows a verified customer their own past payments.", input `{}` closed); `payments.create_refund` (effects `["pay_out", "private_data"]`, not reversible, resource `charge`, "Refunds a verified customer's own payment in full.", input `{charge_id}` closed). Until Task 5 a call refuses at step 1.
  - `compiler.desk_schema(profiles)` appends one action per MCP profile, `memberOf` its effect groups, `appliesTo` the principal types of its "Given to" row and resource `Charge`. `prove_presets.py` compiles `rivera` over the native profiles plus both payments profiles at `seed_pins()`, and `ask_first` and `auto` over native profiles only.
  - `check_pin(ctx, desk_id, tool) -> PinCheck` (`ok`, `drifted(entry, sha)`, `removed`, `unavailable`), writing its row change, alert and ledger entry in the caller's transaction.
  - `enables` ("Activation gate"): `activation.current_hashes(ctx, desk_id, *, enables=())` computes `desk_schema` and `profiles_sha256` over the enabled profiles plus `enables` (current hashes, no pending drift); `confirm` passes the version's `enables` after a `check_pin` of each: drift → 409 `conflict` (`pin_changed`), unreachable → 503 `internal`, both ledgered, nothing activated.
  - Drift alerts go to the owner through `demo_inbox.deliver` always (drift isn't in Rivera's `now`) and into the refused decision's `inbox`: "{label} changed. Review it before Claude uses it again." or "{label} is no longer offered. Claude won't use it." (`TOOL_LABELS`: "Payment history", "Refunds").

| Profile state | Event | Next (ledger `tool_pin`) |
|---|---|---|
| — / any | `/tools/connect` / again | `needs_review` at the listing hash with the adapter's parts (`connected`) / unchanged, the current profiles |
| `needs_review` | `/tools/confirm` `enable: true` naming the listing hash (or `pending_sha256`), re-listed | a proved draft with `enables`; `enabled`, pending fields cleared, when `/policy/confirm` activates it |
| `enabled` | `/tools/confirm` `enable: true` at the current hash | unchanged, 200, no draft |
| any | `/tools/confirm` naming another hash / server unreachable / `enable: false` | unchanged, 409 `conflict` / unchanged, 503 `internal` / `disabled` at once |
| `enabled` | `check_pin` finds another hash / no such tool | `needs_review` with `pending_definition_text` (canonical JSON) and `pending_sha256` / with pending fields null, confirm 409 until listed again; the alert (`drift`) |
| `enabled` | `check_pin` can't list within 2 s | unchanged; the call refused |
| `enabled` | `/tools/simulate_change` | the server changes the definition (`simulated`), then `check_pin` at once; returns the drifted profile |

  `POST /copies`, after `create_desk`: connects each `DeskSeed.connections` entry with the seed's profiles `enabled` (a listing hash other than `seed_pins()` → 503 `seed_unproved`); seeds `RIVERA_MOCKPAY_CHARGES` through `/provider/seed` (Dana $180 "Drain clearing" and $250 "Leak repair", Bob $150 "Water heater flush"), writing each `charge:<id>` fact with that title (readers `["owner", "person:<id>"]`); then `activate_shipped("rivera")`. Server unreachable → 503 `internal`, rolled back, log `mockpay_unavailable`. Cards: `rv-charges` (`payments.list_charges` auto, record_owner), `rv-refund` (`payments.create_refund` ask, record_owner).

- [ ] **Step 1: Write the failing tests:** `test_rivera_copy_starts_with_both_payments_tools_pinned` (both `enabled`, `definition_sha256 == pin_sha256(entry) == seed_pins()[name]`; verified Dana's `/context` `tools` offers `payments.list_charges` with the adapter's description and schema); `test_new_desk_has_no_payments_tools_until_connected` (`POST /desks` → no `payments.*` row; `/decide` → `refuse`, `action` None; connect → `needs_review`); `test_new_desk_enables_payments_through_a_proved_draft` (connect, `/tools/confirm`, `/policy/confirm` → `enabled`; with an active $300 auto `effect:charge` card and a lowering to $100 left unconfirmed, the `/tools/confirm` draft carries the card at $100); `test_server_text_never_reaches_context` (a server description containing `IGNORE-PREVIOUS-7731`, re-pinned → absent from `tools` and `tools_declared` of every `/context`); `test_extra_listed_tool_is_never_profiled` (a listed `delete_customer` → two profiles; `/decide` on `payments.delete_customer` → `refuse`, `action` None, ledgered); `test_drift_disables_the_tool` (4 cases edited on the server: description, `inputSchema`, `annotations.destructiveHint`, tool removed → `needs_review`; the owner alert though drift isn't in `now`; Dana's `/context` loses it); `test_simulate_change_shows_review_at_once` (`needs_review` with `pending_sha256`; ledger `simulated` then `drift`); `test_confirm_names_the_reviewed_hash` (old hash → 409; `pending_sha256` → a proved draft; `/policy/confirm` → `enabled` and usable); `test_second_drift_blocks_the_pending_confirm`; `test_confirm_when_the_server_is_down_activates_nothing`; `test_unreachable_server_is_unavailable`; `test_relist_past_deadline_is_unavailable` (a 3 s `tools` delay → `unavailable` within 2.5 s); `test_copy_creation_with_the_server_down_is_503`; `test_disable_takes_effect_at_once`; `test_shipped_seed_report_matches` (`solver`; `prove_presets.py --check` passes; two Rivera copies' active hashes equal the shipped report's).
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/kernel/test_mcp_pins.py -v` → FAIL.
- [ ] **Step 3: Implement**; run `make proofs`.
- [ ] **Step 4: Run** → PASS (15 functions, 18 cases); Plan 01a's `test_kernel_seams.py`, `test_proving.py` and `test_policy.py` still pass.
- [ ] **Step 5: Commit** `git commit -m "feat(kernel): connect the mock payments server with pinned tool definitions and drift review"`.

### Task 5: Charges and refunds through trusted adapters

**Files:**
- Modify: `adapters/payments_mcp.py` (normalize, execute, reconcile), `execute.py` (`recheck`), `render/{en,es}.py` (`charges`, `refund_issued`, the visitor template `tool_unavailable`)
- Test: `backend/tests/kernel/test_payments_adapters.py`, `backend/tests/kernel/test_money_rows.py`

**Interfaces:**
- Produces:
  - `execute.recheck` on both paths, so a refund approved after a drift is caught: an MCP tool's `check_pin` must be `ok`; `drifted` or `removed` → `refused_at_execution` ("rules changed"); `unavailable` → `refused_at_execution` with visitor template `tool_unavailable` ("This isn't available right now, so it didn't go ahead" / "Esto no está disponible ahora, así que no se hizo"); no intent row; the drift row commits with the refusal.
  - `payments.list_charges`: `normalize` per "Listing charges" (no verified person → refuse). `execute`: `call_tool("list_charges", {"customer_id": f"person:{pid}"})`; `isError`, an MCP error or a result failing the strict `ChargeList` → `AdapterFailure` (a read moves nothing; `model_view = {}`, no facts). Facts upsert by `fact_id` `charge:<charge_id>`: a new one gets claims total, starts_at, ref (no title; the card says "Payment" / "Pago") and readers `["owner", "person:<pid>"]`; an existing one keeps its kernel claims and gains `person:<pid>` when the charge's `owner_person_id` is the principal's. `model_view {charges: [{fact_id, title, amount_cents, created_at}]}`, titles only from facts.
  - `payments.create_refund`: `normalize` ("Payments (mocked)"): no verified person → refuse; `read_charge(charge_id)` (404, failure or timeout → refuse at step 1); a partly refunded charge → refuse (full refunds only); `amount_cents` = the charge's; `ResourceRef(kind="charge", id=charge_id, owner_person_id=<the charge's>)`, so the baseline's record-owner forbid refuses another person's charge. `execute`: `call_tool("create_refund", {charge_id, amount_cents, "idempotency_key": action_id})`; `isError` or `McpUnavailable` → `AdapterFailure`; `McpTimeout`, any other error, or a result failing the strict `RefundResult` (`charge_id` and `amount_cents` equal to the action's) → `unknown`, `model_view = {}`; a `refund:<refund_id>` fact labelled like the charges. `reconcile`: `void("refund", action_id)`: `exists` → the result; `voided` → None.

- [ ] **Step 1: Write the failing tests** (cards via `draft_and_confirm`: auto `payments.list_charges` for `record_owner`, ask `payments.create_refund`): `test_schemas_are_closed`; `test_dana_lists_only_her_charges` (a mock description holding digits and an instruction is in no fact, card or `model_view`; Bob's charge ID nowhere); `test_listing_twice_and_after_a_paid_link_succeeds`; `test_unverified_list_is_refused`; `test_refund_of_someone_elses_charge_is_refused` (no `create_refund` call); `test_cross_copy_refund_is_refused`; `test_refund_needs_an_owner_card` (`hold`; `allow_once` → `executed`; `refund_issued` renders for Dana); `test_agent_cannot_refund`; `test_drift_refuses_the_call` (2 cases: an allowed list, an approved refund → `refused_at_execution`, no intent row, no server call, `needs_review`); `test_unreachable_server_refuses_the_call` (the same 2 cases; `visitor_plain` is `tool_unavailable`); `test_bad_server_output_fails_closed` (4 cases: a listed amount as `"18000"`, `true` or `18000.0` → `failed`, `model_view == {}`; a malformed refund result → `unknown`, then `executed` on reconcile); `test_lost_refund_response_reconciles_once` (the response dropped after the server refunded → `unknown`; reconcile → `executed`; one refund); `test_charges_clause_renders_per_fact` (en and es).
- [ ] **Step 2: Write the money row** in `test_money_rows.py`: `test_joint_pay_out_and_private_data_hold_a_large_refund` (`effect:pay_out` auto up to $50 plus `effect:private_data` auto for verified people; 2 cases on Dana's own seeded charges: $400 → `hold`; $40 → `allow`).
- [ ] **Step 3: Run** `cd backend && uv run pytest tests/kernel/test_payments_adapters.py tests/kernel/test_money_rows.py -v` → FAIL.
- [ ] **Step 4: Implement**; run `make proofs`.
- [ ] **Step 5: Run** → PASS (14 functions, 21 cases in the two files' new tests).
- [ ] **Step 6: Commit** `git commit -m "feat(kernel): list a verified customer's own charges and refund them through trusted adapters"`.

### Task 6: Signed visiting agents and demo agents

**Files:**
- Create: `backend/desk/kernel_service/agents.py`, a migration for the agent and wallet tables
- Modify: `auth.py` (agent signatures on every session call), `sessions.py` (agent `POST /sessions` and `/whoami`), `reply_check.py` (ending the nonce's turn), `demo_inbox.py` (minted agents' codes), `public.py` and `render/{en,es}.py` (Agent Card), `app.py` (`POST /agents/demo`), `backend/tests/kernel/test_context.py` (an agent session's set)
- Test: `backend/tests/kernel/test_agent_auth.py`

**Interfaces:**
- Produces (`agents.py`, Python `cryptography` per "Rust module surface"): `sign_canonical(private_key_hex, obj)`, `verify_canonical(public_key_hex, obj, sig_hex)` (Ed25519 over the UTF-8 of `canonical_json(json.dumps(obj))`; `agent_key_id` = first 16 hex of sha256 of the public key); `verify_agent_auth(repo, desk_slug, auth, body_sha256, session_id) -> str` (the key read through the `KernelRepo` of the slug's copy) and `verify_mandate(repo, desk_id, agent_key_id, mandate)`, raising `AgentAuthError(reason)` → 401 `auth`, ledgered `agent_auth` with the reason, never the signature; `issue_demo_agent(repo, desk_id, minted_by) -> DemoAgentIssued` (a fresh keypair, public key stored, `source="demo"`; a mandate from the copy's demo-wallet key, made on first use: `issuer="demo-wallet"`, `on_behalf_of="Demo visitor"`, `allowed_effects=["charge"]`, the "Agent demo" row's $20, $100 and one hour, `usd`, a random nonce; ledgered `agent_auth` `{agent_key_id, mandate_id, minted_by: "owner" | "session"}`, never a key). `AGENT_TS_SKEW_S = 300`, `NONCE_TTL_S = 300`, `DEMO_AGENTS_PER_COPY_PER_HOUR = 10` (over it: 429 `rate_limited`, ledgered `rate_limit`).
- Agent calls authenticate as "Agent sessions" says, including `/verify/start`, `/verify/check` and `GET /demo_inbox?session_id=`. The nonce lasts one A2A turn:

| Nonce state | Event | Next |
|---|---|---|
| unseen | first signed call by any route (`POST /sessions` creates the session and binds the nonce in one transaction) | bound to the session and body hash |
| bound | same session and body hash, or `POST /sessions` with the same body hash | accepted (`POST /sessions` returns the bound session; no new session, the mandate nonce not spent again) |
| bound or spent | another session or body hash | 401 `auth`, ledgered |
| bound | a verdict with `ok == true` or an immediate-handoff violation (`canary`, `unsupported_language`, `session_paused`), the second `/check_reply`, or 5 minutes | spent |
| spent | `POST /sessions` with the same key and body hash | 200, the bound session's `SessionCreated` (nothing created, the mandate nonce not spent again), ledgered `agent_auth {resent_opening: true}` |
| spent | any other call with the same session and body hash | 409 `replayed`, ledgered |

  Agent `POST /sessions` checks the mandate as "Agent sessions" says (issuer: this copy's demo wallet), stores it, binds the key and sets `agent_key_id` and `mandate_id`. `POST /agents/demo`: owner of the copy (`minted_by="owner"`) or a session on that `desk_id` (its id). `GET /demo_inbox?session_id=` adds `verification_code` entries for challenges started by agent sessions whose key that session minted. `public.public_desk` fills `agent_card` with en/es blocks (`kind="prose"`, no template or fact): the agent tools by plain label without amounts, the slug, `/api/a2a/{desk_slug}`, the signed fields, Ed25519 over RFC 8785, the 5-minute window, the AI disclosure, and that agent keys are not business credentials.

- [ ] **Step 1: Write the failing tests:** `test_demo_agent_round_trip` (`agent_keys` has no private key column; the mint ledgered without a key; the mandate verifies with the wallet's public key; a signed `POST /sessions` → `SessionState(kind="agent")`, principal with `agent_key_id` and `mandate_id`; `GET /whoami?session_id=` answers); `test_bad_signature_is_refused` (signed over another slug → 401, `agent_auth`); `test_stale_timestamp_is_refused`; `test_nonce_rules` (same session and body → accepted; other body → 401; other session → 401; after a passing verdict, and after a `canary` handoff, the same `/whoami` call → 409 `replayed`; six minutes later → spent); `test_resent_opening_request_recovers_its_session` (3 cases: during the turn → the same session, one `sessions` row; after a passing verdict and after an immediate handoff → the bound session's `SessionCreated`, still one row); `test_regenerate_after_a_violation_uses_the_same_nonce` (a violating `/check_reply`, then a passing one on the same nonce → the second verdict's blocks; a third call → 409 `replayed`); `test_unsigned_agent_calls_are_refused` (`/context`, `/decide`, `/execute`, `/check_reply`); `test_signed_request_for_another_agents_session_is_refused` (agent B's valid signature naming agent A's session → 401, ledgered `agent_auth`); `test_key_from_another_copy_is_refused`; `test_mandate_checks` (6 cases: another Desk, expired, nonce reused, `agent_key_id` mismatch, untrusted signer, `total_cents` edited → 401, no session); `test_demo_agent_rate_limit` (over the limit → 429 `{"code": "rate_limited"}`, ledgered `rate_limit`); `test_session_cannot_mint_for_another_desk`; `test_minting_session_reads_its_agents_codes` (signed `/verify/start` and `/verify/check` for Dana; the minting session's inbox shows the code, another session's doesn't); `test_public_agent_card_is_kernel_rendered` (en and es; the agent tools by label; no amount, key, mandate or private field).
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/kernel/test_agent_auth.py -v` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (14 functions, 21 cases).
- [ ] **Step 5: Commit** `git commit -m "feat(kernel): verify signed visiting agents and mint demo agents with wallet-signed mandates"`.

### Task 7: Mandates and agent charges

**Files:**
- Create: `backend/desk/kernel_service/{mandates.py,adapters/charge_mandate.py}`, a migration for `kernel.mandate_reservations`
- Modify: `decide.py` (`mandate_remaining_cents` in the principal), `adapters/payment_link.py` (agent reservations), `payments.py` (link transitions settle them), `seed.py` (`rv-mandate`), `render/{en,es}.py` (`charge_confirmed`), `kernel/cedar/proofs/*.json` (regenerated)
- Test: `backend/tests/kernel/test_mandates.py`

**Interfaces:**
- Produces (`mandates.py`): `remaining_cents(session, mandate_row, desk_id, now) -> int | None` = `min(per_charge_cents, total_cents − committed_cents − reserved_cents)`, None (the attribute absent) when expired, for another Desk or without `charge` in `allowed_effects`; set on each request of a session with a mandate. `reserve(session, mandate_id, action_id, amount_cents)`: `SELECT … FOR UPDATE` on the mandate row, the same bound, else `MandateExhausted`; adds to `reserved_cents` and inserts the reservation. `commit(session, action_id)` and `release(session, action_id)` move the amount out of `reserved_cents` (into `committed_cents` on commit) under the same lock; idempotent, a missing reservation is a no-op.
- `native.charge_mandate`: `Args{quote_id}` (closed); amount and title are normalized from the quote row, as for `native.payment_link`. The approved path reserves too: 01a's `approvals.answer` already runs `prepare`.

| Hook (01a seam) | `native.charge_mandate` | an agent session's `native.payment_link` |
|---|---|---|
| `prepare` (T1, with the intent row) | `reserve`; `MandateExhausted` → `AdapterRefusal` → `refused_at_execution` | the same |
| `execute` (T2) | `ProviderClient.charge` (key `action_id`, `customer_id=f"agent:{agent_key_id}"`), `commit`, a `charge:<charge_id>` fact (the quote's title; readers `["owner", "session:<sid>"]`) for `charge_confirmed`; `ProviderError` → `AdapterFailure`; anything else → `unknown`, reservation kept | Task 2's checkout and link; the reservation stays for the link table |
| `on_failed` | `release` | `release` |
| `reconcile` | `void("charge", action_id)`: `exists` → `commit`, the fact, the result; `voided` → None (then `on_failed`) | Task 2's; `exists` keeps the reservation |
| link transitions (Task 3) | — | `paid` → `commit`; `expired`, `cancelled` → `release`; `unknown` → kept until reconciled |

- Seed (01c row): `RIVERA_CARDS` gains `rv-mandate` (`native.charge_mandate` auto, anyone, `max_amount_cents=2_000`); the $20 `deposit` item is Plan 01a's.

- [ ] **Step 1: Write the failing tests** (a test Desk with $20 and $25 items via `POST /desks`, its money cap set to $500 by the first `draft_and_confirm(..., auto_money_cap_cents=50_000)`; cards via `draft_and_confirm`: `rv-mandate`, auto `native.quote`, auto `native.payment_link` up to $500; a demo agent session): `test_agent_without_a_mandate_is_refused_for_both` (`native.payment_link` and `native.charge_mandate` → `refuse` at step 1, `action` None, ledgered); `test_mandate_oracle` (ten $20 charges, each on its own quote: five `executed`, six to ten `refused` at `/decide`; five mock charges; `kernel_ro.mandates.committed_cents == 10_000`); `test_charge_above_per_charge_is_refused_at_decide`; `test_expired_mandate_refuses`; `test_refund_under_a_mandate_is_refused`; `test_race_for_the_last_twenty` (2 cases, `native.charge_mandate` and `native.payment_link`: after $80 committed, two allowed calls execute concurrently → exactly one succeeds, the other `refused_at_execution`); `test_approved_agent_charge_reserves_before_executing` (an ask card; `allow_once` reserves with the intent; with no room → `refused_at_execution`, approval consumed, no provider call); `test_restart_between_intent_and_result` (the result write raises after the provider charged → `unknown`, still `reserved`, so with $80 committed another $20 charge is refused; reconcile → `executed`, `committed`; one charge); `test_timeout_then_reconcile_never_double_spends` (a 3 s `charge` delay → `unknown`; reconcile at once → `voided`, `failed`, released; the late charge refused; a new charge executes and `committed_cents` is exact); `test_provider_failure_releases`; `test_payment_link_reservations_follow_the_link_table` (paid, cancelled, expired, unknown then reconciled); `test_demo_agent_pays_the_rivera_deposit` (a Rivera copy: quote `deposit`, `native.charge_mandate` → `executed`, `charge_confirmed` renders).
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/kernel/test_mandates.py -v` → FAIL.
- [ ] **Step 3: Implement**; run `make proofs`.
- [ ] **Step 4: Run** → PASS (12 functions, 13 cases); Tasks 2–4 still pass.
- [ ] **Step 5: Commit** `git commit -m "feat(kernel): reserve agent spend with the execution intent and commit or release it as the charge settles"`.

### Task 8: Setup tools: website fetch and memory reads

**Files:**
- Create: `backend/desk/kernel_service/fetch_guard.py`, `adapters/{fetch_website,read_memory}.py`, `fixtures/memory.json` (the simulated memory: business, trade, service area, hours, website)
- Modify: `adapters/__init__.py`, `kernel/cedar/proofs/*.json` (regenerated), `backend/tests/kernel/test_context.py` (the owner set gains `native.fetch_website` and `native.read_memory`)
- Test: `backend/tests/kernel/test_fetch_guard.py`, `backend/tests/kernel/test_setup_tools.py`

**Interfaces:**
- Produces (in `fetch_guard.py`, implementing the master's "Website fetch" bullet): `is_public_address(ip)` (`ip.is_global` and not `is_multicast`, `is_reserved` or `is_unspecified`, and false for any IPv4-mapped, 6to4, Teredo or 64:ff9b::/96 form; `test_address_policy` is its contract); `Resolver` and `system_resolver` (one `getaddrinfo`); `guarded_fetch(url, *, resolver, transport=None) -> FetchedPage{final_url, content_type, title, text}` raising `FetchRefused(reason)` (`scheme`, `port`, `userinfo`, `address`, `redirects`, `type`, `too_large`, `timeout`, `error`). Rules: `http`/`https`, port 80 or 443, no userinfo; resolve once, refuse if any answer isn't public, connect to the first answer with the address in the URL, a `Host` header and `extensions={"sni_hostname": host}`; `follow_redirects=False`, `trust_env=False`; a `Location` resolves against the hostname URL and is validated from scratch, at most 3; `text/html` or `text/plain`; 1 MiB streamed cap; all within `FETCH_TOTAL_TIMEOUT_S`; HTML to text with `html.parser` (no script or style, whitespace collapsed, 20_000 characters).
- `native.fetch_website`: `Args{url ≤ 2048}`; owner sessions only; `execute` stores a `KnowledgeItem(source="website")` through `labels.store_knowledge` (owner-only), `model_view {item_id, title, text[:8000]}`; `FetchRefused` → `AdapterFailure` (`failed`, `model_view = {}`, the reason in the ledger).
- `native.read_memory`: `Args{query ≤ 200}`; owner only; fixture items matching the query words stored as `memory_import`, owner-only; `model_view {items: [{title, text}], simulated: true}`.

- [ ] **Step 1: Write the failing tests** in `test_fetch_guard.py`: `test_address_policy` (20 cases: `8.8.8.8` and `2606:4700::1111` public; `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `127.0.0.1`, `169.254.170.2`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`, `224.0.0.1`, `255.255.255.255`, `::1`, `fe80::1`, `fd12::1`, `::ffff:127.0.0.1`, `::ffff:8.8.8.8`, `64:ff9b::a00:1`, `2002:a00:1::`, `ff02::1` not); `test_private_target_refused` (the transport never called); `test_any_private_answer_refuses`; `test_rebinding_resolves_once_and_connects_to_the_checked_address` (resolver ran once; URL host `93.184.215.14`, `Host` `rivera-plumbing.example`, matching `sni_hostname`); `test_redirect_to_private_is_refused` (3 cases: a host resolving to `10.0.0.5`, `[::ffff:127.0.0.1]`, `169.254.170.2`); `test_relative_redirect_keeps_the_hostname`; `test_redirect_limit`; `test_size_and_type_limits`; `test_scheme_port_userinfo_rejected`; `test_timeout` (within 4.5 s).
- [ ] **Step 2: Write the failing tests** in `test_setup_tools.py`: `test_fetch_is_owner_only_and_decided` (a visitor → refuse; the owner under the `ask_first` preset → executed, an owner-only item, `decide` and `execute` entries; a refused fetch → `failed`, empty `model_view`); `test_memory_reads_are_simulated`; `test_fetched_text_with_a_canary_stays_owner_only`.
- [ ] **Step 3: Run** `cd backend && uv run pytest tests/kernel/test_fetch_guard.py tests/kernel/test_setup_tools.py -v` → FAIL.
- [ ] **Step 4: Implement**; run `make proofs`.
- [ ] **Step 5: Run** → PASS (34 cases).
- [ ] **Step 6: Commit** `git commit -m "feat(kernel): add the owner's website fetch with SSRF guards and simulated memory reads"`.

### Task 9: Setup safety probes

**Files:**
- Modify: `activation.py` (`probe_version`), `app.py` (`POST /policy/{version}/probe`)
- Test: `backend/tests/kernel/test_probe.py`

**Interfaces:**
- Produces: `probe_version(repo, desk_id, version, probes) -> list[ProbeResult]`, one per probe, never a batch failure (only a malformed body is 422 `invalid`). It loads the version (any status) under its own engine key and builds each `Probe` without resolving or executing anything:

| Part | Built from |
|---|---|
| Principal | `actor`; verified iff `who` is `verified`, `record_owner` or `person`; `person_id` = `subject_id` for `person`, else `probe:caller` when verified; `agent_key_id` = `subject_id` for `agent`, else `probe:agent`; with `agent_mandate_remaining_cents` set, `mandate_id="probe:mandate"` and `mandate_remaining_cents` = it |
| Tool | `decide.tools_given` with a stand-in `SessionRow(kind=actor, verified, person_id, mode="ai")` over the version's enabled profiles; an unknown or withheld tool (`admin.export_customers`, an agent's refund) or args failing the closed `input_schema` → `refuse`, no cards, a plain reason |
| Resource | `ResourceRef(kind=resource_kind, id="probe")`, `owner_person_id` the caller's (`caller`), `probe:other` (`other`) or None; no quote, slot or document is read |
| Prices | `list_cents = amount_cents`; `discount_bp` from `args.requested_discount_bp`; `amount_cents` per "Discounts"; a money tool without `amount_cents` → `refuse`; `context.auto_money_cap_cents` is the version's cap (Plan 01b) |
| Time | `local_dow` and `local_minute` from `probe.starts_at` when set (slot and booking probes; the stand-in `Normalized.starts_at` is set from it), else from `clock.now()`, in the business's time zone |

  Then steps 2–5 in phase `pre`; on `needs_review`, phase `final` with `review` absent (no reviewer call) and `depends_on_review = True`. No decision, approval or execution rows, no version change; one `policy` entry `{version, probes: n, outcomes}`. Owner of the copy only; a proving call ("How proofs run": 60 s, 202 poll).

- [ ] **Step 1: Write the failing tests:** `test_stranger_asking_half_off_asks_the_owner` (`hold` with the quote card in `card_ids`); `test_probes_change_nothing` (active version and row counts unchanged); `test_review_gated_card_probes_as_hold_depending_on_review` (`hold`, `depends_on_review`, no reviewer call); `test_agent_probe_uses_the_hypothetical_mandate` (2 cases on `native.charge_mandate` at `amount_cents=2_000` with an auto card: remaining 1_000 → `refuse` naming `agent_charge_within_mandate`; remaining 5_000 → `allow`); `test_money_probes_need_no_quote` (`native.payment_link` at a stand-in $80 → decided on it; no `amount_cents` → `refuse`); `test_unknown_or_withheld_tool_probes_refuse` (both → `refuse`, batch 200); `test_probe_callers` (3 cases on `native.release_document`: unverified → `refuse`; verified, `resource_owner="other"` → `refuse`; `record_owner`, `resource_owner="caller"`, a record-owner auto card → `allow`); `test_probe_uses_its_start_time` (2 cases under a weekday-hours `auto native.book` card: Sunday 22:00 → `hold`; Tuesday 10:00 → `allow`); `test_probe_requires_the_owner_of_the_copy` (another copy → 404).
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/kernel/test_probe.py -v` → FAIL (404).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (9 functions, 13 cases).
- [ ] **Step 5: Commit** `git commit -m "feat(kernel): run setup safety probes against a rule draft without activating it"`.

### Task 10: Evals gate for this plan

**Files:**
- Create: `evals/tier1/test_01c_*.py` (`requires("01c")`, the Task 8–9 cases `requires("01c-setup")`; Plan 05a's ownership rule) for the cases below
- Modify: `evals/tier1/landed.toml` (add `01c`, and `01c-setup` once Tasks 8–9 are in); `evals/results/<inputs>.json` (once tier 2 exists)

- [ ] **Step 1: Add** tier 1 cases through the kernel HTTP API that Plan 05a lacks: `payment_confirmed` only for the link's session; concurrent completes paying once; a new Desk without `payments.*`; an approved refund refused after a drift; a timed-out mandate charge settled by `void` without a second charge; nonces resent after a turn or handoff (409 `replayed`) and a resent opening request after its turn (the bound session); minted agents' codes; unknown-tool and amount-less money probes.
- [ ] **Step 2: Run** `make evals-tier1` → new cases fail only where the kernel is wrong; fix the kernel, never the case or its oracle; then every `01a`, `01b`, `01c` and (once landed) `01c-setup` row passes with 0 baseline violations. `cd backend && uv run alembic heads` → one head.
- [ ] **Step 3: Before merge** (again after any later kernel change), once Plan 05b's tier 2 runner is on `main` (its Task 4, in 05b's PR 1, which merges Friday morning before this plan's PR): rebase onto `main`, run `make evals-tier2` (`--suite all --split all`) and commit the run-free results file it writes at the rebased head (`evals/results/<inputs>.json`, `make evals-key`), which CI's `tier 2 results` check (`make evals-results-check`) requires. Until Plan 02 lands (`02` in `landed.toml`), every 01c scenario is pending and that file has no runs, which is no pass: the PR body says "tier 2 pending Plan 02", and the coordinator reruns Plan 05b's 01c scenarios in the first tier 2 pass after Plan 02 lands → zero baseline violations, legitimate completion reported only.
- [ ] **Step 4: Commit** `git commit -m "test(evals): add tier 1 cases for payments, pins, agents, mandates and setup fetches"`.

## Open questions for the master plan

1. **`Probe` time.** Answered: the master adds `Probe.starts_at` for `slot` and `booking` probes; Task 9 reads it.
2. **A kernel rate-limit code.** Answered: the master adds 429 `rate_limited`; `POST /agents/demo` uses it (Task 6).
3. **`definition_sha256` wording.** Answered: "every field of the parsed `tools/list` entry; fields the SDK drops reach no one" (Task 4).
4. **One payment per quote (owner decision).** A quote can back several links or charges today, bounded by the cards and the mandate. Recommended: at most one open or paid link, or one charge, per quote.
5. **Simulate wording.** Answered: "Connected integration" says `/tools/simulate_change` re-lists at once, so "Needs your review" shows right away and the next call is refused.
6. **A resent opening request after its turn.** Answered: a spent nonce's opening `POST /sessions` with the same key and body hash returns the bound session (Task 6); only the key holder could have signed it, and `ts` bounds a resend to 5 minutes.

## Review Ledger

Round 1 (2026-10-29): seats Sol, Opus, Fable — P1/P2/P3 Sol 3/6/2, Opus 3/15/10, Fable 2/7/10; 36 root causes: 32 fixed, 1 master plan change, 1 deferred, 2 invalid.

Major findings and changes:
- Mandate spend is reserved in 01a's `prepare` (with the intent row) and released in `on_failed`, keyed by `action_id` for charges and agent links; the approved path calls `prepare` (all seats).
- Uncertain provider and MCP outcomes are `unknown`, settled at the provider (`void`, checkout `cancel`) so nothing lands after a release (Opus, Sol).
- Link completion is fenced by a row lock, a marker and 01a's orphan rule, in its own task (all seats).
- Pins are re-listed in `execute.recheck` on both paths; `simulate_change` shows review at once; drift alerts always reach the owner (Opus, Sol, Fable).
- Rivera's shipped proof includes the pinned payments profiles; confirming `enables` hashes schema and profiles alike (all seats).
- Mock server: a 32+ character key, an exact child environment, supervision, no spawning in tests, in-memory delays, strict money; `POST /copies` answers 503 when it's down (Opus, Fable, Sol).
- Charge facts upsert with kernel titles only; link facts expire with the link; opening agent requests recover their session; the $400 refund and $800 link rows; a landing split; an honest tier 2 step.

Deferred: one payment per quote (open question 4); a `Health` field for the payments child (a contract change; supervision and logs cover it).

Invalid: `minted_by_session_id` (01b moved the minted-agent inbox here with `minted_by`); token access-log redaction (01b's filter covers `/payment_links/`).

Master plan changes requested: open questions 1, 2, 3, 5 and 6.

Owner decisions, 2026-10-29: the auto-money cap comes from each Desk's charter under a $20,000 platform ceiling (master "Charter money cap"; Plan 01b's Task 3b switches it). Here: test Desks from `POST /desks` set their cap before drafting auto money cards (Global Constraints, Task 7), and probes evaluate at the version's cap (Task 9). The setup interview and the per-business-type templates that carry a suggested cap are Plan 02b's (`setup.py`, `setup_templates.py`), so that change lives there.

Fix round, 2026-10-29: Task 4's `/tools/confirm` draft brings carried-over money cards down to a lowered cap with Plan 01b's `lower_to_cap`, tested in `test_new_desk_enables_payments_through_a_proved_draft`.

Round 2 (seam review, 2026-10-29): seam-02 Tasks 8–9 rows `requires("01c-setup")`, landed per PR; seam-03 05b's runner merges Friday morning, so Task 10 commits a run-free results file at the rebased head; seam-14 demo-agent limit is 429 `rate_limited`; seam-15 probes take time from `probe.starts_at` (`test_probe_uses_its_start_time`); seam-16 a resent opening request after its turn returns the bound session; seam-35 plan names 05a, 06b; seam-36 01a runs `prepare` on approval, open questions 3 and 5 answered; seam-40 `test_context.py` in Tasks 2, 4, 6, 8; seam-42 `native.charge_mandate` takes `Args{quote_id}`; seam-43 the mock child runs via `sys.executable -m` from the backend root.
