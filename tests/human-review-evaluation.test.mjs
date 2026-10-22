import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHumanReviews } from "../src/human-review-evaluation.mjs";

const queue = [{ review_id: "H1" }, { review_id: "H2" }];
const labels = { should_remember: "yes", memory_tier: "long_term", memory_domain: "user", memory_kind: "semantic",
  faithful_to_evidence: "yes", scope_correct: "yes", sensitivity_correct: "yes" };

test("unlabeled human queue remains explicitly pending", () => {
  const report = evaluateHumanReviews(queue);
  assert.equal(report.status, "needs_review");
  assert.equal(report.coverage, 0);
  assert.equal(report.agreement.should_remember.kappa, null);
});

test("independent agreement and disagreements are measured without inventing labels", () => {
  const first = queue.map((item) => ({ ...item, reviewer: "A", labels }));
  const second = queue.map((item) => ({ ...item, reviewer: "B", labels: item.review_id === "H2"
    ? { ...labels, should_remember: "no" } : labels }));
  const report = evaluateHumanReviews(queue, [first, second]);
  assert.equal(report.coverage, 1);
  assert.deepEqual(report.disagreements, ["H2"]);
  assert.equal(report.agreement.should_remember.exact, 0.5);
  assert.equal(report.status, "needs_review");
});

test("invalid or non-independent annotations are rejected", () => {
  const first = [{ review_id: "H1", reviewer: "A", labels }];
  assert.throws(() => evaluateHumanReviews(queue, [first, first]), /independent/);
  assert.throws(() => evaluateHumanReviews(queue, [[{ ...first[0], labels: { ...labels, memory_tier: "unknown" } }]]), /Invalid memory_tier/);
});
