import { clone, normalizeCandidate } from "../memory-model.mjs";

export function createScriptedExtractor(script = {}) {
  return {
    name: "scripted-extractor",
    version: "0.2",
    async extract(events) {
      return events.flatMap((event) => clone(script[event.event_id] ?? []).map(normalizeCandidate));
    }
  };
}

