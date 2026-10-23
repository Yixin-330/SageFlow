import { createHash } from "node:crypto";
import { promotionPolicy, PROMOTION_POLICY_VERSION } from "./promotion-policy.mjs";
import { legacyPromotionSituation } from "./promotion-scope.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, stable(value[key])]));
  return value;
}

const ALIASES = Object.freeze({
  prefers_travel_pace: { unhurried: "slow", not_rushed: "slow", quick: "fast" }
});

export function canonicalClaim(candidate) {
  const predicate = candidate.statement.predicate;
  const raw = candidate.statement.value;
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : stable(raw);
  return { subject: candidate.statement.subject, predicate,
    value: typeof normalized === "string" ? ALIASES[predicate]?.[normalized] ?? normalized : normalized };
}

export function promotionScopeAnchor(scope = {}, evidenceEvents = [], explicitGeneralization = false) {
  const first = evidenceEvents[0];
  const situations = [...(scope.situations ?? [])];
  const legacySituations = (scope.applies_when ?? []).map(legacyPromotionSituation).filter(Boolean);
  for (const item of legacySituations) {
    if (situations.some((known) => known.field === item.field
      && JSON.stringify(known.value) !== JSON.stringify(item.value))) {
      return { domain: scope.domain, ...(scope.topic ? { topic: scope.topic } : {}), situations: [],
        unresolved_trip_id: first?.trip_id ?? "unknown" };
    }
    if (!situations.some((known) => known.field === item.field)) situations.push(item);
  }
  const legacyTripKind = legacySituations.find((item) => item.field === "trip_kind")?.value;
  const tripKind = first?.payload?.trip_kind ?? legacyTripKind;
  const assertedKind = situations.find((item) => item.field === "trip_kind");
  if (assertedKind && tripKind && assertedKind.value !== tripKind) return {
    domain: scope.domain, ...(scope.topic ? { topic: scope.topic } : {}), situations: [],
    unresolved_trip_id: first?.trip_id ?? "unknown"
  };
  if (tripKind && !assertedKind && !explicitGeneralization) situations.push({ field: "trip_kind", value: tripKind });
  situations.sort((a, b) => `${a.field}:${JSON.stringify(stable(a.value))}`
    .localeCompare(`${b.field}:${JSON.stringify(stable(b.value))}`));
  const anchor = { domain: scope.domain, ...(scope.topic ? { topic: scope.topic } : {}), situations };
  if (!situations.length && !explicitGeneralization) {
    anchor.unresolved_trip_id = first?.trip_id ?? "unknown";
  }
  if (!situations.length && explicitGeneralization) anchor.explicit_global = true;
  return anchor;
}

export function promotionGroupIdentity(userId, candidate, evidenceEvents, sourceScope = candidate.scope) {
  const claim = canonicalClaim(candidate);
  const scopeAnchor = promotionScopeAnchor(sourceScope, evidenceEvents, candidate.explicit_generalization === true);
  const key = { user_id: userId, subject: claim.subject, memory_domain: candidate.memory_domain,
    memory_kind: candidate.memory_kind, predicate: claim.predicate, value: claim.value, scope_anchor: scopeAnchor };
  const groupId = `pg_${createHash("sha256").update(JSON.stringify(stable(key))).digest("hex")}`;
  return { group_id: groupId, claim, scope_anchor: scopeAnchor };
}

export function promotionSource({ candidate, sourceType, sourceId, events, sourceScope = candidate.scope }) {
  if (!["pending", "short_term"].includes(sourceType)) throw new Error("Invalid promotion source type");
  const userId = candidate.user_id ?? events[0]?.user_id;
  const identity = promotionGroupIdentity(userId, candidate, events, sourceScope);
  return { ...identity, user_id: userId, memory_domain: candidate.memory_domain, memory_kind: candidate.memory_kind,
    source_type: sourceType, source_id: sourceId, candidate_id: candidate.candidate_id,
    sensitivity: candidate.sensitivity, service_role: candidate.service_role ?? null,
    policy_version: PROMOTION_POLICY_VERSION,
    evidence: events.map((event) => ({ event_id: event.event_id,
      occurrence_id: event.payload?.utterance_id ?? event.payload?.interaction_id ?? event.event_id,
      trip_id: event.trip_id, session_id: event.payload?.session_id ?? null,
      occurred_at: event.occurred_at, evidence_kind: candidate.evidence_kind,
      confidence: candidate.confidence, sensitivity: candidate.sensitivity,
      service_role: candidate.service_role ?? null,
      explicit_generalization: candidate.explicit_generalization === true,
      source_scope: promotionScopeAnchor(sourceScope, [event], candidate.explicit_generalization === true),
      source_refs: [{ source_type: sourceType, source_id: sourceId }] })) };
}

export function mergePromotionGroup(existing, source, now) {
  const policy = promotionPolicy(source.claim.predicate);
  const firstSeen = source.evidence.map((item) => Date.parse(item.occurred_at))
    .filter(Number.isFinite).sort((a, b) => a - b)[0] ?? Date.parse(now);
  const restarted = existing && (existing.status === "expired"
    || (["collecting", "eligible", "needs_confirmation", "blocked_by_counter_evidence"].includes(existing.status)
      && Date.parse(existing.observation_deadline_at) <= Date.parse(now)));
  const prior = restarted ? [...(existing.history ?? []), { generation: existing.generation ?? 1,
    status: "expired", expired_at: existing.expired_at ?? now, evidence_event_ids: existing.evidence_event_ids }] : existing?.history ?? [];
  const base = !existing || restarted ? {
    group_id: source.group_id, user_id: source.user_id, claim: source.claim,
    memory_domain: source.memory_domain, memory_kind: source.memory_kind, scope_anchor: source.scope_anchor,
    status: "collecting", generation: restarted ? (existing.generation ?? 1) + 1 : 1,
    policy_version: source.policy_version, created_at: now, first_seen_at: new Date(firstSeen).toISOString(),
    observation_deadline_at: new Date(firstSeen + policy.observation_days * 86_400_000).toISOString(),
    evidence: [], evidence_event_ids: [], candidate_ids: [], pending_ids: [], source_memory_ids: [],
    sensitivity: policy.risk_tier === "high" ? "sensitive" : "normal", service_role: null,
    trip_ids: [], session_ids: [], counter_evidence: [], last_evaluated_at: null, history: prior
  } : structuredClone(existing);
  base.policy_version = source.policy_version;
  if (source.sensitivity === "sensitive" || policy.risk_tier === "high") base.sensitivity = "sensitive";
  const roleRank = { observation: 0, commitment: 1, hard_constraint: 2 };
  if (source.service_role && (roleRank[source.service_role] ?? 0) > (roleRank[base.service_role] ?? -1)) {
    base.service_role = source.service_role;
  }
  const byEvent = new Map(base.evidence.map((item) => [item.event_id, item]));
  for (const item of source.evidence) {
    const priorEvent = byEvent.get(item.event_id);
    if (priorEvent) {
      for (const ref of item.source_refs) {
        if (!priorEvent.source_refs.some((known) => known.source_type === ref.source_type && known.source_id === ref.source_id)) {
          priorEvent.source_refs.push(ref);
        }
      }
    } else byEvent.set(item.event_id, structuredClone(item));
  }
  base.evidence = [...byEvent.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)
    || a.event_id.localeCompare(b.event_id));
  base.evidence_event_ids = base.evidence.map((item) => item.event_id);
  base.candidate_ids = [...new Set([...base.candidate_ids, source.candidate_id])].sort();
  const field = source.source_type === "pending" ? "pending_ids" : "source_memory_ids";
  base[field] = [...new Set([...base[field], source.source_id])].sort();
  base.trip_ids = [...new Set(base.evidence.map((item) => item.trip_id).filter(Boolean))].sort();
  base.session_ids = [...new Set(base.evidence.map((item) => item.session_id).filter(Boolean))].sort();
  base.first_seen_at = base.evidence[0]?.occurred_at ?? base.first_seen_at;
  base.observation_deadline_at = new Date(Date.parse(base.first_seen_at)
    + policy.observation_days * 86_400_000).toISOString();
  base.last_seen_at = base.evidence.at(-1)?.occurred_at ?? now;
  base.updated_at = now;
  return base;
}
