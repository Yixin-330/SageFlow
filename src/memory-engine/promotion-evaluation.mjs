import { createMemoryEngine } from "./memory-engine.mjs";
import { createInMemoryMemoryRepository } from "./adapters/in-memory-repository.mjs";
import { createScriptedExtractor } from "./adapters/scripted-extractor.mjs";
import { promotionPolicy } from "./promotion-policy.mjs";

const ratio = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const dayAt = (day) => new Date(Date.parse("2026-01-01T00:00:00Z") + (day - 1) * 86_400_000).toISOString();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function candidateFor(caseId, observation, suffix = "") {
  const predicate = observation.predicate ?? "prefers_travel_pace";
  return {
    candidate_id: `${caseId}_${observation.id}${suffix}`,
    statement: { subject: "user", predicate, value: observation.value },
    memory_tier: observation.memory_tier ?? "short_term", memory_domain: "user", memory_kind: "semantic",
    scope: { domain: "travel", ...(observation.trip_kind
      ? { situations: [{ field: "trip_kind", value: observation.trip_kind }] } : {}),
    ...(observation.entity ? { entities: [observation.entity] } : {}) },
    evidence_event_ids: [observation.id], evidence_kind: observation.evidence_kind ?? "explicit_statement",
    confidence: observation.confidence ?? 0.9, salience: 0.8,
    retention: observation.retention ?? "current_trip", sensitivity: observation.sensitivity ?? "normal",
    ...(observation.explicit_generalization ? { explicit_generalization: true } : {})
  };
}

function eventFor(observation) {
  return { schema_version: "1.0", event_id: observation.id,
    event_type: observation.event_type ?? "dialogue.user_statement", user_id: "promotion_eval_user",
    trip_id: observation.trip, occurred_at: dayAt(observation.day), recorded_at: dayAt(observation.day),
    trace_id: `promotion_eval_${observation.id}`, source: { type: "user" },
    payload: { ...(observation.trip_kind ? { trip_kind: observation.trip_kind } : {}),
      utterance_id: observation.utterance ?? observation.id } };
}

async function runCase(spec) {
  let now = dayAt(1);
  const extractorScript = {};
  for (const item of spec.observations) if (item.event_type !== "trip.ended") {
    extractorScript[item.id] = Array.from({ length: item.duplicate_candidates ?? 1 }, (_, index) =>
      candidateFor(spec.id, item, index ? `_duplicate_${index}` : ""));
  }
  const repository = createInMemoryMemoryRepository();
  const engine = createMemoryEngine({ repository, extractor: createScriptedExtractor(extractorScript),
    clock: { now: () => now } });
  const batches = new Map();
  spec.observations.forEach((item, index) => {
    const key = item.batch ?? `single_${index}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(eventFor(item));
  });
  const decisions = [];
  for (const batch of batches.values()) {
    now = batch[0].occurred_at;
    const result = await engine.observe(batch, { permissions: ["memory:sensitive:write"] });
    decisions.push(...result.promotion_decisions);
  }
  if (spec.replay_last_batch) {
    const last = [...batches.values()].at(-1);
    now = last[0].occurred_at;
    const replay = await engine.observe(last, { permissions: ["memory:sensitive:write"] });
    decisions.push(...replay.promotion_decisions);
  }
  if (spec.sweep_at_day) {
    now = dayAt(spec.sweep_at_day);
    await engine.expirePromotionGroups({ now });
  }
  const snapshot = await repository.snapshot();
  const promotions = snapshot.mutations.filter((item) => item.operation === "PROMOTE");
  const promotionIds = new Set(promotions.map((item) => item.target_memory_id));
  const promotedMemories = snapshot.memories.filter((item) => promotionIds.has(item.memory_id));
  const lastPromoted = promotedMemories.at(-1);
  const actual = {
    promote: promotions.length > 0, promotion_count: promotions.length,
    long_term_count: snapshot.memories.filter((item) => item.memory_tier === "long_term").length,
    scope: lastPromoted?.generalized_scope ?? lastPromoted?.scope ?? null,
    reason_codes: decisions.map((item) => item.reason_code),
    expired_groups: snapshot.promotion_groups.filter((item) => item.status === "expired").length,
    corrected_after_promotion: promotedMemories.some((item) => item.status === "superseded")
      || snapshot.conflicts.some((item) => item.memory_ids.some((id) => promotionIds.has(id))),
    duplicate_promotions: Math.max(0, promotions.length
      - new Set(promotions.map((item) => item.promotion_group_id)).size),
    idempotency_violations: Math.abs(promotions.length - snapshot.promotion_results.length)
  };
  const failures = [];
  for (const [field, expected] of Object.entries(spec.expected)) {
    if (field === "reason_code") {
      if (!actual.reason_codes.includes(expected)) failures.push(`reason_code:${expected}`);
    } else if (!same(actual[field], expected)) failures.push(`${field}:expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual[field])}`);
  }
  if (actual.duplicate_promotions) failures.push("duplicate_promotions");
  if (actual.idempotency_violations) failures.push("idempotency_violation");
  if (actual.promote && promotions.length !== 1) failures.push("promotion_count_not_one");
  const provenance = promotions.map((item) => {
    const memory = snapshot.memories.find((entry) => entry.memory_id === item.target_memory_id);
    const group = snapshot.promotion_groups.find((entry) => entry.group_id === item.promotion_group_id);
    const policy = promotionPolicy(group?.claim.predicate);
    const edges = snapshot.edges.filter((edge) => edge.relation === "PROMOTED_FROM"
      && edge.source_id === memory?.memory_id);
    return Boolean(memory && group && memory.evidence_event_ids?.length >= policy.min_distinct_trips
      && memory.evidence_trip_ids?.length >= policy.min_distinct_trips
      && (memory.promoted_from ?? []).every((id) => edges.some((edge) => edge.target_id === id))
      && snapshot.promotion_results.some((result) => result.promotion_key === item.promotion_id
        && result.memory_id === memory.memory_id));
  });
  if (provenance.some((value) => !value)) failures.push("provenance_incomplete");
  const first = spec.observations.find((item) => item.predicate || item.value !== undefined);
  return { id: spec.id, predicate: first?.predicate ?? "prefers_travel_pace",
    risk_tier: promotionPolicy(first?.predicate ?? "prefers_travel_pace").risk_tier,
    expected: spec.expected, actual, passed: failures.length === 0, failures,
    provenance, groups: snapshot.promotion_groups, promotions, pending: snapshot.pending_candidates,
    review_item: { case_id: spec.id, observations: spec.observations.map((item) => ({
      event_id: item.id, day: item.day, trip_id: item.trip, trip_kind: item.trip_kind ?? null,
      predicate: item.predicate ?? "prefers_travel_pace", value: item.value ?? null,
      confidence: item.confidence ?? 0.9, event_type: item.event_type ?? "dialogue.user_statement" })),
      automatic_decision: actual.promote ? "promote" : actual.reason_codes.at(-1) ?? "wait",
      proposed_scope: actual.scope, review_fields: ["should_promote", "scope_correct", "provenance_correct"] } };
}

export function evaluatePromotionHumanReviews(cases, annotations = []) {
  const ids = new Set(cases.map((item) => item.id));
  const byCase = new Map();
  for (const item of annotations) {
    if (!ids.has(item.case_id) || !item.reviewer_id
      || ["should_promote", "scope_correct", "provenance_correct"].some((key) => typeof item[key] !== "boolean")) {
      throw new Error(`Invalid promotion review: ${item.case_id ?? "unknown"}`);
    }
    const reviews = byCase.get(item.case_id) ?? new Map();
    if (reviews.has(item.reviewer_id)) throw new Error(`Duplicate reviewer: ${item.case_id}/${item.reviewer_id}`);
    reviews.set(item.reviewer_id, item);
    byCase.set(item.case_id, reviews);
  }
  const paired = [...byCase].filter(([, reviews]) => reviews.size >= 2);
  const disagreements = paired.filter(([, reviews]) => {
    const entries = [...reviews.values()];
    return ["should_promote", "scope_correct", "provenance_correct"].some((key) =>
      entries.some((item) => item[key] !== entries[0][key]));
  }).map(([caseId]) => caseId);
  const reviewFindings = paired.filter(([caseId, reviews]) => !disagreements.includes(caseId)
    && [...reviews.values()].some((item) => !item.scope_correct || !item.provenance_correct
      || item.should_promote !== cases.find((entry) => entry.id === caseId).actual.promote))
    .map(([caseId]) => caseId);
  return { status: paired.length === cases.length
    ? disagreements.length ? "needs_adjudication" : reviewFindings.length ? "review_findings"
      : "dual_review_complete" : "needs_review",
  paired: paired.length, total: cases.length, coverage: ratio(paired.length, cases.length),
  disagreements, review_findings: reviewFindings };
}

export async function runPromotionGate(suite, annotations = []) {
  if (!suite?.cases?.length) throw new Error("Promotion evaluation requires nonempty cases");
  if (new Set(suite.cases.map((item) => item.id)).size !== suite.cases.length) {
    throw new Error("Promotion evaluation case IDs must be unique");
  }
  const cases = [];
  for (const spec of suite.cases) cases.push(await runCase(spec));
  const positives = cases.filter((item) => item.expected.promote === true);
  const negatives = cases.filter((item) => item.expected.promote === false);
  const falsePromotions = negatives.filter((item) => item.actual.promote);
  const missedPromotions = positives.filter((item) => !item.actual.promote);
  const byRisk = Object.fromEntries([...new Set(cases.map((item) => item.risk_tier))].map((risk) => {
    const subset = negatives.filter((item) => item.risk_tier === risk);
    return [risk, { false_promotion_rate: ratio(subset.filter((item) => item.actual.promote).length, subset.length),
      negative_cases: subset.length }];
  }));
  const byPredicate = Object.fromEntries([...new Set(cases.map((item) => item.predicate))].map((predicate) => {
    const subset = negatives.filter((item) => item.predicate === predicate);
    return [predicate, { false_promotion_rate: ratio(subset.filter((item) => item.actual.promote).length, subset.length),
      negative_cases: subset.length }];
  }));
  const allPromotions = cases.flatMap((item) => item.promotions);
  const allPending = cases.flatMap((item) => item.pending);
  const allProvenance = cases.flatMap((item) => item.provenance);
  const dwell = cases.flatMap((item) => item.groups).filter((item) => ["promoted", "expired"].includes(item.status))
    .map((item) => (Date.parse(item.promoted_at ?? item.expired_at) - Date.parse(item.first_seen_at)) / 86_400_000)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const metrics = {
    false_promotion_rate: ratio(falsePromotions.length, negatives.length),
    missed_promotion_rate: ratio(missedPromotions.length, positives.length),
    false_promotion_by_risk: byRisk, false_promotion_by_predicate: byPredicate,
    pending_expiry_rate: ratio(allPending.filter((item) => item.status === "expired").length,
      allPending.length),
    mean_candidate_dwell_days: dwell.length ? Number((dwell.reduce((sum, value) => sum + value, 0) / dwell.length).toFixed(2)) : null,
    post_promotion_correction_conflict_rate: ratio(cases.filter((item) => item.actual.promote
      && item.actual.corrected_after_promotion).length, cases.filter((item) => item.actual.promote).length),
    duplicate_promotion_count: cases.reduce((sum, item) => sum + item.actual.duplicate_promotions, 0),
    idempotency_violation_count: cases.reduce((sum, item) => sum + item.actual.idempotency_violations, 0),
    provenance_coverage: ratio(allProvenance.filter(Boolean).length, allPromotions.length),
    scope_accuracy: ratio(positives.filter((item) => item.expected.scope)
      .filter((item) => same(item.actual.scope, item.expected.scope)).length,
    positives.filter((item) => item.expected.scope).length),
    sample_sizes: { cases: cases.length, positives: positives.length, negatives: negatives.length,
      promotions: allPromotions.length, pending: allPending.length,
      scope_labeled: positives.filter((item) => item.expected.scope).length }
  };
  const thresholds = suite.thresholds;
  const checks = {
    scenario_expectations: cases.every((item) => item.passed),
    false_promotion_low: byRisk.low?.negative_cases > 0
      && byRisk.low.false_promotion_rate <= thresholds.max_false_promotion_rate_low,
    false_promotion_high: byRisk.high?.negative_cases > 0
      && byRisk.high.false_promotion_rate <= thresholds.max_false_promotion_rate_high,
    missed_promotion: positives.length > 0 && metrics.missed_promotion_rate <= thresholds.max_missed_promotion_rate,
    duplicate_promotion: metrics.duplicate_promotion_count <= thresholds.max_duplicate_promotions
      && metrics.idempotency_violation_count === 0,
    provenance: metrics.provenance_coverage >= thresholds.min_provenance_coverage,
    scope: metrics.scope_accuracy >= thresholds.min_scope_accuracy
  };
  const human = evaluatePromotionHumanReviews(cases, annotations);
  return { scope: "deterministic_promotion_prototype", deterministic_pass: Object.values(checks).every(Boolean),
    pilot_ready: false, checks, metrics, human, cases: cases.map(({ groups, promotions, pending, ...item }) => item),
    human_review_queue: cases.map((item) => item.review_item),
    pilot_blockers: [
      ...(human.status === "dual_review_complete" ? [] : ["PROMOTION_HUMAN_SCOPE_REVIEW_INCOMPLETE"]),
      "REAL_POSTGRES_CONCURRENCY_NOT_VERIFIED", "REAL_USER_OUTCOMES_NOT_MEASURED"
    ] };
}
