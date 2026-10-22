import { readFile } from "node:fs/promises";
import { runPromotionGate } from "../src/memory-engine/promotion-evaluation.mjs";

const suite = JSON.parse(await readFile(new URL("../evaluation/promotion-cases.json", import.meta.url), "utf8"));
let annotations = [];
try {
  annotations = (await readFile(new URL("../evaluation/promotion-human-review.jsonl", import.meta.url), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const report = await runPromotionGate(suite, annotations);
const compact = { ...report, cases: report.cases.map((item) => ({ id: item.id, predicate: item.predicate,
  risk_tier: item.risk_tier, passed: item.passed, failures: item.failures,
  promotion_count: item.actual.promotion_count, reason_codes: item.actual.reason_codes })),
human_review_queue: undefined };
console.log(JSON.stringify(process.argv.includes("--queue") ? report.human_review_queue : compact, null, 2));
if (!report.deterministic_pass) process.exitCode = 1;
