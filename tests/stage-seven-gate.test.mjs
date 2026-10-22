import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runStageSevenGate } from "../src/stage-seven-gate.mjs";

const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const queue = (await readFile(new URL("../evaluation/human-memory-review-v2.jsonl", import.meta.url), "utf8"))
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

test("prototype gate passes while pilot readiness remains honestly blocked", async () => {
  const report = await runStageSevenGate({
    catalog: await readJson("../scenarios/catalog.json"),
    memorySuite: await readJson("../evaluation/memory-cases.json"),
    recallSuite: await readJson("../evaluation/recall-cases.json"),
    stressSuite: await readJson("../evaluation/stress-cases.json"),
    humanQueue: queue
  });
  assert.equal(report.prototype_pass, true, JSON.stringify(report.checks, null, 2));
  assert.equal(report.pilot_ready, false);
  assert.ok(report.pilot_blockers.includes("HUMAN_REVIEW_INCOMPLETE"));
  assert.equal(report.results.stress.passed, 8);
});
