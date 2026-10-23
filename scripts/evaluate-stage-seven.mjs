import { readFile } from "node:fs/promises";
import { runStageSevenGate } from "../src/stage-seven-gate.mjs";

const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const readJsonl = async (relative) => (await readFile(new URL(relative, import.meta.url), "utf8"))
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const report = await runStageSevenGate({
  catalog: await readJson("../scenarios/catalog.json"),
  memorySuite: await readJson("../evaluation/memory-cases.json"),
  recallSuite: await readJson("../evaluation/recall-cases.json"),
  promotionSuite: await readJson("../evaluation/promotion-cases.json"),
  stressSuite: await readJson("../evaluation/stress-cases.json"),
  humanQueue: await readJsonl("../evaluation/human-memory-review-v2.jsonl")
});
console.log(JSON.stringify(report, null, 2));
if (!report.prototype_pass) process.exitCode = 1;
