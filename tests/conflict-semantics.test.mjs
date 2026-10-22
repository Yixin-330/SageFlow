import test from "node:test";
import assert from "node:assert/strict";
import { predicatePolicy, validPredicateValue, normalizeScope, sameValue, scopeRelation, conflictRelation } from "../src/memory-engine/conflict-semantics.mjs";
import { createInMemoryMemoryRepository } from "../src/memory-engine/index.mjs";

const memory = (id, predicate, value, scope = { domain: "travel" }) => ({
  memory_id: id, user_id: "usr_1", memory_tier: "long_term", memory_domain: "user", memory_kind: "semantic",
  statement: { subject: "user", predicate, value }, scope, confidence: 0.8, salience: 0.7,
  evidence_event_ids: [`evt_${id}`], valid_from: "2026-10-01T00:00:00+08:00",
  last_confirmed_at: "2026-10-01T00:00:00+08:00", status: "active", sensitivity: "normal",
  version: 1, lineage_id: id
});

test("predicate registry distinguishes single and multi-value meanings", () => {
  assert.equal(predicatePolicy("prefers_travel_pace").cardinality, "single");
  assert.equal(predicatePolicy("likes_experience").cardinality, "multi");
  assert.equal(predicatePolicy("health_constraint").cardinality, "multi");
  assert.equal(predicatePolicy("service_policy").cardinality, "multi");
  assert.equal(predicatePolicy("unregistered_predicate").cardinality, "unknown");
  assert.equal(conflictRelation(memory("a", "likes_experience", "photography"),
    memory("b", "likes_experience", "hiking")), "none");
  assert.equal(conflictRelation(memory("a", "prefers_travel_pace", "slow"),
    memory("b", "prefers_travel_pace", "fast")), "equal");
});

test("registered predicate values are checked without silently coercing types", () => {
  assert.equal(validPredicateValue("comfortable_activity_budget_cny", 150), true);
  assert.equal(validPredicateValue("comfortable_activity_budget_cny", "150"), false);
  assert.equal(validPredicateValue("comfortable_activity_budget_cny", Number.NaN), false);
  assert.equal(validPredicateValue("service_policy", { action: "remain_silent" }), true);
  assert.equal(validPredicateValue("service_policy", ["remain_silent"]), false);
});

test("scope normalization removes list-order differences before storage", () => {
  assert.deepEqual(normalizeScope({ domain: "travel", trips: ["b", "a", "a"] }),
    { domain: "travel", trips: ["a", "b"] });
});

test("value comparison ignores object key order but does not coerce types", () => {
  assert.equal(sameValue({ pace: "slow", reason: { source: "user", count: 2 } },
    { reason: { count: 2, source: "user" }, pace: "slow" }), true);
  assert.equal(sameValue(150, "150"), false);
});

test("typed scopes distinguish equality, coverage, disjointness and overlap", () => {
  const global = { domain: "travel" };
  const business = { domain: "travel", situations: [{ field: "trip_kind", value: "business_trip" }] };
  const familyBusiness = { domain: "travel", situations: [{ field: "with_child", value: true }, { field: "trip_kind", value: "business_trip" }] };
  assert.equal(scopeRelation(global, business), "a_covers_b");
  assert.equal(scopeRelation(business, global), "b_covers_a");
  assert.equal(scopeRelation(business, familyBusiness), "a_covers_b");
  assert.equal(scopeRelation({ domain: "travel", trips: ["trip_b", "trip_a"] },
    { domain: "travel", trips: ["trip_a", "trip_b"] }), "equal");
  assert.equal(scopeRelation({ domain: "travel", trips: ["trip_a"] },
    { domain: "travel", trips: ["trip_b"] }), "disjoint");
  assert.equal(scopeRelation({ domain: "travel", applies_when: ["leisure_trip"] },
    { domain: "travel", applies_when: ["city_break"] }), "unknown");
});

test("seed conflicts use the same semantics as runtime conflicts", async () => {
  const repository = createInMemoryMemoryRepository([
    memory("photo", "likes_experience", "photography"),
    memory("hike", "likes_experience", "hiking"),
    memory("general", "prefers_travel_pace", "slow"),
    memory("business", "prefers_travel_pace", "fast", { domain: "travel", situations: [{ field: "trip_kind", value: "business_trip" }] }),
    memory("same_scope", "prefers_travel_pace", "fast")
  ]);
  const conflicts = await repository.listConflicts("usr_1");
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].memory_ids, ["general", "same_scope"]);
  const edges = await repository.listEdgesByMemoryIds("usr_1", ["business"]);
  assert.ok(edges.some((edge) => edge.relation === "EXCEPTION_TO"
    && edge.source_id === "business" && edge.target_id === "general"));
});
