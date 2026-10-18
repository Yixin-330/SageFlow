import { readFile } from "node:fs/promises";
import { runMemoryEvaluation } from "../src/memory-engine/evaluation.mjs";

const suite = JSON.parse(await readFile(new URL("../evaluation/memory-cases.json", import.meta.url), "utf8"));
const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));
const report = await runMemoryEvaluation(suite, catalog.memory_catalog);

console.log(`Memory Engine deterministic evaluation: ${report.passed}/${report.total}`);
for (const item of report.cases) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.id} ${item.title}`);
if (report.passed !== report.total) process.exitCode = 1;

