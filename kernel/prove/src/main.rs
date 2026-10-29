//! desk-prove: proves a Desk's policy sets with SymCC and prints a ProofReport.
//!
//! ```text
//! desk-prove --schema <file> --sets <file> --checks <file> --timeout-ms <n>
//! desk-prove --selftest [--timeout-ms <n>]
//! ```
//!
//! - `--schema`: the Desk's Cedar JSON schema.
//! - `--sets`: `{"B", "F", "A", "A0", "H", "R", "R_hold": <Cedar text>,
//!   "always": [<Cedar text>], "auto": [<Cedar text>]}`; only the sets the
//!   requested checks use are required.
//! - `--checks`: `{"checks": [<names>], "money_uncovered": [<tool>]}`.
//! - Exit codes: 0 every check holds; 1 a check failed (its counterexample, a
//!   request_json, is in the report); 2 tool error or timeout, also reported
//!   as `timed_out`.
//!
//! The whole run gets `--timeout-ms`, counted from before any input is read.
//! The work (reading, parsing, compiling, solving) runs on a worker thread;
//! the main thread waits for it until the deadline and a short grace, then
//! kills the solver itself and reports a timeout, so synchronous work can't
//! stretch the budget. The worker also stops at the deadline on its own: each
//! check runs under a timer, the deadline is checked between steps, cvc5
//! starts with `--tlimit-per`, and a result that arrives late counts as a
//! timeout. A solver `unknown`, an error or a timeout never counts as a proof.
//! Calls go through the `cedar-policy-symcc` API with one cvc5 process per
//! run, never the Cedar CLI (which exits 0 on a failed proof).
use anyhow::{Context as _, Result, anyhow, bail};
use cedar_policy::{
    ActionConstraint, Entities, EntityUid, Policy, PolicyId, PolicySet, RequestEnv, Schema,
};
use cedar_policy_symcc::solver::{Decision, DecisionWithModel, Solver, SolverError};
use cedar_policy_symcc::{CedarSymCompiler, CompiledPolicy, CompiledPolicySet, Env, SmtLibScript};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::process::{ExitCode, Stdio};
use std::str::FromStr;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// Every check this binary knows, with the sets it reads (master plan, "Proof obligations").
const CHECKS: [(&str, &[&str]); 7] = [
    ("never_errors", &["B", "F", "A", "H"]),
    ("baseline_auto", &["B", "F", "A", "always", "auto"]),
    ("baseline_approvable", &["B", "F", "H", "always"]),
    ("auto_within_cards", &["B", "F", "A", "R"]),
    ("review_only_narrows", &["B", "F", "A", "A0"]),
    ("hold_within_cards", &["B", "F", "H", "R_hold"]),
    ("money_needs_card", &["B", "F", "A"]),
];
const TEXT_SETS: [&str; 7] = ["B", "F", "A", "A0", "H", "R", "R_hold"];
const LIST_SETS: [&str; 2] = ["always", "auto"];

type Symcc = CedarSymCompiler<ProofSolver>;

/// The pid of the live solver, if any, shared with the main thread so it can
/// kill the solver at the deadline even while the worker is busy. The worker
/// kills its solver before clearing the slot and clears it before reaping, so
/// the pid here is never one the system could have reused.
type SolverSlot = Arc<Mutex<Option<u32>>>;

/// How long the main thread waits past the deadline for the worker to stop
/// its solver and report on its own.
const GRACE: Duration = Duration::from_millis(250);
/// Proving a large set recurses deeply; the worker gets room for it.
const WORKER_STACK: usize = 256 * 1024 * 1024;

/// cvc5 as a child this binary spawns itself, so its pid is known. It speaks
/// the same SMT-LIB protocol as the library's `LocalSolver`, and never reaps
/// the child except in `stop`.
struct ProofSolver {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl ProofSolver {
    fn spawn(budget: Duration, slot: &SolverSlot) -> Result<Self> {
        let cvc5 = std::env::var("CVC5").unwrap_or_else(|_| "cvc5".into());
        let mut child = Command::new(&cvc5)
            .args([
                "--lang",
                "smt",
                &format!("--tlimit-per={}", budget.as_millis().max(1)),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("starting {cvc5}"))?;
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = child.id();
        let stdin = child.stdin.take().context("the solver's input")?;
        let stdout = child.stdout.take().context("the solver's output")?;
        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
        })
    }

    async fn line(&mut self) -> Result<String, SolverError> {
        let mut line = String::new();
        if self.stdout.read_line(&mut line).await? == 0 {
            return Err(SolverError::Solver("the solver closed its output".into()));
        }
        Ok(line)
    }

    /// Kills the solver and reaps it, unless the main thread already killed it.
    async fn stop(&mut self, slot: &SolverSlot) {
        let ours = {
            let mut pid = slot.lock().unwrap_or_else(|e| e.into_inner());
            let ours = pid.is_some();
            if ours {
                let _ = self.child.start_kill();
                *pid = None;
            }
            ours
        };
        if ours {
            let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        }
    }
}

impl Solver for ProofSolver {
    fn smtlib_input(&mut self) -> &mut (dyn tokio::io::AsyncWrite + Unpin + Send) {
        &mut self.stdin
    }

    async fn enable_models(&mut self) -> Result<(), SolverError> {
        Ok(self.stdin.set_option("produce-models", "true").await?)
    }

    async fn check_sat(&mut self) -> Result<Decision, SolverError> {
        self.stdin.check_sat().await?;
        self.stdin.flush().await?;
        match self.line().await?.trim() {
            "sat" => Ok(Decision::Sat),
            "unsat" => Ok(Decision::Unsat),
            "unknown" => Ok(Decision::Unknown),
            other => Err(SolverError::Solver(other.to_string())),
        }
    }

    async fn check_sat_with_model(&mut self) -> Result<DecisionWithModel, SolverError> {
        match self.check_sat().await? {
            Decision::Sat => {
                self.stdin.get_model().await?;
                self.stdin.flush().await?;
                // A model is "(" on its own line, the definitions, then ")".
                let mut model = self.line().await?;
                if model.trim() != "(" {
                    return Err(SolverError::Solver(model.trim().to_string()));
                }
                loop {
                    let line = self.line().await?;
                    let end = line.trim() == ")";
                    model.push_str(&line);
                    if end {
                        break Ok(DecisionWithModel::Sat { model });
                    }
                }
            }
            Decision::Unsat => Ok(DecisionWithModel::Unsat),
            Decision::Unknown => Ok(DecisionWithModel::Unknown),
        }
    }
}

/// Debug builds only: block the worker after it starts its solver, standing in
/// for synchronous work that overruns the deadline, so a test can check that
/// the main thread still kills the solver. Release builds have no such hook.
fn stall_for_tests() {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("DESK_PROVE_TEST_STALL_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
    {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

/// The deadline passed during a check.
#[derive(Debug)]
struct OutOfTime;

impl std::fmt::Display for OutOfTime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("out of time")
    }
}

impl std::error::Error for OutOfTime {}

fn in_time(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        Err(OutOfTime.into())
    } else {
        Ok(())
    }
}

/// A Desk's proof inputs, parsed.
struct Inputs {
    schema: Schema,
    actions: Entities,
    sets: HashMap<String, Vec<Policy>>,
    invariants: HashMap<String, Vec<PolicySet>>,
    checks: Vec<String>,
    money_uncovered: Vec<String>,
}

struct CheckResult {
    name: String,
    ok: bool,
    counterexample: Option<Value>,
    /// Where a check without a counterexample failed, for stderr.
    detail: Option<String>,
}

/// Why a run stopped before every check finished.
enum Stop {
    Timeout,
    Tool(anyhow::Error),
}

/// Parses one Cedar text and names each policy `<set>.<@id>` (or `<set>.policyN`
/// when it has no `@id`), so policies from several sets can share a policy set.
fn named(set: &str, text: &str) -> Result<Vec<Policy>> {
    let parsed = PolicySet::from_str(text).map_err(|e| anyhow!("{set}: {e}"))?;
    if parsed.templates().next().is_some() {
        bail!("{set}: templates are not allowed");
    }
    Ok(parsed
        .policies()
        .map(|p| {
            let local = p
                .annotation("id")
                .map_or_else(|| p.id().to_string(), str::to_string);
            p.new_id(PolicyId::new(format!("{set}.{local}")))
        })
        .collect())
}

fn union(parts: &[&[Policy]]) -> Result<PolicySet> {
    let mut set = PolicySet::new();
    for policy in parts.iter().flat_map(|part| part.iter()) {
        set.add(policy.clone())
            .map_err(|e| anyhow!("{}: {e}", policy.id()))?;
    }
    Ok(set)
}

impl Inputs {
    fn parse(schema_json: &str, sets_json: &str, checks_json: &str) -> Result<Self> {
        let schema = Schema::from_json_str(schema_json).map_err(|e| anyhow!("schema: {e}"))?;
        let actions = schema
            .action_entities()
            .map_err(|e| anyhow!("schema actions: {e}"))?;
        let checks_file: Value = serde_json::from_str(checks_json).context("checks file")?;
        let strings = |field: &str| -> Result<Vec<String>> {
            checks_file
                .get(field)
                .and_then(Value::as_array)
                .with_context(|| format!("checks file needs a {field} list"))?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .with_context(|| format!("{field} holds names"))
                })
                .collect()
        };
        let checks = strings("checks")?;
        let money_uncovered = strings("money_uncovered")?;
        if checks.is_empty() {
            bail!("no checks requested: nothing would be proved");
        }
        let mut needed: Vec<&str> = vec![];
        for (i, name) in checks.iter().enumerate() {
            let (_, sets) = CHECKS
                .iter()
                .find(|(known, _)| known == name)
                .with_context(|| format!("unknown check {name:?}"))?;
            if checks[..i].contains(name) {
                bail!("check {name:?} is requested twice");
            }
            needed.extend(sets.iter());
        }
        let sets_file: Value = serde_json::from_str(sets_json).context("sets file")?;
        let sets_file = sets_file
            .as_object()
            .context("the sets file is an object")?;
        if let Some(unknown) = sets_file
            .keys()
            .find(|k| !TEXT_SETS.contains(&k.as_str()) && !LIST_SETS.contains(&k.as_str()))
        {
            bail!("unknown set {unknown:?}");
        }
        let mut sets = HashMap::new();
        for name in TEXT_SETS.iter().filter(|name| needed.contains(name)) {
            let text = sets_file
                .get(*name)
                .and_then(Value::as_str)
                .with_context(|| format!("set {name} is required"))?;
            sets.insert(name.to_string(), named(name, text)?);
        }
        let mut invariants = HashMap::new();
        for name in LIST_SETS.iter().filter(|name| needed.contains(name)) {
            let texts = sets_file
                .get(*name)
                .and_then(Value::as_array)
                .with_context(|| format!("set {name} is required"))?;
            if texts.is_empty() {
                bail!("{name} holds no invariants: nothing would be proved");
            }
            let parsed = texts
                .iter()
                .enumerate()
                .map(|(i, text)| {
                    let text = text
                        .as_str()
                        .with_context(|| format!("{name}[{i}] is Cedar text"))?;
                    union(&[&named(&format!("{name}{i}"), text)?])
                })
                .collect::<Result<Vec<_>>>()?;
            invariants.insert(name.to_string(), parsed);
        }
        for tool in &money_uncovered {
            if !schema
                .request_envs()
                .any(|env| env.action().id().unescaped() == tool)
            {
                bail!("money_uncovered names {tool:?}, which this schema doesn't declare");
            }
        }
        Ok(Self {
            schema,
            actions,
            sets,
            invariants,
            checks,
            money_uncovered,
        })
    }

    fn set(&self, name: &str) -> &[Policy] {
        &self.sets[name]
    }

    fn union_of(&self, names: &[&str]) -> Result<PolicySet> {
        union(&names.iter().map(|n| self.set(n)).collect::<Vec<_>>())
    }

    /// The request envs a policy's action scope can match; a policy can't
    /// apply, or error, anywhere else. (Derived from the scope itself rather
    /// than trusted from `@applies_to`, so a mislabelled policy is still checked.)
    fn envs_for(&self, policy: &Policy) -> Vec<RequestEnv> {
        let in_group = |action: &EntityUid, group: &EntityUid| {
            action == group
                || self
                    .actions
                    .ancestors(action)
                    .is_some_and(|mut groups| groups.any(|g| g == group))
        };
        self.schema
            .request_envs()
            .filter(|env| match policy.action_constraint() {
                ActionConstraint::Any => true,
                ActionConstraint::Eq(action) => env.action() == &action,
                ActionConstraint::In(groups) => groups.iter().any(|g| in_group(env.action(), g)),
            })
            .collect()
    }
}

fn symcc_err(e: impl std::fmt::Debug) -> anyhow::Error {
    anyhow!("symcc: {e:?}")
}

/// A counterexample as a request_json (the master plan's "Rust module surface"),
/// without the schema's action entities.
fn request_json(env: &Env) -> Value {
    let request = &env.request;
    let uid = |u: Option<&EntityUid>| {
        u.map(|u| json!({"type": u.type_name().to_string(), "id": u.id().unescaped()}))
    };
    let entities = env
        .entities
        .to_json_value()
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    json!({
        "principal": uid(request.principal()),
        "action": request.action().map(|a| a.id().unescaped().to_string()),
        "resource": uid(request.resource()),
        "context": request.context().and_then(|c| c.to_json_value().ok()),
        "entities": entities.into_iter().filter(|e| e["uid"]["type"] != "Action").collect::<Vec<_>>(),
    })
}

/// Does `lhs` imply `rhs` in every request env? The first counterexample if not.
async fn implies(
    deadline: Instant,
    symcc: &mut Symcc,
    inputs: &Inputs,
    lhs: &PolicySet,
    rhs: &PolicySet,
) -> Result<Option<Value>> {
    for env in inputs.schema.request_envs() {
        in_time(deadline)?;
        let left = CompiledPolicySet::compile(lhs, &env, &inputs.schema).map_err(symcc_err)?;
        let right = CompiledPolicySet::compile(rhs, &env, &inputs.schema).map_err(symcc_err)?;
        if let Some(cex) = symcc
            .check_implies_with_counterexample_opt(&left, &right)
            .await
            .map_err(symcc_err)?
        {
            return Ok(Some(request_json(&cex)));
        }
    }
    Ok(None)
}

/// Runs one check. `Ok(false)` results are proofs that failed; `Err` is a tool
/// problem (including a solver `unknown`), never a pass.
async fn run_check(
    deadline: Instant,
    symcc: &mut Symcc,
    inputs: &Inputs,
    name: &str,
) -> Result<CheckResult> {
    let result = |ok: bool, counterexample: Option<Value>| CheckResult {
        name: name.to_string(),
        ok,
        counterexample,
        detail: None,
    };
    let failed_at = |detail: String| CheckResult {
        name: name.to_string(),
        ok: false,
        counterexample: None,
        detail: Some(detail),
    };
    let implication = |lhs: &[&str], rhs: &[&str]| -> Result<(PolicySet, PolicySet)> {
        Ok((inputs.union_of(lhs)?, inputs.union_of(rhs)?))
    };
    match name {
        "never_errors" => {
            for policy in ["B", "F", "A", "H"].iter().flat_map(|set| inputs.set(set)) {
                for env in inputs.envs_for(policy) {
                    in_time(deadline)?;
                    let compiled =
                        CompiledPolicy::compile(policy, &env, &inputs.schema).map_err(symcc_err)?;
                    if !symcc
                        .check_never_errors_opt(&compiled)
                        .await
                        .map_err(symcc_err)?
                    {
                        return Ok(failed_at(format!(
                            "{} can error for {}",
                            policy.id(),
                            env.action()
                        )));
                    }
                }
            }
            Ok(result(true, None))
        }
        "baseline_auto" | "baseline_approvable" => {
            let (lhs, kinds): (&[&str], &[&str]) = match name {
                "baseline_auto" => (&["B", "F", "A"], &["always", "auto"]),
                _ => (&["B", "F", "H"], &["always"]),
            };
            let lhs = inputs.union_of(lhs)?;
            for invariant in kinds.iter().flat_map(|kind| &inputs.invariants[*kind]) {
                if let Some(cex) = implies(deadline, symcc, inputs, &lhs, invariant).await? {
                    return Ok(result(false, Some(cex)));
                }
            }
            Ok(result(true, None))
        }
        "auto_within_cards" | "review_only_narrows" | "hold_within_cards" => {
            let (lhs, rhs) = match name {
                "auto_within_cards" => implication(&["B", "F", "A"], &["R"])?,
                "review_only_narrows" => implication(&["B", "F", "A"], &["B", "F", "A0"])?,
                _ => implication(&["B", "F", "H"], &["R_hold"])?,
            };
            let cex = implies(deadline, symcc, inputs, &lhs, &rhs).await?;
            Ok(result(cex.is_none(), cex))
        }
        "money_needs_card" => {
            let auto = inputs.union_of(&["B", "F", "A"])?;
            for tool in &inputs.money_uncovered {
                for env in inputs
                    .schema
                    .request_envs()
                    .filter(|env| env.action().id().unescaped() == tool)
                {
                    in_time(deadline)?;
                    let compiled = CompiledPolicySet::compile(&auto, &env, &inputs.schema)
                        .map_err(symcc_err)?;
                    if !symcc
                        .check_always_denies_opt(&compiled)
                        .await
                        .map_err(symcc_err)?
                    {
                        return Ok(failed_at(format!(
                            "{tool} can be auto-allowed with no owner card"
                        )));
                    }
                }
            }
            Ok(result(true, None))
        }
        other => bail!("unknown check {other:?}"),
    }
}

fn spawn_solver(deadline: Instant, slot: &SolverSlot) -> Result<Symcc> {
    let solver = ProofSolver::spawn(deadline.saturating_duration_since(Instant::now()), slot)?;
    CedarSymCompiler::new(solver).map_err(symcc_err)
}

/// Runs the requested checks and returns the ones that finished before the
/// deadline; a check that finishes after it counts as unfinished.
async fn prove(
    inputs: &Inputs,
    deadline: Instant,
    slot: &SolverSlot,
) -> (Vec<CheckResult>, Option<Stop>) {
    let mut results = vec![];
    if in_time(deadline).is_err() {
        return (results, Some(Stop::Timeout));
    }
    let mut symcc = match spawn_solver(deadline, slot) {
        Ok(symcc) => symcc,
        Err(e) => return (results, Some(Stop::Tool(e))),
    };
    stall_for_tests();
    let mut stop = None;
    for name in &inputs.checks {
        let timer = tokio::time::Instant::from_std(deadline);
        let outcome =
            tokio::time::timeout_at(timer, run_check(deadline, &mut symcc, inputs, name)).await;
        stop = match outcome {
            Ok(Ok(result)) if in_time(deadline).is_ok() => {
                results.push(result);
                continue;
            }
            Ok(Err(e)) if !e.is::<OutOfTime>() => Some(Stop::Tool(e)),
            _ => Some(Stop::Timeout),
        };
        break;
    }
    // Kill the solver and reap it, so nothing outlives the report.
    symcc.solver_mut().stop(slot).await;
    (results, stop)
}

/// The report and exit code for a run. Checks that never finished count as
/// failed. A finished check that failed outranks a timeout (exit 1, not 2),
/// since its counterexample is the more useful answer.
fn report(requested: &[String], finished: &[CheckResult], stop: Option<&Stop>) -> (Value, u8) {
    let failed = finished.iter().any(|r| !r.ok);
    let code = if failed {
        1
    } else if stop.is_some() {
        2
    } else {
        0
    };
    for r in finished {
        if let Some(detail) = &r.detail {
            eprintln!("{}: {detail}", r.name);
        }
    }
    if let Some(stop) = stop {
        match stop {
            Stop::Timeout => eprintln!("desk-prove: out of time before every check finished"),
            Stop::Tool(e) => eprintln!("desk-prove: {e:#}"),
        }
    }
    let checks: Vec<Value> = requested
        .iter()
        .map(|name| match finished.iter().find(|r| &r.name == name) {
            Some(r) => json!({"name": name, "ok": r.ok, "counterexample_plain": null, "counterexample_raw": r.counterexample}),
            None => json!({"name": name, "ok": false, "counterexample_plain": null, "counterexample_raw": null}),
        })
        .collect();
    (
        json!({"ok": code == 0, "method": "symcc", "cases": null, "timed_out": code == 2, "checks": checks}),
        code,
    )
}

/// The selftest's inputs, compiled in: the image carries no fixture files.
const SELFTEST_SCHEMA: &str = include_str!("../../cedar/fixtures/schema.cedarschema.json");
const SELFTEST_BASELINE: &str = include_str!("../../cedar/fixtures/baseline.cedar");
const SELFTEST_AUTO: &str = include_str!("../../cedar/fixtures/auto.cedar");
const SELFTEST_AUTO_UNGATED: &str = include_str!("../../cedar/fixtures/auto_ungated.cedar");
const SELFTEST_BUGGY_OR_GATE: &str = include_str!("../../cedar/fixtures/buggy_or_gate.cedar");
const SELFTEST_ERRORING_FORBID: &str = include_str!("../../cedar/fixtures/erroring_forbid.cedar");
const SELFTEST_BUDGET: Duration = Duration::from_secs(20);

/// What a selftest case expects of its one check.
type Expectation = fn(&CheckResult) -> bool;

/// The startup check behind the kernel's proof mode: the solver must prove a
/// true implication, refute an OR-ed review gate with a counterexample that
/// sets the score, and catch a forbid that can error. Any other answer,
/// error or timeout fails it (exit 2), and the kernel uses bounded mode.
async fn selftest(deadline: Instant, slot: &SolverSlot) -> (Value, u8) {
    let erroring_baseline = format!("{SELFTEST_BASELINE}\n{SELFTEST_ERRORING_FORBID}");
    let cases: [(&str, &str, &str, &str, Expectation); 3] = [
        (
            "selftest.gated_implies_ungated",
            SELFTEST_BASELINE,
            SELFTEST_AUTO,
            "review_only_narrows",
            |r| r.ok,
        ),
        (
            "selftest.or_gate_counterexample",
            SELFTEST_BASELINE,
            SELFTEST_BUGGY_OR_GATE,
            "review_only_narrows",
            |r| {
                !r.ok
                    && r.counterexample
                        .as_ref()
                        .is_some_and(|cex| cex["context"]["review"].is_object())
            },
        ),
        (
            "selftest.erroring_forbid_detected",
            &erroring_baseline,
            SELFTEST_AUTO,
            "never_errors",
            |r| !r.ok,
        ),
    ];
    let mut checks = vec![];
    let mut stopped = false;
    for (name, baseline, auto, check, expected) in cases {
        let sets = json!({"B": baseline, "F": "", "A": auto, "A0": SELFTEST_AUTO_UNGATED,
                          "H": "", "R": "", "R_hold": "", "always": [], "auto": []});
        let checks_file = json!({"checks": [check], "money_uncovered": []});
        let met = match Inputs::parse(SELFTEST_SCHEMA, &sets.to_string(), &checks_file.to_string())
        {
            Err(e) => {
                eprintln!("{name}: {e:#}");
                false
            }
            Ok(inputs) => {
                let (finished, stop) = prove(&inputs, deadline, slot).await;
                stopped |= stop.is_some();
                stop.is_none() && finished.first().is_some_and(expected)
            }
        };
        checks.push(json!({"name": name, "ok": met, "counterexample_plain": null, "counterexample_raw": null}));
    }
    let ok = checks.iter().all(|c| c["ok"] == true);
    (
        json!({"ok": ok, "method": "symcc", "cases": null, "timed_out": stopped, "checks": checks}),
        if ok { 0 } else { 2 },
    )
}

struct Args {
    schema: Option<String>,
    sets: Option<String>,
    checks: Option<String>,
    timeout_ms: Option<u64>,
    selftest: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        schema: None,
        sets: None,
        checks: None,
        timeout_ms: None,
        selftest: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().with_context(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--schema" => args.schema = Some(value()?),
            "--sets" => args.sets = Some(value()?),
            "--checks" => args.checks = Some(value()?),
            "--timeout-ms" => {
                args.timeout_ms = Some(value()?.parse().context("--timeout-ms is a whole number")?)
            }
            "--selftest" => args.selftest = true,
            other => bail!("unknown argument {other:?}"),
        }
    }
    Ok(args)
}

fn tool_error(e: anyhow::Error) -> (Value, u8) {
    report(&[], &[], Some(&Stop::Tool(e)))
}

/// Everything after argument parsing, on the worker thread, within `deadline`.
async fn job(args: Args, deadline: Instant, slot: SolverSlot) -> (Value, u8) {
    if args.selftest {
        return selftest(deadline, &slot).await;
    }
    let (Some(schema), Some(sets), Some(checks)) = (args.schema, args.sets, args.checks) else {
        return tool_error(anyhow!(
            "usage: desk-prove --schema <file> --sets <file> --checks <file> --timeout-ms <n>"
        ));
    };
    let read =
        |path: &str| std::fs::read_to_string(path).with_context(|| format!("reading {path}"));
    let inputs = match (|| Inputs::parse(&read(&schema)?, &read(&sets)?, &read(&checks)?))() {
        Ok(inputs) => inputs,
        Err(e) => return tool_error(e),
    };
    let (finished, stop) = prove(&inputs, deadline, &slot).await;
    report(&inputs.checks, &finished, stop.as_ref())
}

/// The check names in a checks file, for a report the main thread writes
/// without the worker; empty when the file can't be read.
fn requested_checks(path: &str) -> Vec<String> {
    let names = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|file| file.get("checks").and_then(Value::as_array).cloned());
    names
        .into_iter()
        .flatten()
        .filter_map(|n| n.as_str().map(str::to_string))
        .collect()
}

/// Kills the live solver, if any. Holding the slot's lock keeps the worker
/// from reaping it in between, so the pid can't have been reused.
fn kill_solver(slot: &SolverSlot) {
    let pid = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(pid) = *pid {
        // SAFETY: kill(2) takes plain integers and touches no memory of ours;
        // the pid is our own unreaped child (see `SolverSlot`).
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

fn finish((report, code): (Value, u8)) -> ExitCode {
    println!("{report}");
    ExitCode::from(code)
}

fn main() -> ExitCode {
    // The budget covers the whole run, so it starts before any input is read.
    let started = Instant::now();
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => return finish(tool_error(e)),
    };
    let budget = match (args.selftest, args.timeout_ms) {
        (true, ms) => ms.map_or(SELFTEST_BUDGET, Duration::from_millis),
        (false, Some(ms)) => Duration::from_millis(ms),
        (false, None) => return finish(tool_error(anyhow!("--timeout-ms is required"))),
    };
    let deadline = started + budget;
    let requested = args
        .checks
        .as_deref()
        .map(requested_checks)
        .unwrap_or_default();
    let slot = SolverSlot::default();
    let (sender, receiver) = mpsc::channel();
    let worker_slot = slot.clone();
    let worker = std::thread::Builder::new()
        .name("desk-prove".into())
        .stack_size(WORKER_STACK)
        .spawn(move || {
            let outcome = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime.block_on(job(args, deadline, worker_slot)),
                Err(e) => tool_error(e.into()),
            };
            let _ = sender.send(outcome);
        });
    if let Err(e) = worker {
        return finish(tool_error(e.into()));
    }
    let wait = deadline.saturating_duration_since(Instant::now()) + GRACE;
    let outcome = match receiver.recv_timeout(wait) {
        Ok(outcome) => outcome,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill_solver(&slot);
            report(&requested, &[], Some(&Stop::Timeout))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            kill_solver(&slot);
            report(
                &requested,
                &[],
                Some(&Stop::Tool(anyhow!("the proof worker stopped"))),
            )
        }
    };
    // Returning ends the process, and with it a worker still busy past the deadline.
    finish(outcome)
}
