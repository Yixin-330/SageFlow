import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createSession,
  runToEnd,
  evaluateModes,
  evaluateScenario,
  buildEvaluationReport,
  applyFeedback
} from "../src/engine.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

test("the catalog contains the eight planned deterministic stories", () => {
  assert.deepEqual(catalog.scenarios.map((item) => item.id), ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08"]);
});

for (const scenario of catalog.scenarios) {
  test(`${scenario.id} satisfies protocol, memory, state, decision, and feedback assertions`, () => {
    const result = evaluateScenario(scenario, catalog);
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
  });
}

test("all modes share current context but preserve their capability boundaries", () => {
  const session = runToEnd(createSession(catalog.scenarios[0], catalog));
  const results = evaluateModes(session);
  assert.equal(results.baseline.recalled_memories.length, 0);
  assert.equal(results.baseline.state, null);
  assert.ok(results.memory.recalled_memories.length > 0);
  assert.equal(results.memory.state, null);
  assert.ok(results.sageflow.recalled_memories.length > 0);
  assert.ok(results.sageflow.state);
  assert.ok(results.sageflow.candidates.some((item) => item.action_type === "remain_silent"));
});

test("a rejection does not rewrite an unrelated long-term preference", () => {
  const session = runToEnd(createSession(catalog.scenarios[0], catalog));
  applyFeedback(session, "action_rejected");
  assert.deepEqual(session.mutations.map((item) => item.operation), ["NO_LONG_TERM_CHANGE"]);
  assert.ok(session.memories.some((item) => item.memory_id === "mem_photography" && item.status === "active"));
});

test("an ignored action lowers frequency without inventing a preference", () => {
  const session = runToEnd(createSession(catalog.scenarios[0], catalog));
  const before = session.context.recentIgnored;
  applyFeedback(session, "action_ignored");
  assert.equal(session.context.recentIgnored, before + 1);
  assert.equal(session.frequencyPolicy, "lower");
  assert.equal(session.mutations.at(-1).operation, "ADJUST_FREQUENCY");
});

test("a correction becomes short-term intent and preserves long-term pace", () => {
  const session = runToEnd(createSession(catalog.scenarios[0], catalog));
  applyFeedback(session, "user_corrected");
  assert.ok(session.memories.some((item) => item.memory_type === "short_term"));
  assert.ok(session.memories.some((item) => item.memory_id === "mem_slow_pace" && item.status === "active"));
  assert.equal(evaluateModes(session).sageflow.selected_action.action_type, "remain_silent");
});

test("the complete deterministic evaluation report passes", () => {
  const report = buildEvaluationReport(catalog);
  assert.equal(report.total, 8);
  assert.equal(report.passed, 8);
});

