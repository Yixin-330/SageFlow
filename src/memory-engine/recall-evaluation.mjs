import { createMemoryEngine } from "./memory-engine.mjs";
import { createInMemoryMemoryRepository } from "./adapters/in-memory-repository.mjs";
import { createScriptedExtractor } from "./adapters/scripted-extractor.mjs";

const NOW = "2026-10-17T12:00:00+08:00";
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const round = (value) => Number(value.toFixed(4));

export async function runRecallEvaluation(suite, catalog, architectures = ["flat", "typed", "hybrid"]) {
  const byId = new Map(catalog.map((memory) => [memory.memory_id, memory]));
  const modes = {};
  for (const architecture of architectures) {
    const cases = [];
    for (const item of suite.cases) {
      const seed = item.seed_memory_ids.map((id) => {
        const source = byId.get(id);
        if (!source) throw new Error(`Unknown evaluation memory: ${id}`);
        return { ...structuredClone(source), ...structuredClone(item.overrides?.[id] ?? {}) };
      });
      const repository = createInMemoryMemoryRepository(seed);
      for (const edge of item.edges ?? []) await repository.upsertEdge(edge);
      const engine = createMemoryEngine({ repository, extractor: createScriptedExtractor(), architecture, clock: { now: () => NOW } });
      const result = await engine.recall({ user_id: seed[0]?.user_id ?? "usr_001", ...item.request });
      const selected = result.memories.map((hit) => hit.memory.memory_id);
      const relevant = new Set(item.relevant_ids);
      const relevantHits = selected.filter((id) => relevant.has(id));
      const reciprocalRank = selected.findIndex((id) => relevant.has(id));
      const dcg = selected.reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
      const idealCount = Math.min(relevant.size, selected.length);
      const idealDcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
      cases.push({
        id: item.id,
        selected_ids: selected,
        recall_at_k: relevant.size ? relevantHits.length / relevant.size : 1,
        precision_at_k: selected.length ? relevantHits.length / selected.length : (relevant.size ? 0 : 1),
        hit_at_1: relevant.size ? Number(relevant.has(selected[0])) : Number(selected.length === 0),
        mrr: relevant.size && reciprocalRank >= 0 ? 1 / (reciprocalRank + 1) : Number(!relevant.size && selected.length === 0),
        ndcg_at_k: idealDcg ? dcg / idealDcg : Number(selected.length === 0),
        required_misses: (item.required_ids ?? []).filter((id) => !selected.includes(id)),
        forbidden_leaks: (item.forbidden_ids ?? []).filter((id) => selected.includes(id)),
        conflict_covered: !item.conflict_ids || item.conflict_ids.every((id) => selected.includes(id))
          && result.conflicts.some((conflict) => item.conflict_ids.every((id) => conflict.memory_ids.includes(id))),
        elapsed_ms: result.trace.elapsed_ms
      });
    }
    modes[architecture] = {
      cases,
      metrics: {
        recall_at_k: round(mean(cases.map((item) => item.recall_at_k))),
        precision_at_k: round(mean(cases.map((item) => item.precision_at_k))),
        hit_at_1: round(mean(cases.map((item) => item.hit_at_1))),
        mrr: round(mean(cases.map((item) => item.mrr))),
        ndcg_at_k: round(mean(cases.map((item) => item.ndcg_at_k))),
        required_misses: cases.reduce((sum, item) => sum + item.required_misses.length, 0),
        forbidden_leaks: cases.reduce((sum, item) => sum + item.forbidden_leaks.length, 0),
        conflict_coverage: round(mean(cases.filter((item) => suite.cases.find((source) => source.id === item.id)?.conflict_ids)
          .map((item) => Number(item.conflict_covered)))),
        mean_latency_ms: round(mean(cases.map((item) => item.elapsed_ms)))
      }
    };
  }
  return { suite_version: suite.suite_version, disclaimer: suite.disclaimer, modes };
}
