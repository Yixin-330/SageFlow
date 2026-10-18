import { clone, legacyMemoryType, normalizeMemory, routeCandidate } from "./memory-model.mjs";
import { eligibleMemoryIds, memoryText, retrieveMemories } from "./retrieval.mjs";

const TRANSACTION_ACTIVE = Symbol("memory-transaction-active");

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameKey = (memory, candidate) => memory.statement.subject === candidate.statement.subject
  && memory.statement.predicate === candidate.statement.predicate
  && memory.scope.domain === candidate.scope.domain
  && memory.memory_domain === candidate.memory_domain
  && memory.memory_kind === candidate.memory_kind;
const sameScope = (memory, candidate) => JSON.stringify(memory.scope.applies_when ?? []) === JSON.stringify(candidate.scope.applies_when ?? []);

function makeMemory(candidate, eventMap, now) {
  const firstEvent = eventMap.get(candidate.evidence_event_ids[0]);
  const memory = {
    memory_id: `mem_${candidate.candidate_id}`,
    memory_tier: candidate.memory_tier,
    memory_domain: candidate.memory_domain,
    memory_kind: candidate.memory_kind,
    user_id: firstEvent?.user_id ?? candidate.user_id,
    statement: clone(candidate.statement),
    scope: clone(candidate.scope),
    confidence: candidate.confidence,
    salience: candidate.salience,
    evidence_event_ids: [...new Set(candidate.evidence_event_ids)],
    valid_from: firstEvent?.occurred_at ?? now,
    last_confirmed_at: firstEvent?.occurred_at ?? now,
    status: "active",
    sensitivity: candidate.sensitivity,
    retention: candidate.retention,
    extractor: candidate.extractor,
    version: 1,
    lineage_id: `mem_${candidate.candidate_id}`
  };
  // Transitional read compatibility for the existing prototype. New logic uses the
  // three canonical dimensions above and never branches on memory_type.
  memory.memory_type = legacyMemoryType(memory);
  return memory;
}

function edge(relation, sourceId, targetId, userId, now, evidenceEventIds = [], extra = {}) {
  return {
    edge_id: `edge_${relation}_${sourceId}_${targetId}`,
    user_id: userId,
    source_id: sourceId,
    source_type: "memory",
    relation,
    target_id: targetId,
    target_type: relation === "SUPPORTED_BY" ? "observation_event" : relation === "APPLIES_WHEN" ? "scope" : "memory",
    created_at: now,
    evidence_event_ids: evidenceEventIds,
    ...extra
  };
}

function mutation(operation, memoryId, candidate, now, extra = {}) {
  return {
    mutation_id: `mut_${candidate?.candidate_id ?? operation.toLowerCase()}_${Date.parse(now)}`,
    operation,
    target_memory_id: memoryId,
    candidate_id: candidate?.candidate_id ?? null,
    user_id: candidate?.user_id ?? extra.user_id,
    evidence_event_ids: candidate?.evidence_event_ids ?? [],
    occurred_at: now,
    ...extra
  };
}

export function createMemoryEngine({ repository, extractor, embedder, architecture = "hybrid", clock = { now: () => new Date().toISOString() } }) {
  if (!repository || !extractor) throw new Error("MemoryEngine requires repository and extractor adapters");
  if (!["flat", "typed", "hybrid"].includes(architecture)) throw new Error(`Unsupported memory architecture: ${architecture}`);
  if (embedder && repository.searchVector && !embedder.version) throw new Error("Postgres vector retrieval requires embedder.version");
  let recallSequence = 0;

  async function persistMemory(memory) {
    await repository.upsert(memory);
    if (memory.status === "active" && embedder && repository.upsertEmbedding) {
      if (!embedder.version) throw new Error("Postgres embedding persistence requires embedder.version");
      await repository.upsertEmbedding(memory.user_id, memory.memory_id, await embedder.embed(memoryText(memory)), embedder.version);
    }
  }

  async function saveEdge(record) {
    if (architecture === "hybrid" && repository.upsertEdge) await repository.upsertEdge(record);
  }

  async function saveEvidenceEdges(memory, now) {
    for (const eventId of memory.evidence_event_ids) {
      await saveEdge(edge("SUPPORTED_BY", memory.memory_id, eventId, memory.user_id, now, [eventId]));
    }
    for (const scope of memory.scope?.applies_when ?? []) {
      await saveEdge(edge("APPLIES_WHEN", memory.memory_id, scope, memory.user_id, now, memory.evidence_event_ids));
    }
  }

  return {
    async observe(events, options = {}) {
      if (!Array.isArray(events) || events.length === 0) throw new Error("observe requires at least one Observation Event");
      if (repository.withTransaction && !options[TRANSACTION_ACTIVE]) {
        return repository.withTransaction((transactionRepository) => createMemoryEngine({
          repository: transactionRepository,
          extractor,
          embedder,
          architecture,
          clock
        }).observe(events, { ...options, [TRANSACTION_ACTIVE]: true }));
      }
      const now = clock.now();
      const permissions = new Set(options.permissions ?? []);
      const ingestion = repository.appendObservationEvents
        ? await repository.appendObservationEvents(events)
        : { inserted_event_ids: events.map((item) => item.event_id), duplicate_event_ids: [] };
      const insertedIds = new Set(ingestion.inserted_event_ids);
      const acceptedEvents = events.filter((item) => insertedIds.has(item.event_id));
      const eventMap = new Map(acceptedEvents.map((item) => [item.event_id, item]));
      const extracted = await extractor.extract(acceptedEvents);
      const candidates = [];
      const rejections = [];
      const applied = [];
      const pending = [];

      for (const extractedCandidate of extracted) {
        const routed = routeCandidate(extractedCandidate);
        const candidate = routed.candidate;
        candidate.user_id ??= eventMap.get(candidate.evidence_event_ids[0])?.user_id;
        candidate.extractor = { name: extractor.name, version: extractor.version };
        candidates.push(candidate);
        const missingEvidence = candidate.evidence_event_ids.filter((id) => !eventMap.has(id));
        if (missingEvidence.length) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "MISSING_EVIDENCE", evidence_event_ids: missingEvidence });
          continue;
        }
        if (routed.disposition === "reject") {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: routed.reason_code });
          continue;
        }
        if (candidate.retention === "do_not_store") {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "RETENTION_POLICY_REJECTED" });
          continue;
        }
        if (candidate.sensitivity === "sensitive" && !permissions.has("memory:sensitive:write")) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "SENSITIVE_STORAGE_PERMISSION_REQUIRED" });
          continue;
        }
        if (routed.disposition === "pending") {
          const firstEvent = eventMap.get(candidate.evidence_event_ids[0]);
          const record = {
            pending_id: `pending_${candidate.candidate_id}`,
            user_id: firstEvent?.user_id ?? candidate.user_id,
            candidate: clone(candidate),
            reason_code: routed.reason_code,
            status: "pending",
            created_at: now
          };
          if (repository.appendPendingCandidate) await repository.appendPendingCandidate(record);
          pending.push(record);
          continue;
        }

        const userId = eventMap.get(candidate.evidence_event_ids[0])?.user_id;
        const existing = (await repository.listByUser(userId)).map(normalizeMemory);
        const activeForKey = existing.filter((item) => item.status === "active" && sameKey(item, candidate));
        const exact = activeForKey.find((item) => sameValue(item.statement.value, candidate.statement.value) && sameScope(item, candidate));

        if (exact) {
          exact.confidence = Math.min(0.99, Number((exact.confidence + (candidate.evidence_kind === "explicit_statement" ? 0.05 : 0.02)).toFixed(2)));
          exact.salience = Math.max(exact.salience, candidate.salience);
          exact.last_confirmed_at = now;
          exact.evidence_event_ids = [...new Set([...exact.evidence_event_ids, ...candidate.evidence_event_ids])];
          await persistMemory(exact);
          await saveEvidenceEdges({ ...exact, evidence_event_ids: candidate.evidence_event_ids }, now);
          const record = mutation("REINFORCE", exact.memory_id, candidate, now);
          await repository.appendMutation(record);
          applied.push(record);
          continue;
        }

        const contradictory = activeForKey.find((item) => !sameValue(item.statement.value, candidate.statement.value) && sameScope(item, candidate));
        const scopedAlternative = activeForKey.find((item) => !sameValue(item.statement.value, candidate.statement.value) && !sameScope(item, candidate));
        const isTemporary = candidate.memory_tier === "short_term" || candidate.retention === "current_trip";
        const created = makeMemory(candidate, eventMap, now);

        const splitHint = candidate.evolution_hint?.operation === "SPLIT" ? candidate.evolution_hint : null;
        const splitTarget = splitHint
          ? existing.find((item) => item.memory_id === splitHint.target_memory_id
            && (item.status === "active" || item.superseded_at === now))
          : null;

        if (splitTarget) {
          splitTarget.status = "superseded";
          splitTarget.superseded_at = now;
          const previousBranches = Array.isArray(splitTarget.superseded_by)
            ? splitTarget.superseded_by
            : splitTarget.superseded_by ? [splitTarget.superseded_by] : [];
          splitTarget.superseded_by = [...new Set([...previousBranches, created.memory_id])];
          created.version = (splitTarget.version ?? 1) + 1;
          created.lineage_id = splitTarget.lineage_id ?? splitTarget.memory_id;
          created.split_from = splitTarget.memory_id;
          await persistMemory(splitTarget);
          await persistMemory(created);
          await saveEvidenceEdges(created, now);
          await saveEdge(edge("DERIVED_FROM", created.memory_id, splitTarget.memory_id, created.user_id, now, candidate.evidence_event_ids, { split_group_id: splitHint.split_group_id }));
          const record = mutation("SPLIT", splitTarget.memory_id, candidate, now, { resulting_memory_id: created.memory_id, split_group_id: splitHint.split_group_id });
          await repository.appendMutation(record);
          applied.push(record);
        } else if (contradictory && candidate.evidence_kind === "user_correction") {
          contradictory.status = "superseded";
          contradictory.superseded_at = now;
          contradictory.superseded_by = created.memory_id;
          created.supersedes = contradictory.memory_id;
          created.version = (contradictory.version ?? 1) + 1;
          created.lineage_id = contradictory.lineage_id ?? contradictory.memory_id;
          await persistMemory(contradictory);
          await persistMemory(created);
          await saveEvidenceEdges(created, now);
          await saveEdge(edge("SUPERSEDES", created.memory_id, contradictory.memory_id, created.user_id, now, candidate.evidence_event_ids));
          const record = mutation("SUPERSEDE", contradictory.memory_id, candidate, now, { replacement_memory_id: created.memory_id });
          await repository.appendMutation(record);
          applied.push(record);
        } else if (contradictory && !isTemporary) {
          await persistMemory(created);
          await saveEvidenceEdges(created, now);
          const memoryIds = [contradictory.memory_id, created.memory_id].sort();
          const conflict = {
            conflict_id: `conflict_${memoryIds.join("_")}`,
            user_id: created.user_id,
            predicate: created.statement.predicate,
            memory_ids: memoryIds,
            status: "open",
            created_at: now,
            reason_code: "INCOMPATIBLE_VALUES_SAME_SCOPE"
          };
          await repository.createConflict(conflict);
          await saveEdge(edge("CONTRADICTS", created.memory_id, contradictory.memory_id, created.user_id, now, candidate.evidence_event_ids, { conflict_id: conflict.conflict_id }));
          const record = mutation("FLAG_CONFLICT", created.memory_id, candidate, now, { conflict_id: conflict.conflict_id, conflicting_memory_id: contradictory.memory_id });
          await repository.appendMutation(record);
          applied.push(record);
        } else {
          await persistMemory(created);
          await saveEvidenceEdges(created, now);
          if (scopedAlternative && !isTemporary) {
            await saveEdge(edge("EXCEPTION_TO", created.memory_id, scopedAlternative.memory_id, created.user_id, now, candidate.evidence_event_ids));
          }
          const record = mutation("CREATE", created.memory_id, candidate, now, {
            coexistence_reason: contradictory ? "TEMPORARY_SCOPE" : scopedAlternative ? "SCOPED_EXCEPTION" : null
          });
          await repository.appendMutation(record);
          applied.push(record);
        }
      }

      if (!candidates.length && acceptedEvents.some((item) => item.event_type === "feedback.action_rejected")) {
        const record = mutation("NO_LONG_TERM_CHANGE", null, null, now, { user_id: events[0].user_id, reason_code: "REJECTION_REASON_UNKNOWN", evidence_event_ids: acceptedEvents.map((item) => item.event_id) });
        await repository.appendMutation(record);
        applied.push(record);
      }

      if (!candidates.length && acceptedEvents.some((item) => item.event_type === "feedback.action_ignored")) {
        const record = mutation("ADJUST_FREQUENCY", null, null, now, { user_id: events[0].user_id, reason_code: "RECENT_ACTION_IGNORED", evidence_event_ids: acceptedEvents.map((item) => item.event_id) });
        await repository.appendMutation(record);
        applied.push(record);
      }

      const userId = events[0].user_id;
      const currentMemories = await repository.listByUser(userId);
      const currentRelations = architecture === "hybrid" && repository.listEdgesByMemoryIds
        ? await repository.listEdgesByMemoryIds(userId, currentMemories.map((item) => item.memory_id))
        : [];
      return {
        trace_id: events[0].trace_id,
        ingestion,
        candidates: clone(candidates),
        mutations: clone(applied),
        rejections,
        pending_candidates: clone(pending),
        memories: currentMemories,
        conflicts: await repository.listConflicts(userId),
        relations: currentRelations,
        architecture
      };
    },

    async recall(request) {
      const started = Date.now();
      const now = clock.now();
      const memories = (await repository.listByUser(request.user_id)).map(normalizeMemory);
      const conflicts = await repository.listConflicts(request.user_id);
      const relations = architecture === "hybrid" && repository.listEdgesByMemoryIds
        ? await repository.listEdgesByMemoryIds(request.user_id, memories.map((item) => item.memory_id))
        : [];
      const allowedIds = eligibleMemoryIds(memories, request, now);
      const channelLimit = Math.max(30, (request.limit ?? 5) * 4);
      const fullTextHits = architecture !== "flat" && request.query_text && repository.searchText
        ? await repository.searchText(request.user_id, request.query_text, allowedIds, channelLimit) : [];
      const vectorHits = architecture !== "flat" && request.query_text && embedder && repository.searchVector
        ? await repository.searchVector(request.user_id, await embedder.embed(request.query_text), embedder.version, allowedIds, channelLimit) : [];
      const retrieved = await retrieveMemories({ memories, conflicts, edges: relations, request, now, architecture, embedder, fullTextHits, vectorHits });
      retrieved.trace.elapsed_ms = Date.now() - started;
      recallSequence += 1;
      const uniqueRecallId = globalThis.crypto?.randomUUID?.() ?? `${Date.parse(now)}_${recallSequence}`;
      const bundle = {
        trace_id: request.trace_id ?? `recall_${request.user_id}_${uniqueRecallId}`,
        purpose: request.purpose,
        ...retrieved,
        policy_version: `memory-recall-${architecture}-0.3`,
        architecture
      };
      if (repository.appendRecallLog) {
        await repository.appendRecallLog({
          trace_id: bundle.trace_id,
          user_id: request.user_id,
          purpose: request.purpose,
          selected_memory_ids: bundle.trace.selected_memory_ids,
          omitted: clone(bundle.omitted),
          channel_counts: bundle.trace.plan,
          architecture,
          policy_version: bundle.policy_version,
          created_at: now
        });
      }
      return bundle;
    }
  };
}
