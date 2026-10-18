import { clone, normalizeMemory } from "../memory-model.mjs";

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
      const samePredicate = left.user_id === right.user_id
        && left.statement?.predicate === right.statement?.predicate
        && left.scope?.domain === right.scope?.domain;
      const differentValue = JSON.stringify(left.statement?.value) !== JSON.stringify(right.statement?.value);
      if (samePredicate && differentValue) {
        const memoryIds = [left.memory_id, right.memory_id].sort();
        const id = `conflict_${memoryIds.join("_")}`;
        conflicts.set(`${left.user_id}:${id}`, {
          conflict_id: id,
          user_id: left.user_id,
          predicate: left.statement.predicate,
          memory_ids: memoryIds,
          status: "open",
          created_at: left.last_confirmed_at,
          reason_code: "SEEDED_INCOMPATIBLE_VALUES"
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
    async appendRecallLog(record) {
      recallLogs.set(`${record.user_id}:${record.trace_id}`, clone(record));
      return clone(record);
    },
    async snapshot() {
      return {
        memories: clone([...memories.values()]),
        conflicts: clone([...conflicts.values()]),
        mutations: clone(mutations),
        edges: clone([...edges.values()]),
        pending_candidates: clone([...pendingCandidates.values()]),
        observation_events: clone([...observationEvents.values()]),
        recall_logs: clone([...recallLogs.values()])
      };
    }
  };
}
