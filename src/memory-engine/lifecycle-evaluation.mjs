const ratio = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const mean = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;

export function evaluateMemoryLifecycle({ memories = [], recalls = [], conflicts = [], pendingCandidates = [],
  mutations = [], labels = {} } = {}) {
  const byId = new Map(memories.map((item) => [item.memory_id, item]));
  const expiredSelections = recalls.flatMap((recall) => (recall.selected_memory_ids ?? []).filter((id) => {
    const memory = byId.get(id);
    return memory?.memory_tier === "short_term" && memory.expires_at
      && Date.parse(memory.expires_at) <= Date.parse(recall.evaluated_at);
  }));
  const totalSelections = recalls.reduce((count, item) => count + (item.selected_memory_ids ?? []).length, 0);
  const expiredOpportunities = recalls.reduce((count, recall) => count + memories.filter((memory) =>
    memory.memory_tier === "short_term" && memory.expires_at
      && Date.parse(memory.expires_at) <= Date.parse(recall.evaluated_at)).length, 0);
  const conflictLabels = new Map((labels.conflicts ?? []).map((item) => [item.conflict_id, item.is_true_conflict]));
  const labeledConflicts = conflicts.filter((item) => conflictLabels.has(item.conflict_id));
  const falseConflicts = labeledConflicts.filter((item) => conflictLabels.get(item.conflict_id) === false);
  const closureHours = conflicts.filter((item) => item.status === "resolved" && item.resolved_at)
    .map((item) => (Date.parse(item.resolved_at) - Date.parse(item.created_at)) / 3_600_000)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const pending = pendingCandidates.filter((item) => item.status === "pending" || item.status === "promoted" || item.status === "expired");
  const promotions = mutations.filter((item) => item.operation === "PROMOTE");
  const promotionLabels = new Map((labels.promotions ?? []).map((item) => [item.mutation_id, item.correct]));
  const labeledPromotions = promotions.filter((item) => promotionLabels.has(item.mutation_id));
  const confidenceLabels = new Map((labels.memories ?? []).map((item) => [item.memory_id, item.outcome]));
  const calibrated = memories.filter((item) => confidenceLabels.has(item.memory_id)
    && Number.isFinite(item.confidence) && [0, 1].includes(confidenceLabels.get(item.memory_id)));
  return {
    expired_short_term_recall_rate: ratio(expiredSelections.length, expiredOpportunities),
    expired_short_term_recall_count: expiredSelections.length,
    conflict_false_positive_rate: ratio(falseConflicts.length, labeledConflicts.length),
    conflict_mean_closure_hours: mean(closureHours),
    pending_promotion_rate: ratio(pending.filter((item) => item.status === "promoted").length, pending.length),
    pending_expiry_rate: ratio(pending.filter((item) => item.status === "expired").length, pending.length),
    promotion_error_rate: ratio(labeledPromotions.filter((item) => promotionLabels.get(item.mutation_id) === false).length,
      labeledPromotions.length),
    confidence_brier_score: mean(calibrated.map((item) => (item.confidence - confidenceLabels.get(item.memory_id)) ** 2)),
    sample_sizes: { recall_selections: totalSelections, expired_opportunities: expiredOpportunities,
      labeled_conflicts: labeledConflicts.length,
      resolved_conflicts: closureHours.length, pending: pending.length, labeled_promotions: labeledPromotions.length,
      calibrated_memories: calibrated.length },
    note: "null means no usable denominator or labels; it is not a passing score"
  };
}
