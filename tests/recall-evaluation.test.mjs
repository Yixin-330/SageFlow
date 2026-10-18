import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runRecallEvaluation } from "../src/memory-engine/recall-evaluation.mjs";

const suite = JSON.parse(await readFile(new URL("../evaluation/recall-cases.json", import.meta.url), "utf8"));
const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

test("hybrid recall passes mandatory, privacy, scope, and conflict gates", async () => {
  const report = await runRecallEvaluation(suite, catalog.memory_catalog);
  assert.equal(report.modes.hybrid.cases.length, 7);
  assert.equal(report.modes.hybrid.metrics.required_misses, 0);
  assert.equal(report.modes.hybrid.metrics.forbidden_leaks, 0);
  assert.equal(report.modes.hybrid.metrics.conflict_coverage, 1);
  assert.ok(report.modes.hybrid.metrics.recall_at_k >= 0.8);
  assert.ok(report.modes.hybrid.metrics.recall_at_k > report.modes.typed.metrics.recall_at_k);
});
