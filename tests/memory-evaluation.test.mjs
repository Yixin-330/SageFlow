import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runMemoryEvaluation } from "../src/memory-engine/evaluation.mjs";

const suite = JSON.parse(await readFile(new URL("../evaluation/memory-cases.json", import.meta.url), "utf8"));
const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

test("all Memory Engine deterministic evaluation cases pass through observe and recall", async () => {
  const report = await runMemoryEvaluation(suite, catalog.memory_catalog);
  assert.equal(report.total, 8);
  assert.equal(report.passed, 8, JSON.stringify(report.cases.filter((item) => !item.passed), null, 2));
});

