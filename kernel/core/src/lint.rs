//! `lint_policies`: the shape rules a compiled draft must meet before it is
//! validated or proved (master plan, "Lint at compile").
//!
//! - Every policy carries non-empty `@id`, `@card`, `@tier` and `@applies_to`,
//!   and each set holds only its own kind: `F` `@tier("refuse")` forbids, `A`
//!   `@tier("auto")` permits, `H` `@tier("hold")` permits.
//! - `context.review` appears only in `A`, only in `when` clauses, and only as
//!   top-level `&&` conjuncts of exactly these forms, which are monotone (a
//!   higher charter score or a lower manipulation score can only allow more):
//!   `context has review`, `context.review.within_charter_bp >= N`,
//!   `context.review.manipulation_bp <= N`.
//! - `unless` clauses appear only in `A`, where they carry the overlap
//!   exclusions: the scopes of other cards. A scope reads the principal, the
//!   action and `context.record_owner_match`, never review or any limit.
//! - `context` is never used whole (`context == {...}` would read review too).
//!
//! The rules are checked on Cedar's JSON form of each policy.
use cedar_policy::{Effect, Policy, PolicySet};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::str::FromStr;

const ANNOTATIONS: [&str; 4] = ["id", "card", "tier", "applies_to"];

/// The sets a compiled draft holds, with the effect and tier each allows.
const SETS: [(&str, Effect, &str); 3] = [
    ("F", Effect::Forbid, "refuse"),
    ("A", Effect::Permit, "auto"),
    ("H", Effect::Permit, "hold"),
];

/// Lints `sets_json` (`{"F", "A", "H"}` Cedar texts). Empty means it passes.
pub fn lint_policies(sets_json: &str) -> Vec<String> {
    let sets: Value = match serde_json::from_str(sets_json) {
        Ok(v) => v,
        Err(e) => return vec![format!("sets_json: {e}")],
    };
    let Some(sets) = sets.as_object() else {
        return vec!["sets_json must be an object of F, A and H texts".into()];
    };
    let mut errors: Vec<String> = sets
        .keys()
        .filter(|k| !SETS.iter().any(|(name, ..)| name == k))
        .map(|k| format!("sets_json: unknown set {k:?}"))
        .collect();
    for (name, effect, tier) in SETS {
        match sets.get(name).and_then(Value::as_str) {
            Some(text) => lint_set(name, text, effect, tier, &mut errors),
            None => errors.push(format!("sets_json needs a {name} text")),
        }
    }
    errors
}

fn lint_set(set: &str, text: &str, effect: Effect, tier: &str, errors: &mut Vec<String>) {
    let parsed = match PolicySet::from_str(text) {
        Ok(p) => p,
        Err(e) => return errors.push(format!("{set}: {e}")),
    };
    if parsed.templates().next().is_some() {
        errors.push(format!("{set}: templates are not allowed"));
    }
    let mut seen = HashSet::new();
    for policy in parsed.policies() {
        let name = format!("{set}.{}", policy.annotation("id").unwrap_or("<no @id>"));
        let mut fail = |msg: &str| errors.push(format!("{name}: {msg}"));
        for key in ANNOTATIONS {
            if policy.annotation(key).is_none_or(|v| v.trim().is_empty()) {
                fail(&format!("needs a non-empty @{key}"));
            }
        }
        if !seen.insert(name.clone()) {
            fail("duplicate @id in its set");
        }
        if policy.effect() != effect || policy.annotation("tier") != Some(tier) {
            let kind = if effect == Effect::Permit {
                "permit"
            } else {
                "forbid"
            };
            fail(&format!("set {set} holds only @tier(\"{tier}\") {kind}s"));
        }
        let est = match policy.to_json() {
            Ok(est) => est,
            Err(e) => {
                fail(&format!("can't be read: {e}"));
                continue;
            }
        };
        let gated = set == "A" && policy.effect() == Effect::Permit;
        for condition in est["conditions"].as_array().into_iter().flatten() {
            let body = &condition["body"];
            if uses_whole_context(body) {
                fail("uses context as a whole; read single attributes instead");
            }
            match condition["kind"].as_str() {
                Some("when") if gated => {
                    if conjuncts(body)
                        .into_iter()
                        .any(|c| reads_review(c) && !is_review_gate(c))
                    {
                        fail(
                            "reads context.review outside the monotone gate (top-level && conjuncts: context has review, \
                              within_charter_bp >= N, manipulation_bp <= N)",
                        );
                    }
                }
                Some("when") => {
                    if reads_review(body) {
                        fail("reads context.review, which only auto permits may do");
                    }
                }
                Some("unless") if gated => {
                    if context_attrs(body)
                        .iter()
                        .any(|attr| attr != "record_owner_match")
                    {
                        fail(
                            "unless clauses carry only card scopes (principal, action, context.record_owner_match)",
                        );
                    }
                }
                _ => fail("unless clauses appear only in auto permits"),
            }
        }
    }
}

/// The top-level `&&` conjuncts of a condition.
fn conjuncts(e: &Value) -> Vec<&Value> {
    match e.get("&&") {
        Some(and) => [conjuncts(&and["left"]), conjuncts(&and["right"])].concat(),
        None => vec![e],
    }
}

fn is_context(e: &Value) -> bool {
    *e == json!({"Var": "context"})
}

/// The first attribute an access (`.`) or `has` node reads: `context has
/// review.within_charter_bp` arrives with an attribute list.
fn first_attr(node: &Value) -> Option<&str> {
    match &node["attr"] {
        Value::String(attr) => Some(attr),
        Value::Array(path) => path.first().and_then(Value::as_str),
        _ => None,
    }
}

/// Every attribute of `context` the expression reads or tests with `has`.
fn context_attrs(e: &Value) -> Vec<String> {
    let mut found = vec![];
    visit(e, &mut |node| {
        for op in [".", "has"] {
            if let Some(inner) = node.get(op).filter(|inner| is_context(&inner["left"])) {
                found.push(first_attr(inner).unwrap_or("").to_string());
            }
        }
    });
    found
}

fn reads_review(e: &Value) -> bool {
    context_attrs(e).iter().any(|attr| attr == "review")
}

/// Does `policy` read `context.review` in any condition, directly or by using
/// `context` whole? The baseline may do neither.
pub(crate) fn reads_review_anywhere(policy: &Policy) -> Result<bool, String> {
    let est = policy
        .to_json()
        .map_err(|e| format!("can't be read: {e}"))?;
    Ok(est["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|condition| {
            reads_review(&condition["body"]) || uses_whole_context(&condition["body"])
        }))
}

/// Is `context` used other than as the left side of an access or `has`?
fn uses_whole_context(e: &Value) -> bool {
    match e {
        Value::Object(map) => map.iter().any(|(key, child)| match (key.as_str(), child) {
            ("Var", Value::String(var)) => var == "context",
            ("." | "has", inner) if is_context(&inner["left"]) => false,
            _ => uses_whole_context(child),
        }),
        Value::Array(items) => items.iter().any(uses_whole_context),
        _ => false,
    }
}

fn visit(e: &Value, f: &mut impl FnMut(&Value)) {
    f(e);
    match e {
        Value::Object(map) => map.values().for_each(|child| visit(child, f)),
        Value::Array(items) => items.iter().for_each(|child| visit(child, f)),
        _ => {}
    }
}

/// Exactly `context has review`, `context.review.within_charter_bp >= N` or
/// `context.review.manipulation_bp <= N`, with `N` an integer literal.
fn is_review_gate(e: &Value) -> bool {
    let review_score = |attr: &str| json!({".": {"left": {".": {"left": {"Var": "context"}, "attr": "review"}}, "attr": attr}});
    let compares = |op: &str, attr: &str| {
        e.get(op).is_some_and(|cmp| {
            cmp.as_object().is_some_and(|m| m.len() == 2)
                && cmp["left"] == review_score(attr)
                && cmp["right"].get("Value").is_some_and(Value::is_i64)
        })
    };
    *e == json!({"has": {"left": {"Var": "context"}, "attr": "review"}})
        || compares(">=", "within_charter_bp")
        || compares("<=", "manipulation_bp")
}
