import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runDecisionCycleEvaluation } from "../src/decision-cycle-evaluation.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

test("stage-six integrated evaluation passes scenarios and counterfactuals", async () => {
  const report = await runDecisionCycleEvaluation(catalog);
  assert.equal(report.metrics.scenario_pass, 8, JSON.stringify(report.cases.filter((item) => !item.passed), null, 2));
  assert.equal(report.metrics.counterfactual_pass, 2);
  assert.equal(report.metrics.silence_accuracy, 1);
  assert.equal(report.metrics.trace_coverage, 1);
  assert.equal(report.metrics.audit_coverage, 1);
  assert.equal(report.metrics.feedback_safety, 1);
});
