# Spike: a Rust Cedar policy kernel called from Python

Date: 2026-10-28. A throwaway feasibility spike run before planning the safety kernel (master plan Task 1). It answers four questions: can `cedar-policy` decide allow/hold/refuse across three policy sets fast enough; can the reviewer call be skipped when its score can't change the outcome; can SymCC prove the safety properties and produce counterexamples; and can the kernel ship as a Python extension in Linux containers. Host: macOS on arm64 with Docker Desktop.

## Summary

**What works:**
- `cedar-policy =4.14.0` loads the three sets (baseline forbids, owner permits, review-gated permits), validated, in about 4 ms. `decide` takes 51–65 µs in Rust and 37–39 µs from Python, and returns allow/hold/refuse with the deciding policy ids.
- Partial evaluation with `context.review` left unknown works with the feature `partial-eval`. When the decision comes back known, the reviewer call can be skipped; 7 of 9 test requests skipped it. TPE (`tpe`) can't leave only part of the context unknown, so it doesn't fit.
- SymCC proved P1 (public users can never read private data), P2 (the review set only narrows) and P2' (per action). Buggy policies produced counterexamples. Each proof takes 8–17 ms through the CLI; all 22 checks take 25 ms from Rust on one solver process.
- `cedar-policy-symcc =0.8.0` needs no features and must match the Cedar version exactly. `cedar-policy` itself has no `analyze` feature (only the CLI does). cvc5 1.4.2 runs as a separate process and works.
- `pyo3 0.30.1` (`extension-module`, `abi3-py313`) with maturin 1.15.0 builds; `decide`, `append` and `verify` work on macOS, Linux arm64 and Linux amd64.
- Linux builds: arm64 native 1m20s; amd64 zig cross-compile 1m42s; amd64 emulated 8m12s. `Dockerfile.ecs` (python:3.13-slim + rustup, two stages): arm64 2m34s, runtime image 163 MB.

**What breaks the plan's assumptions:**
1. The installed `cedar` CLI was built without `analyze`, so `symcc` only prints an error. Rebuild with `--features analyze,experimental`.
2. `cedar symcc` exits 0 even when a proof fails. CI must look for `DOES NOT HOLD`, or (better) use the Rust API's `Option<Env>`.
3. `>=` doesn't work on `decimal`: use `.greaterThanOrEqual(decimal("0.8"))`. Cedar has no floats; convert the score to a 4-decimal value and reject anything outside [0,1].
4. "No money movement without an owner rule" can't be a Cedar forbid (a policy can't see which other policy matched). Enforce it with proof P3 (review set always denies MoveMoney) plus the kernel's rule that MoveMoney allow requires an `owner.*` permit among the deciding policies. A forbid on `context has review` would also break reviewer-skipping, because an unknown `review` makes `has` true.
5. "Review only narrows" holds trivially when the gate is a separate AND clause. It only catches bugs if the rule compiler also emits each owner rule *without* the gate and the proof compares the gated set against that ungated set.
6. A forbid that errors fails open (Cedar skips erroring policies). The kernel must refuse when any baseline policy errors, and the never-errors proof (P4) must stay in CI.
7. A schema-validated request can't contain an unknown: validate the request without `review` first, then build the partial request with no schema.
8. `serde_json` key order isn't sorted in this build (`cedar-policy-core` enables `preserve_order`); `append` sorts keys itself. That isn't full RFC 8785; adopt JCS if other languages must recompute hashes.
9. Policies compiled into the wheel with `include_str!` need a rebuild to change. Owner rules change at runtime, so expose a `Kernel(schema, sets)` class to Python (`Kernel::from_sources` exists in the core).

## Recommended pins

| Component | Pin |
|---|---|
| rustc/cargo | 1.99.1, edition 2024, resolver 3 |
| cedar-policy | `=4.14.0`, `default-features=false`, features `["decimal","partial-eval"]` |
| cedar-policy-symcc | `=0.8.0`, no features (0.7.0 needs `=4.13.0`; 0.6.0 needs `=4.12.0`) |
| cedar-policy-cli | 4.14.0 built with `--features analyze,experimental` |
| cvc5 | 1.4.2 (`CVC5=~/.local/bin/cvc5`) |
| tokio (for symcc) | 1.54.1, features `rt,macros,process` (symcc needs ≥ 1.52) |
| pyo3 | 0.30.1, `extension-module`, `abi3-py313` |
| maturin | 1.15.0 |
| ed25519-dalek / sha2 / hex / serde_json | 3.0.0 / 0.11.1 / 0.4.3 / 1.0.154 |
| Python | 3.13 |
| ghcr.io/pyo3/maturin | pin by digest `sha256:1c897d72a79c083cdea8829662f7b28e7657cf5b0d7f44fb4231e55998cf52ed` (maturin 1.15.0, rustc 1.98.0, manylinux2014), only if wheels must install outside our own image |

Upgrade Cedar and symcc together.

## How decide works in the spike

- Load: parse each policy file, rename each policy to `<set>.<@id>` with `p.new_id(PolicyId::new(..))` (the library's `PolicySet::from_str` names them `policy0..N`; only the CLI uses `@id`), put all into one `PolicySet`, validate with `Validator::validate(.., ValidationMode::Strict)`.
- Deciding ids come from `resp.diagnostics().reason()`; the prefix tells which set fired.
- Outcome: **refuse** if a `baseline.*` policy decided it or any `baseline.*` policy errored; **allow** if Cedar allows (for MoveMoney, an `owner.*` permit must also be among the deciding policies); **hold** otherwise.
- Reviewer skip: build context with `RestrictedExpression::new_unknown("review")`, call `Authorizer::is_authorized_partial`. `pr.decision()` is `Some(_)` → skip the reviewer; `None` → review needed, `nontrivial_residuals()` lists the pending review-gated policies. If a baseline forbid is still unresolved, ask for the review anyway. Re-running `decide` with the score filled in costs ~50 µs (simpler than `reauthorize_with_bindings`).

## Proofs

SymCC has no "prove this formula" command: each property is a spec policy set checked with `implies`, `always-denies`, `equivalent`, `disjoint` or `never-errors`, one (principal type, action, resource type) combination per check. Global flags go before the subcommand:

```
cedar symcc --principal-type Desk::Principal --action 'Desk::Action::"ReadPrivate"' \
  --resource-type Desk::Dataset --schema desk.cedarschema \
  implies --policies1 all.cedar --policies2 props/public_no_readprivate.cedar
... implies --policies1 review.cedar --policies2 review_intent.cedar   # P2
... implies --policies1 all.cedar    --policies2 all_intent.cedar      # P2', per action
... always-denies --policies review.cedar   (MoveMoney)                # P3
... never-errors  --policies single/<id>.cedar                         # P4
```

From Rust: `CedarSymCompiler::new(LocalSolver::cvc5()?)` (reads `$CVC5` or PATH, 60 s limit), `CompiledPolicySet::compile(&pset, &RequestEnv, &schema)`, then `check_implies_with_counterexample_opt`, `check_always_denies_opt`, `check_never_errors_opt`; `schema.request_envs()` lists every combination. Counterexamples come back as an `Env` with `.request` and `.entities`. Run proofs in a small Rust binary (like `crates/symcc-rs`) in CI and when an owner publishes rules (10–30 ms per proof at 250 policies). Keep SymCC out of the runtime wheel.

Sample counterexample (review gate OR-ed instead of AND-ed):
```
✗ Policy set 1 implies policy set 2: DOES NOT HOLD
principal: Desk::Principal::"", action: Desk::Action::"SendMessage", resource: Desk::Owner::""
context: {review: {within_charter: decimal("922337203685477.5807")}, topic: ""}
```

## PyO3 module (spike)

`decide(request_json)` (releases the GIL), `pre_review(request_json)`, `append(prev_hash, payload_json)` → hash, Ed25519 signature, pubkey, `dev_key` flag (hash = SHA-256("desk-ledger-v1\0" ‖ prev or 32 zero bytes ‖ canonical JSON)), `verify(entry_json)`, `public_key()`. Key from `DESK_SIGNING_SEED` (64 hex); production must fail closed when it's missing instead of using the dev key. Set `strip = true` in the release profile (the `.so` is 7.8 MB unstripped).

## Container builds

- arm64 (Graviton): `Dockerfile.ecs` on an arm64 runner, 2.5 min cold, 163 MB; add a BuildKit cache mount for the cargo registry (saves ~55 s).
- amd64: build natively or zig cross-compile from arm64 (1m42s); avoid emulation.
- One local Docker tag holds one architecture with the classic image store; build each platform separately.
