import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSession, advanceSession } from "../src/engine.mjs";
import { createDecisionCycle } from "../src/decision-cycle.mjs";
import { createMemoryEngine, createInMemoryMemoryRepository, createDeterministicExtractor } from "../src/memory-engine/index.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

async function runCycle(scenario, { removeMemoryIds = [], extraMemories = [] } = {}) {
  const session = createSession(scenario, catalog);
  session.memories = session.memories.filter((memory) => !removeMemoryIds.includes(memory.memory_id));
  const repository = createInMemoryMemoryRepository([...session.memories, ...extraMemories]);
  const engine = createMemoryEngine({ repository, extractor: createDeterministicExtractor(),
    clock: { now: () => `2026-08-25T${session.context.time}:00+08:00` } });
  while (session.cursor < scenario.timeline.length) {
    const event = scenario.timeline[session.cursor];
    advanceSession(session);
    await engine.observe([event]);
  }
  return createDecisionCycle({ memoryEngine: engine }).evaluate(session);
}

for (const scenario of catalog.scenarios) {
  test(`${scenario.id} integrated recall, state and action match the story`, async () => {
    const { recall, modes } = await runCycle(scenario);
    assert.equal(modes.sageflow.selected_action.action_type, scenario.expected.sageflow_action);
    assert.equal(modes.sageflow.decision.recall_trace_id, recall.trace_id);
    assert.deepEqual(modes.baseline.recalled_memories, []);
    assert.equal(modes.memory.state, null);
    for (const [dimension, value] of Object.entries(scenario.expected.state)) {
      assert.equal(modes.sageflow.state.dimensions[dimension]?.value, value);
    }
  });
}

test("removing budget memory changes budget state and decision despite unchanged context", async () => {
  const scenario = catalog.scenarios.find((item) => item.id === "S06");
  const withMemory = await runCycle(scenario);
  const withoutMemory = await runCycle(scenario, { removeMemoryIds: ["mem_budget_150"] });
  assert.equal(withMemory.modes.sageflow.state.dimensions.budget_pressure.value, "high");
  assert.equal(withMemory.modes.sageflow.selected_action.action_type, "ask_user_preference");
  assert.equal(withoutMemory.modes.sageflow.state.dimensions.budget_pressure, undefined);
  assert.notEqual(withoutMemory.modes.sageflow.selected_action.action_type, "ask_user_preference");
});

test("matched user service rule suppresses a nonurgent intervention but not a high-urgency one", async () => {
  const source = catalog.memory_catalog.find((memory) => memory.memory_id === "mem_photography");
  const rule = { ...structuredClone(source), memory_id: "mem_rule_silence", memory_domain: "relational",
    memory_kind: "procedural", statement: { subject: "sageflow", predicate: "service_policy",
      value: { conditions: [{ field: "weather", value: "rain" }], service_policy: { action: "remain_silent" } } },
    scope: { domain: "proactive_service" } };
  const low = await runCycle(catalog.scenarios.find((item) => item.id === "S06"), { extraMemories: [rule] });
  assert.deepEqual(low.recall.matched_rules.map((item) => item.memory_id), ["mem_rule_silence"]);
  assert.equal(low.modes.sageflow.selected_action.action_type, "remain_silent");
  assert.ok(low.modes.sageflow.selected_action.reason_codes.includes("MATCHED_SERVICE_POLICY"));

  const highScenario = structuredClone(catalog.scenarios.find((item) => item.id === "S01"));
  const high = await runCycle(highScenario, { extraMemories: [rule] });
  assert.equal(high.modes.sageflow.selected_action.action_type, "propose_itinerary_adjustment");
});
