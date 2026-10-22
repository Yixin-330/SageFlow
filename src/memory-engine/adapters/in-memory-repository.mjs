import { clone, normalizeMemory } from "../memory-model.mjs";
import { conflictRelation } from "../conflict-semantics.mjs";

export function createInMemoryMemoryRepository(seed = []) {
  const memories = new Map(seed.map((item) => {
    const normalized = normalizeMemory(item);
    return [`${normalized.user_id}:${normalized.memory_id}`, normalized];
  }));
  const conflicts = new Map();
  const mutations = [];
  const edges = new Map();
  const pendingCandidates = new Map();
  const observationEvents = new Map();
  const recallLogs = new Map();
  const tombstones = new Map();
  const promotionGroups = new Map();
  const promotionResults = new Map();

  for (const memory of memories.values()) {
    for (const eventId of memory.evidence_event_ids ?? []) {
      const edgeId = `edge_SUPPORTED_BY_${memory.memory_id}_${eventId}`;
      edges.set(`${memory.user_id}:${edgeId}`, {
        edge_id: edgeId,
        user_id: memory.user_id,
        source_id: memory.memory_id,
        source_type: "memory",
        relation: "SUPPORTED_BY",
        target_id: eventId,
        target_type: "observation_event",
        created_at: memory.last_confirmed_at,
        evidence_event_ids: [eventId]
      });
    }
    for (const scope of memory.scope?.applies_when ?? []) {
      const edgeId = `edge_APPLIES_WHEN_${memory.memory_id}_${scope}`;
      edges.set(`${memory.user_id}:${edgeId}`, {
        edge_id: edgeId,
        user_id: memory.user_id,
        source_id: memory.memory_id,
        source_type: "memory",
        relation: "APPLIES_WHEN",
        target_id: scope,
        target_type: "scope",
        created_at: memory.last_confirmed_at,
        evidence_event_ids: [...memory.evidence_event_ids]
      });
    }
  }

  const active = [...memories.values()].filter((item) => item.status === "active");
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const left = active[leftIndex];
      const right = active[rightIndex];
      const relation = left.user_id === right.user_id ? conflictRelation(left, right) : "none";
      if (relation === "equal" || relation === "overlap") {
        const memoryIds = [left.memory_id, right.memory_id].sort();
        const id = `conflict_${memoryIds.join("_")}`;
        conflicts.set(`${left.user_id}:${id}`, {
          conflict_id: id,
          user_id: left.user_id,
          predicate: left.statement.predicate,
          memory_ids: memoryIds,
          status: "open",
          created_at: left.last_confirmed_at,
          reason_code: relation === "equal" ? "SEEDED_INCOMPATIBLE_VALUES" : "SEEDED_OVERLAPPING_SCOPE"
        });
        const edgeId = `edge_CONTRADICTS_${memoryIds.join("_")}`;
        edges.set(`${left.user_id}:${edgeId}`, {
          edge_id: edgeId,
          user_id: left.user_id,
          source_id: memoryIds[0],
          source_type: "memory",
          relation: "CONTRADICTS",
          target_id: memoryIds[1],
          target_type: "memory",
          created_at: left.last_confirmed_at,
          evidence_event_ids: []
        });
      } else if (relation === "a_covers_b" || relation === "b_covers_a") {
        const specific = relation === "a_covers_b" ? right : left;
        const general = relation === "a_covers_b" ? left : right;
        const edgeId = `edge_EXCEPTION_TO_${specific.memory_id}_${general.memory_id}`;
        edges.set(`${left.user_id}:${edgeId}`, {
          edge_id: edgeId,
          user_id: left.user_id,
          source_id: specific.memory_id,
          source_type: "memory",
          relation: "EXCEPTION_TO",
          target_id: general.memory_id,
          target_type: "memory",
          created_at: specific.last_confirmed_at,
          evidence_event_ids: [...specific.evidence_event_ids]
        });
      }
    }
  }

  return {
    async appendObservationEvents(events) {
      const insertedEventIds = [];
      const duplicateEventIds = [];
      for (const event of events) {
        const key = `${event.user_id}:${event.event_id}`;
        const existing = observationEvents.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error(`Observation Event is immutable: ${event.event_id}`);
        }
        if (existing) duplicateEventIds.push(event.event_id);
        else {
          observationEvents.set(key, clone(event));
          insertedEventIds.push(event.event_id);
        }
      }
      return { inserted_event_ids: insertedEventIds, duplicate_event_ids: duplicateEventIds };
    },
    async listByUser(userId) {
      return clone([...memories.values()].filter((item) => item.user_id === userId));
    },
    async upsert(memory) {
      const normalized = normalizeMemory(memory);
      memories.set(`${normalized.user_id}:${normalized.memory_id}`, normalized);
      return clone(normalized);
    },
    async appendMutation(mutation) {
      mutations.push(clone(mutation));
      return clone(mutation);
    },
    async createConflict(conflict) {
      conflicts.set(`${conflict.user_id}:${conflict.conflict_id}`, clone(conflict));
      return clone(conflict);
    },
    async listConflicts(userId) {
      return clone([...conflicts.values()].filter((item) => item.user_id === userId && item.status === "open"));
    },
    async upsertEdge(edge) {
      edges.set(`${edge.user_id}:${edge.edge_id}`, clone(edge));
      return clone(edge);
    },
    async listEdgesByMemoryIds(userId, memoryIds) {
      const selected = new Set(memoryIds);
      return clone([...edges.values()].filter((item) => item.user_id === userId
        && (selected.has(item.source_id) || selected.has(item.target_id))));
    },
    async appendPendingCandidate(record) {
      pendingCandidates.set(`${record.user_id}:${record.pending_id}`, clone(record));
      return clone(record);
    },
    async listPendingCandidates(userId) {
      return clone([...pendingCandidates.values()].filter((item) => item.user_id === userId));
    },
    async expirePendingCandidates(now, limit = 100) {
      const due = [...pendingCandidates.values()].filter((item) => item.status === "pending"
        && item.observation_deadline_at && Date.parse(item.observation_deadline_at) <= Date.parse(now))
        .sort((a, b) => a.observation_deadline_at.localeCompare(b.observation_deadline_at)).slice(0, limit);
      for (const item of due) {
        item.status = "expired";
        item.expired_at = now;
        item.status_reason = "OBSERVATION_WINDOW_EXPIRED";
        pendingCandidates.set(`${item.user_id}:${item.pending_id}`, clone(item));
      }
      return clone(due);
    },
    async getPromotionGroup(userId, groupId) {
      const record = promotionGroups.get(`${userId}:${groupId}`);
      return record ? clone(record) : null;
    },
    async listPromotionGroupsByUser(userId) {
      return clone([...promotionGroups.values()].filter((item) => item.user_id === userId));
    },
    async listPromotionGroupsByClaim(userId, claim, domain, kind) {
      return clone([...promotionGroups.values()].filter((item) => item.user_id === userId
        && item.claim.subject === claim.subject && item.claim.predicate === claim.predicate
        && item.memory_domain === domain && item.memory_kind === kind));
    },
    async getPromotionResult(userId, promotionKey) {
      return clone(promotionResults.get(`${userId}:${promotionKey}`) ?? null);
    },
    async recordPromotionResult(record) {
      const key = `${record.user_id}:${record.promotion_key}`;
      if (promotionResults.has(key)) return clone(promotionResults.get(key));
      promotionResults.set(key, clone(record));
      return clone(record);
    },
    async upsertPromotionGroup(record) {
      promotionGroups.set(`${record.user_id}:${record.group_id}`, clone(record));
      return clone(record);
    },
    async expirePromotionGroups(now, limit = 100) {
      const due = [...promotionGroups.values()].filter((item) =>
        ["collecting", "eligible", "needs_confirmation", "blocked_by_counter_evidence"].includes(item.status)
        && Date.parse(item.observation_deadline_at) <= Date.parse(now))
        .sort((a, b) => a.observation_deadline_at.localeCompare(b.observation_deadline_at)).slice(0, limit);
      for (const item of due) {
        item.status = "expired";
        item.expired_at = now;
        item.last_evaluated_at = now;
        item.status_reason = "OBSERVATION_WINDOW_EXPIRED";
        promotionGroups.set(`${item.user_id}:${item.group_id}`, clone(item));
      }
      return clone(due);
    },
    async appendRecallLog(record) {
      recallLogs.set(`${record.user_id}:${record.trace_id}`, clone(record));
      return clone(record);
    },
    async getRecallLog(userId, traceId) {
      const record = recallLogs.get(`${userId}:${traceId}`);
      return record ? clone(record) : null;
    },
    async isForgottenMemory(userId, memoryId) {
      return tombstones.has(`${userId}:${memoryId}`);
    },
    async forgetArtifacts(userId, memoryIds, evidenceEventIds, forgottenAt) {
      const ids = new Set(memoryIds);
      const evidence = new Set(evidenceEventIds);
      for (const id of ids) {
        memories.delete(`${userId}:${id}`);
        tombstones.set(`${userId}:${id}`, { user_id: userId, memory_id: id, forgotten_at: forgottenAt });
      }
      for (const [key, item] of edges) {
        if (item.user_id === userId && (ids.has(item.source_id) || ids.has(item.target_id)
          || evidence.has(item.source_id) || evidence.has(item.target_id))) edges.delete(key);
      }
      for (const [key, item] of conflicts) {
        if (item.user_id === userId && item.memory_ids.some((id) => ids.has(id))) conflicts.delete(key);
      }
      for (const [key, item] of pendingCandidates) {
        if (item.user_id === userId && (item.evidence_event_ids ?? item.candidate?.evidence_event_ids ?? [])
          .some((id) => evidence.has(id))) pendingCandidates.delete(key);
      }
      for (const [key, item] of promotionGroups) {
        if (item.user_id === userId && ((item.evidence_event_ids ?? []).some((id) => evidence.has(id))
          || (item.source_memory_ids ?? []).some((id) => ids.has(id))
          || ids.has(item.promoted_memory_id))) promotionGroups.delete(key);
      }
      for (const [key, item] of promotionResults) {
        if (item.user_id === userId && (ids.has(item.memory_id)
          || (item.evidence_event_ids ?? []).some((id) => evidence.has(id)))) promotionResults.delete(key);
      }
      for (const [key, item] of recallLogs) {
        if (item.user_id === userId && ((item.selected_memory_ids ?? []).some((id) => ids.has(id))
          || (item.omitted ?? []).some((entry) => ids.has(entry.memory_id)))) recallLogs.delete(key);
      }
      for (const id of evidence) observationEvents.delete(`${userId}:${id}`);
    },
    async snapshot() {
      return {
        memories: clone([...memories.values()]),
        conflicts: clone([...conflicts.values()]),
        mutations: clone(mutations),
        edges: clone([...edges.values()]),
        pending_candidates: clone([...pendingCandidates.values()]),
        promotion_groups: clone([...promotionGroups.values()]),
        promotion_results: clone([...promotionResults.values()]),
        observation_events: clone([...observationEvents.values()]),
        recall_logs: clone([...recallLogs.values()]),
        tombstones: clone([...tombstones.values()])
      };
    }
  };
}
