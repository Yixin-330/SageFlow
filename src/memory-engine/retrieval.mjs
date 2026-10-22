import { normalizeMemory } from "./memory-model.mjs";
import { evaluateScope } from "./scope.mjs";

const RRF_K = 60;
const CONSTRAINT = /budget|allerg|health_constraint|accessibility|safety|permission|must_avoid|constraint|预算|过敏|禁忌|无障碍/i;
const SERVICE = /notification_frequency|interrupt|提醒频率|打扰/i;
const MANDATORY_CAP = 8;
const BLOCKING_MANDATORY_REASONS = new Set(["SCOPE_UNRESOLVED", "SENSITIVE_RECALL_PERMISSION_REQUIRED"]);

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

const applicability = (memory, request, now) => evaluateScope(memory.scope, request, now);

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

function tripChannel(eligible, request) {
  if (!request.trip_id) return [];
  return ranked(eligible.filter(({ memory }) => memory.memory_tier === "short_term"
    && (memory.scope?.trips ?? memory.scope?.applies_when ?? []).includes(request.trip_id))
    .map(({ memory }) => ({ memory, score: (memory.salience ?? 0.5) + 0.1 })), "trip");
}

function isMandatory(memory, request) {
  if ((request.required_memory_ids ?? []).includes(memory.memory_id)) return true;
  if (request.purpose !== "decision") return false;
  if (["hard_constraint", "commitment"].includes(memory.service_role)) return true;
  if (memory.memory_kind === "procedural" && ruleMatches(memory, request.situation)) return true;
  const predicate = memory.statement?.predicate ?? "";
  return CONSTRAINT.test(predicate) || SERVICE.test(predicate);
}

function requiredIds(eligible, request, conflicts) {
  const ids = new Set();
  for (const { memory } of eligible) {
    if (isMandatory(memory, request)) ids.add(memory.memory_id);
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

export function validateStateSnapshot(state, request, now) {
  if (!state) return { state: null, status: "NOT_PROVIDED" };
  const required = ["state_id", "user_id", "trip_id", "observed_at", "expires_at", "model_version"];
  if (required.some((field) => !state[field]) || !state.dimensions || typeof state.dimensions !== "object") {
    return { state: null, status: "INVALID_STATE" };
  }
  if (state.sensitivity && !["normal", "sensitive"].includes(state.sensitivity)) {
    return { state: null, status: "INVALID_STATE" };
  }
  if (state.user_id !== request.user_id || !request.trip_id || state.trip_id !== request.trip_id) {
    return { state: null, status: "STATE_SCOPE_MISMATCH" };
  }
  const observed = Date.parse(state.observed_at);
  const expires = Date.parse(state.expires_at);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > current || expires <= current || expires <= observed) {
    return { state: null, status: "STATE_EXPIRED_OR_INVALID_TIME" };
  }
  if (Object.values(state.dimensions).some((dimension) => !dimension || typeof dimension !== "object"
    || !Object.hasOwn(dimension, "value") || !Number.isFinite(dimension.confidence)
    || dimension.confidence < 0 || dimension.confidence > 1
    || !Array.isArray(dimension.evidence_ids) || !dimension.evidence_ids.length)) {
    return { state: null, status: "STATE_EVIDENCE_REQUIRED" };
  }
  const sensitive = state.sensitivity === "sensitive"
    || Object.values(state.dimensions).some((dimension) => dimension.sensitivity === "sensitive");
  if (sensitive && !(request.permissions ?? []).includes("state:sensitive:read")) {
    return { state: null, status: "STATE_SENSITIVE_PERMISSION_REQUIRED" };
  }
  return { state, status: "ACCEPTED" };
}

export function eligibleMemoryIds(memories, request, now) {
  const permissions = new Set(request.permissions ?? []);
  return memories.map(normalizeMemory).filter((memory) => {
    if (memory.status !== "active") return false;
    if (memory.sensitivity === "sensitive" && !permissions.has("memory:sensitive:read")) return false;
    if (memory.valid_from && Date.parse(memory.valid_from) > Date.parse(now)) return false;
    if (memory.expires_at && Date.parse(memory.expires_at) <= Date.parse(now)) return false;
    return applicability(memory, request, now).allowed;
  }).map((memory) => memory.memory_id);
}

export async function retrieveMemories({ memories, conflicts = [], edges = [], request, now, architecture, embedder, fullTextHits = [], vectorHits = [] }) {
  const started = Date.now();
  const permissions = new Set(request.permissions ?? []);
  const omitted = [];
  const eligible = [];
  const evaluated = [];
  for (const original of memories) {
    const memory = normalizeMemory(original);
    let reasonCode = null;
    let scope = null;
    if (memory.status !== "active") reasonCode = "INACTIVE";
    else if (memory.sensitivity === "sensitive" && !permissions.has("memory:sensitive:read")) {
      reasonCode = "SENSITIVE_RECALL_PERMISSION_REQUIRED";
    } else if (memory.valid_from && Date.parse(memory.valid_from) > Date.parse(now)) reasonCode = "NOT_YET_VALID";
    else if (memory.expires_at && Date.parse(memory.expires_at) <= Date.parse(now)) reasonCode = "EXPIRED";
    else {
      scope = applicability(memory, request, now);
      if (!scope.allowed) reasonCode = scope.reason_code;
    }
    evaluated.push({ memory, reasonCode });
    if (reasonCode) {
      omitted.push(reasonCode === "SENSITIVE_RECALL_PERMISSION_REQUIRED"
        ? { reason_code: reasonCode }
        : { memory_id: memory.memory_id, reason_code: reasonCode });
    } else {
      eligible.push({ memory, applicability: scope });
    }
  }
  const unavailableMandatory = evaluated.filter(({ memory, reasonCode }) =>
    reasonCode && BLOCKING_MANDATORY_REASONS.has(reasonCode) && isMandatory(memory, request))
    .map(({ memory, reasonCode }) => {
      if (reasonCode === "SENSITIVE_RECALL_PERMISSION_REQUIRED") return { reason_code: reasonCode };
      return {
        memory_id: memory.memory_id,
        reason_code: reasonCode,
        predicate: memory.statement?.predicate ?? null,
        ...(memory.service_role ? { service_role: memory.service_role } : {})
      };
    });

  const structured = structuredChannel(eligible, request);
  const lexical = architecture === "flat" ? [] : lexicalChannel(eligible, request);
  const semantic = architecture === "flat" || vectorHits.length ? [] : await semanticChannel(eligible, request, embedder);
  const procedural = architecture === "flat" ? [] : proceduralChannel(eligible, request);
  const trip = tripChannel(eligible, request);
  const allowedMap = new Map(eligible.map(({ memory }) => [memory.memory_id, memory]));
  const external = (hits, channel) => ranked(hits.flatMap((hit) => allowedMap.has(hit.memory_id)
    ? [{ memory: allowedMap.get(hit.memory_id), score: Number(hit.score) }] : []), channel);
  const fullText = architecture === "flat" ? [] : external(fullTextHits, "full_text");
  const vector = architecture === "flat" ? [] : external(vectorHits, "vector");
  const seedIds = new Set([...structured, ...lexical, ...semantic, ...fullText, ...vector, ...procedural, ...trip]
    .slice(0, 20).map((item) => item.memory.memory_id));
  const graph = architecture === "hybrid" ? graphChannel(eligible, edges, seedIds) : [];
  const channels = { structured, lexical, full_text: fullText, semantic, vector, graph, procedural, trip };
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
    const tripBoost = item.memory.memory_tier === "short_term" && item.applicability === "current_trip" ? 0.12 : 0;
    const score = Number((item.rrf_score * 10 + quality + 0.4 * directRelevance + tripBoost).toFixed(4));
    return {
      ...item,
      layer: item.memory.memory_tier === "long_term" ? "long_term" : item.applicability === "current_trip" ? "trip" : "short_term",
      score,
      reason_codes: [mandatory.has(item.memory.memory_id) ? "MANDATORY_EVIDENCE" : null,
        ...Object.keys(item.channel_ranks).map((channel) => `RETRIEVED_${channel.toUpperCase()}`)].filter(Boolean),
      score_breakdown: { rrf: Number(item.rrf_score.toFixed(5)), quality: Number(quality.toFixed(4)), direct_relevance: Number(directRelevance.toFixed(4)), trip_boost: tripBoost }
    };
  }).sort((a, b) => b.score - a.score || a.memory.memory_id.localeCompare(b.memory.memory_id));

  const limit = request.limit ?? 5;
  const mandatoryRanked = rankedItems.filter((item) => mandatory.has(item.memory.memory_id));
  const selected = mandatoryRanked.slice(0, Math.max(limit, MANDATORY_CAP));
  const mandatoryOverflow = mandatoryRanked.slice(selected.length);
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
  const disputedIds = new Set(visibleConflicts.flatMap((conflict) => conflict.memory_ids));
  for (const item of selected) {
    if (!disputedIds.has(item.memory.memory_id)) continue;
    item.disputed = true;
    item.reason_codes.push("DISPUTED_MEMORY");
  }
  for (const item of rankedItems) {
    if (!selectedIds.has(item.memory.memory_id)) omitted.push({ memory_id: item.memory.memory_id,
      reason_code: mandatory.has(item.memory.memory_id) ? "MANDATORY_OVERFLOW" : "RANKED_OUT" });
  }
  const stateGate = validateStateSnapshot(request.current_state, request, now);
  return {
    memories: selected,
    long_term_memories: selected.filter((item) => item.layer === "long_term"),
    trip_memories: selected.filter((item) => item.layer === "trip"),
    short_term_memories: selected.filter((item) => item.layer === "short_term"),
    mandatory_evidence: selected.filter((item) => mandatory.has(item.memory.memory_id)),
    ranked_memories: selected.filter((item) => !mandatory.has(item.memory.memory_id)),
    matched_rules: selected.filter((item) => item.memory.memory_kind === "procedural" && ruleMatches(item.memory, request.situation))
      .map((item) => ({ memory_id: item.memory.memory_id, service_policy: item.memory.service_policy ?? item.memory.statement?.value?.service_policy })),
    current_state: stateGate.state,
    conflicts: visibleConflicts,
    relations: architecture === "hybrid" ? safeRelations(edges, selectedIds, visibleIds) : [],
    omitted,
    unavailable_mandatory: unavailableMandatory,
    trace: {
      plan: Object.fromEntries(Object.entries(channels).map(([name, hits]) => [name, hits.length])),
      selected_memory_ids: selected.map((item) => item.memory.memory_id),
      mandatory_memory_ids: selected.filter((item) => mandatory.has(item.memory.memory_id)).map((item) => item.memory.memory_id),
      mandatory_overflow_count: mandatoryOverflow.length,
      unavailable_mandatory: unavailableMandatory,
      unavailable_mandatory_count: unavailableMandatory.length,
      context_complete: mandatoryOverflow.length === 0 && unavailableMandatory.length === 0,
      state_status: stateGate.status,
      elapsed_ms: Date.now() - started
    }
  };
}
