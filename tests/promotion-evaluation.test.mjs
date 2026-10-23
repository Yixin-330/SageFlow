import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluatePromotionHumanReviews, runPromotionGate } from "../src/memory-engine/promotion-evaluation.mjs";

const suite = JSON.parse(await readFile(new URL("../evaluation/promotion-cases.json", import.meta.url), "utf8"));

test("promotion gate covers errors, misses, provenance, expiry, correction and scoped labels", async () => {
  const report = await runPromotionGate(suite);
  assert.equal(report.deterministic_pass, true);
  assert.equal(report.metrics.sample_sizes.cases, 14);
  assert.equal(report.metrics.false_promotion_rate, 0);
  assert.equal(report.metrics.missed_promotion_rate, 0);
  assert.equal(report.metrics.duplicate_promotion_count, 0);
  assert.equal(report.metrics.provenance_coverage, 1);
  assert.equal(report.metrics.scope_accuracy, 1);
  assert.equal(report.metrics.pending_expiry_rate, 0.3333);
  assert.equal(report.metrics.post_promotion_correction_conflict_rate, 0.25);
  assert.equal(report.human.status, "needs_review");
  assert.equal(report.pilot_ready, false);
});

test("wrong gold expectation and absent high-risk cases cannot pass the gate", async () => {
  const wrong = structuredClone(suite);
  wrong.cases[0].expected.promote = false;
  assert.equal((await runPromotionGate(wrong)).deterministic_pass, false);
  const noHighRisk = structuredClone(suite);
  noHighRisk.cases = noHighRisk.cases.filter((item) => item.id !== "health_requires_confirmation");
  assert.equal((await runPromotionGate(noHighRisk)).checks.false_promotion_high, false);
});

test("human scope review requires two independent reviewers and surfaces agreement on an error", () => {
  const cases = [{ id: "x", actual: { promote: true } }];
  const a = { case_id: "x", reviewer_id: "r1", should_promote: true,
    scope_correct: true, provenance_correct: true };
  const b = { ...a, reviewer_id: "r2" };
  assert.equal(evaluatePromotionHumanReviews(cases, [a]).status, "needs_review");
  assert.equal(evaluatePromotionHumanReviews(cases, [a, b]).status, "dual_review_complete");
  assert.equal(evaluatePromotionHumanReviews(cases, [a, { ...b, scope_correct: false }]).status, "needs_adjudication");
  const incorrect = evaluatePromotionHumanReviews(cases,
    [{ ...a, scope_correct: false }, { ...b, scope_correct: false }]);
  assert.equal(incorrect.status, "review_findings");
  assert.deepEqual(incorrect.review_findings, ["x"]);
  assert.throws(() => evaluatePromotionHumanReviews(cases, [a, a]), /Duplicate reviewer/);
});
