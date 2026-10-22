import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryMemoryRepository, createMemoryEngine, createScriptedExtractor, createDeterministicExtractor } from "../src/memory-engine/index.mjs";
import { evaluateScope } from "../src/memory-engine/scope.mjs";

const firstNow = "2026-10-17T12:00:00+08:00";
const event = (id, eventType = "dialogue.user_statement", payload = {}) => ({
  schema_version: "1.0", event_id: id, event_type: eventType, user_id: "usr_1", trip_id: "trip_hz",
  occurred_at: firstNow, recorded_at: firstNow, source: { type: "user" }, payload, trace_id: `trace_${id}`
});
const candidate = (id, retention = "current_trip", extra = {}) => ({
  candidate_id: id, statement: { subject: "user", predicate: "current_trip_budget_intent", value: "avoid_expensive" },
  memory_tier: "short_term", memory_domain: "user", memory_kind: "semantic",
  scope: { domain: "travel", topic: "activity_budget" }, evidence_event_ids: [`evt_${id}`],
  evidence_kind: "explicit_statement", confidence: 0.9, salience: 0.8, retention, sensitivity: "normal", ...extra
});

test("structured and legacy scopes fail closed when the required context is missing", () => {
  assert.equal(evaluateScope({ situations: [{ field: "trip_kind", value: "business_trip" }] }, {}, firstNow).reason_code, "SCOPE_UNRESOLVED");
  assert.equal(evaluateScope({ applies_when: ["business_trip"] }, {}, firstNow).reason_code, "SCOPE_UNRESOLVED");
  assert.equal(evaluateScope({ trips: ["trip_hz"] }, { trip_id: "trip_other" }, firstNow).reason_code, "OUT_OF_SCOPE");
  assert.equal(evaluateScope({ trips: ["trip_hz"], entities: ["exhibit_1"] }, { trip_id: "trip_hz" }, firstNow).reason_code, "SCOPE_UNRESOLVED");
  assert.equal(evaluateScope({ trips: ["trip_hz"], entities: ["exhibit_1"] }, { trip_id: "trip_hz", entity_id: "exhibit_1" }, firstNow).allowed, true);
});

test("short-term memory has a hard expiry and an ended trip emits an auditable EXPIRE", async () => {
  let current = firstNow;
  const repository = createInMemoryMemoryRepository();
  const memoryEngine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    evt_budget: [candidate("budget", "current_trip", { evidence_event_ids: ["evt_budget"] })]
  }), clock: { now: () => current } });
  const observed = await memoryEngine.observe([event("evt_budget", "dialogue.user_statement", { trip_ends_at: "2026-10-18T18:00:00+08:00" })]);
  assert.equal(observed.memories[0].expires_at, "2026-10-19T10:00:00.000Z");
  const during = await memoryEngine.recall({ user_id: "usr_1", trip_id: "trip_hz", purpose: "decision", topics: ["activity_budget"] });
  assert.equal(during.memories.length, 1);
  await memoryEngine.observe([event("evt_end", "trip.ended")]);
  const afterEnd = await memoryEngine.recall({ user_id: "usr_1", trip_id: "trip_hz", purpose: "decision", topics: ["activity_budget"] });
  assert.equal(afterEnd.memories.length, 0);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.memories[0].status, "expired");
  assert.equal(snapshot.mutations.at(-1).operation, "EXPIRE");
  assert.deepEqual(snapshot.mutations.at(-1).evidence_event_ids, ["evt_end"]);
  current = "2026-10-20T12:00:00+08:00";
  assert.equal((await memoryEngine.recall({ user_id: "usr_1", trip_id: "trip_hz", purpose: "decision" })).memories.length, 0);
});

test("ending a trip closes conflicts involving its expired short-term memories", async () => {
  const repository = createInMemoryMemoryRepository();
  const pace = (id, value) => candidate(id, "current_trip", {
    evidence_event_ids: [`evt_${id}`], statement: { subject: "user", predicate: "current_trip_pace", value }
  });
  const memoryEngine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    evt_slow: [pace("slow", "slow")], evt_fast: [pace("fast", "fast")]
  }), clock: { now: () => firstNow } });
  await memoryEngine.observe([event("evt_slow")]);
  const conflicted = await memoryEngine.observe([event("evt_fast")]);
  assert.equal(conflicted.conflicts.length, 1);
  const ended = await memoryEngine.observe([event("evt_end_conflict", "trip.ended")]);
  assert.equal(ended.conflicts.length, 0);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.conflicts[0].status, "resolved");
  assert.equal(snapshot.conflicts[0].resolution_reason, "EXPIRED");
});

test("short_lived candidates require an explicit future deadline", async () => {
  const repository = createInMemoryMemoryRepository();
  const memoryEngine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    evt_short: [candidate("short", "short_lived", { evidence_event_ids: ["evt_short"] })]
  }), clock: { now: () => firstNow } });
  const result = await memoryEngine.observe([event("evt_short")]);
  assert.equal(result.memories.length, 0);
  assert.equal(result.rejections[0].reason_code, "SHORT_TERM_EXPIRY_REQUIRED");
});

test("explicit short-lived expiry prevents recall even without a trip-end event", async () => {
  let current = firstNow;
  const repository = createInMemoryMemoryRepository();
  const memoryEngine = createMemoryEngine({ repository, extractor: createScriptedExtractor({
    evt_lunch: [candidate("lunch", "short_lived", { evidence_event_ids: ["evt_lunch"],
      expires_at: "2026-10-17T13:00:00+08:00" })]
  }), clock: { now: () => current } });
  const observed = await memoryEngine.observe([event("evt_lunch")]);
  assert.equal(observed.memories.length, 1);
  current = "2026-10-17T13:00:00+08:00";
  const recall = await memoryEngine.recall({ user_id: "usr_1", purpose: "decision", topics: ["activity_budget"] });
  assert.equal(recall.memories.length, 0);
  assert.ok(recall.omitted.some((item) => item.reason_code === "EXPIRED"));
});

test("today's walking intention expires at the local day boundary rather than the trip boundary", async () => {
  let current = firstNow;
  const memoryEngine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    extractor: createDeterministicExtractor(), clock: { now: () => current } });
  const observed = await memoryEngine.observe([event("evt_today", "dialogue.user_statement", { utterance: "我今天状态很好，想多走走。" })]);
  assert.equal(observed.memories.length, 1);
  assert.equal(observed.memories[0].scope.time_window.end, "2026-10-17T23:59:59+08:00");
  current = "2026-10-18T00:00:00+08:00";
  const recall = await memoryEngine.recall({ user_id: "usr_1", trip_id: "trip_hz", purpose: "decision", topics: ["travel_pacing"] });
  assert.equal(recall.memories.length, 0);
  assert.ok(recall.omitted.some((item) => item.reason_code === "EXPIRED"));
});

test("state requires TTL, matching identity, evidence and sensitive read permission", async () => {
  const memoryEngine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    extractor: createScriptedExtractor(), clock: { now: () => firstNow } });
  const state = { state_id: "state_1", user_id: "usr_1", trip_id: "trip_hz", observed_at: firstNow,
    expires_at: "2026-10-17T13:00:00+08:00", model_version: "test",
    dimensions: { fatigue: { value: "high", confidence: 0.9, evidence_ids: ["evt_steps"] } } };
  const recall = (current_state, permissions = []) => memoryEngine.recall({ user_id: "usr_1", trip_id: "trip_hz",
    purpose: "decision", current_state, permissions });
  assert.equal((await recall({ ...state, expires_at: undefined })).trace.state_status, "INVALID_STATE");
  assert.equal((await recall({ ...state, user_id: "usr_2" })).trace.state_status, "STATE_SCOPE_MISMATCH");
  assert.equal((await recall({ ...state, dimensions: { fatigue: { value: "high", confidence: 0.9, evidence_ids: [] } } })).trace.state_status, "STATE_EVIDENCE_REQUIRED");
  assert.equal((await recall({ ...state, sensitivity: "sensitive" })).trace.state_status, "STATE_SENSITIVE_PERMISSION_REQUIRED");
  assert.equal((await recall({ ...state, sensitivity: "sensitive" }, ["state:sensitive:read"])).trace.state_status, "ACCEPTED");
});

test("an unresolved mandatory constraint makes the decision context incomplete", async () => {
  const health = {
    memory_id: "mem_health_scope", user_id: "usr_1", memory_tier: "long_term",
    memory_domain: "user", memory_kind: "semantic",
    statement: { subject: "user", predicate: "health_constraint", value: "avoid_heat" },
    scope: { domain: "travel", situations: [{ field: "health_profile", value: "heat_sensitive" }] },
    confidence: 0.95, salience: 0.9, evidence_event_ids: ["hist_health"],
    valid_from: "2026-01-01T00:00:00+08:00", last_confirmed_at: "2026-10-01T00:00:00+08:00",
    status: "active", sensitivity: "normal", version: 1, lineage_id: "mem_health_scope"
  };
  const memoryEngine = createMemoryEngine({ repository: createInMemoryMemoryRepository([health]),
    extractor: createScriptedExtractor(), clock: { now: () => firstNow } });
  const recall = await memoryEngine.recall({ user_id: "usr_1", trip_id: "trip_hz", purpose: "decision",
    situation: { weather: "rain" } });

  assert.equal(recall.memories.length, 0);
  assert.equal(recall.trace.context_complete, false);
  assert.equal(recall.trace.unavailable_mandatory_count, 1);
  assert.equal(recall.trace.unavailable_mandatory[0].memory_id, "mem_health_scope");
  assert.equal(recall.trace.unavailable_mandatory[0].reason_code, "SCOPE_UNRESOLVED");
});

test("a sensitive mandatory constraint without read permission also blocks the decision context", async () => {
  const health = {
    memory_id: "mem_health_sensitive", user_id: "usr_1", memory_tier: "long_term",
    memory_domain: "user", memory_kind: "semantic",
    statement: { subject: "user", predicate: "health_constraint", value: "needs_rest" },
    scope: { domain: "travel" }, confidence: 0.95, salience: 0.9,
    evidence_event_ids: ["hist_health_sensitive"], valid_from: "2026-01-01T00:00:00+08:00",
    last_confirmed_at: "2026-10-01T00:00:00+08:00", status: "active",
    sensitivity: "sensitive", version: 1, lineage_id: "mem_health_sensitive"
  };
  const memoryEngine = createMemoryEngine({ repository: createInMemoryMemoryRepository([health]),
    extractor: createScriptedExtractor(), clock: { now: () => firstNow } });
  const recall = await memoryEngine.recall({ user_id: "usr_1", trip_id: "trip_hz", purpose: "decision" });

  assert.equal(recall.memories.length, 0);
  assert.equal(recall.trace.context_complete, false);
  assert.equal(recall.trace.unavailable_mandatory_count, 1);
  assert.equal(recall.trace.unavailable_mandatory[0].reason_code, "SENSITIVE_RECALL_PERMISSION_REQUIRED");
  assert.equal(recall.trace.unavailable_mandatory[0].memory_id, undefined);
});

test("reinforcing a current-trip memory never extends it past the trip boundary", async () => {
  let current = firstNow;
  const memoryEngine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    extractor: createScriptedExtractor({
      evt_budget: [candidate("budget", "current_trip", { evidence_event_ids: ["evt_budget"] })],
      evt_budget_again: [candidate("budget_again", "current_trip", { evidence_event_ids: ["evt_budget_again"] })]
    }), clock: { now: () => current } });
  const first = await memoryEngine.observe([event("evt_budget", "dialogue.user_statement",
    { trip_ends_at: "2026-10-18T18:00:00+08:00" })]);
  const firstExpiry = first.memories[0].expires_at;
  current = "2026-10-18T12:00:00+08:00";
  const reinforced = await memoryEngine.observe([event("evt_budget_again")]);

  assert.equal(reinforced.mutations[0].operation, "REINFORCE");
  assert.equal(reinforced.memories[0].expires_at, firstExpiry);
});

test("a time-expired short-term memory is not matched by new evidence", async () => {
  let current = firstNow;
  const memoryEngine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    extractor: createScriptedExtractor({
      evt_lunch: [candidate("lunch", "short_lived", { evidence_event_ids: ["evt_lunch"],
        expires_at: "2026-10-17T13:00:00+08:00" })],
      evt_lunch_again: [candidate("lunch_again", "short_lived", { evidence_event_ids: ["evt_lunch_again"],
        expires_at: "2026-10-17T15:00:00+08:00" })]
    }), clock: { now: () => current } });
  await memoryEngine.observe([event("evt_lunch")]);
  current = "2026-10-17T14:00:00+08:00";
  const result = await memoryEngine.observe([event("evt_lunch_again")]);

  assert.equal(result.mutations[0].operation, "CREATE");
  assert.equal(result.mutations.some((item) => item.operation === "REINFORCE"), false);
  assert.equal(result.memories.find((item) => item.memory_id === "mem_lunch_again").status, "active");
});
