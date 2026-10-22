import { runMemoryEvaluation } from "./memory-engine/evaluation.mjs";
import { runRecallEvaluation } from "./memory-engine/recall-evaluation.mjs";
import { runDecisionCycleEvaluation } from "./decision-cycle-evaluation.mjs";
import { runStressEvaluation } from "./stress-evaluation.mjs";
import { evaluateHumanReviews } from "./human-review-evaluation.mjs";
import { evaluateMemoryLifecycle } from "./memory-engine/lifecycle-evaluation.mjs";

export async function runStageSevenGate({ catalog, memorySuite, recallSuite, stressSuite, humanQueue, humanReviewSets = [], lifecycleData = {} }) {
  const [memory, recall, cycle, stress] = await Promise.all([
    runMemoryEvaluation(memorySuite, catalog.memory_catalog),
    runRecallEvaluation(recallSuite, catalog.memory_catalog),
    runDecisionCycleEvaluation(catalog),
    runStressEvaluation(catalog, stressSuite)
  ]);
  const human = evaluateHumanReviews(humanQueue, humanReviewSets);
  const lifecycle = evaluateMemoryLifecycle(lifecycleData);
  const hybrid = recall.modes.hybrid.metrics;
  const checks = {
    memory_regression: memory.passed === memory.total,
    recall_constraints: hybrid.required_misses === 0 && hybrid.forbidden_leaks === 0
      && hybrid.conflict_coverage === 1,
    recall_quality_floor: hybrid.recall_at_k >= 0.9,
    decision_cycle: cycle.passed === cycle.total && cycle.metrics.counterfactual_pass === cycle.metrics.counterfactual_total,
    evidence_audit: cycle.metrics.audit_coverage === 1,
    stress_cases: stress.passed === stress.total
  };
  return {
    scope: "deterministic_prototype",
    prototype_pass: Object.values(checks).every(Boolean),
    pilot_ready: false,
    checks,
    results: {
      memory: { passed: memory.passed, total: memory.total },
      recall: hybrid,
      cycle: cycle.metrics,
      stress: { passed: stress.passed, total: stress.total },
      human,
      lifecycle
    },
    pilot_blockers: [
      ...(human.status === "dual_review_complete" ? [] : ["HUMAN_REVIEW_INCOMPLETE"]),
      "REAL_DATABASE_AND_SERVICE_NOT_VERIFIED",
      "REAL_USER_OUTCOMES_NOT_MEASURED",
      ...(lifecycle.sample_sizes.labeled_conflicts && lifecycle.sample_sizes.labeled_promotions
        && lifecycle.sample_sizes.calibrated_memories ? [] : ["LIFECYCLE_LABELS_NOT_MEASURED"])
    ]
  };
}
