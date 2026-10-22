import { inferState } from "./engine.mjs";
import { validateStateSnapshot } from "./memory-engine/retrieval.mjs";

export function buildDecisionContext(session, request, recall) {
  const memories = recall.memories.map((item) => item.memory);
  const inferred = recall.current_state ? null : inferState({ ...session, memories });
  const stateGate = recall.current_state
    ? { state: recall.current_state, status: "ACCEPTED" }
    : validateStateSnapshot(inferred, request, recall.evaluated_at);
  const state = stateGate.state;
  return {
    trace_id: recall.trace_id,
    user_id: request.user_id,
    trip_id: request.trip_id,
    purpose: request.purpose,
    permissions: [...(request.permissions ?? [])],
    current_facts: structuredClone(session.context),
    long_term: recall.long_term_memories,
    current_trip: recall.trip_memories,
    other_short_term: recall.short_term_memories,
    state,
    state_source: recall.current_state ? "provided" : "inferred",
    state_status: stateGate.status,
    matched_rules: recall.matched_rules,
    conflicts: recall.conflicts,
    omitted: recall.omitted,
    complete: recall.trace.context_complete && Boolean(state),
    mandatory_overflow_count: recall.trace.mandatory_overflow_count,
    unavailable_mandatory_count: recall.trace.unavailable_mandatory_count ?? 0,
    unavailable_mandatory: recall.trace.unavailable_mandatory ?? []
  };
}
