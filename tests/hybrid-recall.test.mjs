import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryMemoryRepository, createMemoryEngine, createScriptedExtractor } from "../src/memory-engine/index.mjs";

const now = "2026-10-17T12:00:00+08:00";
const clock = { now: () => now };

function memory(id, predicate, value, extra = {}) {
  return {
    memory_id: id, user_id: "usr_1", memory_tier: "long_term", memory_domain: "user", memory_kind: "semantic",
    statement: { subject: "user", predicate, value }, scope: { domain: "travel", topic: "activities" },
    confidence: 0.8, salience: 0.7, evidence_event_ids: [`evt_${id}`],
    valid_from: "2026-01-01T00:00:00+08:00", last_confirmed_at: "2026-10-01T00:00:00+08:00",
    status: "active", sensitivity: "normal", version: 1, lineage_id: id, ...extra
  };
}

function engine(memories, options = {}) {
  const repository = createInMemoryMemoryRepository(memories);
  return { repository, memoryEngine: createMemoryEngine({ repository, extractor: createScriptedExtractor(), clock, ...options }) };
}

test("a budget constraint and current-trip intent survive a one-item recall limit", async () => {
  const trip = memory("trip_intent", "current_trip_pace", "walk_more", {
    memory_tier: "short_term", scope: { domain: "travel", applies_when: ["trip_hz"], topic: "pacing" }
  });
  const { memoryEngine } = engine([
    memory("photo", "likes_experience", "photography", { label: "摄影展" }),
    memory("budget", "comfortable_activity_budget_cny", 150), trip
  ]);

  const result = await memoryEngine.recall({
    user_id: "usr_1", purpose: "decision", trip_id: "trip_hz", query_text: "摄影展", limit: 1
  });

  assert.deepEqual(new Set(result.mandatory_evidence.map((item) => item.memory.memory_id)), new Set(["budget", "trip_intent"]));
  assert.ok(result.memories.length >= 2);
  assert.deepEqual(result.trace.mandatory_memory_ids.sort(), ["budget", "trip_intent"]);
});

test("sensitive memory and its graph edges are invisible without permission", async () => {
  const { repository, memoryEngine } = engine([
    memory("public", "likes_experience", "photography"),
    memory("private", "health_constraint", "needs_rest", { sensitivity: "sensitive" })
  ]);
  await repository.upsertEdge({ edge_id: "edge_private", user_id: "usr_1", source_id: "public", source_type: "memory",
    target_id: "private", target_type: "memory", relation: "CONTRADICTS" });

  const result = await memoryEngine.recall({ user_id: "usr_1", purpose: "decision", query_text: "photography", limit: 5 });

  assert.ok(result.memories.every((item) => item.memory.memory_id !== "private"));
  assert.ok(result.relations.every((item) => item.source_id !== "private" && item.target_id !== "private"));
  assert.ok(result.omitted.some((item) => item.reason_code === "SENSITIVE_RECALL_PERMISSION_REQUIRED" && !item.memory_id));
});

test("procedural memory only matches its situation conditions", async () => {
  const rule = memory("rain_rule", "service_policy", {
    conditions: [{ field: "weather", value: "rain" }, { field: "fatigue", value: "high" }],
    service_policy: { action: "suggest_nearby_indoor" }
  }, { memory_kind: "procedural", memory_domain: "relational" });
  const { memoryEngine } = engine([rule]);

  const dry = await memoryEngine.recall({ user_id: "usr_1", purpose: "decision", situation: { weather: "clear", fatigue: "high" } });
  const rainy = await memoryEngine.recall({ user_id: "usr_1", purpose: "decision", situation: { weather: "rain", fatigue: "high" } });

  assert.equal(dry.matched_rules.length, 0);
  assert.deepEqual(rainy.matched_rules[0].service_policy, { action: "suggest_nearby_indoor" });
  assert.ok(rainy.memories[0].channel_ranks.procedural);
});

test("semantic channel can recover a paraphrase and reports its rank", async () => {
  const vectors = new Map([
    ["nearby quiet place", [1, 0]],
    ["calm cafe", [0.95, 0.05]],
    ["busy market", [0, 1]]
  ]);
  const embedder = { async embed(text) {
    for (const [key, value] of vectors) if (text.includes(key)) return value;
    return [0, 0];
  } };
  const { memoryEngine } = engine([
    memory("calm", "likes_experience", "calm cafe"),
    memory("busy", "likes_experience", "busy market")
  ], { embedder });

  const result = await memoryEngine.recall({ user_id: "usr_1", purpose: "conversation", query_text: "nearby quiet place", limit: 1 });

  assert.equal(result.memories[0].memory.memory_id, "calm");
  assert.equal(result.memories[0].channel_ranks.semantic, 1);
  assert.equal(result.trace.plan.semantic, 1);
});

test("state snapshot is copied only while valid and is not promoted into memory", async () => {
  const { memoryEngine } = engine([]);
  const state = { state_id: "state_now", expires_at: "2026-10-17T13:00:00+08:00", dimensions: { fatigue: "high" } };
  const current = await memoryEngine.recall({ user_id: "usr_1", purpose: "decision", current_state: state });
  const stale = await memoryEngine.recall({ user_id: "usr_1", purpose: "decision", current_state: { ...state, expires_at: "2026-10-17T11:00:00+08:00" } });

  assert.equal(current.current_state.state_id, "state_now");
  assert.equal(stale.current_state, null);
  assert.deepEqual(current.memories, []);
});

test("graph expansion retrieves the eligible conflict counterpart with provenance", async () => {
  const { repository, memoryEngine } = engine([
    memory("slow", "prefers_travel_pace", "slow", { scope: { domain: "travel", topic: "pacing" } }),
    memory("fast", "prefers_travel_pace", "fast", { scope: { domain: "travel", topic: "pacing" } })
  ]);
  await repository.upsertEdge({ edge_id: "edge_pace", user_id: "usr_1", source_id: "slow", source_type: "memory",
    target_id: "fast", target_type: "memory", relation: "CONTRADICTS" });
  const result = await memoryEngine.recall({ user_id: "usr_1", purpose: "conversation", required_memory_ids: ["slow"], limit: 2 });

  assert.ok(result.memories.some((item) => item.memory.memory_id === "fast" && item.channel_ranks.graph));
  assert.ok(result.relations.some((item) => item.edge_id === "edge_pace"));
});

test("repository search channels receive only eligible IDs and preserve trace", async () => {
  const repository = createInMemoryMemoryRepository([
    memory("allowed", "likes_experience", "quiet cafe"),
    memory("sensitive", "health_constraint", "quiet rest", { sensitivity: "sensitive" })
  ]);
  const calls = [];
  repository.searchText = async (userId, query, ids) => {
    calls.push({ channel: "text", userId, query, ids });
    return [{ memory_id: "allowed", score: 0.8 }, { memory_id: "sensitive", score: 1 }];
  };
  repository.searchVector = async (userId, vector, version, ids) => {
    calls.push({ channel: "vector", userId, version, ids });
    return [{ memory_id: "allowed", score: 0.9 }, { memory_id: "sensitive", score: 1 }];
  };
  const embedder = { version: "test-v1", async embed() { return [1, 0]; } };
  const memoryEngine = createMemoryEngine({ repository, extractor: createScriptedExtractor(), embedder, clock });
  const result = await memoryEngine.recall({ user_id: "usr_1", purpose: "conversation", query_text: "quiet cafe", limit: 2 });
  assert.deepEqual(calls.map((call) => call.ids), [["allowed"], ["allowed"]]);
  assert.deepEqual(result.trace.plan.full_text, 1);
  assert.deepEqual(result.trace.plan.vector, 1);
  assert.equal(result.memories.length, 1);
});

test("in-memory repository keeps equal memory IDs from different users separate", async () => {
  const repository = createInMemoryMemoryRepository([
    memory("shared", "likes_experience", "quiet cafe"),
    { ...memory("shared", "likes_experience", "busy market"), user_id: "usr_2" }
  ]);
  const first = createMemoryEngine({ repository, extractor: createScriptedExtractor(), clock });
  const one = await first.recall({ user_id: "usr_1", purpose: "conversation" });
  const two = await first.recall({ user_id: "usr_2", purpose: "conversation" });
  assert.equal(one.memories[0].memory.statement.value, "quiet cafe");
  assert.equal(two.memories[0].memory.statement.value, "busy market");
});
