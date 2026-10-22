import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { replayDecisionScenario } from "../src/decision-cycle-evaluation.mjs";
import { applyFeedback } from "../src/engine.mjs";
import { auditDecisionTrace } from "../src/decision-trace-audit.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

test("state evidence resolves to current events or recalled memories", async () => {
  const { session, result } = await replayDecisionScenario(catalog.scenarios[0], catalog);
  assert.equal(result.audit.passed, true);
  assert.ok(result.audit.state_evidence.every((item) => item.source !== "unresolved"));
  assert.ok(result.audit.historical_memory_evidence_unverified.length > 0);
  const broken = structuredClone(result.modes);
  broken.sageflow.state.dimensions.fatigue.evidence_ids = ["unknown_source"];
  const audit = auditDecisionTrace(session, result.recall, broken);
  assert.equal(audit.passed, false);
  assert.equal(audit.checks.state_evidence, false);
});

test("feedback-driven state cites the feedback event rather than initial context", async () => {
  const run = await replayDecisionScenario(catalog.scenarios[0], catalog);
  const event = applyFeedback(run.session, "action_ignored", run.result.modes.sageflow.decision.decision_id);
  await run.memoryEngine.observe([event]);
  const after = await run.cycle.evaluate(run.session);
  assert.equal(after.modes.sageflow.state.dimensions.interruption_tolerance.value, "low");
  assert.deepEqual(after.modes.sageflow.state.dimensions.interruption_tolerance.evidence_ids, [event.event_id]);
  assert.equal(after.modes.sageflow.decision.trigger_event_id, event.event_id);
  assert.equal(after.audit.passed, true);
});
