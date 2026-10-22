import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runStressEvaluation } from "../src/stress-evaluation.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));
const suite = JSON.parse(await readFile(new URL("../evaluation/stress-cases.json", import.meta.url), "utf8"));

test("stage-seven stress suite enforces permission, freshness, scope and counterfactual gates", async () => {
  const report = await runStressEvaluation(catalog, suite);
  assert.equal(report.total, 8);
  assert.equal(report.passed, 8, JSON.stringify(report.cases.filter((item) => !item.passed), null, 2));
});
