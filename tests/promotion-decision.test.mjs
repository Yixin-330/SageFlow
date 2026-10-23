import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryEngine, createInMemoryMemoryRepository, createScriptedExtractor } from "../src/memory-engine/index.mjs";
import { commonScope, decidePromotion } from "../src/memory-engine/promotion-decision.mjs";
import { promotionPolicy } from "../src/memory-engine/promotion-policy.mjs";
import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

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
  const waiting = await engine.observe([e1]);
  now = date(10);
  const result = await engine.observe([e2]);
  assert.equal(result.promotion_decisions[0].action, "promote");
  const groupId = result.promotion_groups[0].group_id;
  const decisions = await repo.listPromotionDecisions("u1", groupId);
  assert.deepEqual(decisions.map((item) => item.action), ["wait", "promote"]);
  assert.deepEqual(decisions.map((item) => item.evidence_event_ids), [["e1"], ["e1", "e2"]]);
  assert.equal(decisions[0].reason_codes[0], waiting.promotion_decisions[0].reason_code);
  assert.equal(decisions[1].target_scope.domain, "travel");
  const longTerm = result.memories.find((item) => item.memory_tier === "long_term");
  assert.deepEqual(longTerm.scope, { domain: "travel", situations: [{ field: "trip_kind", value: "leisure_trip" }] });
  assert.deepEqual(longTerm.evidence_trip_ids, ["t1", "t2"]);
  assert.equal(longTerm.valid_from, date(1));
  assert.equal(longTerm.last_confirmed_at, date(10));
  assert.equal(longTerm.promoted_at, date(10));
  assert.equal(longTerm.confidence < 0.9, true);
  assert.deepEqual(longTerm.promoted_from.sort(), ["mem_c1", "mem_c2"]);
  assert.equal(result.memories.filter((item) => item.memory_tier === "short_term").length, 2);
  assert.equal(result.mutations.some((item) => item.operation === "PROMOTE"), true);
  assert.equal(result.relations.filter((item) => item.relation === "PROMOTED_FROM").length, 2);
  await engine.observe([e2]);
  assert.equal((await repo.listPromotionDecisions("u1", groupId)).length, 2);
  assert.equal((await repo.snapshot()).promotion_results.length, 1);
  assert.equal((await repo.snapshot()).memories.filter((item) => item.memory_tier === "long_term").length, 1);
  const forgotten = await engine.forget({ user_id: "u1", memory_id: "mem_c1", permissions: ["memory:forget"] });
  assert.equal(forgotten.forgotten_memory_ids.includes(longTerm.memory_id), true);
  assert.equal((await repo.snapshot()).promotion_results.length, 0);
  assert.equal((await repo.listPromotionDecisions("u1", groupId)).length, 0);
});

test("promoted sensitive constraints keep their access boundary and mandatory service role", async () => {
  let now = date(1);
  const repo = createInMemoryMemoryRepository();
  const protectedCandidate = (id, eventId) => ({ ...candidate(id, eventId),
    sensitivity: "sensitive", service_role: "hard_constraint" });
  const engine = createMemoryEngine({ repository: repo, clock: { now: () => now },
    extractor: createScriptedExtractor({ e1: [protectedCandidate("c1", "e1")],
      e2: [candidate("c2", "e2")], e3: [candidate("c3", "e3")] }) });
  await engine.observe([event("e1", "t1", 1)], { permissions: ["memory:sensitive:write"] });
  now = date(10);
  const blocked = await engine.observe([event("e2", "t2", 10)]);
  assert.equal(blocked.promotion_decisions[0].reason_code, "SENSITIVE_STORAGE_PERMISSION_REQUIRED");
  assert.equal(blocked.memories.some((item) => item.memory_tier === "long_term"), false);
  const result = await engine.observe([event("e3", "t2", 10)], { permissions: ["memory:sensitive:write"] });
  const promoted = result.memories.find((item) => item.memory_tier === "long_term");
  assert.equal(promoted.sensitivity, "sensitive");
  assert.equal(promoted.service_role, "hard_constraint");
  const request = { user_id: "u1", purpose: "decision", situation: { trip_kind: "leisure_trip" } };
  const denied = await engine.recall(request);
  assert.equal(denied.memories.some((item) => item.memory.memory_id === promoted.memory_id), false);
  const allowed = await engine.recall({ ...request, permissions: ["memory:sensitive:read"] });
  assert.equal(allowed.memories.some((item) => item.memory.memory_id === promoted.memory_id), true);
  assert.equal(allowed.mandatory_evidence.some((item) => item.memory.memory_id === promoted.memory_id), true);
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
  const blocked = result.promotion_decisions.find((item) => item.action === "blocked_by_counter_evidence");
  assert.equal((await repo.listPromotionDecisions("u1", blocked.group_id)).at(-1).action,
    "blocked_by_counter_evidence");
});

test("policy-rejected long-term candidate leaves a durable promotion decision", async () => {
  const repo = createInMemoryMemoryRepository();
  const rejected = { ...candidate("unknown", "e1"), memory_tier: "long_term",
    retention: "long_term_candidate", statement: { subject: "user", predicate: "unknown_preference", value: "x" } };
  const engine = createMemoryEngine({ repository: repo, clock: { now: () => date(1) },
    extractor: createScriptedExtractor({ e1: [rejected] }) });
  const result = await engine.observe([event("e1", "t1", 1)]);
  assert.equal(result.rejections[0].reason_code, "DIRECT_LONG_TERM_NOT_ALLOWED");
  const decisions = await repo.listPromotionDecisions("u1");
  assert.equal(decisions[0].action, "rejected_by_policy");
  assert.deepEqual(decisions[0].evidence_event_ids, ["e1"]);
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

test("typed leisure evidence reinforces the existing legacy catalog memory", async () => {
  let now = "2026-10-01T00:00:00Z";
  const legacy = { ...catalog.memory_catalog.find((item) => item.memory_id === "mem_slow_pace"), user_id: "u1" };
  const repo = createInMemoryMemoryRepository([legacy]);
  const e1 = { ...event("legacy_e1", "t1", 1), occurred_at: now, recorded_at: now };
  const e2 = { ...event("legacy_e2", "t2", 10), occurred_at: "2026-10-10T00:00:00Z",
    recorded_at: "2026-10-10T00:00:00Z" };
  const engine = createMemoryEngine({ repository: repo, clock: { now: () => now },
    extractor: createScriptedExtractor({ legacy_e1: [candidate("legacy_c1", "legacy_e1")],
      legacy_e2: [candidate("legacy_c2", "legacy_e2")] }) });
  await engine.observe([e1]);
  now = e2.occurred_at;
  const result = await engine.observe([e2]);
  assert.equal(result.promotion_decisions[0].reason_code, "REINFORCE_EXISTING_LONG_TERM");
  assert.deepEqual(result.memories.filter((item) => item.memory_tier === "long_term")
    .map((item) => item.memory_id), ["mem_slow_pace"]);
});

test("unmapped legacy scope blocks a duplicate long-term promotion for review", async () => {
  let now = date(1);
  const legacy = { ...catalog.memory_catalog.find((item) => item.memory_id === "mem_slow_pace"),
    user_id: "u1", scope: { domain: "travel", applies_when: ["unmapped_travel_context"] } };
  const engine = createMemoryEngine({ repository: createInMemoryMemoryRepository([legacy]),
    clock: { now: () => now }, extractor: createScriptedExtractor({ e1: [candidate("c1", "e1")],
      e2: [candidate("c2", "e2")] }) });
  await engine.observe([event("e1", "t1", 1)]);
  now = date(10);
  const result = await engine.observe([event("e2", "t2", 10)]);
  assert.equal(result.promotion_decisions[0].reason_code, "EXISTING_LONG_TERM_SCOPE_UNKNOWN");
  assert.equal(result.memories.filter((item) => item.memory_tier === "long_term").length, 1);
});

test("legacy with_child context can generalize across two trips without inventing a trip kind", async () => {
  let now = date(1);
  const scoped = (id, eventId) => ({ ...candidate(id, eventId),
    scope: { domain: "travel", applies_when: ["with_child"] } });
  const withoutKind = (id, trip, day) => ({ ...event(id, trip, day), payload: { with_child: true } });
  const engine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    clock: { now: () => now }, extractor: createScriptedExtractor({ e1: [scoped("c1", "e1")],
      e2: [scoped("c2", "e2")] }) });
  await engine.observe([withoutKind("e1", "t1", 1)]);
  now = date(10);
  const result = await engine.observe([withoutKind("e2", "t2", 10)]);
  assert.equal(result.promotion_decisions[0].action, "promote");
  assert.deepEqual(result.memories.find((item) => item.memory_tier === "long_term").scope,
    { domain: "travel", situations: [{ field: "with_child", value: true }] });
});

test("catalog city_break and single_activity tags map to bounded typed situations", async () => {
  for (const tag of ["city_break", "single_activity"]) {
    let now = date(1);
    const scoped = (id, eventId) => ({ ...candidate(id, eventId),
      scope: { domain: "travel", applies_when: [tag] } });
    const withoutKind = (id, trip, day) => ({ ...event(id, trip, day), payload: { [tag]: true } });
    const engine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
      clock: { now: () => now }, extractor: createScriptedExtractor({ e1: [scoped("c1", "e1")],
        e2: [scoped("c2", "e2")] }) });
    await engine.observe([withoutKind("e1", "t1", 1)]);
    now = date(10);
    const result = await engine.observe([withoutKind("e2", "t2", 10)]);
    assert.equal(result.promotion_decisions[0].action, "promote", tag);
    assert.deepEqual(result.memories.find((item) => item.memory_tier === "long_term").scope,
      { domain: "travel", situations: [{ field: tag, value: true }] }, tag);
  }
});

test("session-bound statements cannot join a cross-trip promotion group", async () => {
  let now = date(1);
  const sessionBound = (id, eventId, sessionId) => ({ ...candidate(id, eventId),
    scope: { domain: "travel", sessions: [sessionId],
      situations: [{ field: "trip_kind", value: "leisure_trip" }] } });
  const engine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    clock: { now: () => now }, extractor: createScriptedExtractor({
      e1: [sessionBound("c1", "e1", "s1")], e2: [sessionBound("c2", "e2", "s2")] }) });
  await engine.observe([event("e1", "t1", 1)]);
  now = date(10);
  const result = await engine.observe([event("e2", "t2", 10)]);
  assert.equal(result.promotion_groups.length, 0);
  assert.equal(result.memories.some((item) => item.memory_tier === "long_term"), false);
});

test("conflicting legacy and typed trip tags never produce a generalized memory", async () => {
  let now = date(1);
  const conflicting = (id, eventId) => ({ ...candidate(id, eventId),
    scope: { domain: "travel", applies_when: ["leisure_trip"],
      situations: [{ field: "trip_kind", value: "business_trip" }] } });
  const engine = createMemoryEngine({ repository: createInMemoryMemoryRepository(),
    clock: { now: () => now }, extractor: createScriptedExtractor({
      e1: [conflicting("c1", "e1")], e2: [conflicting("c2", "e2")] }) });
  await engine.observe([event("e1", "t1", 1, "business_trip")]);
  now = date(10);
  const result = await engine.observe([event("e2", "t2", 10, "business_trip")]);
  assert.equal(result.memories.some((item) => item.memory_tier === "long_term"), false);
});
