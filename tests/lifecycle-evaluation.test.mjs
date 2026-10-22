import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMemoryLifecycle } from "../src/memory-engine/lifecycle-evaluation.mjs";

test("lifecycle metrics count leakage, false conflicts, closure and calibration", () => {
  const report = evaluateMemoryLifecycle({
    memories: [{ memory_id: "m1", memory_tier: "short_term", expires_at: "2026-10-01T00:00:00Z", confidence: 0.8 }],
    recalls: [{ evaluated_at: "2026-10-02T00:00:00Z", selected_memory_ids: ["m1"] }],
    conflicts: [{ conflict_id: "c1", status: "resolved", created_at: "2026-10-01T00:00:00Z", resolved_at: "2026-10-01T02:00:00Z" }],
    pendingCandidates: [{ pending_id: "p1", status: "promoted" }, { pending_id: "p2", status: "expired" }],
    mutations: [{ mutation_id: "prom1", operation: "PROMOTE" }],
    labels: { conflicts: [{ conflict_id: "c1", is_true_conflict: false }],
      promotions: [{ mutation_id: "prom1", correct: false }], memories: [{ memory_id: "m1", outcome: 1 }] }
  });
  assert.equal(report.expired_short_term_recall_rate, 1);
  assert.equal(report.conflict_false_positive_rate, 1);
  assert.equal(report.conflict_mean_closure_hours, 2);
  assert.equal(report.pending_promotion_rate, 0.5);
  assert.equal(report.pending_expiry_rate, 0.5);
  assert.equal(report.promotion_error_rate, 1);
  assert.equal(report.confidence_brier_score, 0.04);
});

test("unmeasured lifecycle metrics stay null rather than claiming zero errors", () => {
  const report = evaluateMemoryLifecycle();
  assert.equal(report.conflict_false_positive_rate, null);
  assert.equal(report.promotion_error_rate, null);
  assert.equal(report.confidence_brier_score, null);
});
