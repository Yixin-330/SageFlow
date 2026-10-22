export function auditDecisionTrace(session, recall, modes) {
  const currentEvents = new Set([session.initialObservation?.event_id,
    ...session.appliedEvents.map((event) => event.event_id),
    ...session.feedback.map((event) => event.event_id)].filter(Boolean));
  const selectedMemories = new Map(recall.memories.map((item) => [item.memory.memory_id, item.memory]));
  const state = modes.sageflow.state;
  const decision = modes.sageflow.decision;
  const selectedAction = modes.sageflow.selected_action;
  const stateEvidence = Object.entries(state?.dimensions ?? {}).flatMap(([dimension, detail]) =>
    (detail.evidence_ids ?? []).map((id) => ({ dimension, evidence_id: id,
      source: currentEvents.has(id) ? "current_event" : selectedMemories.has(id) ? "recalled_memory" : "unresolved" })));
  const historicalMemoryEvidence = [...selectedMemories.values()].flatMap((memory) =>
    (memory.evidence_event_ids ?? []).filter((id) => !currentEvents.has(id))
      .map((id) => ({ memory_id: memory.memory_id, evidence_event_id: id })));
  const checks = {
    recall_link: decision.recall_trace_id === recall.trace_id,
    selected_action_link: decision.selected_action_id === selectedAction.action_id
      && decision.candidate_action_ids.includes(selectedAction.action_id),
    recall_selection: [...selectedMemories.keys()].every((id) => recall.trace.selected_memory_ids.includes(id))
      && recall.trace.selected_memory_ids.length === selectedMemories.size,
    state_evidence: stateEvidence.every((item) => item.source !== "unresolved"),
    rule_link: (decision.matched_rule_ids ?? []).every((id) =>
      recall.matched_rules.some((rule) => rule.memory_id === id))
  };
  return {
    trace_id: decision.trace_id,
    recall_trace_id: recall.trace_id,
    current_event_ids: [...currentEvents],
    selected_memory_ids: [...selectedMemories.keys()],
    state_evidence: stateEvidence,
    historical_memory_evidence_unverified: historicalMemoryEvidence,
    checks,
    passed: Object.values(checks).every(Boolean)
  };
}
