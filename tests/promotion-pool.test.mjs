import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryEngine, createInMemoryMemoryRepository, createScriptedExtractor } from "../src/memory-engine/index.mjs";
import { canCollectPromotionSource, classifyAdmission, promotionPolicy } from "../src/memory-engine/promotion-policy.mjs";
import { promotionGroupIdentity } from "../src/memory-engine/promotion-groups.mjs";

const event = (id, tripId, occurredAt, payload = {}) => ({ schema_version: "1.0", event_id: id,
  event_type: "dialogue.user_statement", user_id: "usr_1", trip_id: tripId, occurred_at: occurredAt,
  recorded_at: occurredAt, source: { type: "user" }, payload, trace_id: `trace_${id}` });
const candidate = (id, eventId, confidence = 0.9, extra = {}) => ({ candidate_id: id,
  statement: { subject: "user", predicate: "prefers_travel_pace", value: "slow" },
  memory_tier: "short_term", memory_domain: "user", memory_kind: "semantic",
  scope: { domain: "travel", situations: [{ field: "trip_kind", value: "leisure_trip" }] },
  evidence_event_ids: [eventId], evidence_kind: "explicit_statement", confidence, salience: 0.8,
  retention: "current_trip", sensitivity: "normal", ...extra });

test("admission policy separates direct long-term, confirmation and non-promotable intentions", () => {
  const first = event("e1", "trip_1", "2026-01-01T00:00:00Z");
  assert.equal(promotionPolicy("prefers_travel_pace").min_distinct_trips, 2);
  assert.equal(promotionPolicy("current_trip_budget_intent").promotable, false);
  const longTerm = { ...candidate("lt", "e1"), memory_tier: "long_term", retention: "long_term_candidate" };
  assert.equal(classifyAdmission(longTerm, [first]).path, "direct_long_term");
  assert.equal(classifyAdmission({ ...longTerm, explicit_generalization: true }, [first]).path, "promotion_group");
  assert.equal(classifyAdmission({ ...longTerm, evidence_kind: "observed_behavior" }, [first]).path, "promotion_group");
  assert.equal(classifyAdmission({ ...longTerm,
    statement: { subject: "user", predicate: "health_constraint", value: "needs_rest" } }, [first]).path, "promotion_group");
  assert.equal(classifyAdmission({ ...longTerm, evidence_kind: "user_correction",
    statement: { subject: "user", predicate: "health_constraint", value: "needs_rest" } },
  [{ ...first, event_type: "feedback.user_corrected" }]).path, "direct_long_term");
});

test("an unconfirmed health constraint remains usable for this trip but does not enter long-term memory", async () => {
  const now = "2026-01-01T00:00:00Z";
  const health = { ...candidate("health", "e1"), memory_tier: "long_term", retention: "long_term_candidate",
    sensitivity: "sensitive", statement: { subject: "user", predicate: "health_constraint", value: "avoid_heat" },
    scope: { domain: "travel", topic: "health" } };
  const engine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    extractor: createScriptedExtractor({ e1: [health] }), clock: { now: () => now } });
  const result = await engine.observe([event("e1", "trip_1", now)],
    { permissions: ["memory:sensitive:write"] });
  assert.equal(result.memories[0].memory_tier, "short_term");
  assert.deepEqual(result.memories[0].scope.trips, ["trip_1"]);
  assert.equal(result.promotion_groups[0].status, "collecting");
});

test("a sensitive health proposal requires matching user confirmation and preserves provenance", async () => {
  let now = "2026-01-01T00:00:00Z";
  const repository = createInMemoryMemoryRepository();
  const health = (id, eventId) => candidate(id, eventId, 0.9, {
    memory_tier: "long_term", retention: "long_term_candidate", sensitivity: "normal",
    service_role: "hard_constraint", statement: { subject: "user", predicate: "health_constraint", value: "avoid_heat" },
    scope: { domain: "travel", topic: "health" }
  });
  const engine = createMemoryEngine({ repository, clock: { now: () => now },
    extractor: createScriptedExtractor({ e1: [health("h1", "e1")], e2: [health("h2", "e2")] }) });
  const permissions = ["memory:sensitive:write"];
  const e1 = event("e1", "t1", now, { trip_kind: "leisure_trip" });
  const rejected = await engine.observe([e1]);
  assert.equal(rejected.rejections[0].reason_code, "SENSITIVE_STORAGE_PERMISSION_REQUIRED");
  now = "2026-01-10T00:00:00Z";
  // A rejected event is immutable; use fresh evidence for the confirmation flow.
  const first = event("e1a", "t1", now, { trip_kind: "leisure_trip" });
  const second = event("e2", "t2", "2026-01-20T00:00:00Z", { trip_kind: "leisure_trip" });
  const activeEngine = createMemoryEngine({ repository, clock: { now: () => now },
    extractor: createScriptedExtractor({ e1a: [health("h1a", "e1a")], e2: [health("h2", "e2")] }) });
  await activeEngine.observe([first], { permissions });
  now = second.occurred_at;
  const proposed = await activeEngine.observe([second], { permissions });
  const group = proposed.promotion_groups[0];
  assert.equal(group.status, "needs_confirmation");
  assert.equal(group.sensitivity, "sensitive");
  assert.ok(group.proposal_id);
  const confirmation = { ...event("confirm", "t2", now), event_type: "feedback.user_confirmed",
    payload: { promotion_group_id: group.group_id, proposal_id: group.proposal_id } };
  const wrong = await activeEngine.observe([{ ...confirmation, event_id: "wrong",
    payload: { ...confirmation.payload, proposal_id: "wrong" } }], { permissions });
  assert.equal(wrong.memories.filter((item) => item.memory_tier === "long_term").length, 0);
  const result = await activeEngine.observe([confirmation], { permissions });
  const promoted = result.memories.find((item) => item.memory_tier === "long_term");
  assert.equal(promoted.sensitivity, "sensitive");
  assert.equal(promoted.service_role, "hard_constraint");
  assert.equal(promoted.evidence_event_ids.includes("confirm"), true);
  assert.equal(result.promotion_decisions[0].action, "promote");
  assert.equal(result.promotion_groups[0].confirmation.event_id, "confirm");
  const denied = await activeEngine.recall({ user_id: "usr_1", purpose: "decision" });
  assert.equal(denied.memories.some((item) => item.memory.memory_id === promoted.memory_id), false);
  await activeEngine.forget({ user_id: "usr_1", memory_id: "mem_h1a", permissions: ["memory:forget"] });
  assert.equal((await repository.snapshot()).observation_events.some((item) => item.event_id === "confirm"), false);
});

test("explicit future-wide claim enters a proposal even when marked long-term", async () => {
  const now = "2026-01-01T00:00:00Z";
  const repository = createInMemoryMemoryRepository();
  const broad = candidate("future", "future_event", 0.9, {
    memory_tier: "long_term", retention: "long_term_candidate", explicit_generalization: true,
    scope: { domain: "travel" }
  });
  const engine = createMemoryEngine({ repository, clock: { now: () => now },
    extractor: createScriptedExtractor({ future_event: [broad] }) });
  const first = await engine.observe([event("future_event", "t1", now, { trip_kind: "leisure_trip" })]);
  assert.equal(first.memories.filter((item) => item.memory_tier === "long_term").length, 0);
  assert.equal(first.promotion_groups[0].status, "needs_confirmation");
  assert.ok(first.promotion_groups[0].proposal_id);
  const group = first.promotion_groups[0];
  const confirmed = await engine.observe([{ ...event("future_confirm", "t1", now),
    event_type: "feedback.user_confirmed", payload: { promotion_group_id: group.group_id,
      proposal_id: group.proposal_id } }]);
  assert.equal(confirmed.promotion_decisions[0].action, "promote");
  assert.deepEqual(confirmed.memories.find((item) => item.memory_tier === "long_term").scope,
    { domain: "travel" });
});

test("group identity ignores trip and session but keeps subject, domain, kind and safe scope anchor", () => {
  const c1 = candidate("a", "e1");
  const c2 = candidate("b", "e2");
  const e1 = event("e1", "trip_1", "2026-01-01T00:00:00Z", { session_id: "s1" });
  const e2 = event("e2", "trip_2", "2026-01-10T00:00:00Z", { session_id: "s2" });
  assert.equal(promotionGroupIdentity("usr_1", c1, [e1]).group_id,
    promotionGroupIdentity("usr_1", c2, [e2]).group_id);
  assert.notEqual(promotionGroupIdentity("usr_1", c1, [e1]).group_id,
    promotionGroupIdentity("usr_1", { ...c2, memory_domain: "relational" }, [e2]).group_id);
  assert.notEqual(promotionGroupIdentity("usr_1", c1, [e1]).group_id,
    promotionGroupIdentity("usr_1", { ...c2, scope: { domain: "travel",
      situations: [{ field: "trip_kind", value: "business_trip" }] } }, [e2]).group_id);
  const unknownScope = { domain: "travel" };
  assert.notEqual(promotionGroupIdentity("usr_1", { ...c1, scope: unknownScope }, [e1]).group_id,
    promotionGroupIdentity("usr_1", { ...c2, scope: unknownScope }, [e2]).group_id);
});

test("entity-specific or ambiguous legacy scope is not collected as a general preference", () => {
  const e1 = event("e1", "trip_1", "2026-01-01T00:00:00Z");
  assert.equal(canCollectPromotionSource(candidate("exhibit", "e1", 0.9, {
    scope: { domain: "travel", applies_when: ["photo_exhibit_7"] }
  }), [e1]), false);
  assert.equal(canCollectPromotionSource(candidate("trip", "e1", 0.9, {
    scope: { domain: "travel", applies_when: ["trip_1"] }
  }), [e1]), true);
});

test("pending and active short-term evidence share one group without promoting or double counting an event", async () => {
  let now = "2026-01-01T00:00:00Z";
  const repository = createInMemoryMemoryRepository();
  const e1 = event("e1", "trip_1", now, { session_id: "s1" });
  const e2 = event("e2", "trip_2", "2026-01-10T00:00:00Z", { session_id: "s2" });
  const engine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    e1: [candidate("low", "e1", 0.4), candidate("low_duplicate", "e1", 0.4)],
    e2: [candidate("active", "e2")]
  }), clock: { now: () => now } });
  const first = await engine.observe([e1]);
  assert.equal(first.memories.length, 0);
  assert.equal(first.pending_candidates.length, 2);
  assert.equal(first.pending_candidates[0].pending_id, first.pending_candidates[1].pending_id);
  assert.equal(first.promotion_groups[0].evidence_event_ids.length, 1);
  now = e2.occurred_at;
  const second = await engine.observe([e2]);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.pending_candidates.length, 1);
  assert.equal(snapshot.promotion_groups.length, 1);
  assert.deepEqual(second.promotion_groups[0].trip_ids, ["trip_1", "trip_2"]);
  assert.deepEqual(second.promotion_groups[0].evidence_event_ids, ["e1", "e2"]);
  assert.equal(second.promotion_groups[0].status, "collecting");
  assert.equal(second.memories.filter((item) => item.memory_tier === "long_term").length, 0);
  assert.deepEqual(second.promotion_groups[0].source_memory_ids, ["mem_active"]);
});

test("candidate pool survives short-term expiry and expires through an independent sweep", async () => {
  let now = "2026-01-01T00:00:00Z";
  const repository = createInMemoryMemoryRepository();
  const e1 = event("e1", "trip_1", now);
  const engine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    e1: [candidate("active", "e1"), candidate("pending", "e1", 0.4)]
  }), clock: { now: () => now } });
  await engine.observe([e1]);
  await engine.observe([{ ...event("trip_end", "trip_1", now), event_type: "trip.ended" }]);
  assert.equal((await repository.snapshot()).promotion_groups[0].status, "collecting");
  now = "2026-04-05T00:00:00Z";
  const expired = await engine.expirePromotionGroups();
  assert.equal(expired.groups.length, 1);
  const decisions = await repository.listPromotionDecisions("usr_1", expired.groups[0].group_id);
  assert.equal(decisions.at(-1).action, "expire");
  assert.deepEqual(decisions.at(-1).reason_codes, ["OBSERVATION_WINDOW_EXPIRED"]);
  assert.equal(expired.pending.length, 1);
  assert.equal((await repository.snapshot()).promotion_groups[0].status, "expired");
  const freshEvent = event("e2", "trip_2", now);
  const restartedEngine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    e2: [candidate("new_pending", "e2", 0.4)]
  }), clock: { now: () => now } });
  const restarted = await restartedEngine.observe([freshEvent]);
  assert.equal(restarted.promotion_groups[0].generation, 2);
  assert.deepEqual(restarted.promotion_groups[0].evidence_event_ids, ["e2"]);
  assert.equal(restarted.promotion_groups[0].history[0].status, "expired");
});

test("forgetting a short-term source also removes its pending group and raw pending-only evidence", async () => {
  let now = "2026-01-01T00:00:00Z";
  const repository = createInMemoryMemoryRepository();
  const engine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    e1: [candidate("pending", "e1", 0.4)], e2: [candidate("active", "e2")]
  }), clock: { now: () => now } });
  await engine.observe([event("e1", "trip_1", now)]);
  now = "2026-01-10T00:00:00Z";
  await engine.observe([event("e2", "trip_2", now)]);
  const forgotten = await engine.forget({ user_id: "usr_1", memory_id: "mem_active",
    permissions: ["memory:forget"] });
  assert.deepEqual(forgotten.forgotten_memory_ids, ["mem_active"]);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.promotion_groups.length, 0);
  assert.equal(snapshot.pending_candidates.length, 0);
  assert.equal(snapshot.observation_events.length, 0);
});
