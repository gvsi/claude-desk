//! desk-prove, run as the kernel runs it: files in, a ProofReport on stdout,
//! and an exit code (0 every check holds, 1 a check failed, 2 tool error or
//! timeout). These tests need cvc5, found through `CVC5` or `PATH`.
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../cedar/fixtures");

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn invariants(kind: &str) -> Vec<String> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(format!("{FIXTURES}/invariants/{kind}"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    paths.sort();
    paths
        .iter()
        .map(|p| std::fs::read_to_string(p).unwrap())
        .collect()
}

/// The fixture sets, with the ungated auto set and the hold set standing in for
/// the reference generator's R and R_hold.
fn fixture_sets() -> Value {
    json!({
        "B": fixture("baseline.cedar"), "F": "", "A": fixture("auto.cedar"), "A0": fixture("auto_ungated.cedar"),
        "H": fixture("hold.cedar"), "R": fixture("auto_ungated.cedar"), "R_hold": fixture("hold.cedar"),
        "always": invariants("always"), "auto": invariants("auto"),
    })
}

struct Run {
    code: i32,
    report: Value,
    elapsed: Duration,
}

fn run(name: &str, args: &[&str], env: &[(&str, &str)]) -> Run {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_desk-prove"));
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let start = Instant::now();
    let out = cmd.output().expect("desk-prove runs");
    let elapsed = start.elapsed();
    let report = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "{name}: stdout is not a report ({e}): {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    });
    Run {
        code: out.status.code().unwrap_or(-1),
        report,
        elapsed,
    }
}

/// Writes the sets and checks files for one case and runs desk-prove on them.
fn prove(name: &str, sets: &Value, checks: &Value, timeout_ms: u64, env: &[(&str, &str)]) -> Run {
    let schema = fixture("schema.cedarschema.json");
    prove_with_schema(name, &schema, sets, checks, timeout_ms, env)
}

/// `prove` against a schema of the test's own.
fn prove_with_schema(
    name: &str,
    schema: &str,
    sets: &Value,
    checks: &Value,
    timeout_ms: u64,
    env: &[(&str, &str)],
) -> Run {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let (sets_path, checks_path) = (dir.join("sets.json"), dir.join("checks.json"));
    std::fs::write(&sets_path, sets.to_string()).unwrap();
    std::fs::write(&checks_path, checks.to_string()).unwrap();
    let schema_path = dir.join("schema.cedarschema.json");
    std::fs::write(&schema_path, schema).unwrap();
    let schema = schema_path.to_str().unwrap().to_string();
    let timeout = timeout_ms.to_string();
    run(
        name,
        &[
            "--schema",
            &schema,
            "--sets",
            sets_path.to_str().unwrap(),
            "--checks",
            checks_path.to_str().unwrap(),
            "--timeout-ms",
            &timeout,
        ],
        env,
    )
}

fn check<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no {name}: {report}"))
}

#[test]
fn gated_implies_ungated() {
    let run = prove(
        "gated_implies_ungated",
        &fixture_sets(),
        &json!({"checks": ["review_only_narrows"], "money_uncovered": []}),
        30_000,
        &[],
    );
    assert_eq!(run.code, 0, "{}", run.report);
    assert_eq!(run.report["ok"], true);
    assert_eq!(run.report["method"], "symcc");
    assert_eq!(run.report["timed_out"], false);
    let narrows = check(&run.report, "review_only_narrows");
    assert_eq!(narrows["ok"], true);
    assert_eq!(narrows["counterexample_raw"], Value::Null);
}

#[test]
fn or_gate_counterexample() {
    let mut sets = fixture_sets();
    sets["A"] = json!(fixture("buggy_or_gate.cedar"));
    let run = prove(
        "or_gate_counterexample",
        &sets,
        &json!({"checks": ["review_only_narrows"], "money_uncovered": []}),
        30_000,
        &[],
    );
    assert_eq!(run.code, 1, "{}", run.report);
    assert_eq!(run.report["ok"], false);
    assert_eq!(run.report["timed_out"], false);
    let narrows = check(&run.report, "review_only_narrows");
    assert_eq!(narrows["ok"], false);
    // The counterexample is a request_json: a discounted quote let through by a score.
    let cex = &narrows["counterexample_raw"];
    assert_eq!(cex["action"], "native.quote", "{cex}");
    assert!(
        cex["context"]["review"]["within_charter_bp"]
            .as_i64()
            .unwrap()
            >= 9000,
        "{cex}"
    );
    assert!(cex["context"]["discount_bp"].as_i64().unwrap() > 0, "{cex}");
    assert!(
        ["Visitor", "Agent"].contains(&cex["principal"]["type"].as_str().unwrap()),
        "{cex}"
    );
}

#[test]
fn erroring_forbid_fails_never_errors() {
    let checks = json!({"checks": ["never_errors"], "money_uncovered": []});
    let clean = prove("never_errors_clean", &fixture_sets(), &checks, 30_000, &[]);
    assert_eq!(clean.code, 0, "{}", clean.report);

    let mut sets = fixture_sets();
    sets["B"] = json!(format!(
        "{}\n{}",
        fixture("baseline.cedar"),
        fixture("erroring_forbid.cedar")
    ));
    let run = prove(
        "erroring_forbid_fails_never_errors",
        &sets,
        &checks,
        30_000,
        &[],
    );
    assert_eq!(run.code, 1, "{}", run.report);
    assert_eq!(run.report["ok"], false);
    assert_eq!(check(&run.report, "never_errors")["ok"], false);
}

fn alive(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid.trim()])
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn solver_timeout_fails_closed() {
    let pids = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("sleeping_solver.pids");
    let _ = std::fs::remove_file(&pids);
    let stub = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/sleeping_solver.sh");
    let names = ["review_only_narrows", "baseline_auto", "never_errors"];
    let run = prove(
        "solver_timeout_fails_closed",
        &fixture_sets(),
        &json!({"checks": names, "money_uncovered": []}),
        500,
        &[
            ("CVC5", stub),
            ("SLEEPING_SOLVER_PIDS", pids.to_str().unwrap()),
        ],
    );
    assert_eq!(run.code, 2, "{}", run.report);
    assert!(
        run.elapsed < Duration::from_secs(3),
        "took {:?}",
        run.elapsed
    );
    assert_eq!(run.report["ok"], false);
    assert_eq!(run.report["timed_out"], true);
    for name in names {
        assert_eq!(check(&run.report, name)["ok"], false, "{name}");
    }
    let started = std::fs::read_to_string(&pids).expect("the stub solver started");
    assert!(!started.trim().is_empty());
    for pid in started.lines() {
        assert!(!alive(pid), "stub solver {pid} is still running");
    }
}

#[test]
fn selftest_passes() {
    let run = run("selftest_passes", &["--selftest"], &[]);
    assert_eq!(run.code, 0, "{}", run.report);
    assert_eq!(run.report["ok"], true);
    assert_eq!(run.report["method"], "symcc");
    assert!(
        run.report["checks"].as_array().unwrap().len() >= 3,
        "{}",
        run.report
    );

    // With a solver that never answers, the selftest fails, so the kernel falls back to bounded mode.
    let stub = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/sleeping_solver.sh");
    let run = run_selftest_with(stub);
    assert_eq!(run.code, 2, "{}", run.report);
    assert_eq!(run.report["ok"], false);
}

fn run_selftest_with(cvc5: &str) -> Run {
    run(
        "selftest_with_stub",
        &["--selftest", "--timeout-ms", "500"],
        &[("CVC5", cvc5)],
    )
}

const ALL_CHECKS: [&str; 7] = [
    "never_errors",
    "baseline_auto",
    "baseline_approvable",
    "auto_within_cards",
    "review_only_narrows",
    "hold_within_cards",
    "money_needs_card",
];

#[test]
fn all_checks_hold_on_fixtures() {
    // No auto card covers charging through a mandate, so it must always be denied.
    let checks = json!({"checks": ALL_CHECKS, "money_uncovered": ["native.charge_mandate"]});
    let run = prove(
        "all_checks_hold_on_fixtures",
        &fixture_sets(),
        &checks,
        30_000,
        &[],
    );
    assert_eq!(run.code, 0, "{}", run.report);
    for name in ALL_CHECKS {
        assert_eq!(check(&run.report, name)["ok"], true, "{name}");
    }
}

#[test]
fn each_check_catches_its_bug() {
    let failing = |case: &str, check_name: &str, sets: Value, money_uncovered: Value| {
        let checks = json!({"checks": [check_name], "money_uncovered": money_uncovered});
        let run = prove(case, &sets, &checks, 30_000, &[]);
        assert_eq!(run.code, 1, "{case}: {}", run.report);
        check(&run.report, check_name).clone()
    };
    let with = |key: &str, value: Value| {
        let mut sets = fixture_sets();
        sets[key] = value;
        sets
    };

    // An auto card above the $500 hard cap.
    let big_deposit = fixture("auto.cedar").replace(
        "context.amount_cents <= 2000",
        "context.amount_cents <= 60000",
    );
    let cex = failing(
        "baseline_auto",
        "baseline_auto",
        with("A", json!(big_deposit)),
        json!([]),
    )["counterexample_raw"]
        .clone();
    assert_eq!(cex["action"], "native.payment_link", "{cex}");

    // A baseline without its private-data forbid lets the default ask approve anyone.
    let baseline = fixture("baseline.cedar");
    let without_private = &baseline[baseline
        .find("@id(\"recipient_owner_or_verified_contact\")")
        .unwrap()..];
    let cex = failing(
        "baseline_approvable",
        "baseline_approvable",
        with("B", json!(without_private)),
        json!([]),
    )["counterexample_raw"]
        .clone();
    assert_eq!(cex["action"], "native.release_document", "{cex}");

    // Cedar wider than the cards: the reference allows nothing.
    failing(
        "auto_within_cards",
        "auto_within_cards",
        with("R", json!("")),
        json!([]),
    );
    // An approvable action no card asks about: the reference has no ask for booking.
    let hold = fixture("hold.cedar");
    let block = &hold[hold.find(r#"@id("default_book")"#).unwrap()..];
    let without_book = hold.replace(&block[..block.find("\n\n").unwrap()], "");
    assert_ne!(hold, without_book);
    failing(
        "hold_within_cards",
        "hold_within_cards",
        with("R_hold", json!(without_book)),
        json!([]),
    );
    // Money with no owner card: the deposit card does cover payment links, so
    // claiming none does fails.
    failing(
        "money_needs_card",
        "money_needs_card",
        fixture_sets(),
        json!(["native.payment_link"]),
    );
}

#[test]
fn bad_input_is_a_tool_error() {
    let mut no_baseline = fixture_sets();
    no_baseline.as_object_mut().unwrap().remove("B");
    let cases = [
        (
            "empty_checks",
            fixture_sets(),
            json!({"checks": [], "money_uncovered": []}),
        ),
        (
            "unknown_check",
            fixture_sets(),
            json!({"checks": ["looks_fine"], "money_uncovered": []}),
        ),
        (
            "unknown_money_tool",
            fixture_sets(),
            json!({"checks": ["money_needs_card"], "money_uncovered": ["native.refund"]}),
        ),
        (
            "missing_set",
            no_baseline,
            json!({"checks": ["review_only_narrows"], "money_uncovered": []}),
        ),
        (
            "no_invariants",
            json!({"B": "", "F": "", "A": "", "always": [], "auto": []}),
            json!({"checks": ["baseline_auto"], "money_uncovered": []}),
        ),
    ];
    for (case, sets, checks) in cases {
        let run = prove(case, &sets, &checks, 30_000, &[]);
        assert_eq!(run.code, 2, "{case}: {}", run.report);
        assert_eq!(run.report["ok"], false, "{case}");
        assert_eq!(run.report["timed_out"], true, "{case}");
    }
    let run = run("no_arguments", &[], &[]);
    assert_eq!(run.code, 2);
    let run = prove(
        "missing_solver",
        &fixture_sets(),
        &json!({"checks": ["review_only_narrows"], "money_uncovered": []}),
        30_000,
        &[("CVC5", "/nonexistent/cvc5")],
    );
    assert_eq!(run.code, 2, "{}", run.report);
}

/// The MCP schema with the refund tool also given to agents: the baseline, not
/// the schema, has to keep agents from paying out.
fn agent_payout_schema() -> String {
    let mut schema: Value =
        serde_json::from_str(&fixture("schema_with_mcp.cedarschema.json")).unwrap();
    schema[""]["actions"]["payments.create_refund"]["appliesTo"]["principalTypes"] =
        json!(["Visitor", "Agent"]);
    schema.to_string()
}

#[test]
fn agent_payout_is_proved_impossible() {
    // A refund card for anyone, and an ask for refunds, over a schema where
    // agents could call the refund tool.
    let refund_card = r#"
        @id("refunds_small") @card("c-refund") @tier("auto") @applies_to("payments.create_refund")
        permit (principal, action == Action::"payments.create_refund", resource)
        when { context has amount_cents && context.amount_cents <= 5000 };"#;
    let refund_ask = r#"
        @id("default_create_refund") @card("default:payments.create_refund") @tier("hold")
        @applies_to("payments.create_refund")
        permit (principal, action == Action::"payments.create_refund", resource);"#;
    let mut sets = fixture_sets();
    sets["A"] = json!(format!("{}\n{refund_card}", fixture("auto.cedar")));
    sets["H"] = json!(format!("{}\n{refund_ask}", fixture("hold.cedar")));
    let checks = json!({"checks": ["baseline_auto", "baseline_approvable"], "money_uncovered": []});
    let schema = agent_payout_schema();

    let run = prove_with_schema(
        "agent_payout_baseline",
        &schema,
        &sets,
        &checks,
        30_000,
        &[],
    );
    assert_eq!(run.code, 0, "{}", run.report);

    // Without the baseline's forbid, both evaluations would let an agent pay out.
    let baseline = fixture("baseline.cedar");
    let without = &baseline[..baseline
        .find("@id(\"no_agent_pay_out\")")
        .expect("the forbid")];
    sets["B"] = json!(without);
    let run = prove_with_schema(
        "agent_payout_no_forbid",
        &schema,
        &sets,
        &checks,
        30_000,
        &[],
    );
    assert_eq!(run.code, 1, "{}", run.report);
    for name in ["baseline_auto", "baseline_approvable"] {
        let cex = &check(&run.report, name)["counterexample_raw"];
        assert_eq!(cex["principal"]["type"], "Agent", "{name}: {cex}");
        assert_eq!(cex["action"], "payments.create_refund", "{name}: {cex}");
    }
}
