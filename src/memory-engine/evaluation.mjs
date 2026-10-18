import { createMemoryEngine } from "./memory-engine.mjs";
import { createInMemoryMemoryRepository } from "./adapters/in-memory-repository.mjs";
import { createScriptedExtractor } from "./adapters/scripted-extractor.mjs";

const NOW = "2026-08-25T14:20:00+08:00";

function makeEvent(spec) {
  return {
    schema_version: "1.0",
    event_id: spec.id,
    event_type: spec.type,
    user_id: "usr_001",
    trip_id: "trip_hangzhou_001",
    occurred_at: NOW,
    recorded_at: NOW,
    source: { type: "evaluation_fixture" },
    payload: { description: spec.description },
    trace_id: `trace_${spec.id}`
  };
}

function makeCandidate(testCase) {
  if (!testCase.candidate) return null;
  return {
    candidate_id: `${testCase.id}_candidate`,
    evidence_event_ids: [testCase.event.id],
    ...testCase.candidate
  };
}

export async function runMemoryEvaluation(suite, memoryCatalog) {
  const catalog = new Map(memoryCatalog.map((item) => [item.memory_id, item]));
  const cases = [];
  for (const testCase of suite.cases) {
    const seed = (testCase.seed_memory_ids ?? []).map((id) => catalog.get(id));
    const event = makeEvent(testCase.event);
    const candidate = makeCandidate(testCase);
    const engine = createMemoryEngine({
      repository: createInMemoryMemoryRepository(seed),
      extractor: createScriptedExtractor({ [event.event_id]: candidate ? [candidate] : [] }),
      clock: { now: () => NOW }
    });
    const observed = await engine.observe([event], { permissions: testCase.permissions ?? [] });
    const recalled = testCase.recall ? await engine.recall({
      user_id: "usr_001",
      purpose: "decision",
      permissions: [],
      limit: 5,
      ...testCase.recall
    }) : null;
    const checks = [];
    const expected = testCase.expected;
    if (expected.mutation) checks.push({ name: "mutation", pass: observed.mutations[0]?.operation === expected.mutation, expected: expected.mutation, actual: observed.mutations[0]?.operation });
    if (expected.rejection) checks.push({ name: "rejection", pass: observed.rejections[0]?.reason_code === expected.rejection, expected: expected.rejection, actual: observed.rejections[0]?.reason_code });
    if (expected.active_values) {
      const actual = observed.memories.filter((item) => item.status === "active").map((item) => item.statement.value);
      checks.push({ name: "active_values", pass: JSON.stringify([...actual].sort()) === JSON.stringify([...expected.active_values].sort()), expected: expected.active_values, actual });
    }
    if (expected.superseded_values) {
      const actual = observed.memories.filter((item) => item.status === "superseded").map((item) => item.statement.value);
      checks.push({ name: "superseded_values", pass: JSON.stringify([...actual].sort()) === JSON.stringify([...expected.superseded_values].sort()), expected: expected.superseded_values, actual });
    }
    if (expected.conflict_count !== undefined) checks.push({ name: "conflicts", pass: observed.conflicts.length === expected.conflict_count, expected: expected.conflict_count, actual: observed.conflicts.length });
    if (expected.memory_count !== undefined) checks.push({ name: "memory_count", pass: observed.memories.length === expected.memory_count, expected: expected.memory_count, actual: observed.memories.length });
    if (expected.recall_count !== undefined) checks.push({ name: "recall_count", pass: recalled?.memories.length === expected.recall_count, expected: expected.recall_count, actual: recalled?.memories.length });
    if (expected.omitted_reason) checks.push({ name: "omitted_reason", pass: recalled?.omitted.some((item) => item.reason_code === expected.omitted_reason), expected: expected.omitted_reason, actual: recalled?.omitted.map((item) => item.reason_code) });
    cases.push({ id: testCase.id, title: testCase.title, category: testCase.category, passed: checks.every((item) => item.pass), checks });
  }
  const categories = {};
  for (const item of cases) {
    categories[item.category] ??= { passed: 0, total: 0 };
    categories[item.category].total += 1;
    if (item.passed) categories[item.category].passed += 1;
  }
  return { cases, categories, passed: cases.filter((item) => item.passed).length, total: cases.length, disclaimer: suite.disclaimer };
}

