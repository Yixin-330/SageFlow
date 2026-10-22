import { clone, legacyMemoryType, normalizeMemory, routeCandidate } from "./memory-model.mjs";
import { eligibleMemoryIds, memoryText, retrieveMemories } from "./retrieval.mjs";
import { conflictRelation, sameSubjectPredicate, sameValue, scopeRelation, validPredicateValue } from "./conflict-semantics.mjs";
import { canCollectPromotionSource, promotionPolicy } from "./promotion-policy.mjs";
import { mergePromotionGroup, promotionGroupIdentity, promotionSource } from "./promotion-groups.mjs";
import { decidePromotion, commonScope } from "./promotion-decision.mjs";

const TRANSACTION_ACTIVE = Symbol("memory-transaction-active");

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
    ...(candidate.service_role ? { service_role: candidate.service_role } : {}),
    retention: candidate.retention,
    ...(candidate.expires_at ? { expires_at: candidate.expires_at } : {}),
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

  async function closeConflictsForMemory(userId, memoryId, reason, resolverId, now, evidenceEventIds = []) {
    const open = await repository.listConflicts(userId);
    for (const conflict of open.filter((item) => item.memory_ids.includes(memoryId))) {
      conflict.status = "resolved";
      conflict.resolved_at = now;
      conflict.resolution_reason = reason;
      conflict.resolved_by = resolverId;
      await repository.createConflict(conflict);
      await saveEdge({ edge_id: `edge_RESOLVED_BY_${conflict.conflict_id}_${resolverId}`,
        user_id: userId, source_id: conflict.conflict_id, source_type: "conflict", relation: "RESOLVED_BY",
        target_id: resolverId, target_type: "memory", created_at: now, evidence_event_ids: evidenceEventIds });
    }
  }

  async function flagConflict(created, memory, relation, candidate, now, applied) {
    const memoryIds = [memory.memory_id, created.memory_id].sort();
    const conflict = {
      conflict_id: `conflict_${memoryIds.join("_")}`,
      user_id: created.user_id,
      predicate: created.statement.predicate,
      memory_ids: memoryIds,
      status: "open",
      created_at: now,
      reason_code: relation === "equal" ? "INCOMPATIBLE_VALUES_SAME_SCOPE" : "INCOMPATIBLE_VALUES_OVERLAPPING_SCOPE"
    };
    await repository.createConflict(conflict);
    await saveEdge(edge("CONTRADICTS", created.memory_id, memory.memory_id, created.user_id, now,
      candidate.evidence_event_ids, { conflict_id: conflict.conflict_id }));
    const record = mutation("FLAG_CONFLICT", created.memory_id, candidate, now,
      { conflict_id: conflict.conflict_id, conflicting_memory_id: memory.memory_id });
    record.mutation_id = `${record.mutation_id}_${memory.memory_id}`;
    await repository.appendMutation(record);
    applied.push(record);
  }

  async function saveExceptionEdges(created, alternatives, candidate, now) {
    for (const { memory, relation } of alternatives) {
      const specificId = relation === "a_covers_b" ? created.memory_id : memory.memory_id;
      const generalId = relation === "a_covers_b" ? memory.memory_id : created.memory_id;
      await saveEdge(edge("EXCEPTION_TO", specificId, generalId, created.user_id, now, candidate.evidence_event_ids));
    }
  }

  async function saveTemporalExceptionEdges(created, alternatives, candidate, now) {
    for (const { memory } of alternatives) {
      const shortTerm = created.memory_tier === "short_term" ? created : memory;
      const longTerm = created.memory_tier === "short_term" ? memory : created;
      await saveEdge(edge("EXCEPTION_TO", shortTerm.memory_id, longTerm.memory_id, created.user_id, now,
        candidate.evidence_event_ids, { temporal_override: true }));
    }
  }

  return {
    async expirePromotionGroups({ now = clock.now(), limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid promotion expiry limit");
      if (!repository.expirePromotionGroups) throw new Error("Repository does not support promotion group expiry");
      if (repository.withTransaction) {
        return repository.withTransaction((transactionRepository) => createMemoryEngine({ repository: transactionRepository,
          extractor, embedder, architecture, clock }).expirePromotionGroups({ now, limit }));
      }
      const groups = await repository.expirePromotionGroups(now, limit);
      const pending = repository.expirePendingCandidates ? await repository.expirePendingCandidates(now, limit) : [];
      return { groups, pending };
    },

    async forget({ user_id: userId, memory_id: memoryId, permissions = [] }) {
      if (!permissions.includes("memory:forget")) throw new Error("Memory forget permission required");
      if (!userId || !memoryId) throw new Error("forget requires exact user_id and memory_id");
      if (!repository.forgetArtifacts) throw new Error("Repository does not support memory forgetting");
      if (repository.withTransaction) {
        return repository.withTransaction((transactionRepository) => createMemoryEngine({ repository: transactionRepository,
          extractor, embedder, architecture, clock }).forget({ user_id: userId, memory_id: memoryId, permissions }));
      }
      const memories = await repository.listByUser(userId);
      const byId = new Map(memories.map((item) => [item.memory_id, item]));
      if (!byId.has(memoryId)) return { forgotten_memory_ids: [], status: "NOT_FOUND" };
      const edges = repository.listEdgesByMemoryIds
        ? await repository.listEdgesByMemoryIds(userId, memories.map((item) => item.memory_id)) : [];
      const forgottenIds = new Set([memoryId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of memories) {
          const parents = [item.split_from, item.derived_from, ...(item.promoted_from ?? [])].filter(Boolean);
          const linked = edges.some((edge) => ["DERIVED_FROM", "PROMOTED_FROM"].includes(edge.relation)
            && edge.source_id === item.memory_id && forgottenIds.has(edge.target_id));
          if (!forgottenIds.has(item.memory_id) && (parents.some((id) => forgottenIds.has(id)) || linked)) {
            forgottenIds.add(item.memory_id);
            changed = true;
          }
        }
      }
      const retainedEvidenceIds = new Set(memories.filter((item) => !forgottenIds.has(item.memory_id))
        .flatMap((item) => item.evidence_event_ids ?? []));
      const evidenceIds = new Set(memories.filter((item) => forgottenIds.has(item.memory_id) && !item.promotion_id)
        .flatMap((item) => item.evidence_event_ids ?? []));
      const groups = repository.listPromotionGroupsByUser
        ? await repository.listPromotionGroupsByUser(userId) : [];
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const group of groups) {
          if ((group.source_memory_ids ?? []).some((id) => forgottenIds.has(id))
            || forgottenIds.has(group.promoted_memory_id)
            || (group.evidence_event_ids ?? []).some((id) => evidenceIds.has(id))) {
            for (const id of group.evidence_event_ids ?? []) {
              if (!evidenceIds.has(id) && !retainedEvidenceIds.has(id)) {
                evidenceIds.add(id); expanded = true;
              }
            }
          }
        }
      }
      const shared = memories.filter((item) => !forgottenIds.has(item.memory_id)
        && (item.evidence_event_ids ?? []).some((id) => evidenceIds.has(id)));
      if (shared.length) throw new Error(`Shared evidence requires a wider forget request: ${shared.map((item) => item.memory_id).join(", ")}`);
      const ids = [...forgottenIds].sort();
      const now = clock.now();
      await repository.forgetArtifacts(userId, ids, [...evidenceIds], now);
      const mutations = [];
      for (const id of ids) {
        const record = { mutation_id: `mut_forget_${id}_${Date.parse(now)}`, operation: "FORGET",
          target_memory_id: id, user_id: userId, evidence_event_ids: [], occurred_at: now,
          reason_code: "USER_REQUESTED_FORGET" };
        await repository.appendMutation(record);
        mutations.push(record);
      }
      return { forgotten_memory_ids: ids, status: "FORGOTTEN", mutations };
    },

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
      if (repository.lockPromotionGroup) {
        const keys = new Map();
        const claimKeys = new Map();
        for (const raw of extracted) {
          const evidenceEvents = raw.evidence_event_ids.map((id) => eventMap.get(id)).filter(Boolean);
          if (evidenceEvents.length !== raw.evidence_event_ids.length || !evidenceEvents.length
            || evidenceEvents.some((event) => event.user_id !== evidenceEvents[0].user_id)) continue;
          const routed = routeCandidate(raw, evidenceEvents);
          if (!canCollectPromotionSource(routed.candidate, evidenceEvents)) continue;
          const userId = evidenceEvents[0].user_id;
          const identity = promotionGroupIdentity(userId, routed.candidate, evidenceEvents);
          const groupId = identity.group_id;
          keys.set(`${userId}\u0000${groupId}`, { userId, groupId });
          const claimKey = `${identity.claim.subject}:${routed.candidate.memory_domain}:${routed.candidate.memory_kind}:${identity.claim.predicate}`;
          claimKeys.set(`${userId}\u0000${claimKey}`, { userId, claimKey });
        }
        if (repository.lockPromotionClaim) for (const key of [...claimKeys.keys()].sort()) {
          const { userId, claimKey } = claimKeys.get(key);
          await repository.lockPromotionClaim(userId, claimKey);
        }
        for (const key of [...keys.keys()].sort()) {
          const { userId, groupId } = keys.get(key);
          await repository.lockPromotionGroup(userId, groupId);
        }
      }
      const candidates = [];
      const rejections = [];
      const applied = [];
      const pending = [];
      const promotionSources = [];
      const storedShortTerm = [];

      for (const extractedCandidate of extracted) {
        const evidenceEvents = extractedCandidate.evidence_event_ids.map((id) => eventMap.get(id)).filter(Boolean);
        const routed = routeCandidate(extractedCandidate, evidenceEvents);
        const candidate = routed.candidate;
        const sourceScope = clone(candidate.scope);
        candidate.user_id ??= eventMap.get(candidate.evidence_event_ids[0])?.user_id;
        candidate.extractor = { name: extractor.name, version: extractor.version };
        const missingEvidence = candidate.evidence_event_ids.filter((id) => !eventMap.has(id));
        const mismatchedEvidenceUsers = evidenceEvents.some((event) => event.user_id !== candidate.user_id);
        const evidenceTripIds = [...new Set(candidate.evidence_event_ids.map((id) => eventMap.get(id)?.trip_id).filter(Boolean))];
        if (candidate.retention === "current_trip" && evidenceTripIds.length === 1) {
          candidate.scope = { ...candidate.scope, trips: [evidenceTripIds[0]], applies_when: [evidenceTripIds[0]] };
        }
        candidates.push(candidate);
        if (missingEvidence.length) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "MISSING_EVIDENCE", evidence_event_ids: missingEvidence });
          continue;
        }
        if (mismatchedEvidenceUsers) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "CROSS_USER_EVIDENCE" });
          continue;
        }
        if (repository.isForgottenMemory && await repository.isForgottenMemory(candidate.user_id, `mem_${candidate.candidate_id}`)) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "FORGOTTEN_MEMORY_TOMBSTONE" });
          continue;
        }
        if (candidate.evidence_event_ids.every((id) => /^feedback\.action_/.test(eventMap.get(id)?.event_type ?? ""))) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "ACTION_FEEDBACK_NOT_PREFERENCE_EVIDENCE" });
          continue;
        }
        if (routed.disposition === "reject") {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: routed.reason_code });
          continue;
        }
        if (!validPredicateValue(candidate.statement?.predicate, candidate.statement?.value)) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "PREDICATE_VALUE_TYPE_MISMATCH" });
          continue;
        }
        if (candidate.retention === "do_not_store") {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "RETENTION_POLICY_REJECTED" });
          continue;
        }
        if (candidate.retention === "current_trip" && evidenceTripIds.length !== 1) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "CURRENT_TRIP_SCOPE_REQUIRED" });
          continue;
        }
        if (candidate.memory_tier === "short_term") {
          if (!["current_trip", "short_lived"].includes(candidate.retention)) {
            rejections.push({ candidate_id: candidate.candidate_id, reason_code: "SHORT_TERM_RETENTION_REQUIRED" });
            continue;
          }
          const firstEvent = eventMap.get(candidate.evidence_event_ids[0]);
          const tripEnd = firstEvent?.payload?.trip_ends_at;
          const deadlines = candidate.retention === "current_trip"
            ? [Date.parse(now) + 14 * 86_400_000, ...(tripEnd ? [Date.parse(tripEnd) + 86_400_000] : [])]
            : [];
          if (candidate.expires_at) deadlines.push(Date.parse(candidate.expires_at));
          if (candidate.scope?.time_window?.end) deadlines.push(Date.parse(candidate.scope.time_window.end));
          if (!deadlines.length || deadlines.some((value) => !Number.isFinite(value)) || Math.min(...deadlines) <= Date.parse(now)) {
            rejections.push({ candidate_id: candidate.candidate_id, reason_code: "SHORT_TERM_EXPIRY_REQUIRED" });
            continue;
          }
          candidate.expires_at = new Date(Math.min(...deadlines)).toISOString();
        }
        if (candidate.sensitivity === "sensitive" && !permissions.has("memory:sensitive:write")) {
          rejections.push({ candidate_id: candidate.candidate_id, reason_code: "SENSITIVE_STORAGE_PERMISSION_REQUIRED" });
          continue;
        }
        if (routed.disposition === "pending") {
          const firstEvent = eventMap.get(candidate.evidence_event_ids[0]);
          const collectable = canCollectPromotionSource(candidate, evidenceEvents);
          const source = collectable ? promotionSource({ candidate, sourceType: "pending",
            sourceId: "", events: evidenceEvents, sourceScope }) : null;
          const pendingId = source ? `pending_${source.group_id}` : `pending_${candidate.candidate_id}`;
          if (source) {
            source.source_id = pendingId;
            source.evidence.forEach((item) => { item.source_refs = [{ source_type: "pending", source_id: pendingId }]; });
            promotionSources.push(source);
          }
          const previous = repository.listPendingCandidates
            ? (await repository.listPendingCandidates(candidate.user_id)).find((item) => item.pending_id === pendingId
              && item.status === "pending" && Date.parse(item.observation_deadline_at) > Date.parse(now)) : null;
          const record = {
            pending_id: pendingId,
            user_id: firstEvent?.user_id ?? candidate.user_id,
            candidate: clone(previous?.candidate ?? candidate),
            ...(source ? { group_id: source.group_id, policy_version: routed.admission.policy.policy_version } : {}),
            candidate_ids: [...new Set([...(previous?.candidate_ids ?? []), candidate.candidate_id])].sort(),
            evidence_event_ids: [...new Set([...(previous?.evidence_event_ids ?? []), ...candidate.evidence_event_ids])].sort(),
            trip_ids: [...new Set([...(previous?.trip_ids ?? []), ...evidenceTripIds])].sort(),
            reason_code: routed.reason_code,
            status: "pending",
            created_at: previous?.created_at ?? now,
            updated_at: now,
            observation_deadline_at: previous?.observation_deadline_at
              ?? new Date(Date.parse(firstEvent?.occurred_at ?? now)
                + routed.admission.policy.observation_days * 86_400_000).toISOString()
          };
          if (repository.appendPendingCandidate) await repository.appendPendingCandidate(record);
          pending.push(record);
          continue;
        }

        const userId = eventMap.get(candidate.evidence_event_ids[0])?.user_id;
        const existing = (await repository.listByUser(userId)).map(normalizeMemory);
        const nowMs = Date.parse(now);
        const activeForKey = existing.filter((item) => item.status === "active"
          && !(item.expires_at && Date.parse(item.expires_at) <= nowMs)
          && !(item.valid_from && Date.parse(item.valid_from) > nowMs)
          && sameSubjectPredicate(item, candidate));
        const exact = activeForKey.find((item) => item.memory_tier === candidate.memory_tier
          && sameValue(item.statement.value, candidate.statement.value)
          && scopeRelation(item.scope, candidate.scope) === "equal");

        if (exact) {
          exact.confidence = Math.min(0.99, Number((exact.confidence + (candidate.evidence_kind === "explicit_statement" ? 0.05 : 0.02)).toFixed(2)));
          exact.salience = Math.max(exact.salience, candidate.salience);
          exact.last_confirmed_at = now;
          if (exact.memory_tier === "short_term" && candidate.expires_at) {
            exact.expires_at = new Date(Math.min(
              Date.parse(exact.expires_at ?? candidate.expires_at),
              Date.parse(candidate.expires_at)
            )).toISOString();
          }
          exact.evidence_event_ids = [...new Set([...exact.evidence_event_ids, ...candidate.evidence_event_ids])];
          await persistMemory(exact);
          await saveEvidenceEdges({ ...exact, evidence_event_ids: candidate.evidence_event_ids }, now);
          const record = mutation("REINFORCE", exact.memory_id, candidate, now);
          await repository.appendMutation(record);
          applied.push(record);
          if (candidate.memory_tier === "short_term") storedShortTerm.push({ candidate, sourceScope, sourceId: exact.memory_id, evidenceEvents });
          continue;
        }

        const alternatives = activeForKey.filter((item) => !sameValue(item.statement.value, candidate.statement.value))
          .map((memory) => ({ memory, relation: conflictRelation(memory, candidate) }));
        const contradictions = alternatives.filter((item) => item.relation === "equal" || item.relation === "overlap");
        const exactContradictions = contradictions.filter((item) => item.relation === "equal"
          && item.memory.memory_tier === candidate.memory_tier);
        const sameTierContradictions = contradictions.filter((item) => item.memory.memory_tier === candidate.memory_tier);
        const crossTierContradictions = contradictions.filter((item) => item.memory.memory_tier !== candidate.memory_tier);
        const scopedAlternatives = alternatives.filter((item) => item.relation === "a_covers_b" || item.relation === "b_covers_a");
        const correction = candidate.evidence_kind === "user_correction"
          || candidate.evidence_event_ids.some((id) => eventMap.get(id)?.event_type === "feedback.user_corrected");
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
          await closeConflictsForMemory(created.user_id, splitTarget.memory_id, "SCOPE_DISAMBIGUATION", created.memory_id, now, candidate.evidence_event_ids);
          await saveEvidenceEdges(created, now);
          await saveEdge(edge("DERIVED_FROM", created.memory_id, splitTarget.memory_id, created.user_id, now, candidate.evidence_event_ids, { split_group_id: splitHint.split_group_id }));
          const record = mutation("SPLIT", splitTarget.memory_id, candidate, now, { resulting_memory_id: created.memory_id, split_group_id: splitHint.split_group_id });
          await repository.appendMutation(record);
          applied.push(record);
        } else if (correction && exactContradictions.length) {
          const replaced = exactContradictions.map((item) => item.memory);
          created.supersedes = replaced.map((item) => item.memory_id);
          created.version = Math.max(...replaced.map((item) => item.version ?? 1)) + 1;
          created.lineage_id = replaced[0].lineage_id ?? replaced[0].memory_id;
          for (const memory of replaced) {
            memory.status = "superseded";
            memory.superseded_at = now;
            memory.superseded_by = created.memory_id;
            await persistMemory(memory);
          }
          await persistMemory(created);
          await saveEvidenceEdges(created, now);
          for (const memory of replaced) {
            await closeConflictsForMemory(created.user_id, memory.memory_id, "USER_CORRECTION", created.memory_id, now, candidate.evidence_event_ids);
            await saveEdge(edge("SUPERSEDES", created.memory_id, memory.memory_id, created.user_id, now, candidate.evidence_event_ids));
            const record = mutation("SUPERSEDE", memory.memory_id, candidate, now, { replacement_memory_id: created.memory_id });
            record.mutation_id = `${record.mutation_id}_${memory.memory_id}`;
            await repository.appendMutation(record);
            applied.push(record);
          }
          for (const { memory, relation } of sameTierContradictions.filter((item) => item.relation === "overlap")) {
            await flagConflict(created, memory, relation, candidate, now, applied);
          }
          await saveExceptionEdges(created, scopedAlternatives, candidate, now);
          await saveTemporalExceptionEdges(created, crossTierContradictions, candidate, now);
        } else if (sameTierContradictions.length) {
          await persistMemory(created);
          await saveEvidenceEdges(created, now);
          for (const { memory, relation } of sameTierContradictions) {
            await flagConflict(created, memory, relation, candidate, now, applied);
          }
          await saveExceptionEdges(created, scopedAlternatives, candidate, now);
          await saveTemporalExceptionEdges(created, crossTierContradictions, candidate, now);
        } else {
          await persistMemory(created);
          await saveEvidenceEdges(created, now);
          await saveExceptionEdges(created, scopedAlternatives, candidate, now);
          await saveTemporalExceptionEdges(created, crossTierContradictions, candidate, now);
          const record = mutation("CREATE", created.memory_id, candidate, now, {
            coexistence_reason: scopedAlternatives.length ? "SCOPED_EXCEPTION"
              : crossTierContradictions.length ? "TEMPORAL_EXCEPTION"
                : alternatives.length ? "DISTINCT_OR_UNRESOLVED_SCOPE" : null
          });
          await repository.appendMutation(record);
          applied.push(record);
        }
        if (candidate.memory_tier === "short_term") storedShortTerm.push({ candidate, sourceScope, sourceId: created.memory_id, evidenceEvents });
      }

      for (const event of acceptedEvents.filter((item) => item.event_type === "trip.ended" || item.event_type === "trip.cancelled")) {
        const memories = await repository.listByUser(event.user_id);
        for (const memory of memories) {
          if (memory.status !== "active" || memory.memory_tier !== "short_term") continue;
          if (!(memory.scope?.trips ?? memory.scope?.applies_when ?? []).includes(event.trip_id)) continue;
          memory.status = "expired";
          memory.expired_at = now;
          await persistMemory(memory);
          await closeConflictsForMemory(event.user_id, memory.memory_id, "EXPIRED", memory.memory_id, now, [event.event_id]);
          const record = mutation("EXPIRE", memory.memory_id, null, now, {
            user_id: event.user_id, evidence_event_ids: [event.event_id], reason_code: event.event_type.toUpperCase().replace(".", "_")
          });
          record.mutation_id = `mut_expire_${memory.memory_id}_${Date.parse(now)}`;
          await repository.appendMutation(record);
          applied.push(record);
        }
      }

      for (const feedback of acceptedEvents.filter((item) => ["feedback.action_accepted", "feedback.action_rejected", "feedback.action_ignored"].includes(item.event_type))) {
        const recallTraceId = feedback.payload?.recall_trace_id;
        const recallLog = recallTraceId && repository.getRecallLog
          ? await repository.getRecallLog(feedback.user_id, recallTraceId) : null;
        if (recallTraceId && !recallLog) {
          rejections.push({ event_id: feedback.event_id, reason_code: "RECALL_TRACE_NOT_FOUND" });
          continue;
        }
        const operation = feedback.event_type === "feedback.action_ignored" ? "ADJUST_FREQUENCY" : "NO_LONG_TERM_CHANGE";
        const record = mutation(operation, null, null, now, {
          user_id: feedback.user_id,
          evidence_event_ids: [feedback.event_id],
          reason_code: feedback.event_type === "feedback.action_ignored" ? "RECENT_ACTION_IGNORED"
            : feedback.event_type === "feedback.action_rejected" ? "REJECTION_REASON_UNKNOWN" : "ACTION_ACCEPTED_NOT_PREFERENCE_CONFIRMATION",
          ...(recallLog ? { recall_trace_id: recallTraceId, supported_memory_ids: recallLog.selected_memory_ids } : {})
        });
        record.mutation_id = `mut_${operation.toLowerCase()}_${feedback.event_id}`;
        await repository.appendMutation(record);
        applied.push(record);
        for (const memoryId of recallLog?.selected_memory_ids ?? []) {
          await saveEdge(edge("RECALLED_BEFORE_FEEDBACK", memoryId, feedback.event_id, feedback.user_id, now,
            [feedback.event_id], { target_type: "feedback", recall_trace_id: recallTraceId,
              feedback_outcome: feedback.event_type }));
        }
      }

      for (const { candidate, sourceScope, sourceId, evidenceEvents } of storedShortTerm) {
        if (!canCollectPromotionSource(candidate, evidenceEvents)) continue;
        promotionSources.push(promotionSource({ candidate, sourceType: "short_term",
          sourceId, events: evidenceEvents, sourceScope }));
      }
      const affectedGroups = new Map();
      for (const source of promotionSources) {
        if (!repository.getPromotionGroup || !repository.upsertPromotionGroup) continue;
        const existingGroup = await repository.getPromotionGroup(source.user_id, source.group_id);
        const group = mergePromotionGroup(existingGroup, source, now);
        await repository.upsertPromotionGroup(group);
        affectedGroups.set(group.group_id, group);
      }

      const promotionDecisions = [];
      // The complete batch has already settled corrections and same-tier conflicts here.
      for (const group of affectedGroups.values()) {
        const peers = repository.listPromotionGroupsByClaim
          ? await repository.listPromotionGroupsByClaim(group.user_id, group.claim, group.memory_domain, group.memory_kind) : [];
        const counterEvidence = peers.filter((item) => item.group_id !== group.group_id
          && !["expired", "rejected_by_policy"].includes(item.status)
          && !sameValue(item.claim.value, group.claim.value))
          .flatMap((item) => {
            const credible = (item.evidence ?? []).filter((entry) => entry.confidence >= promotionPolicy(item.claim.predicate).min_evidence_confidence
              && entry.evidence_kind !== "inference");
            const scope = commonScope(credible.map((entry) => entry.source_scope ?? item.scope_anchor));
            return scope ? [{ value: item.claim.value, scope, group_id: item.group_id }] : [];
          });
        const longTerm = (await repository.listByUser(group.user_id)).filter((item) => item.memory_tier === "long_term");
        const decision = decidePromotion({ group, policy: promotionPolicy(group.claim.predicate), now,
          counterEvidence, existingLongTerm: longTerm });
        promotionDecisions.push(decision);
        group.last_evaluated_at = now;
        group.status_reason = decision.reason_code;
        if (decision.action === "promote") {
          const priorResult = repository.getPromotionResult
            ? await repository.getPromotionResult(group.user_id, decision.promotion_key) : null;
          if (priorResult) {
            group.status = "promoted";
            group.promoted_memory_id = priorResult.memory_id;
          } else {
            const candidate = { candidate_id: decision.promotion_key, user_id: group.user_id,
              memory_tier: "long_term", memory_domain: group.memory_domain, memory_kind: group.memory_kind,
              statement: group.claim, scope: decision.target_scope, confidence: decision.confidence,
              salience: 0.7, evidence_event_ids: decision.evidence_event_ids,
              retention: "long_term_candidate", sensitivity: "normal",
              extractor: { name: "promotion-policy", version: group.policy_version } };
            const existing = decision.existing_memory_id
              ? longTerm.find((item) => item.memory_id === decision.existing_memory_id) : null;
            const promoted = existing ? clone(existing) : makeMemory(candidate, eventMap, now);
            if (existing) {
              promoted.evidence_event_ids = [...new Set([...promoted.evidence_event_ids, ...decision.evidence_event_ids])].sort();
              promoted.evidence_trip_ids = [...new Set([...(promoted.evidence_trip_ids ?? []), ...decision.evidence_trip_ids])].sort();
              promoted.promoted_from = [...new Set([...(promoted.promoted_from ?? []), ...group.source_memory_ids])].sort();
              promoted.promotion_history = [...(promoted.promotion_history ?? []), {
                promotion_id: decision.promotion_key, promotion_group_id: group.group_id,
                promotion_policy_version: group.policy_version, promoted_at: now }];
              promoted.last_confirmed_at = now;
            } else {
              promoted.memory_id = `mem_${decision.promotion_key}`;
              promoted.lineage_id = promoted.memory_id;
              promoted.promotion_group_id = group.group_id;
              promoted.promotion_scope_hash = decision.promotion_key;
              promoted.promoted_from = [...group.source_memory_ids];
              promoted.promotion_id = decision.promotion_key;
              promoted.promotion_policy_version = group.policy_version;
              promoted.evidence_trip_ids = decision.evidence_trip_ids;
              promoted.generalized_scope = clone(decision.target_scope);
              promoted.promoted_at = now;
            }
            await persistMemory(promoted);
            await saveEvidenceEdges({ ...promoted, evidence_event_ids: decision.evidence_event_ids }, now);
            for (const sourceId of group.source_memory_ids) {
              await saveEdge(edge("PROMOTED_FROM", promoted.memory_id, sourceId, group.user_id, now,
                decision.evidence_event_ids, { promotion_id: decision.promotion_key }));
            }
            const record = mutation("PROMOTE", promoted.memory_id, candidate, now, {
              promotion_id: decision.promotion_key, promotion_group_id: group.group_id,
              promotion_policy_version: group.policy_version, reason_code: decision.reason_code,
              source_memory_ids: [...group.source_memory_ids] });
            record.mutation_id = `mut_${decision.promotion_key}`;
            await repository.appendMutation(record);
            applied.push(record);
            if (repository.recordPromotionResult) await repository.recordPromotionResult({
              user_id: group.user_id, promotion_key: decision.promotion_key, group_id: group.group_id,
              memory_id: promoted.memory_id, evidence_event_ids: decision.evidence_event_ids,
              evidence_trip_ids: decision.evidence_trip_ids, created_at: now });
            if (repository.listPendingCandidates && repository.appendPendingCandidate && group.pending_ids.length) {
              const activePending = await repository.listPendingCandidates(group.user_id);
              for (const item of activePending.filter((entry) => group.pending_ids.includes(entry.pending_id)
                && entry.status === "pending")) {
                item.status = "promoted";
                item.promoted_at = now;
                item.promoted_memory_id = promoted.memory_id;
                await repository.appendPendingCandidate(item);
                const batchEntry = pending.find((entry) => entry.pending_id === item.pending_id);
                if (batchEntry) Object.assign(batchEntry, item);
              }
            }
            group.status = "promoted";
            group.promoted_at = now;
            group.promoted_memory_id = promoted.memory_id;
            group.promotion_id = decision.promotion_key;
          }
        } else if (["expire", "needs_confirmation", "blocked_by_counter_evidence", "rejected_by_policy"].includes(decision.action)) {
          group.status = decision.action === "expire" ? "expired" : decision.action;
        }
        await repository.upsertPromotionGroup(group);
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
        promotion_groups: clone([...affectedGroups.values()]),
        promotion_decisions: clone(promotionDecisions),
        memories: currentMemories,
        conflicts: await repository.listConflicts(userId),
        relations: currentRelations,
        architecture
      };
    },

    async recall(request) {
      if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50)) {
        throw new Error("Recall limit must be an integer from 1 to 50");
      }
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
        evaluated_at: now,
        ...retrieved,
        policy_version: `memory-recall-${architecture}-0.4`,
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
          mandatory_overflow_count: bundle.trace.mandatory_overflow_count,
          unavailable_mandatory_count: bundle.trace.unavailable_mandatory_count,
          context_complete: bundle.trace.context_complete,
          architecture,
          policy_version: bundle.policy_version,
          created_at: now
        });
      }
      return bundle;
    }
  };
}
