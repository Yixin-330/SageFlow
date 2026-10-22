import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryEngine, createInMemoryMemoryRepository, createScriptedExtractor } from "../src/memory-engine/index.mjs";
import { commonScope, decidePromotion } from "../src/memory-engine/promotion-decision.mjs";
import { promotionPolicy } from "../src/memory-engine/promotion-policy.mjs";

const date = (day) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
const event = (id, trip, day, kind = "leisure_trip", utterance = id) => ({ schema_version: "1.0",
  event_id: id, event_type: "dialogue.user_statement", user_id: "u1", trip_id: trip,
  occurred_at: date(day), recorded_at: date(day), trace_id: id, source: { type: "user" },
  payload: { trip_kind: kind, utterance_id: utterance } });
const candidate = (id, eventId, value = "slow", kind = "leisure_trip") => ({ candidate_id: id,
  statement: { subject: "user", predicate: "prefers_travel_pace", value }, memory_tier: "short_term",
  memory_domain: "user", memory_kind: "semantic", scope: { domain: "travel",
    situations: [{ field: "trip_kind", value: kind }] }, evidence_event_ids: [eventId],
  evidence_kind: "explicit_statement", confidence: 0.9, salience: 0.8,
  retention: "current_trip", sensitivity: "normal" });

test("common scope never invents a global preference from incompatible trip kinds", () => {
  const leisure = { domain: "travel", situations: [{ field: "trip_kind", value: "leisure_trip" }] };
  const business = { domain: "travel", situations: [{ field: "trip_kind", value: "business_trip" }] };
  assert.deepEqual(commonScope([leisure, leisure]), leisure);
  assert.equal(commonScope([leisure, business]), null);
  assert.equal(commonScope([{ domain: "travel", unresolved_trip_id: "t1" }]), null);
});

test("two independent trips promote only to their shared trip kind, with provenance and replay safety", async () => {
  let now = date(1);
  const repo = createInMemoryMemoryRepository();
  const e1 = event("e1", "t1", 1);
  const e2 = event("e2", "t2", 10);
  const engine = createMemoryEngine({ repository: repo, clock: { now: () => now },
    extractor: createScriptedExtractor({ e1: [candidate("c1", "e1")], e2: [candidate("c2", "e2")] }) });
  await engine.observe([e1]);
  now = date(10);
  const result = await engine.observe([e2]);
  assert.equal(result.promotion_decisions[0].action, "promote");
  const longTerm = result.memories.find((item) => item.memory_tier === "long_term");
  assert.deepEqual(longTerm.scope, { domain: "travel", situations: [{ field: "trip_kind", value: "leisure_trip" }] });
  assert.deepEqual(longTerm.evidence_trip_ids, ["t1", "t2"]);
  assert.equal(longTerm.confidence < 0.9, true);
  assert.deepEqual(longTerm.promoted_from.sort(), ["mem_c1", "mem_c2"]);
  assert.equal(result.memories.filter((item) => item.memory_tier === "short_term").length, 2);
  assert.equal(result.mutations.some((item) => item.operation === "PROMOTE"), true);
  assert.equal(result.relations.filter((item) => item.relation === "PROMOTED_FROM").length, 2);
  await engine.observe([e2]);
  assert.equal((await repo.snapshot()).promotion_results.length, 1);
  assert.equal((await repo.snapshot()).memories.filter((item) => item.memory_tier === "long_term").length, 1);
  const forgotten = await engine.forget({ user_id: "u1", memory_id: "mem_c1", permissions: ["memory:forget"] });
  assert.equal(forgotten.forgotten_memory_ids.includes(longTerm.memory_id), true);
  assert.equal((await repo.snapshot()).promotion_results.length, 0);
});

test("opposing evidence in the same scope blocks promotion after the full batch", async () => {
  const now = date(10);
  const repo = createInMemoryMemoryRepository();
  const engine = createMemoryEngine({ repository: repo, clock: { now: () => now }, extractor: createScriptedExtractor({
    e1: [candidate("c1", "e1")], e2: [candidate("c2", "e2")],
    e3: [candidate("c3", "e3", "fast")]
  }) });
  const result = await engine.observe([event("e1", "t1", 1), event("e2", "t2", 10), event("e3", "t3", 10)]);
  assert.equal(result.promotion_decisions.find((item) => item.action === "blocked_by_counter_evidence")?.reason_code,
    "UNRESOLVED_COUNTER_EVIDENCE");
  assert.equal(result.memories.filter((item) => item.memory_tier === "long_term").length, 0);
});

test("independence excludes same-trip repetition, duplicate utterances and low-confidence pending noise", () => {
  const policy = promotionPolicy("prefers_travel_pace");
  const scope = { domain: "travel", situations: [{ field: "trip_kind", value: "leisure_trip" }] };
  const group = { group_id: "pg1", generation: 1, policy_version: policy.policy_version,
    status: "collecting", observation_deadline_at: "2026-04-01T00:00:00Z",
    claim: { subject: "user", predicate: "prefers_travel_pace", value: "slow" },
    memory_domain: "user", memory_kind: "semantic", scope_anchor: scope,
    evidence: [
      { event_id: "e1", occurrence_id: "utt1", trip_id: "t1", occurred_at: date(1),
        evidence_kind: "explicit_statement", confidence: 0.9, source_scope: scope },
      { event_id: "e2", occurrence_id: "utt1", trip_id: "t1", occurred_at: date(10),
        evidence_kind: "explicit_statement", confidence: 0.9, source_scope: scope },
      { event_id: "e3", occurrence_id: "utt3", trip_id: "t2", occurred_at: date(10),
        evidence_kind: "explicit_statement", confidence: 0.4, source_scope: scope }
    ] };
  assert.equal(decidePromotion({ group, policy, now: date(10) }).reason_code, "INSUFFICIENT_DISTINCT_TRIPS");
});

test("an equivalent long-term memory is reinforced instead of duplicated", async () => {
  let now = date(1);
  const repo = createInMemoryMemoryRepository();
  const stable = { ...candidate("stable", "e0"), memory_tier: "long_term", retention: "long_term_candidate" };
  const engine = createMemoryEngine({ repository: repo, clock: { now: () => now },
    extractor: createScriptedExtractor({ e0: [stable], e1: [candidate("c1", "e1")],
      e2: [candidate("c2", "e2")] }) });
  await engine.observe([event("e0", "t0", 1)]);
  await engine.observe([event("e1", "t1", 1)]);
  now = date(10);
  const result = await engine.observe([event("e2", "t2", 10)]);
  assert.equal(result.promotion_decisions[0].reason_code, "REINFORCE_EXISTING_LONG_TERM");
  assert.equal(result.memories.filter((item) => item.memory_tier === "long_term").length, 1);
  assert.deepEqual(result.memories.find((item) => item.memory_tier === "long_term").evidence_trip_ids, ["t1", "t2"]);
});
