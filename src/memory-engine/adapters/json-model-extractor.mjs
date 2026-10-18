import { normalizeCandidate } from "../memory-model.mjs";

const REQUIRED = ["candidate_id", "statement", "memory_tier", "memory_domain", "memory_kind", "scope", "evidence_event_ids", "evidence_kind", "confidence", "salience", "retention", "sensitivity"];

export function createJsonModelExtractor({ invoke, name = "json-model-extractor", version = "unversioned" }) {
  if (typeof invoke !== "function") throw new Error("JSON model extractor requires an invoke function");
  return {
    name,
    version,
    async extract(events) {
      const output = await invoke({
        task: "Extract only evidence-supported travel Memory Candidates. Classify memory_tier, memory_domain and memory_kind independently. Return an array of JSON objects.",
        events,
        constraints: {
          rejection_without_reason_is_not_a_preference: true,
          temporary_intent_is_short_term: true,
          sensitive_memory_requires_explicit_classification: true
        }
      });
      if (!Array.isArray(output)) throw new Error("Model extractor must return an array");
      for (const candidate of output) {
        const missing = REQUIRED.filter((key) => candidate[key] === undefined);
        if (missing.length) throw new Error(`Model candidate missing: ${missing.join(", ")}`);
      }
      return output.map(normalizeCandidate);
    }
  };
}

