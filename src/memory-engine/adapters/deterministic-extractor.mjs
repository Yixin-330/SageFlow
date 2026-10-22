import { normalizeCandidate } from "../memory-model.mjs";

function fromHint(event, hint, index) {
  return normalizeCandidate({
    candidate_id: hint.candidate_id ?? `${event.event_id}_${index + 1}`,
    statement: hint.statement,
    proposed_type: hint.proposed_type ?? "short_term",
    scope: hint.scope ?? { domain: "travel" },
    evidence_event_ids: [event.event_id],
    evidence_kind: hint.evidence_kind ?? "explicit_statement",
    confidence: hint.confidence ?? 0.82,
    salience: hint.salience ?? 0.72,
    retention: hint.retention ?? "current_trip",
    sensitivity: hint.sensitivity ?? "normal",
    service_role: hint.service_role
  });
}

export function createDeterministicExtractor() {
  return {
    name: "deterministic-local-extractor",
    version: "0.3",
    async extract(events) {
      const candidates = [];
      for (const event of events) {
        const hints = event.payload?.memory_candidates ?? [];
        candidates.push(...hints.map((hint, index) => fromHint(event, hint, index)));

        const utterance = event.payload?.utterance ?? event.payload?.description ?? "";
        const saysHighEnergy = /状态很好|体力很好|想多走走|多安排几个/.test(utterance);
        if (!hints.length && event.event_type.includes("dialogue") && saysHighEnergy) {
          const today = /今天|今日/.test(utterance);
          const offset = event.occurred_at?.match(/(?:Z|[+-]\d{2}:\d{2})$/)?.[0] ?? "Z";
          const dayEnd = `${event.occurred_at?.slice(0, 10)}T23:59:59${offset}`;
          candidates.push(fromHint(event, {
            candidate_id: `${event.event_id}_current_pace`,
            statement: { subject: "user", predicate: "current_trip_pace", value: "high_energy" },
            proposed_type: "short_term",
            scope: { domain: "travel", applies_when: [event.trip_id], topic: "travel_pacing",
              ...(today ? { time_window: { start: event.occurred_at, end: dayEnd } } : {}) },
            evidence_kind: event.event_type === "feedback.user_corrected" ? "user_correction" : "explicit_statement",
            confidence: 0.95,
            salience: 0.9,
            retention: "current_trip"
          }, 0));
        }

        if (!hints.length && event.event_type === "feedback.user_corrected") {
          candidates.push(fromHint(event, {
            candidate_id: `${event.event_id}_correction`,
            statement: { subject: "user", predicate: "current_trip_pace", value: "high_energy" },
            proposed_type: "short_term",
            scope: { domain: "travel", applies_when: [event.trip_id], topic: "travel_pacing" },
            evidence_kind: "user_correction",
            confidence: 0.97,
            salience: 0.92,
            retention: "current_trip"
          }, 0));
        }
      }
      return candidates;
    }
  };
}

