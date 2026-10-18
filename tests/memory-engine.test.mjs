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
  const broad = candidate("broad_slow", "slow", { eventId: "evt_broad" });
  const seedEngine = engineWith({ evt_broad: [broad] });
  const seeded = await seedEngine.observe([event("evt_broad")]);
  const exception = candidate("business_fast", "fast", {
    eventId: "evt_exception",
    scope: { domain: "travel", applies_when: ["business_trip"], topic: "travel_pacing" }
  });
  const engine = engineWith({ evt_exception: [exception] }, seeded.memories);

  const result = await engine.observe([event("evt_exception")]);
  const recall = await engine.recall({ user_id: "usr_001", purpose: "decision", situation: { trip_kind: "business_trip" } });

  assert.equal(result.mutations[0].operation, "CREATE");
  assert.equal(result.mutations[0].coexistence_reason, "SCOPED_EXCEPTION");
  assert.ok(recall.relations.some((item) => item.relation === "EXCEPTION_TO"));
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

