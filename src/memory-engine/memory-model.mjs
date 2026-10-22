import { normalizeScope } from "./conflict-semantics.mjs";
import { classifyAdmission } from "./promotion-policy.mjs";

const LEGACY_TYPE = {
  short_term: { memory_tier: "short_term", memory_domain: "user", memory_kind: "semantic" },
  semantic_preference: { memory_tier: "long_term", memory_domain: "user", memory_kind: "semantic" },
  episodic: { memory_tier: "long_term", memory_domain: "user", memory_kind: "episodic" },
  relationship: { memory_tier: "long_term", memory_domain: "relational", memory_kind: "semantic" },
  procedural: { memory_tier: "long_term", memory_domain: "relational", memory_kind: "procedural" }
};

const STATE_PREDICATES = /^(fatigue|time_pressure|interruption_tolerance|exploration_intent|companion_need|budget_pressure|data_freshness|current_(energy|mood|fatigue|location))$/;

export const clone = (value) => JSON.parse(JSON.stringify(value));

export function inferMemoryDimensions(candidate) {
  const legacy = LEGACY_TYPE[candidate.proposed_type] ?? {};
  const memoryTier = candidate.memory_tier
    ?? legacy.memory_tier
    ?? (candidate.retention === "current_trip" || candidate.retention === "short_lived" ? "short_term" : "long_term");
  const memoryDomain = candidate.memory_domain ?? legacy.memory_domain ?? "user";
  const memoryKind = candidate.memory_kind ?? legacy.memory_kind ?? "semantic";
  return { memory_tier: memoryTier, memory_domain: memoryDomain, memory_kind: memoryKind };
}

export function normalizeCandidate(candidate) {
  return { ...clone(candidate), ...inferMemoryDimensions(candidate), scope: normalizeScope(candidate.scope) };
}

export function normalizeMemory(memory) {
  if (memory.memory_tier && memory.memory_domain && memory.memory_kind) return clone(memory);
  const dimensions = inferMemoryDimensions({
    proposed_type: memory.memory_type,
    retention: memory.retention,
    memory_tier: memory.memory_tier,
    memory_domain: memory.memory_domain,
    memory_kind: memory.memory_kind
  });
  return { ...clone(memory), ...dimensions, version: memory.version ?? 1, lineage_id: memory.lineage_id ?? memory.memory_id };
}

export function routeCandidate(candidate, evidenceEvents = []) {
  const normalized = normalizeCandidate(candidate);
  // A trip-scoped retention request cannot become a cross-trip preference.
  if (normalized.retention === "current_trip") normalized.memory_tier = "short_term";
  const predicate = normalized.statement?.predicate ?? "";
  const admission = classifyAdmission(normalized, evidenceEvents);

  if (STATE_PREDICATES.test(predicate)) {
    return { disposition: "reject", reason_code: "STATE_BELONGS_TO_STATE_MODEL", candidate: normalized, admission };
  }
  if (normalized.confidence < 0.55) {
    return { disposition: "pending", reason_code: "LOW_CONFIDENCE", candidate: normalized, admission };
  }
  if (admission.path === "reject" || admission.reason_code === "DIRECT_LONG_TERM_NOT_ALLOWED") {
    return { disposition: "reject", reason_code: admission.reason_code, candidate: normalized, admission };
  }
  if (normalized.memory_tier === "long_term" && admission.reason_code === "LONG_TERM_CONFIRMATION_REQUIRED"
    && ["explicit_statement", "user_correction"].includes(normalized.evidence_kind)) {
    normalized.memory_tier = "short_term";
    normalized.retention = "current_trip";
    return { disposition: "store", reason_code: "TEMPORARY_CONSTRAINT_AWAITING_CONFIRMATION", candidate: normalized, admission };
  }
  if (normalized.memory_tier === "long_term" && admission.path !== "direct_long_term") {
    const reasonCode = normalized.evidence_kind === "inference" && normalized.evidence_event_ids.length < 2
      ? "LONG_TERM_INFERENCE_NEEDS_MORE_EVIDENCE" : admission.reason_code;
    return { disposition: "pending", reason_code: reasonCode, candidate: normalized, admission };
  }
  return { disposition: "store", reason_code: "ROUTED", candidate: normalized, admission };
}

export function legacyMemoryType(memory) {
  if (memory.memory_tier === "short_term") return "short_term";
  if (memory.memory_kind === "episodic") return "episodic";
  if (memory.memory_kind === "procedural") return "procedural";
  if (memory.memory_domain === "relational") return "relationship";
  return "semantic_preference";
}
