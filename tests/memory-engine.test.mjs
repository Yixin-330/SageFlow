import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryEngine,
  createInMemoryMemoryRepository,
  createScriptedExtractor
} from "../src/memory-engine/index.mjs";

const fixedNow = "2026-08-25T14:20:00+08:00";
const clock = { now: () => fixedNow };

function event(id, type = "dialogue.user_statement", payload = {}) {
  return {
    schema_version: "1.0",
    event_id: id,
    event_type: type,
    user_id: "usr_001",
    trip_id: "trip_hangzhou_001",
    occurred_at: fixedNow,
    recorded_at: fixedNow,
    source: { type: "user" },
    payload,
    trace_id: `trace_${id}`
  };
}

function candidate(id, value, overrides = {}) {
  return {
    candidate_id: id,
    statement: { subject: "user", predicate: "prefers_travel_pace", value },
    proposed_type: "semantic_preference",
    scope: { domain: "travel", applies_when: ["leisure_trip"], topic: "travel_pacing" },
    evidence_event_ids: [overrides.eventId ?? `evt_${id}`],
    evidence_kind: "explicit_statement",
    confidence: 0.84,
    salience: 0.8,
    retention: "long_term_candidate",
    sensitivity: "normal",
    ...overrides
  };
}

function engineWith(script, seed = []) {
  return createMemoryEngine({
    repository: createInMemoryMemoryRepository(seed),
    extractor: createScriptedExtractor(script),
    clock
  });
}

test("observe creates an evidence-bearing memory from an explicit stable preference", async () => {
  const c = candidate("slow", "slow", { eventId: "evt_slow" });
  const engine = engineWith({ evt_slow: [c] });

  const result = await engine.observe([event("evt_slow")]);

  assert.equal(result.mutations[0].operation, "CREATE");
  assert.equal(result.memories[0].statement.value, "slow");
  assert.deepEqual(result.memories[0].evidence_event_ids, ["evt_slow"]);
  assert.equal(result.memories[0].status, "active");
});

test("a registered numeric predicate rejects a string value instead of silently storing it", async () => {
  const c = candidate("budget_string", "150", {
    eventId: "evt_budget_string",
    statement: { subject: "user", predicate: "comfortable_activity_budget_cny", value: "150" }
  });
  const result = await engineWith({ evt_budget_string: [c] }).observe([event("evt_budget_string")]);
  assert.equal(result.memories.length, 0);
  assert.equal(result.rejections[0].reason_code, "PREDICATE_VALUE_TYPE_MISMATCH");
});

test("action feedback links to recalled memories without rewriting a long-term preference", async () => {
  const repository = createInMemoryMemoryRepository();
  const engine = createMemoryEngine({ repository,
    extractor: createScriptedExtractor({ evt_pace: [candidate("pace", "slow", { eventId: "evt_pace" })] }), clock });
  await engine.observe([event("evt_pace")]);
  const recall = await engine.recall({ user_id: "usr_001", trip_id: "trip_hangzhou_001",
    purpose: "decision", predicates: ["prefers_travel_pace"], situation: { trip_kind: "leisure_trip" }, limit: 5 });
  const feedback = event("evt_accepted", "feedback.action_accepted", { recall_trace_id: recall.trace_id, decision_id: "dec_1" });
  const observed = await engine.observe([feedback]);
  assert.equal(observed.mutations[0].operation, "NO_LONG_TERM_CHANGE");
  assert.deepEqual(observed.mutations[0].supported_memory_ids, ["mem_pace"]);
  assert.equal(observed.memories.find((item) => item.memory_id === "mem_pace").confidence, 0.84);
  assert.ok((await repository.snapshot()).edges.some((item) => item.relation === "RECALLED_BEFORE_FEEDBACK"
    && item.source_id === "mem_pace" && item.target_id === "evt_accepted"));
  const foreign = await engine.observe([event("evt_bad_feedback", "feedback.action_ignored", { recall_trace_id: "missing" })]);
  assert.equal(foreign.rejections[0].reason_code, "RECALL_TRACE_NOT_FOUND");
});

test("action feedback alone cannot be promoted into a preference candidate", async () => {
  const attempted = candidate("from_acceptance", "fast", { eventId: "evt_acceptance" });
  const result = await engineWith({ evt_acceptance: [attempted] })
    .observe([event("evt_acceptance", "feedback.action_accepted", { decision_id: "dec_1" })]);
  assert.equal(result.memories.length, 0);
  assert.ok(result.rejections.some((item) => item.reason_code === "ACTION_FEEDBACK_NOT_PREFERENCE_EVIDENCE"));
});

test("explicit forgetting removes memory, evidence, graph, recall log and retains only a tombstone", async () => {
  const repository = createInMemoryMemoryRepository();
  const engine = createMemoryEngine({ repository,
    extractor: createScriptedExtractor({ evt_forget: [candidate("forget", "slow", { eventId: "evt_forget" })] }), clock });
  await engine.observe([event("evt_forget")]);
  await engine.recall({ user_id: "usr_001", purpose: "decision", predicates: ["prefers_travel_pace"],
    situation: { trip_kind: "leisure_trip" }, limit: 5 });
  await assert.rejects(engine.forget({ user_id: "usr_001", memory_id: "mem_forget" }), /permission/);
  const result = await engine.forget({ user_id: "usr_001", memory_id: "mem_forget", permissions: ["memory:forget"] });
  assert.deepEqual(result.forgotten_memory_ids, ["mem_forget"]);
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.memories.length, 0);
  assert.equal(snapshot.observation_events.length, 0);
  assert.equal(snapshot.edges.length, 0);
  assert.equal(snapshot.recall_logs.length, 0);
  assert.deepEqual(snapshot.tombstones.map((item) => item.memory_id), ["mem_forget"]);
  assert.equal(snapshot.mutations.at(-1).operation, "FORGET");
  const replay = await engine.observe([event("evt_forget")]);
  assert.equal(replay.rejections[0].reason_code, "FORGOTTEN_MEMORY_TOMBSTONE");
  assert.equal((await repository.snapshot()).memories.length, 0);
});

test("forget refuses partial deletion when another memory shares raw evidence", async () => {
  const c1 = candidate("shared_a", "slow", { eventId: "evt_shared" });
  const c2 = candidate("shared_b", "fast", { eventId: "evt_shared",
    statement: { subject: "user", predicate: "prefers_activity_load", value: "light" } });
  const repository = createInMemoryMemoryRepository();
  const engine = createMemoryEngine({ repository,
    extractor: createScriptedExtractor({ evt_shared: [c1, c2] }), clock });
  await engine.observe([event("evt_shared")]);
  await assert.rejects(engine.forget({ user_id: "usr_001", memory_id: "mem_shared_a",
    permissions: ["memory:forget"] }), /Shared evidence/);
  assert.equal((await repository.snapshot()).memories.length, 2);
});

test("a current-trip intention coexists with a different long-term preference", async () => {
  const seed = [{
    memory_id: "mem_slow",
    memory_type: "semantic_preference",
    user_id: "usr_001",
    statement: { subject: "user", predicate: "prefers_travel_pace", value: "slow" },
    scope: { domain: "travel", applies_when: ["leisure_trip"], topic: "travel_pacing" },
    confidence: 0.86,
    salience: 0.8,
    evidence_event_ids: ["hist_001"],
    valid_from: "2026-05-01T00:00:00+08:00",
    last_confirmed_at: "2026-08-01T00:00:00+08:00",
    status: "active",
    sensitivity: "normal"
  }];
  const c = candidate("today_fast", "fast", {
    eventId: "evt_today_fast",
    proposed_type: "short_term",
    scope: { domain: "travel", applies_when: ["trip_hangzhou_001"], topic: "travel_pacing" },
    retention: "current_trip"
  });
  const engine = engineWith({ evt_today_fast: [c] }, seed);

  const result = await engine.observe([event("evt_today_fast")]);
  const recalled = await engine.recall({
    user_id: "usr_001",
    trip_id: "trip_hangzhou_001",
    purpose: "decision",
    topics: ["travel_pacing"],
    situation: { trip_kind: "leisure_trip" },
    permissions: [],
    limit: 5
  });

  assert.equal(result.mutations[0].operation, "CREATE");
  assert.equal(result.mutations.some((item) => item.operation === "WEAKEN" || item.operation === "SUPERSEDE"), false);
  assert.deepEqual(new Set(recalled.memories.map((item) => item.memory.statement.value)), new Set(["slow", "fast"]));
  assert.equal(recalled.memories.find((item) => item.memory.statement.value === "fast").applicability, "current_trip");
});

test("a short-term observation never reinforces or resets a long-term memory", async () => {
  const seed = [{
    memory_id: "mem_slow",
    memory_type: "semantic_preference",
    user_id: "usr_001",
    statement: { subject: "user", predicate: "prefers_travel_pace", value: "slow" },
    scope: { domain: "travel", applies_when: ["leisure_trip"], topic: "travel_pacing" },
    confidence: 0.86,
    salience: 0.8,
    evidence_event_ids: ["hist_001"],
    valid_from: "2026-05-01T00:00:00+08:00",
    last_confirmed_at: "2026-08-01T00:00:00+08:00",
    status: "active",
    sensitivity: "normal"
  }];
  const short = candidate("short_same", "slow", {
    eventId: "evt_short_same",
    memory_tier: "short_term",
    retention: "short_lived",
    expires_at: "2026-08-26T14:20:00+08:00",
    scope: { domain: "travel", applies_when: ["leisure_trip"], topic: "travel_pacing" }
  });
  const result = await engineWith({ evt_short_same: [short] }, seed).observe([event("evt_short_same")]);

  assert.equal(result.mutations[0].operation, "CREATE");
  assert.equal(result.mutations.some((item) => item.operation === "REINFORCE"), false);
  assert.equal(result.memories.find((item) => item.memory_id === "mem_slow").confidence, 0.86);
  assert.equal(result.memories.find((item) => item.memory_id === "mem_slow").status, "active");
  assert.equal(result.memories.find((item) => item.memory_id === "mem_short_same").memory_tier, "short_term");
});

test("a short-term correction creates a temporal exception instead of superseding a long-term preference", async () => {
  const seed = [{
    memory_id: "mem_slow",
    memory_type: "semantic_preference",
    user_id: "usr_001",
    statement: { subject: "user", predicate: "prefers_travel_pace", value: "slow" },
    scope: { domain: "travel", applies_when: ["leisure_trip"], topic: "travel_pacing" },
    confidence: 0.86,
    salience: 0.8,
    evidence_event_ids: ["hist_001"],
    valid_from: "2026-05-01T00:00:00+08:00",
    last_confirmed_at: "2026-08-01T00:00:00+08:00",
    status: "active",
    sensitivity: "normal"
  }];
  const correction = candidate("short_fix", "fast", {
    eventId: "evt_short_fix",
    memory_tier: "short_term",
    retention: "short_lived",
    expires_at: "2026-08-26T14:20:00+08:00",
    evidence_kind: "user_correction",
    scope: { domain: "travel", applies_when: ["leisure_trip"], topic: "travel_pacing" }
  });
  const result = await engineWith({ evt_short_fix: [correction] }, seed)
    .observe([event("evt_short_fix", "feedback.user_corrected")]);

  assert.equal(result.mutations[0].operation, "CREATE");
  assert.equal(result.mutations[0].coexistence_reason, "TEMPORAL_EXCEPTION");
  assert.equal(result.mutations.some((item) => item.operation === "SUPERSEDE"), false);
  assert.equal(result.memories.find((item) => item.memory_id === "mem_slow").status, "active");
  assert.equal(result.memories.find((item) => item.memory_id === "mem_short_fix").status, "active");
  assert.ok(result.relations.some((item) => item.relation === "EXCEPTION_TO"
    && item.source_id === "mem_short_fix" && item.target_id === "mem_slow" && item.temporal_override === true));
});

test("current-trip retention downgrades a proposed long-term tier and binds recall to the evidence trip", async () => {
  const proposed = candidate("trip_budget", "avoid_expensive_exhibit", {
    eventId: "evt_trip_budget",
    statement: { subject: "user", predicate: "current_trip_budget_intent", value: "avoid_expensive_exhibit" },
    memory_tier: "long_term",
    retention: "current_trip",
    scope: { domain: "travel", topic: "activity_budget" }
  });
  const engine = engineWith({ evt_trip_budget: [proposed] });
  const observed = await engine.observe([event("evt_trip_budget")]);
  assert.equal(observed.memories[0].memory_tier, "short_term");
  assert.deepEqual(observed.memories[0].scope.applies_when, ["trip_hangzhou_001"]);
  const otherTrip = await engine.recall({ user_id: "usr_001", trip_id: "trip_beijing_001", purpose: "decision", topics: ["activity_budget"] });
  assert.equal(otherTrip.memories.length, 0);
  assert.ok(otherTrip.omitted.some((item) => item.reason_code === "OUT_OF_SCOPE"));
});

test("current-trip candidate without one evidence trip is rejected", async () => {
  const proposed = candidate("unscoped_trip", "skip_exhibit", {
    eventId: "evt_unscoped_trip",
    retention: "current_trip",
    scope: { domain: "travel", topic: "activity_interest" }
  });
  const engine = engineWith({ evt_unscoped_trip: [proposed] });
  const result = await engine.observe([{ ...event("evt_unscoped_trip"), trip_id: undefined }]);
  assert.equal(result.memories.length, 0);
  assert.equal(result.rejections[0].reason_code, "CURRENT_TRIP_SCOPE_REQUIRED");
});

test("long-term interest, trip-specific constraint, and live state appear together in recall", async () => {
  const interest = candidate("photo_interest", "photography", {
    eventId: "evt_photo_interest",
    statement: { subject: "user", predicate: "likes_experience", value: "photography" },
    scope: { domain: "travel", topic: "activity_interest" }
  });
  const budget = candidate("trip_budget_coexist", "avoid_expensive", {
    eventId: "evt_budget_coexist",
    statement: { subject: "user", predicate: "current_trip_budget_intent", value: "avoid_expensive" },
    proposed_type: "short_term",
    retention: "current_trip",
    scope: { domain: "travel", topic: "activity_budget" }
  });
  const engine = engineWith({ evt_photo_interest: [interest], evt_budget_coexist: [budget] });
  await engine.observe([event("evt_photo_interest")]);
  await engine.observe([event("evt_budget_coexist")]);
  const currentState = { state_id: "state_coexist", user_id: "usr_001", trip_id: "trip_hangzhou_001",
    observed_at: fixedNow, expires_at: "2026-08-25T15:20:00+08:00", model_version: "test", sensitivity: "normal",
    dimensions: { fatigue: { value: "high", confidence: 0.9, evidence_ids: ["evt_fatigue"] } } };
  const recall = await engine.recall({ user_id: "usr_001", trip_id: "trip_hangzhou_001", purpose: "decision",
    topics: ["activity_interest", "activity_budget"], current_state: currentState, limit: 5 });
  assert.deepEqual(new Set(recall.memories.map((item) => item.memory.statement.value)), new Set(["photography", "avoid_expensive"]));
  assert.deepEqual(recall.current_state, currentState);
  const nextTrip = await engine.recall({ user_id: "usr_001", trip_id: "trip_beijing_001", purpose: "decision",
    topics: ["activity_interest", "activity_budget"], limit: 5 });
  assert.deepEqual(nextTrip.memories.map((item) => item.memory.statement.value), ["photography"]);
});

test("a rejection with unknown reason does not change long-term preference", async () => {
  const seed = [{
    memory_id: "mem_photo",
    memory_type: "semantic_preference",
    user_id: "usr_001",
    statement: { subject: "user", predicate: "likes_experience", value: "photography" },
    scope: { domain: "travel", topic: "activity_interest" },
    confidence: 0.89,
    salience: 0.84,
    evidence_event_ids: ["hist_photo"],
    valid_from: "2026-03-01T00:00:00+08:00",
    last_confirmed_at: "2026-08-01T00:00:00+08:00",
    status: "active",
    sensitivity: "normal"
  }];
  const engine = engineWith({}, seed);

  const result = await engine.observe([event("evt_reject", "feedback.action_rejected", { decision_id: "dec_1" })]);

  assert.equal(result.mutations[0].operation, "NO_LONG_TERM_CHANGE");
  assert.equal(result.memories[0].confidence, 0.89);
});

test("matching evidence reinforces an existing memory instead of duplicating it", async () => {
  const seedCandidate = candidate("existing", "slow", { eventId: "hist_slow" });
  const seedEngine = engineWith({ hist_slow: [seedCandidate] });
  const created = await seedEngine.observe([event("hist_slow")]);
  const next = candidate("confirm", "slow", { eventId: "evt_confirm" });
  const engine = engineWith({ evt_confirm: [next] }, created.memories);

  const result = await engine.observe([event("evt_confirm")]);

  assert.equal(result.memories.length, 1);
  assert.equal(result.mutations[0].operation, "REINFORCE");
  assert.ok(result.memories[0].confidence > created.memories[0].confidence);
  assert.deepEqual(result.memories[0].evidence_event_ids, ["hist_slow", "evt_confirm"]);
});

test("contradictory long-term evidence forms a conflict set without overwriting history", async () => {
  const slow = candidate("slow_seed", "slow", { eventId: "hist_slow" });
  const seedEngine = engineWith({ hist_slow: [slow] });
  const created = await seedEngine.observe([event("hist_slow")]);
  const fast = candidate("fast_new", "fast", { eventId: "evt_fast", confidence: 0.73 });
  const engine = engineWith({ evt_fast: [fast] }, created.memories);

  const result = await engine.observe([event("evt_fast")]);
  const recalled = await engine.recall({
    user_id: "usr_001",
    purpose: "decision",
    topics: ["travel_pacing"],
    situation: { trip_kind: "leisure_trip" },
    permissions: [],
    limit: 5
  });

  assert.equal(result.mutations[0].operation, "FLAG_CONFLICT");
  assert.equal(result.memories.filter((item) => item.status === "active").length, 2);
  assert.equal(recalled.conflicts.length, 1);
  assert.equal(recalled.conflicts[0].memory_ids.length, 2);
  assert.ok(recalled.relations.some((item) => item.relation === "CONTRADICTS"));
  assert.ok(recalled.memories.every((item) => item.disputed === true));
});

test("different positive interests coexist without a false conflict", async () => {
  const photo = candidate("photo_seed", "photography", { eventId: "evt_photo_seed",
    statement: { subject: "user", predicate: "likes_experience", value: "photography" },
    scope: { domain: "travel", topic: "activity_interest" } });
  const engine = engineWith({ evt_photo_seed: [photo], evt_hike: [candidate("hike", "hiking", {
    eventId: "evt_hike", statement: { subject: "user", predicate: "likes_experience", value: "hiking" },
    scope: { domain: "travel", topic: "activity_interest" }
  })] });
  await engine.observe([event("evt_photo_seed")]);
  const result = await engine.observe([event("evt_hike")]);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(new Set(result.memories.map((item) => item.statement.value)), new Set(["photography", "hiking"]));
});

test("a correction event closes an open conflict even if the extractor says explicit_statement", async () => {
  const script = {
    evt_old: [candidate("old_pace", "slow", { eventId: "evt_old" })],
    evt_opposite: [candidate("opposite_pace", "fast", { eventId: "evt_opposite" })],
    evt_fix: [candidate("fix_pace", "moderate", { eventId: "evt_fix", evidence_kind: "explicit_statement" })]
  };
  const repository = createInMemoryMemoryRepository();
  const engine = createMemoryEngine({ repository, extractor: createScriptedExtractor(script), clock });
  await engine.observe([event("evt_old")]);
  const conflicted = await engine.observe([event("evt_opposite")]);
  assert.equal(conflicted.conflicts.length, 1);
  const corrected = await engine.observe([event("evt_fix", "feedback.user_corrected")]);
  assert.equal(corrected.conflicts.length, 0);
  assert.equal(corrected.memories.filter((item) => item.status === "superseded").length, 2);
  assert.equal(corrected.memories.filter((item) => item.status === "active")[0].statement.value, "moderate");
  const snapshot = await repository.snapshot();
  assert.equal(snapshot.conflicts[0].status, "resolved");
  assert.equal(snapshot.conflicts[0].resolution_reason, "USER_CORRECTION");
  assert.ok(snapshot.edges.some((item) => item.relation === "RESOLVED_BY"));
});

test("an explicit user correction supersedes the wrong memory and preserves its history", async () => {
  const wrong = candidate("wrong", "fast", { eventId: "hist_wrong" });
  const seedEngine = engineWith({ hist_wrong: [wrong] });
  const created = await seedEngine.observe([event("hist_wrong")]);
  const correction = candidate("correction", "slow", {
    eventId: "evt_correction",
    evidence_kind: "user_correction",
    confidence: 0.98
  });
  const engine = engineWith({ evt_correction: [correction] }, created.memories);

  const result = await engine.observe([event("evt_correction", "feedback.user_corrected")]);

  assert.equal(result.mutations[0].operation, "SUPERSEDE");
  assert.equal(result.memories.find((item) => item.statement.value === "fast").status, "superseded");
  const replacement = result.memories.find((item) => item.statement.value === "slow");
  assert.equal(replacement.status, "active");
  assert.equal(replacement.version, 2);
  assert.equal(replacement.lineage_id, created.memories[0].lineage_id);
  const recalled = await engine.recall({ user_id: "usr_001", purpose: "decision", situation: { trip_kind: "leisure_trip" } });
  assert.ok(recalled.relations.some((item) => item.relation === "SUPERSEDES"));
});

test("sensitive memory is omitted without explicit storage and recall permission", async () => {
  const c = candidate("health", "needs_frequent_rest", {
    eventId: "evt_health",
    statement: { subject: "user", predicate: "health_constraint", value: "needs_frequent_rest" },
    sensitivity: "sensitive",
    scope: { domain: "travel", topic: "accessibility" }
  });
  const engine = engineWith({ evt_health: [c] });

  const result = await engine.observe([event("evt_health")], { permissions: [] });

  assert.equal(result.memories.length, 0);
  assert.equal(result.rejections[0].reason_code, "SENSITIVE_STORAGE_PERMISSION_REQUIRED");
});

test("recall returns explanations and omits a short-term memory from another trip", async () => {
  const short = candidate("trip_only", "fast", {
    eventId: "evt_trip_only",
    proposed_type: "short_term",
    scope: { domain: "travel", applies_when: ["trip_hangzhou_001"], topic: "travel_pacing" },
    retention: "current_trip"
  });
  const engine = engineWith({ evt_trip_only: [short] });
  await engine.observe([event("evt_trip_only")]);

  const result = await engine.recall({
    user_id: "usr_001",
    trip_id: "trip_beijing_001",
    purpose: "decision",
    topics: ["travel_pacing"],
    situation: { trip_kind: "leisure_trip" },
    permissions: [],
    limit: 5
  });

  assert.equal(result.memories.length, 0);
  assert.equal(result.omitted[0].reason_code, "OUT_OF_SCOPE");
  assert.ok(result.trace_id);
});

test("legacy candidate types are normalized into independent tier, domain, and kind", async () => {
  const c = candidate("typed", "slow", { eventId: "evt_typed" });
  const engine = engineWith({ evt_typed: [c] });

  const result = await engine.observe([event("evt_typed")]);

  assert.equal(result.memories[0].memory_tier, "long_term");
  assert.equal(result.memories[0].memory_domain, "user");
  assert.equal(result.memories[0].memory_kind, "semantic");
  assert.equal(result.memories[0].version, 1);
  assert.equal(result.memories[0].lineage_id, result.memories[0].memory_id);
});

test("low-confidence long-term inference remains pending instead of becoming memory", async () => {
  const c = candidate("uncertain", "slow", {
    eventId: "evt_uncertain",
    evidence_kind: "inference",
    confidence: 0.51
  });
  const engine = engineWith({ evt_uncertain: [c] });

  const result = await engine.observe([event("evt_uncertain")]);

  assert.equal(result.memories.length, 0);
  assert.equal(result.pending_candidates.length, 1);
  assert.equal(result.pending_candidates[0].reason_code, "LOW_CONFIDENCE");
});

test("dynamic state claims are rejected from memory storage", async () => {
  const c = candidate("fatigue", "high", {
    eventId: "evt_fatigue",
    statement: { subject: "user", predicate: "fatigue", value: "high" },
    proposed_type: "short_term",
    retention: "short_lived"
  });
  const engine = engineWith({ evt_fatigue: [c] });

  const result = await engine.observe([event("evt_fatigue")]);

  assert.equal(result.memories.length, 0);
  assert.equal(result.rejections[0].reason_code, "STATE_BELONGS_TO_STATE_MODEL");
});

test("a sensitive low-confidence candidate is not retained in pending storage without permission", async () => {
  const c = candidate("sensitive_pending", "needs_rest", {
    eventId: "evt_sensitive_pending",
    statement: { subject: "user", predicate: "health_constraint", value: "needs_rest" },
    confidence: 0.4,
    sensitivity: "sensitive"
  });
  const engine = engineWith({ evt_sensitive_pending: [c] });

  const result = await engine.observe([event("evt_sensitive_pending")]);

  assert.equal(result.pending_candidates.length, 0);
  assert.equal(result.rejections[0].reason_code, "SENSITIVE_STORAGE_PERMISSION_REQUIRED");
});

test("hybrid architecture records evidence and conflict graph edges", async () => {
  const slow = candidate("graph_slow", "slow", { eventId: "evt_graph_slow" });
  const engine = engineWith({ evt_graph_slow: [slow] });
  await engine.observe([event("evt_graph_slow")]);

  const recall = await engine.recall({
    user_id: "usr_001",
    purpose: "decision",
    topics: ["travel_pacing"],
    situation: { trip_kind: "leisure_trip" }
  });

  assert.equal(recall.architecture, "hybrid");
  assert.ok(recall.relations.some((item) => item.relation === "SUPPORTED_BY" && item.target_id === "evt_graph_slow"));
});

test("a scoped long-term exception coexists and links back to the general memory", async () => {
  const broad = candidate("broad_slow", "slow", { eventId: "evt_broad",
    scope: { domain: "travel", topic: "travel_pacing" } });
  const seedEngine = engineWith({ evt_broad: [broad] });
  const seeded = await seedEngine.observe([event("evt_broad")]);
  const exception = candidate("business_fast", "fast", {
    eventId: "evt_exception",
    scope: { domain: "travel", situations: [{ field: "trip_kind", value: "business_trip" }], topic: "travel_pacing" }
  });
  const engine = engineWith({ evt_exception: [exception] }, seeded.memories);

  const result = await engine.observe([event("evt_exception")]);
  const recall = await engine.recall({ user_id: "usr_001", purpose: "decision", situation: { trip_kind: "business_trip" } });

  assert.equal(result.mutations[0].operation, "CREATE");
  assert.equal(result.mutations[0].coexistence_reason, "SCOPED_EXCEPTION");
  assert.ok(recall.relations.some((item) => item.relation === "EXCEPTION_TO"));
});

test("a newly stated general preference does not become the exception to an older narrow preference", async () => {
  const narrow = candidate("business_fast_first", "fast", { eventId: "evt_narrow",
    scope: { domain: "travel", situations: [{ field: "trip_kind", value: "business_trip" }], topic: "travel_pacing" } });
  const engine = engineWith({ evt_narrow: [narrow], evt_general: [candidate("general_slow_second", "slow", {
    eventId: "evt_general", scope: { domain: "travel", topic: "travel_pacing" }
  })] });
  await engine.observe([event("evt_narrow")]);
  const result = await engine.observe([event("evt_general")]);
  const edge = result.relations.find((item) => item.relation === "EXCEPTION_TO");
  assert.equal(edge.source_id, "mem_business_fast_first");
  assert.equal(edge.target_id, "mem_general_slow_second");
  assert.equal(result.conflicts.length, 0);
});

test("one broad memory can split into multiple versioned branches", async () => {
  const broad = candidate("museum_broad", "dislike", {
    eventId: "evt_museum_broad",
    statement: { subject: "user", predicate: "museum_preference", value: "dislike" },
    scope: { domain: "travel", topic: "activity_interest" }
  });
  const seedEngine = engineWith({ evt_museum_broad: [broad] });
  const seeded = await seedEngine.observe([event("evt_museum_broad")]);
  const targetId = seeded.memories[0].memory_id;
  const branches = [
    candidate("museum_large", "dislike", {
      eventId: "evt_museum_split",
      statement: { subject: "user", predicate: "museum_preference", value: "dislike_large_general_museums" },
      scope: { domain: "travel", applies_when: ["large_general_museum"], topic: "activity_interest" },
      evolution_hint: { operation: "SPLIT", target_memory_id: targetId, split_group_id: "split_museum" }
    }),
    candidate("museum_photo", "like", {
      eventId: "evt_museum_split",
      statement: { subject: "user", predicate: "museum_preference", value: "like_photography_exhibitions" },
      scope: { domain: "travel", applies_when: ["photography_exhibition"], topic: "activity_interest" },
      evolution_hint: { operation: "SPLIT", target_memory_id: targetId, split_group_id: "split_museum" }
    })
  ];
  const engine = engineWith({ evt_museum_split: branches }, seeded.memories);

  const result = await engine.observe([event("evt_museum_split", "feedback.user_corrected")]);

  assert.deepEqual(result.mutations.map((item) => item.operation), ["SPLIT", "SPLIT"]);
  assert.equal(result.memories.filter((item) => item.status === "active").length, 2);
  assert.ok(result.memories.filter((item) => item.status === "active").every((item) => item.version === 2));
  assert.deepEqual(result.memories.find((item) => item.memory_id === targetId).superseded_by.sort(), ["mem_museum_large", "mem_museum_photo"]);
  assert.equal(result.relations.filter((item) => item.relation === "DERIVED_FROM").length, 2);
});

test("flat and typed architecture flags suppress graph relations while preserving the interface", async () => {
  for (const architecture of ["flat", "typed"]) {
    const repository = createInMemoryMemoryRepository();
    const engine = createMemoryEngine({
      repository,
      extractor: createScriptedExtractor({ evt_arch: [candidate(`arch_${architecture}`, "slow", { eventId: "evt_arch" })] }),
      architecture,
      clock
    });
    await engine.observe([event("evt_arch")]);
    const recall = await engine.recall({ user_id: "usr_001", purpose: "decision" });
    assert.equal(recall.architecture, architecture);
    assert.deepEqual(recall.relations, []);
  }
});

test("observe delegates the complete write cycle to a repository transaction when available", async () => {
  const innerRepository = createInMemoryMemoryRepository();
  let transactionCount = 0;
  const transactionalRepository = {
    async withTransaction(work) {
      transactionCount += 1;
      return work(innerRepository);
    }
  };
  const engine = createMemoryEngine({
    repository: transactionalRepository,
    extractor: createScriptedExtractor({ evt_tx: [candidate("tx", "slow", { eventId: "evt_tx" })] }),
    clock
  });

  const result = await engine.observe([event("evt_tx")]);

  assert.equal(transactionCount, 1);
  assert.equal(result.memories.length, 1);
  const snapshot = await innerRepository.snapshot();
  assert.equal(snapshot.observation_events.length, 1);
  assert.equal(snapshot.mutations.length, 1);
});

test("replaying the same Observation Event is idempotent", async () => {
  const c = candidate("idempotent", "slow", { eventId: "evt_idempotent" });
  const engine = engineWith({ evt_idempotent: [c] });
  const input = event("evt_idempotent");

  const first = await engine.observe([input]);
  const replay = await engine.observe([input]);

  assert.deepEqual(first.ingestion.inserted_event_ids, ["evt_idempotent"]);
  assert.deepEqual(replay.ingestion.duplicate_event_ids, ["evt_idempotent"]);
  assert.equal(replay.mutations.length, 0);
  assert.equal(replay.memories[0].confidence, first.memories[0].confidence);
});

test("an Observation Event ID cannot be reused with different content", async () => {
  const c = candidate("immutable", "slow", { eventId: "evt_immutable" });
  const engine = engineWith({ evt_immutable: [c] });
  await engine.observe([event("evt_immutable", "dialogue.user_statement", { utterance: "slow" })]);

  await assert.rejects(
    engine.observe([event("evt_immutable", "dialogue.user_statement", { utterance: "fast" })]),
    /Observation Event is immutable/
  );
});

