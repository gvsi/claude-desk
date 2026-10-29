//! `PolicyEngine`: Cedar decisions over a Desk's policy sets.
//!
//! The master plan's "Decision semantics" (steps 2 to 5) live here; step 1
//! (session checks, normalization, prices) is the kernel service's.
//!
//! - Sets: `B` is the always-on baseline (forbids), `F` the never cards
//!   (forbids), `A` the auto cards (permits), `H` the ask cards and the hold
//!   twins of auto cards (permits). Every policy is renamed `<set>.<@id>` on
//!   load, because the library otherwise names them `policy0..N`.
//! - `auto` is Cedar over `B ∪ F ∪ A` with `context.owner_approved = false`; if it
//!   allows, the outcome is `allow`. Otherwise `approvable` is Cedar over
//!   `B ∪ F ∪ H` with `context.owner_approved = true`: allows → `hold`,
//!   denies → `refuse`.
//! - `pre` first runs partial evaluation with `context.review` unknown. A known
//!   decision means the reviewer's score can't change the outcome, so the
//!   verdict comes from a full evaluation with `review` absent; an unknown one
//!   returns `needs_review` with the residual policies. Every verdict comes from
//!   a full evaluation, so a partial-evaluation mistake can't produce an allow.
use anyhow::{Context as _, Result, anyhow, bail};
use cedar_policy::{
    AuthorizationError, Authorizer, Context, Decision, Effect, Entities, EntityId, EntityTypeName,
    EntityUid, Policy, PolicyId, PolicySet, Request, RestrictedExpression, Schema, ValidationMode,
    Validator,
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::str::FromStr;
use std::sync::{Arc, RwLock};

/// The outcome of one `decide` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Allow,
    Hold,
    Refuse,
    /// `pre` only: the outcome depends on the reviewer's score.
    NeedsReview,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Allow => "allow",
            Outcome::Hold => "hold",
            Outcome::Refuse => "refuse",
            Outcome::NeedsReview => "needs_review",
        }
    }
}

/// `{outcome, policy_ids, pending_policy_ids, errors}`, as `decide` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub outcome: Outcome,
    /// The deciding policies of the evaluation that settled the outcome.
    pub policy_ids: Vec<String>,
    /// `needs_review` only: the review-gated policies still undecided.
    pub pending_policy_ids: Vec<String>,
    pub errors: Vec<String>,
}

impl Verdict {
    fn new(outcome: Outcome, policy_ids: Vec<String>) -> Self {
        Self {
            outcome,
            policy_ids,
            pending_policy_ids: vec![],
            errors: vec![],
        }
    }

    fn refuse_with(error: impl Into<String>) -> Self {
        Self {
            errors: vec![error.into()],
            ..Self::new(Outcome::Refuse, vec![])
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "outcome": self.outcome.as_str(),
            "policy_ids": self.policy_ids,
            "pending_policy_ids": self.pending_policy_ids,
            "errors": self.errors,
        })
    }
}

/// Parses one set's Cedar text and renames each policy `<set>.<@id>`.
pub fn parse_set(set: &str, src: &str) -> Result<Vec<Policy>> {
    let parsed = PolicySet::from_str(src).map_err(|e| anyhow!("{set}: {e}"))?;
    if parsed.templates().next().is_some() {
        bail!("{set}: templates are not allowed");
    }
    parsed
        .policies()
        .map(|p| {
            let local = p
                .annotation("id")
                .ok_or_else(|| anyhow!("{set}: a policy has no @id: {p}"))?;
            Ok(p.new_id(PolicyId::new(format!("{set}.{local}"))))
        })
        .collect()
}

fn policy_set(parts: &[&[Policy]]) -> Result<PolicySet> {
    let mut set = PolicySet::new();
    for policy in parts.iter().flat_map(|part| part.iter()) {
        set.add(policy.clone())
            .map_err(|e| anyhow!("{}: {e}", policy.id()))?;
    }
    Ok(set)
}

/// The effect groups whose tools move money (step 5).
const MONEY_EFFECTS: [&str; 2] = ["effect:charge", "effect:pay_out"];

/// One loaded policy version: a Desk's schema and its two evaluation sets.
struct Version {
    schema: Schema,
    /// The schema's action entities, for each tool's effect groups.
    actions: Entities,
    /// `B ∪ F ∪ A`
    auto: PolicySet,
    /// `B ∪ F ∪ H`
    approvable: PolicySet,
}

/// A request_json, parsed against the version's schema.
struct Parsed {
    principal: EntityUid,
    action: EntityUid,
    resource: EntityUid,
    /// The context as sent, without `owner_approved` (set by the engine) or `review`.
    context: Map<String, Value>,
    review: Option<Value>,
    entities: Entities,
}

struct Evaluation {
    decision: Decision,
    reasons: Vec<String>,
    /// `<policy id>: <message>` for every policy whose evaluation errored.
    errors: Vec<String>,
}

const REQUEST_FIELDS: [&str; 5] = ["principal", "action", "resource", "context", "entities"];

fn entity_ref(v: Option<&Value>, field: &str) -> Result<EntityUid> {
    let v = v.with_context(|| format!("{field} is required"))?;
    let (Some(ty), Some(id), 2) = (
        v.get("type").and_then(Value::as_str),
        v.get("id").and_then(Value::as_str),
        v.as_object().map_or(0, Map::len),
    ) else {
        bail!("{field} must be {{\"type\", \"id\"}}");
    };
    let ty = EntityTypeName::from_str(ty).map_err(|e| anyhow!("{field}: {e}"))?;
    Ok(EntityUid::from_type_name_and_id(ty, EntityId::new(id)))
}

/// Reviewer scores are integer basis points. A review with a score outside
/// 0–10000, a non-integer score or any other shape is a reviewer failure, and
/// a failed review is absent: it can only turn an allow into a hold.
fn valid_review(review: Value) -> Option<Value> {
    let fields = review.as_object()?;
    let score = |name: &str| {
        fields
            .get(name)?
            .as_i64()
            .filter(|bp| (0..=10_000).contains(bp))
    };
    let (within, manipulation) = (score("within_charter_bp")?, score("manipulation_bp")?);
    (fields.len() == 2)
        .then(|| json!({"within_charter_bp": within, "manipulation_bp": manipulation}))
}

fn sorted(ids: impl Iterator<Item = String>) -> Vec<String> {
    let mut ids: Vec<String> = ids.collect();
    ids.sort();
    ids
}

impl Version {
    fn parse(&self, req: &Value) -> Result<Parsed> {
        let obj = req.as_object().context("request must be a JSON object")?;
        if let Some(extra) = obj.keys().find(|k| !REQUEST_FIELDS.contains(&k.as_str())) {
            bail!("unknown request field {extra:?}");
        }
        let principal = entity_ref(obj.get("principal"), "principal")?;
        let tool = obj
            .get("action")
            .and_then(Value::as_str)
            .context("action must be a tool name")?;
        let action = EntityUid::from_type_name_and_id(
            EntityTypeName::from_str("Action").map_err(|e| anyhow!("{e}"))?,
            EntityId::new(tool),
        );
        let resource = entity_ref(obj.get("resource"), "resource")?;
        let mut context = obj
            .get("context")
            .and_then(Value::as_object)
            .context("context must be an object")?
            .clone();
        context.remove("owner_approved");
        let review = context.remove("review").and_then(valid_review);
        let entities = obj
            .get("entities")
            .context("entities are required")?
            .clone();
        let entities = Entities::from_json_value(entities, Some(&self.schema))
            .map_err(|e| anyhow!("entities: {e}"))?;
        Ok(Parsed {
            principal,
            action,
            resource,
            context,
            review,
            entities,
        })
    }

    fn context(&self, p: &Parsed, owner_approved: bool, review: Option<&Value>) -> Result<Context> {
        let mut ctx = p.context.clone();
        ctx.insert("owner_approved".into(), Value::Bool(owner_approved));
        if let Some(review) = review {
            ctx.insert("review".into(), review.clone());
        }
        Context::from_json_value(Value::Object(ctx), Some((&self.schema, &p.action)))
            .map_err(|e| anyhow!("context: {e}"))
    }

    fn evaluate(
        &self,
        set: &PolicySet,
        p: &Parsed,
        owner_approved: bool,
        review: Option<&Value>,
    ) -> Result<Evaluation> {
        let context = self.context(p, owner_approved, review)?;
        let request = Request::new(
            p.principal.clone(),
            p.action.clone(),
            p.resource.clone(),
            context,
            Some(&self.schema),
        )
        .map_err(|e| anyhow!("request: {e}"))?;
        let response = Authorizer::new().is_authorized(&request, set, &p.entities);
        Ok(Evaluation {
            decision: response.decision(),
            reasons: sorted(response.diagnostics().reason().map(ToString::to_string)),
            errors: sorted(response.diagnostics().errors().map(|e| match e {
                AuthorizationError::PolicyEvaluationError(e) => {
                    format!("{}: {}", e.policy_id(), e.inner())
                }
            })),
        })
    }

    /// Steps 3 to 5 on a full request: `auto`, then `approvable`. Cedar skips a
    /// policy whose condition errors, which would let an erroring forbid fail
    /// open, so any evaluation error refuses (step 4).
    fn decide_final(&self, p: &Parsed, review: Option<&Value>) -> Result<Verdict> {
        let auto = self.evaluate(&self.auto, p, false, review)?;
        if !auto.errors.is_empty() {
            return Ok(Verdict {
                errors: auto.errors,
                ..Verdict::new(Outcome::Refuse, vec![])
            });
        }
        if auto.decision == Decision::Allow {
            let money = self.money_effects(&p.action);
            if money.is_empty() || self.owner_card_allows(&p.action, &money, &auto.reasons) {
                return Ok(Verdict::new(Outcome::Allow, auto.reasons));
            }
            // Step 5: money no owner card covers is never an allow, but the
            // owner can still approve it. Execution re-checks `approvable`.
            return Ok(Verdict::new(Outcome::Hold, auto.reasons));
        }
        let approvable = self.evaluate(&self.approvable, p, true, review)?;
        if !approvable.errors.is_empty() {
            return Ok(Verdict {
                errors: approvable.errors,
                ..Verdict::new(Outcome::Refuse, vec![])
            });
        }
        Ok(match approvable.decision {
            Decision::Allow => Verdict::new(Outcome::Hold, approvable.reasons),
            Decision::Deny => Verdict::new(Outcome::Refuse, approvable.reasons),
        })
    }

    /// The money effect groups (`effect:charge`, `effect:pay_out`) the tool is in.
    fn money_effects(&self, action: &EntityUid) -> Vec<String> {
        self.actions
            .ancestors(action)
            .map(|groups| {
                groups
                    .map(|g| g.id().unescaped().to_string())
                    .filter(|g| MONEY_EFFECTS.contains(&g.as_str()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Step 5: is one of the deciding policies an `@tier("auto")` permit of set
    /// `A`, compiled from a card that covers this tool or one of its money effects?
    /// Cedar can't say this as a forbid, since a policy can't see which other
    /// policies matched; the `money_needs_card` proof backs it.
    fn owner_card_allows(&self, action: &EntityUid, money: &[String], deciding: &[String]) -> bool {
        let tool = action.id().unescaped();
        let covers = |applies_to: &str| {
            applies_to
                .split(',')
                .map(str::trim)
                .any(|t| t == tool || money.iter().any(|m| m == t))
        };
        deciding
            .iter()
            .filter(|id| id.starts_with("A."))
            .filter_map(|id| self.auto.policy(&PolicyId::new(id.as_str())))
            .any(|p| {
                p.effect() == Effect::Permit
                    && p.annotation("tier") == Some("auto")
                    && p.annotation("card")
                        .is_some_and(|card| !card.trim().is_empty())
                    && p.annotation("applies_to").is_some_and(covers)
            })
    }

    /// Step 2: partial evaluation of `auto` with `context.review` unknown.
    fn decide_pre(&self, p: &Parsed) -> Result<Verdict> {
        // A request holding an unknown can't be schema-validated, so validate the
        // review-less request first, then build the partial one without a schema.
        let base = self.context(p, false, None)?;
        Request::new(
            p.principal.clone(),
            p.action.clone(),
            p.resource.clone(),
            base.clone(),
            Some(&self.schema),
        )
        .map_err(|e| anyhow!("request: {e}"))?;
        let context = base
            .merge([(
                "review".to_string(),
                RestrictedExpression::new_unknown("review"),
            )])
            .map_err(|e| anyhow!("context: {e}"))?;
        let request = Request::new(
            p.principal.clone(),
            p.action.clone(),
            p.resource.clone(),
            context,
            None,
        )
        .map_err(|e| anyhow!("partial request: {e}"))?;
        let partial = Authorizer::new().is_authorized_partial(&request, &self.auto, &p.entities);
        let errored = sorted(
            partial
                .definitely_errored()
                .map(|id| format!("{id}: evaluation error")),
        );
        if !errored.is_empty() {
            return Ok(Verdict {
                errors: errored,
                ..Verdict::new(Outcome::Refuse, vec![])
            });
        }
        match partial.decision() {
            Some(_) => self.decide_final(p, None),
            None => Ok(Verdict {
                pending_policy_ids: sorted(
                    partial.nontrivial_residuals().map(|p| p.id().to_string()),
                ),
                ..Verdict::new(Outcome::NeedsReview, vec![])
            }),
        }
    }
}

/// Loads policy versions at runtime and decides requests against them.
pub struct PolicyEngine {
    baseline: Vec<Policy>,
    versions: RwLock<HashMap<String, Arc<Version>>>,
}

impl PolicyEngine {
    /// `baseline` is the Cedar text of set `B`; it may hold only forbids.
    pub fn new(baseline: &str) -> Result<Self> {
        let baseline = parse_set("B", baseline)?;
        if let Some(p) = baseline.iter().find(|p| p.effect() != Effect::Forbid) {
            bail!(
                "the baseline may hold only forbids, but {} is a permit",
                p.id()
            );
        }
        Ok(Self {
            baseline,
            versions: RwLock::new(HashMap::new()),
        })
    }

    /// Validates the baseline and `sets_json` (`{"F", "A", "H"}` Cedar texts)
    /// against the Desk's schema and caches them under `key`. Returns the
    /// errors; empty means loaded. A failed load also drops anything cached
    /// under `key`, so deciding against it refuses.
    pub fn load(&self, key: &str, schema_json: &str, sets_json: &str) -> Vec<String> {
        let built = self.build(schema_json, sets_json);
        let mut versions = self.versions.write().unwrap_or_else(|e| e.into_inner());
        match built {
            Ok(version) => {
                versions.insert(key.to_string(), Arc::new(version));
                vec![]
            }
            Err(errors) => {
                versions.remove(key);
                errors
            }
        }
    }

    fn build(&self, schema_json: &str, sets_json: &str) -> Result<Version, Vec<String>> {
        let lint = crate::lint_policies(sets_json);
        if !lint.is_empty() {
            return Err(lint);
        }
        let schema =
            Schema::from_json_str(schema_json).map_err(|e| vec![format!("schema: {e}")])?;
        let sets: Value =
            serde_json::from_str(sets_json).map_err(|e| vec![format!("sets_json: {e}")])?;
        let text = |name: &str| {
            sets.get(name)
                .and_then(Value::as_str)
                .ok_or_else(|| vec![format!("sets_json needs a {name} text")])
        };
        let parse = |name: &str| parse_set(name, text(name)?).map_err(|e| vec![e.to_string()]);
        let (f, a, h) = (parse("F")?, parse("A")?, parse("H")?);
        let one = |e: anyhow::Error| vec![e.to_string()];
        let all = policy_set(&[&self.baseline, &f, &a, &h]).map_err(one)?;
        let validation = Validator::new(schema.clone()).validate(&all, ValidationMode::Strict);
        if !validation.validation_passed() {
            return Err(validation
                .validation_errors()
                .map(|e| e.to_string())
                .collect());
        }
        let actions = schema
            .action_entities()
            .map_err(|e| vec![format!("schema actions: {e}")])?;
        Ok(Version {
            actions,
            auto: policy_set(&[&self.baseline, &f, &a]).map_err(one)?,
            approvable: policy_set(&[&self.baseline, &f, &h]).map_err(one)?,
            schema,
        })
    }

    /// Decides `request_json` against the version loaded under `key`.
    /// `phase` is `"pre"` (may return `needs_review`) or `"final"` (evaluates
    /// whatever review the request carries). Never fails: any problem refuses.
    pub fn decide(&self, key: &str, request_json: &str, phase: &str) -> String {
        catch_unwind(AssertUnwindSafe(|| {
            self.decide_verdict(key, request_json, phase)
        }))
        .unwrap_or_else(|_| Verdict::refuse_with("internal error while deciding"))
        .to_json()
        .to_string()
    }

    fn decide_verdict(&self, key: &str, request_json: &str, phase: &str) -> Verdict {
        let version = self
            .versions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned();
        let Some(version) = version else {
            return Verdict::refuse_with(format!("policy version {key:?} is not loaded"));
        };
        let decided = serde_json::from_str::<Value>(request_json)
            .map_err(|e| anyhow!("request_json: {e}"))
            .and_then(|req| version.parse(&req))
            .and_then(|p| match phase {
                "pre" => version.decide_pre(&p),
                "final" => version.decide_final(&p, p.review.as_ref()),
                other => bail!("unknown phase {other:?}"),
            });
        decided.unwrap_or_else(|e| Verdict::refuse_with(e.to_string()))
    }
}
