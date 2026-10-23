import { createHash } from "node:crypto";
import { predicatePolicy, sameValue, scopeRelation } from "./conflict-semantics.mjs";
import { promotionScopeRelation } from "./promotion-scope.mjs";

const stable = (value) => JSON.stringify(value && typeof value === "object"
  ? Array.isArray(value) ? value.map((item) => JSON.parse(stable(item)))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))]))
  : value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Deliberately small ontology: a trip kind is a supported scope, not evidence for a global preference.
export function commonScope(evidenceScopes) {
  if (!evidenceScopes.length) return null;
  const first = evidenceScopes[0];
  if (!first?.domain || first.unresolved_trip_id) return null;
  if (evidenceScopes.some((item) => item.domain !== first.domain || item.topic !== first.topic
    || item.unresolved_trip_id || stable(item.situations ?? []) !== stable(first.situations ?? []))) return null;
  if (!(first.situations ?? []).length && !evidenceScopes.every((item) => item.explicit_global)) return null;
  return { domain: first.domain, ...(first.topic ? { topic: first.topic } : {}),
    ...(first.situations?.length ? { situations: structuredClone(first.situations) } : {}) };
}

export function scopeCoveredBy(sourceScope, targetScope) {
  if (!sourceScope || !targetScope) return false;
  return ["equal", "b_covers_a"].includes(promotionScopeRelation(sourceScope, targetScope));
}

function independentEvidence(group, policy) {
  const byOccurrence = new Map();
  for (const item of group.evidence ?? []) {
    if (!item.trip_id || !policy.allowed_evidence_kinds.includes(item.evidence_kind)
      || item.evidence_kind === "inference" || item.confidence < policy.min_evidence_confidence
      || !Number.isFinite(Date.parse(item.occurred_at))) continue;
    const key = `${item.trip_id}:${item.occurrence_id ?? item.event_id}`;
    const prior = byOccurrence.get(key);
    if (!prior || item.confidence > prior.confidence) byOccurrence.set(key, item);
  }
  const byTrip = new Map();
  for (const item of byOccurrence.values()) {
    const prior = byTrip.get(item.trip_id);
    if (!prior || Date.parse(item.occurred_at) < Date.parse(prior.occurred_at)) byTrip.set(item.trip_id, item);
  }
  return [...byTrip.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

export function promotionKey(group, evidence) {
  return `promo_${hash({ group_id: group.group_id, generation: group.generation,
    evidence_event_ids: evidence.map((item) => item.event_id).sort(), policy_version: group.policy_version })}`;
}

// No writes, clocks, repositories, or model calls: replayable and human-reviewable.
export function decidePromotion({ group, policy, now, counterEvidence = [], existingLongTerm = [] }) {
  const base = { group_id: group.group_id, policy_version: policy.policy_version,
    target_scope: null, confidence: null, evidence_event_ids: [], evidence_trip_ids: [], promotion_key: null,
    proposal_id: null };
  const result = (action, reason_code, extra = {}) => ({ ...base, action, reason_code, ...extra });
  if (!policy.promotable) return result("rejected_by_policy", "PREDICATE_NOT_PROMOTABLE");
  if (group.status === "promoted") return result("wait", "ALREADY_PROMOTED");
  if (Date.parse(group.observation_deadline_at) <= Date.parse(now)) return result("expire", "OBSERVATION_WINDOW_EXPIRED");
  const scope = commonScope((group.evidence ?? []).map((item) => item.source_scope ?? group.scope_anchor));
  const explicitGlobal = (group.evidence ?? []).length > 0
    && group.evidence.every((item) => (item.source_scope ?? group.scope_anchor).explicit_global === true);
  if (!scope || (policy.scope_policy === "known_situation_required" && !explicitGlobal
    && !scope.situations?.length)) {
    return result("wait", "SCOPE_NOT_GENERALIZABLE");
  }
  const evidence = independentEvidence(group, policy);
  const trips = [...new Set(evidence.map((item) => item.trip_id))];
  const explicitFastPath = evidence.length > 0
    && evidence.every((item) => item.explicit_generalization === true
      && ["explicit_statement", "user_correction"].includes(item.evidence_kind));
  if (!explicitFastPath && trips.length < policy.min_distinct_trips) return result("wait", "INSUFFICIENT_DISTINCT_TRIPS");
  const span = evidence.length > 0
    ? (Date.parse(evidence.at(-1).occurred_at) - Date.parse(evidence[0].occurred_at)) / 86_400_000 : 0;
  if (!explicitFastPath && span < policy.min_span_days) return result("wait", "INSUFFICIENT_TIME_SPAN");
  if (predicatePolicy(group.claim.predicate).cardinality === "single"
    && counterEvidence.some((item) => item.value !== undefined && !sameValue(item.value, group.claim.value)
    && ["equal", "overlap", "a_covers_b", "b_covers_a"].includes(scopeRelation(item.scope, scope)))) {
    return result("blocked_by_counter_evidence", "UNRESOLVED_COUNTER_EVIDENCE", { target_scope: scope });
  }
  const relevant = existingLongTerm.filter((item) => item.status === "active"
    && item.statement?.subject === group.claim.subject && item.statement?.predicate === group.claim.predicate
    && item.memory_domain === group.memory_domain && item.memory_kind === group.memory_kind
    && item.scope?.domain === scope.domain);
  const unknown = relevant.find((item) => promotionScopeRelation(item.scope, scope) === "unknown");
  if (unknown) return result("needs_confirmation", "EXISTING_LONG_TERM_SCOPE_UNKNOWN", { target_scope: scope,
    existing_memory_id: unknown.memory_id });
  const matching = relevant.filter((item) => ["equal", "overlap", "a_covers_b", "b_covers_a"]
    .includes(promotionScopeRelation(item.scope, scope)));
  const different = predicatePolicy(group.claim.predicate).cardinality === "single"
    ? matching.find((item) => !sameValue(item.statement.value, group.claim.value)) : null;
  if (different) return result("needs_confirmation", "EXISTING_LONG_TERM_CONFLICT", { target_scope: scope,
    existing_memory_id: different.memory_id });
  const equivalent = matching.find((item) => sameValue(item.statement.value, group.claim.value)
    && scopeCoveredBy(scope, item.scope));
  if (!equivalent && matching.some((item) => sameValue(item.statement.value, group.claim.value))) {
    return result("needs_confirmation", "EXISTING_LONG_TERM_SCOPE_OVERLAP", { target_scope: scope });
  }
  const eventIds = [...new Set(evidence.map((item) => item.event_id))].sort();
  const sourceConfidence = Math.min(...evidence.map((item) => item.confidence));
  const sourcePenalty = evidence.some((item) => item.source_refs?.every((ref) => ref.source_type === "pending")) ? 0.08 : 0.04;
  const breadthPenalty = scope.situations?.length ? 0.06 : 0.14;
  const confidence = Math.max(0.1, Number((sourceConfidence - sourcePenalty - breadthPenalty).toFixed(2)));
  const fields = { target_scope: scope, confidence, evidence_event_ids: eventIds,
    evidence_trip_ids: trips.sort(), promotion_key: promotionKey(group, evidence),
    ...(equivalent ? { existing_memory_id: equivalent.memory_id } : {}) };
  const confirmationRequired = explicitFastPath || !policy.auto_promote || policy.requires_confirmation || !scope.situations?.length;
  if (confirmationRequired) {
    const proposalId = `proposal_${fields.promotion_key}`;
    if (group.confirmation?.proposal_id === proposalId) {
      return result("promote", equivalent ? "REINFORCE_EXISTING_LONG_TERM" : "USER_CONFIRMED_PROMOTION",
        { ...fields, proposal_id: proposalId });
    }
    return result("needs_confirmation", "POLICY_REQUIRES_CONFIRMATION", { ...fields, proposal_id: proposalId });
  }
  return result("promote", equivalent ? "REINFORCE_EXISTING_LONG_TERM" : "INDEPENDENT_EVIDENCE_MET", fields);
}
