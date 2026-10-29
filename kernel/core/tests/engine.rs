//! Kernel decisions, lint, canonical JSON and ledger signing, against the fixtures
//! in kernel/cedar/fixtures (the master plan's sets B, F, A and H).
use desk_kernel_core::{
    PolicyEngine, Signer, canonical_json, canonical_json_any, ledger_hash, lint_policies,
    verify_chain,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const SCHEMA: &str = include_str!("../../cedar/fixtures/schema.cedarschema.json");
const SCHEMA_WITH_MCP: &str = include_str!("../../cedar/fixtures/schema_with_mcp.cedarschema.json");
const BASELINE: &str = include_str!("../../cedar/fixtures/baseline.cedar");
const AUTO: &str = include_str!("../../cedar/fixtures/auto.cedar");
const HOLD: &str = include_str!("../../cedar/fixtures/hold.cedar");
const ERRORING_FORBID: &str = include_str!("../../cedar/fixtures/erroring_forbid.cedar");
const BUGGY_OR_GATE: &str = include_str!("../../cedar/fixtures/buggy_or_gate.cedar");

const KEY: &str = "desk-1:1";

fn sets(f: &str, a: &str, h: &str) -> String {
    json!({"F": f, "A": a, "H": h}).to_string()
}

fn engine_with(baseline: &str, a: &str) -> PolicyEngine {
    let engine = PolicyEngine::new(baseline).expect("baseline loads");
    let errors = engine.load(KEY, SCHEMA, &sets("", a, HOLD));
    assert!(errors.is_empty(), "load errors: {errors:?}");
    engine
}

fn engine() -> PolicyEngine {
    engine_with(BASELINE, AUTO)
}

fn visitor(verified: bool) -> Value {
    json!({"uid": {"type": "Visitor", "id": "session-v"},
           "attrs": {"verified": verified, "assurance": if verified { "demo_code" } else { "none" },
                     "copy": "copy-1"},
           "parents": []})
}

fn resource(kind: &str, id: &str) -> Value {
    json!({"uid": {"type": kind, "id": id}, "attrs": {"copy": "copy-1"}, "parents": []})
}

/// A request_json in the master plan's shape, with the context every action requires.
fn request(principal: Value, action: &str, resource: Value, context: Value) -> Value {
    let mut ctx = json!({"record_owner_match": false, "local_dow": 2, "local_minute": 600});
    for (k, v) in context.as_object().expect("context is an object") {
        ctx[k] = v.clone();
    }
    json!({"principal": principal["uid"], "action": action, "resource": resource["uid"],
           "context": ctx, "entities": [principal, resource]})
}

fn decide(engine: &PolicyEngine, key: &str, request: &Value, phase: &str) -> Value {
    serde_json::from_str(&engine.decide(key, &request.to_string(), phase))
        .expect("decide returns JSON")
}

fn ids(v: &Value) -> Vec<&str> {
    v.as_array()
        .expect("an id list")
        .iter()
        .map(|id| id.as_str().expect("a string id"))
        .collect()
}

#[test]
fn known_decision_skips_review() {
    let engine = engine();

    let slots = request(
        visitor(false),
        "native.find_slots",
        resource("Desk", "desk-1"),
        json!({}),
    );
    let verdict = decide(&engine, KEY, &slots, "pre");
    assert_eq!(verdict["outcome"], "allow", "{verdict}");
    assert_eq!(ids(&verdict["policy_ids"]), ["A.find_slots"]);
    assert!(ids(&verdict["pending_policy_ids"]).is_empty(), "{verdict}");

    // A baseline forbid settles it without the reviewer as well.
    let doc = request(
        visitor(false),
        "native.release_document",
        resource("Document", "doc-1"),
        json!({"recipient": "verified_contact"}),
    );
    let verdict = decide(&engine, KEY, &doc, "pre");
    assert_eq!(verdict["outcome"], "refuse", "{verdict}");
    assert!(
        ids(&verdict["policy_ids"]).contains(&"B.private_data_record_owner"),
        "{verdict}"
    );
    assert!(ids(&verdict["pending_policy_ids"]).is_empty(), "{verdict}");
}

fn with_review(mut request: Value, within_charter_bp: Value, manipulation_bp: Value) -> Value {
    request["context"]["review"] =
        json!({"within_charter_bp": within_charter_bp, "manipulation_bp": manipulation_bp});
    request
}

#[test]
fn review_dependence_needs_review() {
    let engine = engine();
    let quote = request(
        visitor(false),
        "native.quote",
        resource("Desk", "desk-1"),
        json!({}),
    );

    let pre = decide(&engine, KEY, &quote, "pre");
    assert_eq!(pre["outcome"], "needs_review", "{pre}");
    assert_eq!(ids(&pre["pending_policy_ids"]), ["A.quote_reviewed"]);

    let approved = decide(
        &engine,
        KEY,
        &with_review(quote.clone(), json!(9500), json!(500)),
        "final",
    );
    assert_eq!(approved["outcome"], "allow", "{approved}");
    assert_eq!(ids(&approved["policy_ids"]), ["A.quote_reviewed"]);

    let absent = decide(&engine, KEY, &quote, "final");
    assert_eq!(absent["outcome"], "hold", "{absent}");
    assert_eq!(ids(&absent["policy_ids"]), ["H.quote_twin"]);
}

#[test]
fn out_of_range_score_is_absent() {
    let engine = engine();
    let quote = request(
        visitor(false),
        "native.quote",
        resource("Desk", "desk-1"),
        json!({}),
    );

    let verdict = decide(
        &engine,
        KEY,
        &with_review(quote.clone(), json!(10_001), json!(500)),
        "final",
    );
    assert_eq!(verdict["outcome"], "hold", "{verdict}");

    // Any malformed score is a reviewer failure too, so it holds rather than errors.
    for (within, manipulation) in [
        (json!(9500), json!(-1)),
        (json!(9500.0), json!(500)),
        (json!(true), json!(500)),
        (json!("9500"), json!(500)),
        (json!(9500), json!(null)),
    ] {
        let verdict = decide(
            &engine,
            KEY,
            &with_review(quote.clone(), within.clone(), manipulation.clone()),
            "final",
        );
        assert_eq!(
            verdict["outcome"], "hold",
            "{within} {manipulation}: {verdict}"
        );
    }
}

#[test]
fn erroring_baseline_refuses() {
    let engine = engine_with(&format!("{BASELINE}\n{ERRORING_FORBID}"), AUTO);
    let link = |amount_cents: i64| {
        request(
            visitor(false),
            "native.payment_link",
            resource("Quote", "quote-1"),
            json!({"amount_cents": amount_cents}),
        )
    };

    // Within the deposit card and below the overflow, the forbid evaluates to false.
    assert_eq!(
        decide(&engine, KEY, &link(500), "final")["outcome"],
        "allow"
    );

    // At 2000 cents it overflows; Cedar alone would skip it and allow.
    for phase in ["pre", "final"] {
        let verdict = decide(&engine, KEY, &link(2000), phase);
        assert_eq!(verdict["outcome"], "refuse", "{phase}: {verdict}");
        assert!(
            verdict["errors"]
                .to_string()
                .contains("B.overflowing_amount_check"),
            "{phase}: {verdict}"
        );
    }
}

fn agent(mandate_remaining_cents: Option<i64>) -> Value {
    let mut attrs = json!({"verified": false, "assurance": "agent_key", "copy": "copy-1", "agent_key_id": "key-1"});
    if let Some(cents) = mandate_remaining_cents {
        attrs["mandate_remaining_cents"] = json!(cents);
    }
    json!({"uid": {"type": "Agent", "id": "session-a"}, "attrs": attrs, "parents": []})
}

/// A permit compiled from a lead card whose scope also reaches a money tool:
/// Cedar allows the charge, but no owner card covers charging.
const WIDE_LEAD_PERMIT: &str = r#"
@id("capture_lead_and_more")
@card("c-lead")
@tier("auto")
@applies_to("native.capture_lead")
permit (principal, action in [Action::"native.capture_lead", Action::"native.charge_mandate"], resource);
"#;

#[test]
fn money_allow_needs_owner_card() {
    let engine = engine_with(BASELINE, &format!("{AUTO}\n{WIDE_LEAD_PERMIT}"));
    let charge = request(
        agent(Some(5_000)),
        "native.charge_mandate",
        resource("Quote", "quote-1"),
        json!({"amount_cents": 1_000}),
    );
    for phase in ["pre", "final"] {
        let verdict = decide(&engine, KEY, &charge, phase);
        assert_eq!(verdict["outcome"], "hold", "{phase}: {verdict}");
        assert_eq!(
            ids(&verdict["policy_ids"]),
            ["A.capture_lead_and_more"],
            "{phase}"
        );
    }

    // The same permit still allows the tool its card covers.
    let lead = request(
        agent(None),
        "native.capture_lead",
        resource("Desk", "desk-1"),
        json!({}),
    );
    assert_eq!(decide(&engine, KEY, &lead, "final")["outcome"], "allow");

    // A card naming the money tool, or the charge effect, does allow it.
    for applies_to in ["native.charge_mandate", "effect:charge"] {
        let card = format!(
            r#"
            @id("mandate_charge") @card("c-mandate") @tier("auto") @applies_to("{applies_to}")
            permit (principal is Agent, action == Action::"native.charge_mandate", resource)
            when {{ context has amount_cents && context.amount_cents <= 2000 }};"#
        );
        let engine = engine_with(BASELINE, &format!("{AUTO}\n{card}"));
        let verdict = decide(&engine, KEY, &charge, "final");
        assert_eq!(verdict["outcome"], "allow", "{applies_to}: {verdict}");
        assert_eq!(ids(&verdict["policy_ids"]), ["A.mandate_charge"]);
    }
}

/// A card for the mock payments server's listing tool, which only the MCP schema declares.
const CHARGES_CARD: &str = r#"
@id("list_charges_record_owner")
@card("c-charges")
@tier("auto")
@applies_to("payments.list_charges")
permit (principal, action == Action::"payments.list_charges", resource)
when { principal.verified && context.record_owner_match };
"#;

#[test]
fn runtime_reload_with_schema() {
    let engine = engine();
    let v2 = "desk-1:2";
    let v2_sets = sets("", &format!("{AUTO}\n{CHARGES_CARD}"), HOLD);
    let errors = engine.load(v2, SCHEMA_WITH_MCP, &v2_sets);
    assert!(errors.is_empty(), "{errors:?}");

    let mut dana = visitor(true);
    dana["attrs"]["person_id"] = json!("person-dana");
    let mut charges_of_dana = resource("Charge", "person:person-dana");
    charges_of_dana["attrs"]["owner_person_id"] = json!("person-dana");
    let list = request(
        dana,
        "payments.list_charges",
        charges_of_dana,
        json!({"record_owner_match": true}),
    );
    let verdict = decide(&engine, v2, &list, "final");
    assert_eq!(verdict["outcome"], "allow", "{verdict}");
    assert_eq!(ids(&verdict["policy_ids"]), ["A.list_charges_record_owner"]);

    // The first version still decides as before and doesn't know the MCP tool.
    let verdict = decide(&engine, KEY, &list, "final");
    assert_eq!(verdict["outcome"], "refuse", "{verdict}");
    assert!(
        !verdict["errors"].as_array().expect("errors").is_empty(),
        "{verdict}"
    );
    let slots = request(
        visitor(false),
        "native.find_slots",
        resource("Desk", "desk-1"),
        json!({}),
    );
    assert_eq!(decide(&engine, KEY, &slots, "pre")["outcome"], "allow");

    // A failed load leaves nothing under its key, so deciding against it refuses.
    assert!(!engine.load(v2, SCHEMA, &v2_sets).is_empty());
    assert_eq!(decide(&engine, v2, &list, "final")["outcome"], "refuse");
    assert_eq!(
        decide(&engine, "desk-1:9", &slots, "final")["outcome"],
        "refuse"
    );
}

#[test]
fn lint_rejects_review_outside_auto() {
    assert!(
        lint_policies(&sets("", AUTO, HOLD)).is_empty(),
        "{:?}",
        lint_policies(&sets("", AUTO, HOLD))
    );

    let reviewed_hold = format!(
        r#"{HOLD}
        @id("quote_hold_reviewed") @card("c-quote") @tier("hold") @applies_to("native.quote")
        permit (principal, action == Action::"native.quote", resource)
        when {{ context has review && context.review.within_charter_bp >= 9000 }};"#
    );
    let errors = lint_policies(&sets("", AUTO, &reviewed_hold));
    assert!(
        errors.iter().any(|e| e.contains("H.quote_hold_reviewed")),
        "{errors:?}"
    );

    let reviewed_never = r#"
        @id("never_quote") @card("c-never") @tier("refuse") @applies_to("native.quote")
        forbid (principal, action == Action::"native.quote", resource)
        when { context has review && context.review.manipulation_bp >= 5000 };"#;
    let errors = lint_policies(&sets(reviewed_never, AUTO, HOLD));
    assert!(
        errors.iter().any(|e| e.contains("F.never_quote")),
        "{errors:?}"
    );

    // load runs the same lint and refuses the version.
    let engine = PolicyEngine::new(BASELINE).expect("baseline loads");
    assert!(
        !engine
            .load(KEY, SCHEMA, &sets("", AUTO, &reviewed_hold))
            .is_empty()
    );
}

#[test]
fn lint_rejects_or_gate() {
    let errors = lint_policies(&sets("", BUGGY_OR_GATE, HOLD));
    assert!(
        errors.iter().any(|e| e.contains("A.quote_reviewed")),
        "{errors:?}"
    );

    // Other shapes that would let a score widen access: a gate in the wrong
    // direction, and a negated one.
    for gate in [
        "context has review && context.review.within_charter_bp <= 9000",
        "!(context has review && context.review.manipulation_bp <= 1000)",
    ] {
        let auto = format!(
            r#"
            @id("quote_gated") @card("c-quote") @tier("auto") @applies_to("native.quote")
            permit (principal, action == Action::"native.quote", resource) when {{ {gate} }};"#
        );
        let errors = lint_policies(&sets("", &auto, HOLD));
        assert!(
            errors.iter().any(|e| e.contains("A.quote_gated")),
            "{gate}: {errors:?}"
        );
    }

    let engine = PolicyEngine::new(BASELINE).expect("baseline loads");
    assert!(
        !engine
            .load(KEY, SCHEMA, &sets("", BUGGY_OR_GATE, HOLD))
            .is_empty()
    );
}

#[test]
fn lint_rejects_misplaced_policies() {
    let book = |annotations: &str, effect: &str, rest: &str| {
        format!(
            r#"{annotations} {effect} (principal, action == Action::"native.book", resource) {rest};"#
        )
    };
    let cases = [
        // A permit in F would sit in both evaluations with no review gate.
        (
            sets(
                &book(
                    r#"@id("sneaky") @card("c-x") @tier("refuse") @applies_to("native.book")"#,
                    "permit",
                    "",
                ),
                AUTO,
                HOLD,
            ),
            "F.sneaky",
        ),
        // A never card with an exclusion would stop refusing whoever it excludes.
        (
            sets(
                &book(
                    r#"@id("never_book") @card("c-n") @tier("refuse") @applies_to("native.book")"#,
                    "forbid",
                    "unless { principal.verified }",
                ),
                AUTO,
                HOLD,
            ),
            "F.never_book",
        ),
        // An exclusion that reads a limit is not a card's scope.
        (
            sets(
                "",
                &format!(
                    "{AUTO}{}",
                    book(
                        r#"@id("book_auto") @card("c-b") @tier("auto") @applies_to("native.book")"#,
                        "permit",
                        "unless { context has amount_cents && context.amount_cents > 100 }"
                    )
                ),
                HOLD,
            ),
            "A.book_auto",
        ),
        // Every policy names its card.
        (
            sets(
                "",
                AUTO,
                &format!(
                    "{HOLD}{}",
                    book(
                        r#"@id("book_ask") @tier("hold") @applies_to("native.book")"#,
                        "permit",
                        ""
                    )
                ),
            ),
            "H.book_ask",
        ),
        // Comparing the whole context would read the review too.
        (
            sets(
                "",
                &format!(
                    "{AUTO}{}",
                    book(
                        r#"@id("odd") @card("c-o") @tier("auto") @applies_to("native.book")"#,
                        "permit",
                        r#"when { context == {"owner_approved": false} }"#
                    )
                ),
                HOLD,
            ),
            "A.odd",
        ),
    ];
    for (sets_json, policy) in cases {
        let errors = lint_policies(&sets_json);
        assert!(
            errors.iter().any(|e| e.contains(policy)),
            "{policy}: {errors:?}"
        );
    }

    // An exclusion that is a card's scope passes.
    let scoped = book(
        r#"@id("book_auto") @card("c-b") @tier("auto") @applies_to("native.book")"#,
        "permit",
        r#"unless { principal has person_id && principal.person_id == "person-dana" && context.record_owner_match }"#,
    );
    let errors = lint_policies(&sets("", &format!("{AUTO}{scoped}"), HOLD));
    assert!(errors.is_empty(), "{errors:?}");
    assert!(
        !lint_policies(&json!({"F": "", "A": AUTO, "H": HOLD, "B": ""}).to_string()).is_empty()
    );
}

#[test]
fn canonical_json_sorts_and_rejects_floats() {
    assert_eq!(
        canonical_json(r#"{ "b": 1, "a": {"d": null, "c": "x"}, "e": [3, -2, true] }"#).unwrap(),
        r#"{"a":{"c":"x","d":null},"b":1,"e":[3,-2,true]}"#
    );
    // RFC 8785 section 3.2.3: keys sort by UTF-16 code units, so U+1F600 (a
    // surrogate pair) sorts before U+FB33; strings escape only what JSON needs.
    assert_eq!(
        canonical_json(r#"{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh",
                           "1":"One","\ud83d\ude00":"Emoji: Grinning Face","\u0080":"Control",
                           "\u00f6":"Latin Small Letter O With Diaeresis","/":"\u000f\"\\"}"#).unwrap(),
        "{\"\\r\":\"Carriage Return\",\"/\":\"\\u000f\\\"\\\\\",\"1\":\"One\",\"\u{80}\":\"Control\",\
         \"\u{f6}\":\"Latin Small Letter O With Diaeresis\",\"\u{20ac}\":\"Euro Sign\",\
         \"\u{1f600}\":\"Emoji: Grinning Face\",\"\u{fb33}\":\"Hebrew Letter Dalet With Dagesh\"}"
    );
    // Money is integer cents and scores are basis points: any float is refused.
    for float in [
        "1.5",
        "1.0",
        "1e2",
        "-0.0",
        r#"{"amount_cents": 10.5}"#,
        "[0.1]",
    ] {
        assert!(canonical_json(float).is_err(), "{float}");
    }
}

#[test]
fn canonical_json_rejects_ambiguous_input() {
    // Parsers disagree on which duplicate wins, so a hash over one would bind nothing.
    for dup in [
        r#"{"amount_cents": 100, "amount_cents": 100000}"#,
        r#"[{"a": {"b": 1, "b": 1}}]"#,
    ] {
        assert!(canonical_json(dup).is_err(), "{dup}");
    }
    // RFC 8785 numbers are IEEE doubles; past 2^53 other implementations print another value.
    assert_eq!(
        canonical_json("[9007199254740991, -9007199254740991]").unwrap(),
        "[9007199254740991,-9007199254740991]"
    );
    for unsafe_int in [
        "9007199254740992",
        "-9007199254740992",
        "18446744073709551615",
    ] {
        assert!(canonical_json(unsafe_int).is_err(), "{unsafe_int}");
    }
}

#[test]
fn canonical_json_any_accepts_floats() {
    assert_eq!(
        canonical_json_any(r#"{"b": 1.0, "a": 1e21, "c": [0.000001, 1e-7, -0.0, 123.4560, 10], "d": {"z": 2, "y": null}}"#).unwrap(),
        r#"{"a":1e+21,"b":1,"c":[0.000001,1e-7,0,123.456,10],"d":{"y":null,"z":2}}"#
    );
    // RFC 8785 appendix B: each input is the double the RFC lists, and the
    // output is ECMAScript's Number.prototype.toString (confirmed with Node).
    for (input, expected) in [
        ("5e-324", "5e-324"),
        ("-5e-324", "-5e-324"),
        ("1.7976931348623157e308", "1.7976931348623157e+308"),
        ("-1.7976931348623157e308", "-1.7976931348623157e+308"),
        ("9007199254740992", "9007199254740992"),
        ("-9007199254740992", "-9007199254740992"),
        ("295147905179352825856", "295147905179352830000"),
        ("9.999999999999997e22", "9.999999999999997e+22"),
        ("1e23", "1e+23"),
        ("1.0000000000000001e23", "1.0000000000000001e+23"),
        ("999999999999999700000", "999999999999999700000"),
        ("999999999999999900000", "999999999999999900000"),
        ("9.999999999999997e-7", "9.999999999999997e-7"),
        ("0.000001", "0.000001"),
        ("333333333.3333332", "333333333.3333332"),
        ("333333333.33333325", "333333333.33333325"),
        ("333333333.33333343", "333333333.33333343"),
        ("-0.0000033333333333333333", "-0.0000033333333333333333"),
        ("1424953923781206.2", "1424953923781206.2"),
    ] {
        assert_eq!(canonical_json_any(input).unwrap(), expected, "{input}");
    }
    assert!(canonical_json_any(r#"{"a": 1.5, "a": 2}"#).is_err());
    assert!(canonical_json_any("1e400").is_err());
}

fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// RFC 8032, section 7.1, test 1: the seed and the public key it derives.
const RFC8032_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUBLIC: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

#[test]
fn signer_fails_closed_in_production() {
    assert!(Signer::from_env_with(&vars(&[("DESK_ENV", "production")])).is_err());
    assert!(
        Signer::from_env_with(&vars(&[
            ("DESK_ENV", "production"),
            ("DESK_SIGNING_SEED", "")
        ]))
        .is_err()
    );

    let signer = Signer::from_env_with(&vars(&[
        ("DESK_ENV", "production"),
        ("DESK_SIGNING_SEED", RFC8032_SEED),
    ]))
    .unwrap();
    assert!(!signer.dev_key());
    assert_eq!(signer.public_key_hex(), RFC8032_PUBLIC);
    let public = hex::decode(RFC8032_PUBLIC).unwrap();
    assert_eq!(signer.key_id(), hex::encode(Sha256::digest(&public))[..16]);

    // Outside production a missing seed gives a dev key, labelled as one.
    let dev = Signer::from_env_with(&vars(&[])).unwrap();
    assert!(dev.dev_key());
    assert_ne!(dev.public_key_hex(), signer.public_key_hex());

    // A malformed seed is an error everywhere, never a quiet fallback to the dev key.
    for bad in ["zz".repeat(32), "11".repeat(31), "11".repeat(33)] {
        assert!(
            Signer::from_env_with(&vars(&[("DESK_SIGNING_SEED", &bad)])).is_err(),
            "{bad}"
        );
    }
}

fn signer() -> Signer {
    Signer::from_env_with(&vars(&[("DESK_SIGNING_SEED", RFC8032_SEED)])).unwrap()
}

fn verifies(public_key_hex: &str, message: &[u8], signature_hex: &str) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let key: [u8; 32] = hex::decode(public_key_hex).unwrap().try_into().unwrap();
    let signature: [u8; 64] = hex::decode(signature_hex).unwrap().try_into().unwrap();
    VerifyingKey::from_bytes(&key)
        .unwrap()
        .verify(message, &Signature::from_bytes(&signature))
        .is_ok()
}

#[test]
fn signature_is_bound_to_its_domain() {
    let signer = signer();
    let digest: [u8; 32] = Sha256::digest(b"an envelope").into();
    let signature = signer.sign(b"desk-ledger-v1\0", &digest).unwrap();
    assert_eq!(signature.len(), 128);

    assert!(verifies(
        &signer.public_key_hex(),
        &[b"desk-ledger-v1\0".as_slice(), &digest].concat(),
        &signature
    ));
    assert!(!verifies(
        &signer.public_key_hex(),
        &[b"desk-verdict-v1\0".as_slice(), &digest].concat(),
        &signature
    ));

    // Framing is fixed: a domain ends in one NUL and the digest is 32 bytes.
    assert!(signer.sign(b"desk-ledger-v1", &digest).is_err());
    assert!(signer.sign(b"desk-ledger\0v1\0", &digest).is_err());
    assert!(signer.sign(b"desk-ledger-v1\0", &digest[..31]).is_err());
}

const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// A signed LedgerEntry, built the way the kernel builds one.
fn ledger_entry(signer: &Signer, seq: i64, prev_hash: &str, summary: Value) -> Value {
    let mut entry = json!({
        "copy_id": "copy-1", "desk_id": "desk-1", "seq": seq, "prev_hash": prev_hash,
        "created_at": "2026-10-30T17:04:05.123456Z",
        "event": {"kind": "decide", "origin": "kernel", "session_id": null, "ref_id": "decision-1", "summary": summary},
    });
    let hash = ledger_hash(&canonical_json(&entry.to_string()).unwrap()).unwrap();
    entry["signature"] = json!(
        signer
            .sign(b"desk-ledger-v1\0", &hex::decode(&hash).unwrap())
            .unwrap()
    );
    entry["hash"] = json!(hash);
    entry["key_id"] = json!(signer.key_id());
    entry
}

fn chain(signer: &Signer, summaries: &[Value]) -> Vec<Value> {
    let mut entries: Vec<Value> = vec![];
    for (i, summary) in summaries.iter().enumerate() {
        let prev = entries.last().map_or(GENESIS.to_string(), |e| {
            e["hash"].as_str().unwrap().to_string()
        });
        entries.push(ledger_entry(signer, i as i64 + 1, &prev, summary.clone()));
    }
    entries
}

fn verified(entries: &[Value], public_key_hex: &str) -> Value {
    serde_json::from_str(&verify_chain(&json!(entries).to_string(), public_key_hex).unwrap())
        .unwrap()
}

#[test]
fn verify_chain_finds_first_bad_seq() {
    let signer = signer();
    let pk = signer.public_key_hex();
    let entries = chain(
        &signer,
        &[
            json!({"outcome": "allow"}),
            json!({"outcome": "hold"}),
            json!({"outcome": "refuse"}),
        ],
    );
    assert_eq!(
        verified(&entries, &pk),
        json!({"ok": true, "first_bad_seq": null})
    );

    let mut edited = entries.clone();
    edited[1]["event"]["summary"]["outcome"] = json!("allow");
    assert_eq!(
        verified(&edited, &pk),
        json!({"ok": false, "first_bad_seq": 2})
    );

    // Dropping an entry breaks the link to the next one.
    assert_eq!(
        verified(&[entries[0].clone(), entries[2].clone()], &pk),
        json!({"ok": false, "first_bad_seq": 3})
    );
    // An entry re-signed by another key fails at that entry.
    let other = Signer::from_env_with(&vars(&[("DESK_SIGNING_SEED", &"22".repeat(32))])).unwrap();
    let mut forged = entries.clone();
    forged[2] = ledger_entry(
        &other,
        3,
        entries[1]["hash"].as_str().unwrap(),
        json!({"outcome": "allow"}),
    );
    assert_eq!(
        verified(&forged, &pk),
        json!({"ok": false, "first_bad_seq": 3})
    );
    // A chain must start at the genesis hash.
    assert_eq!(
        verified(&entries[1..], &pk),
        json!({"ok": false, "first_bad_seq": 2})
    );

    // ledger_hash hashes canonical text only.
    assert!(ledger_hash(r#"{"seq": 1}"#).is_err());
}

#[test]
fn decide_fails_closed_on_bad_input() {
    let engine = engine();
    let slots = request(
        visitor(false),
        "native.find_slots",
        resource("Desk", "desk-1"),
        json!({}),
    );
    assert_eq!(decide(&engine, KEY, &slots, "final")["outcome"], "allow");

    let refused = |request_json: &str, phase: &str| {
        let verdict: Value =
            serde_json::from_str(&engine.decide(KEY, request_json, phase)).unwrap();
        assert_eq!(
            verdict["outcome"], "refuse",
            "{request_json} {phase}: {verdict}"
        );
        assert!(
            !verdict["errors"].as_array().unwrap().is_empty(),
            "{verdict}"
        );
    };
    refused("{not json", "final");
    refused(&slots.to_string(), "later");
    let mut extra = slots.clone();
    extra["principal_level"] = json!("verified");
    refused(&extra.to_string(), "final");
    let mut no_principal = slots.clone();
    no_principal.as_object_mut().unwrap().remove("principal");
    let verdict = engine.decide(KEY, &no_principal.to_string(), "final");
    assert!(verdict.contains("principal is required"), "{verdict}");
    // Without its principal entity the baseline forbid can't read principal.verified: an error, so refuse.
    let mut orphan = request(
        visitor(true),
        "native.release_document",
        resource("Document", "doc-1"),
        json!({"recipient": "verified_contact", "record_owner_match": true}),
    );
    orphan["entities"] = json!([orphan["entities"][1]]);
    refused(&orphan.to_string(), "final");
    refused(&orphan.to_string(), "pre");

    // owner_approved is the engine's to set: a request can't claim it.
    let approved_only = r#"@id("approved_book") @card("c-book") @tier("auto") @applies_to("native.book")
        permit (principal, action == Action::"native.book", resource) when { context.owner_approved };"#;
    let engine = engine_with(BASELINE, &format!("{AUTO}\n{approved_only}"));
    let book = request(
        visitor(false),
        "native.book",
        resource("Slot", "slot-1"),
        json!({"owner_approved": true}),
    );
    for phase in ["pre", "final"] {
        assert_eq!(
            decide(&engine, KEY, &book, phase)["outcome"],
            "hold",
            "{phase}"
        );
    }
}

#[test]
fn money_without_a_card_holds_even_with_no_ask() {
    // Step 5 makes an uncovered money allow a hold, whatever H says: the owner's
    // approval path stays open, and execution re-checks `approvable` anyway.
    let engine = PolicyEngine::new(BASELINE).expect("baseline loads");
    let errors = engine.load(
        KEY,
        SCHEMA,
        &sets("", &format!("{AUTO}\n{WIDE_LEAD_PERMIT}"), ""),
    );
    assert!(errors.is_empty(), "{errors:?}");
    let charge = request(
        agent(Some(5_000)),
        "native.charge_mandate",
        resource("Quote", "quote-1"),
        json!({"amount_cents": 1_000}),
    );
    for phase in ["pre", "final"] {
        let verdict = decide(&engine, KEY, &charge, phase);
        assert_eq!(verdict["outcome"], "hold", "{phase}: {verdict}");
        assert_eq!(
            ids(&verdict["policy_ids"]),
            ["A.capture_lead_and_more"],
            "{phase}"
        );
    }
}

/// The MCP schema with the refund tool also given to agents: the baseline, not
/// the schema, has to keep agents from paying out.
fn agent_payout_schema() -> String {
    let mut schema: Value = serde_json::from_str(SCHEMA_WITH_MCP).unwrap();
    schema[""]["actions"]["payments.create_refund"]["appliesTo"]["principalTypes"] =
        json!(["Visitor", "Agent"]);
    schema.to_string()
}

const REFUND_CARD: &str = r#"
@id("refunds_small")
@card("c-refund")
@tier("auto")
@applies_to("payments.create_refund")
permit (principal, action == Action::"payments.create_refund", resource)
when { context has amount_cents && context.amount_cents <= 5000 };
"#;

#[test]
fn agents_never_pay_out() {
    let engine = PolicyEngine::new(BASELINE).expect("baseline loads");
    let errors = engine.load(
        KEY,
        &agent_payout_schema(),
        &sets("", &format!("{AUTO}\n{REFUND_CARD}"), HOLD),
    );
    assert!(errors.is_empty(), "{errors:?}");
    let mut charge = resource("Charge", "charge-1");
    charge["attrs"]["owner_person_id"] = json!("person-dana");
    let context = json!({"amount_cents": 2_000, "record_owner_match": true});

    // Even a verified agent acting for the record owner, under a refund card for anyone.
    let mut agent = agent(Some(10_000));
    agent["attrs"]["verified"] = json!(true);
    agent["attrs"]["person_id"] = json!("person-dana");
    let refund = request(
        agent,
        "payments.create_refund",
        charge.clone(),
        context.clone(),
    );
    for phase in ["pre", "final"] {
        let verdict = decide(&engine, KEY, &refund, phase);
        assert_eq!(verdict["outcome"], "refuse", "{phase}: {verdict}");
        assert!(
            ids(&verdict["policy_ids"]).contains(&"B.no_agent_pay_out"),
            "{phase}: {verdict}"
        );
    }

    // The record owner themself still gets the refund the card allows.
    let mut dana = visitor(true);
    dana["attrs"]["person_id"] = json!("person-dana");
    let refund = request(dana, "payments.create_refund", charge, context);
    assert_eq!(decide(&engine, KEY, &refund, "final")["outcome"], "allow");
}
