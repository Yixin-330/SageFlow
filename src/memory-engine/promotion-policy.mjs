export const PROMOTION_POLICY_VERSION = "promotion-admission-0.1";

const DEFAULT = Object.freeze({
  promotable: false, auto_promote: false, risk_tier: "unclassified",
  min_distinct_trips: null, min_span_days: null, allowed_evidence_kinds: [],
  min_evidence_confidence: 0.65,
  requires_confirmation: true, observation_days: 90, scope_policy: "no_generalization",
  direct_long_term: false
});

const POLICIES = Object.freeze({
  prefers_travel_pace: { promotable: true, auto_promote: true, risk_tier: "low",
    min_distinct_trips: 2, min_span_days: 7, allowed_evidence_kinds: ["explicit_statement", "observed_behavior", "inference", "user_correction"],
    requires_confirmation: false, observation_days: 90, scope_policy: "trip_kind_required", direct_long_term: true },
  prefers_notification_frequency: { promotable: true, auto_promote: true, risk_tier: "low",
    min_distinct_trips: 2, min_span_days: 7, allowed_evidence_kinds: ["explicit_statement", "observed_behavior", "inference", "user_correction"],
    requires_confirmation: false, observation_days: 90, scope_policy: "trip_kind_required", direct_long_term: true },
  prefers_activity_load: { promotable: true, auto_promote: true, risk_tier: "low",
    min_distinct_trips: 2, min_span_days: 7, allowed_evidence_kinds: ["explicit_statement", "observed_behavior", "inference", "user_correction"],
    requires_confirmation: false, observation_days: 90, scope_policy: "trip_kind_required", direct_long_term: true },
  likes_experience: { promotable: true, auto_promote: true, risk_tier: "low",
    min_distinct_trips: 2, min_span_days: 7, allowed_evidence_kinds: ["explicit_statement", "observed_behavior", "inference", "user_correction"],
    requires_confirmation: false, observation_days: 90, scope_policy: "trip_kind_required", direct_long_term: true },
  comfortable_activity_budget_cny: { promotable: true, auto_promote: false, risk_tier: "medium",
    min_distinct_trips: 2, min_span_days: 7, allowed_evidence_kinds: ["explicit_statement", "user_correction"],
    requires_confirmation: true, observation_days: 90, scope_policy: "trip_kind_required", direct_long_term: true },
  health_constraint: { promotable: true, auto_promote: false, risk_tier: "high",
    min_distinct_trips: 2, min_span_days: 7, allowed_evidence_kinds: ["explicit_statement", "user_correction"],
    requires_confirmation: true, observation_days: 90, scope_policy: "trip_kind_required", direct_long_term: true },
  current_trip_pace: { promotable: false, auto_promote: false, risk_tier: "low", scope_policy: "trip_only" },
  current_trip_budget_intent: { promotable: false, auto_promote: false, risk_tier: "medium", scope_policy: "trip_only" },
  service_policy: { promotable: false, auto_promote: false, risk_tier: "medium", scope_policy: "explicit_only",
    requires_confirmation: false, direct_long_term: true },
  museum_preference: { promotable: false, auto_promote: false, risk_tier: "low", scope_policy: "explicit_only",
    requires_confirmation: false, direct_long_term: true }
});

export function promotionPolicy(predicate) {
  return { ...DEFAULT, ...(POLICIES[predicate] ?? {}), policy_version: PROMOTION_POLICY_VERSION };
}

function hasTemporaryScope(scope = {}, evidenceEvents = []) {
  return ["trips", "sessions", "days", "entities", "time_window"].some((key) => scope[key] !== undefined)
    || (scope.applies_when ?? []).some((token) => evidenceEvents.some((event) => token === event.trip_id));
}

export function classifyAdmission(candidate, evidenceEvents = []) {
  const policy = promotionPolicy(candidate.statement?.predicate);
  if (candidate.retention === "do_not_store") return { path: "reject", reason_code: "RETENTION_POLICY_REJECTED", policy };
  if (candidate.memory_tier === "short_term" || ["current_trip", "short_lived"].includes(candidate.retention)) {
    return { path: "short_term", reason_code: "TEMPORARY_SCOPE", policy };
  }
  const explicit = ["explicit_statement", "user_correction"].includes(candidate.evidence_kind);
  const userSourced = evidenceEvents.some((event) => ["dialogue.user_statement", "feedback.user_confirmed", "feedback.user_corrected"].includes(event.event_type));
  const confirmed = evidenceEvents.some((event) => event.event_type === "feedback.user_confirmed"
    || event.payload?.long_term_confirmed === true);
  const corrected = candidate.evidence_kind === "user_correction"
    && evidenceEvents.some((event) => event.event_type === "feedback.user_corrected");
  if (explicit && userSourced && policy.direct_long_term && !hasTemporaryScope(candidate.scope, evidenceEvents)
    && (!policy.requires_confirmation || confirmed || corrected)) {
    return { path: "direct_long_term", reason_code: "EXPLICIT_STABLE_CLAIM", policy };
  }
  return { path: "promotion_group", reason_code: policy.promotable
    ? policy.requires_confirmation ? "LONG_TERM_CONFIRMATION_REQUIRED" : "LONG_TERM_EVIDENCE_REQUIRED"
    : "DIRECT_LONG_TERM_NOT_ALLOWED", policy };
}

export function canCollectPromotionSource(candidate, evidenceEvents = [], policy = promotionPolicy(candidate.statement?.predicate)) {
  if (!policy.promotable || !policy.allowed_evidence_kinds.includes(candidate.evidence_kind)) return false;
  if (candidate.scope?.entities?.length || candidate.scope?.days?.length || candidate.scope?.time_window) return false;
  const knownTripKinds = new Set(["leisure_trip", "business_trip", "family_trip", "solo_trip"]);
  const tripIds = new Set([...(candidate.scope?.trips ?? []), ...evidenceEvents.map((event) => event.trip_id)]);
  if ((candidate.scope?.applies_when ?? []).some((token) => !knownTripKinds.has(token) && !tripIds.has(token))) return false;
  return true;
}
