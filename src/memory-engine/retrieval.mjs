import { normalizeMemory } from "./memory-model.mjs";

const RRF_K = 60;
const CONSTRAINT = /budget|allerg|health_constraint|accessibility|safety|permission|must_avoid|constraint|预算|过敏|禁忌|无障碍/i;
const SERVICE = /notification_frequency|interrupt|提醒频率|打扰/i;

export function memoryText(memory) {
  return [memory.label, memory.statement?.subject, memory.statement?.predicate,
    typeof memory.statement?.value === "string" ? memory.statement.value : JSON.stringify(memory.statement?.value),
    memory.scope?.topic, memory.scope?.domain].filter(Boolean).join(" ").toLowerCase();
}

function termsOf(text) {
  const value = String(text ?? "").toLowerCase();
  const latin = value.match(/[a-z0-9_]+/g) ?? [];
  const chinese = (value.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((part) =>
    part.length < 3 ? [part] : Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2)));
  return [...new Set([...latin, ...chinese])];
}

function applicability(memory, request) {
  const scopes = memory.scope?.applies_when ?? [];
  if (!scopes.length) return { allowed: true, label: "global", score: 0.8 };
  if (request.trip_id && scopes.includes(request.trip_id)) return { allowed: true, label: "current_trip", score: 1 };
  const situation = request.situation ?? {};
  if (scopes.some((scope) => Object.values(situation).includes(scope) || situation[scope] === true)) {
    return { allowed: true, label: "matched_situation", score: 0.9 };
  }
  const tripScoped = scopes.some((scope) => scope.startsWith("trip_"));
  if (!tripScoped && !situation.trip_kind) return { allowed: true, label: "unresolved_scope", score: 0.55 };
  return { allowed: false, label: "out_of_scope", score: 0 };
}

function ruleMatches(memory, situation = {}) {
  const conditions = memory.conditions ?? memory.statement?.value?.conditions;
  if (!Array.isArray(conditions) || !conditions.length) return false;
  return conditions.every((condition) => {
    if (typeof condition === "string") return Boolean(situation[condition]);
    const actual = situation[condition.field];
    if (condition.operator === "in") return Array.isArray(condition.value) && condition.value.includes(actual);
    if (condition.operator === "gte") return Number(actual) >= Number(condition.value);
    if (condition.operator === "lte") return Number(actual) <= Number(condition.value);
    return actual === condition.value;
  });
}

function memoryIsUnmatchedRule(memory, request) {
  return memory.memory_kind === "procedural" && !ruleMatches(memory, request.situation);
}

function freshness(memory, now) {
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(memory.last_confirmed_at ?? memory.valid_from ?? now)) / 86_400_000);
  if (memory.memory_tier === "short_term") return ageDays <= 7 ? 1 : 0.2;
  return Math.max(0.25, 1 - ageDays / 365);
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0; let a = 0; let b = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i]; a += left[i] ** 2; b += right[i] ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

function ranked(entries, channel) {
  return entries.sort((a, b) => b.score - a.score || a.memory.memory_id.localeCompare(b.memory.memory_id))
    .map((item, index) => ({ ...item, channel, rank: index + 1 }));
}

function structuredChannel(eligible, request) {
  const predicates = new Set(request.predicates ?? []);
  const topics = new Set(request.topics ?? []);
  const hasTarget = predicates.size || topics.size || (request.required_memory_ids ?? []).length;
  return ranked(eligible.flatMap(({ memory, applicability: scope }) => {
    if (!hasTarget && request.query_text) return [];
    if (memory.memory_kind === "procedural" && !ruleMatches(memory, request.situation)) return [];
    const predicate = predicates.has(memory.statement?.predicate);
    const topic = topics.has(memory.scope?.topic)
      || (topics.size > 0 && !memory.scope?.topic && scope.label === "matched_situation");
    const required = (request.required_memory_ids ?? []).includes(memory.memory_id);
    if (hasTarget && !predicate && !topic && !required) return [];
    return [{ memory, score: (required ? 3 : 0) + (predicate ? 2 : 0) + (topic ? 1 : 0) + scope.score }];
  }), "structured");
}

function lexicalChannel(eligible, request) {
  const terms = termsOf(request.query_text);
  if (!terms.length) return [];
  return ranked(eligible.flatMap(({ memory }) => {
    const text = memoryText(memory);
    const matches = terms.filter((term) => text.includes(term)).length;
    return matches ? [{ memory, score: matches / terms.length }] : [];
  }), "lexical");
}

async function semanticChannel(eligible, request, embedder) {
  if (!embedder || !request.query_text) return [];
  const queryVector = await embedder.embed(request.query_text);
  const scored = await Promise.all(eligible.map(async ({ memory }) => ({
    memory,
    score: cosine(queryVector, await embedder.embed(memoryText(memory)))
  })));
  return ranked(scored.filter((item) => item.score > 0), "semantic");
}

function graphChannel(eligible, edges, seeds) {
  const allowed = new Map(eligible.map(({ memory }) => [memory.memory_id, memory]));
  const scores = new Map();
  for (const edge of edges) {
    if (edge.source_type !== "memory" || edge.target_type !== "memory") continue;
    if (!["CONTRADICTS", "EXCEPTION_TO", "DERIVED_FROM", "SUPERSEDES"].includes(edge.relation)) continue;
    const sourceSeed = seeds.has(edge.source_id);
    const targetSeed = seeds.has(edge.target_id);
    const neighbor = sourceSeed ? edge.target_id : targetSeed ? edge.source_id : null;
    if (neighbor && allowed.has(neighbor)) scores.set(neighbor, (scores.get(neighbor) ?? 0) + 1);
  }
  return ranked([...scores].map(([id, score]) => ({ memory: allowed.get(id), score })), "graph");
}

function proceduralChannel(eligible, request) {
  return ranked(eligible.filter(({ memory }) => memory.memory_kind === "procedural" && ruleMatches(memory, request.situation))
    .map(({ memory }) => ({ memory, score: memory.confidence ?? 0.5 })), "procedural");
}

function requiredIds(eligible, request, conflicts) {
  const ids = new Set(request.required_memory_ids ?? []);
  for (const { memory } of eligible) {
    const predicate = memory.statement?.predicate ?? "";
    if (request.purpose === "decision" && (CONSTRAINT.test(predicate) || SERVICE.test(predicate))) ids.add(memory.memory_id);
    if (memory.memory_tier === "short_term" && request.trip_id
      && memory.scope?.applies_when?.includes(request.trip_id)) ids.add(memory.memory_id);
  }
  const eligibleIds = new Set(eligible.map(({ memory }) => memory.memory_id));
  for (const conflict of conflicts) {
    if (conflict.memory_ids.every((id) => eligibleIds.has(id))
      && conflict.memory_ids.some((id) => ids.has(id))) {
      conflict.memory_ids.forEach((id) => ids.add(id));
    }
  }
  return ids;
}

function safeRelations(edges, selectedIds, visibleIds) {
  return edges.filter((edge) => {
    if (!selectedIds.has(edge.source_id) && !selectedIds.has(edge.target_id)) return false;
    return (edge.source_type !== "memory" || visibleIds.has(edge.source_id))
      && (edge.target_type !== "memory" || visibleIds.has(edge.target_id));
  });
}

export function eligibleMemoryIds(memories, request, now) {
  const permissions = new Set(request.permissions ?? []);
  return memories.map(normalizeMemory).filter((memory) => {
    if (memory.status !== "active") return false;
    if (memory.sensitivity === "sensitive" && !permissions.has("memory:sensitive:read")) return false;
    if (memory.valid_from && Date.parse(memory.valid_from) > Date.parse(now)) return false;
    if (memory.expires_at && Date.parse(memory.expires_at) <= Date.parse(now)) return false;
    return applicability(memory, request).allowed;
  }).map((memory) => memory.memory_id);
}

export async function retrieveMemories({ memories, conflicts = [], edges = [], request, now, architecture, embedder, fullTextHits = [], vectorHits = [] }) {
  const started = Date.now();
  const permissions = new Set(request.permissions ?? []);
  const omitted = [];
  const eligible = [];
  for (const original of memories) {
    const memory = normalizeMemory(original);
    if (memory.status !== "active") { omitted.push({ memory_id: memory.memory_id, reason_code: "INACTIVE" }); continue; }
    if (memory.sensitivity === "sensitive" && !permissions.has("memory:sensitive:read")) {
      omitted.push({ reason_code: "SENSITIVE_RECALL_PERMISSION_REQUIRED" }); continue;
    }
    if (memory.valid_from && Date.parse(memory.valid_from) > Date.parse(now)) {
      omitted.push({ memory_id: memory.memory_id, reason_code: "NOT_YET_VALID" }); continue;
    }
    if (memory.expires_at && Date.parse(memory.expires_at) <= Date.parse(now)) {
      omitted.push({ memory_id: memory.memory_id, reason_code: "EXPIRED" }); continue;
    }
    const scope = applicability(memory, request);
    if (!scope.allowed) { omitted.push({ memory_id: memory.memory_id, reason_code: "OUT_OF_SCOPE" }); continue; }
    eligible.push({ memory, applicability: scope });
  }

  const structured = structuredChannel(eligible, request);
  const lexical = architecture === "flat" ? [] : lexicalChannel(eligible, request);
  const semantic = architecture === "flat" || vectorHits.length ? [] : await semanticChannel(eligible, request, embedder);
  const procedural = architecture === "flat" ? [] : proceduralChannel(eligible, request);
  const allowedMap = new Map(eligible.map(({ memory }) => [memory.memory_id, memory]));
  const external = (hits, channel) => ranked(hits.flatMap((hit) => allowedMap.has(hit.memory_id)
    ? [{ memory: allowedMap.get(hit.memory_id), score: Number(hit.score) }] : []), channel);
  const fullText = architecture === "flat" ? [] : external(fullTextHits, "full_text");
  const vector = architecture === "flat" ? [] : external(vectorHits, "vector");
  const seedIds = new Set([...structured, ...lexical, ...semantic, ...fullText, ...vector, ...procedural]
    .slice(0, 20).map((item) => item.memory.memory_id));
  const graph = architecture === "hybrid" ? graphChannel(eligible, edges, seedIds) : [];
  const channels = { structured, lexical, full_text: fullText, semantic, vector, graph, procedural };
  const mandatory = requiredIds(eligible, request, conflicts);
  const fused = new Map(eligible.map(({ memory, applicability: scope }) => [memory.memory_id, {
    memory,
    applicability: scope.label,
    channel_ranks: {},
    channel_scores: {},
    rrf_score: 0
  }]));

  for (const [channel, results] of Object.entries(channels)) {
    for (const hit of results) {
      const item = fused.get(hit.memory.memory_id);
      item.channel_ranks[channel] = hit.rank;
      item.channel_scores[channel] = hit.score;
      item.rrf_score += 1 / (RRF_K + hit.rank);
    }
  }

  const hasQuerySignal = Boolean(request.query_text || request.predicates?.length || request.topics?.length || request.required_memory_ids?.length || Object.keys(request.situation ?? {}).length);
  const hasChannelHits = Object.values(channels).some((hits) => hits.length);
  const rankedItems = [...fused.values()].filter((item) => {
    if (memoryIsUnmatchedRule(item.memory, request)) return false;
    return !hasQuerySignal || !hasChannelHits || mandatory.has(item.memory.memory_id) || Object.keys(item.channel_ranks).length > 0;
  }).map((item) => {
    const quality = 0.3 * (item.memory.confidence ?? 0.5)
      + 0.25 * (item.memory.salience ?? 0.5)
      + 0.2 * freshness(item.memory, now)
      + 0.15 * (eligible.find(({ memory }) => memory.memory_id === item.memory.memory_id)?.applicability.score ?? 0)
      + 0.1 * Math.min(1, (item.memory.evidence_event_ids?.length ?? 0) / 3);
    const directRelevance = Math.max(0, ...["lexical", "full_text", "semantic", "vector"]
      .map((channel) => Math.min(1, item.channel_scores[channel] ?? 0)));
    const score = Number((item.rrf_score * 10 + quality + 0.4 * directRelevance).toFixed(4));
    return {
      ...item,
      score,
      reason_codes: [mandatory.has(item.memory.memory_id) ? "MANDATORY_EVIDENCE" : null,
        ...Object.keys(item.channel_ranks).map((channel) => `RETRIEVED_${channel.toUpperCase()}`)].filter(Boolean),
      score_breakdown: { rrf: Number(item.rrf_score.toFixed(5)), quality: Number(quality.toFixed(4)), direct_relevance: Number(directRelevance.toFixed(4)) }
    };
  }).sort((a, b) => b.score - a.score || a.memory.memory_id.localeCompare(b.memory.memory_id));

  const limit = request.limit ?? 5;
  const selected = rankedItems.filter((item) => mandatory.has(item.memory.memory_id));
  const selectedIds = new Set(selected.map((item) => item.memory.memory_id));
  const quota = { episodic: 2, procedural: 2 };
  const count = { episodic: selected.filter((item) => item.memory.memory_kind === "episodic").length,
    procedural: selected.filter((item) => item.memory.memory_kind === "procedural").length };
  for (const item of rankedItems) {
    if (selected.length >= limit) break;
    if (selectedIds.has(item.memory.memory_id)) continue;
    const kind = item.memory.memory_kind;
    if (quota[kind] !== undefined && count[kind] >= quota[kind]) continue;
    selected.push(item);
    selectedIds.add(item.memory.memory_id);
    if (count[kind] !== undefined) count[kind] += 1;
  }
  selected.sort((a, b) => b.score - a.score || a.memory.memory_id.localeCompare(b.memory.memory_id));
  const eligibleIds = new Set(eligible.map(({ memory }) => memory.memory_id));
  const visibleIds = new Set(memories.filter((memory) => memory.sensitivity !== "sensitive"
    || permissions.has("memory:sensitive:read")).map((memory) => memory.memory_id));
  const visibleConflicts = conflicts.filter((conflict) => conflict.memory_ids.every((id) => eligibleIds.has(id))
    && conflict.memory_ids.some((id) => selectedIds.has(id)));
  for (const item of rankedItems) {
    if (!selectedIds.has(item.memory.memory_id)) omitted.push({ memory_id: item.memory.memory_id, reason_code: "RANKED_OUT" });
  }
  const currentState = request.current_state
    && (!request.current_state.expires_at || Date.parse(request.current_state.expires_at) > Date.parse(now))
    ? request.current_state : null;
  return {
    memories: selected,
    mandatory_evidence: selected.filter((item) => mandatory.has(item.memory.memory_id)),
    ranked_memories: selected.filter((item) => !mandatory.has(item.memory.memory_id)),
    matched_rules: selected.filter((item) => item.memory.memory_kind === "procedural" && ruleMatches(item.memory, request.situation))
      .map((item) => ({ memory_id: item.memory.memory_id, service_policy: item.memory.service_policy ?? item.memory.statement?.value?.service_policy })),
    current_state: currentState,
    conflicts: visibleConflicts,
    relations: architecture === "hybrid" ? safeRelations(edges, selectedIds, visibleIds) : [],
    omitted,
    trace: {
      plan: Object.fromEntries(Object.entries(channels).map(([name, hits]) => [name, hits.length])),
      selected_memory_ids: selected.map((item) => item.memory.memory_id),
      mandatory_memory_ids: selected.filter((item) => mandatory.has(item.memory.memory_id)).map((item) => item.memory.memory_id),
      elapsed_ms: Date.now() - started
    }
  };
}
