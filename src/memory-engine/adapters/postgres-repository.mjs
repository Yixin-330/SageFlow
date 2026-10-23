const json = (value) => JSON.stringify(value);

function rows(result) {
  return result.rows.map((row) => typeof row.document === "string" ? JSON.parse(row.document) : row.document);
}

function buildRepository(queryable, { transactional = false } = {}) {
  const repository = {
    async appendObservationEvents(events) {
      const insertedEventIds = [];
      const duplicateEventIds = [];
      for (const event of events) {
        const result = await queryable.query(
          `INSERT INTO observation_events (user_id, event_id, trip_id, occurred_at, recorded_at, event_type, document)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (user_id, event_id) DO NOTHING
           RETURNING event_id`,
          [event.user_id, event.event_id, event.trip_id, event.occurred_at, event.recorded_at, event.event_type, json(event)]
        );
        if (result.rowCount > 0) {
          insertedEventIds.push(event.event_id);
          continue;
        }
        const existing = await queryable.query(
          "SELECT 1 FROM observation_events WHERE user_id = $1 AND event_id = $2 AND document = $3::jsonb",
          [event.user_id, event.event_id, json(event)]
        );
        if (!existing.rows.length) throw new Error(`Observation Event is immutable: ${event.event_id}`);
        duplicateEventIds.push(event.event_id);
      }
      return { inserted_event_ids: insertedEventIds, duplicate_event_ids: duplicateEventIds };
    },

    async listByUser(userId) {
      return rows(await queryable.query(
        "SELECT document FROM memory_items WHERE user_id = $1 ORDER BY updated_at DESC",
        [userId]
      ));
    },

    async searchText(userId, queryText, allowedIds, limit = 30) {
      if (!queryText?.trim() || !allowedIds.length) return [];
      const result = await queryable.query(
        `SELECT memory_id,
           ts_rank_cd(to_tsvector('simple',
             COALESCE(document->>'label', '') || ' ' ||
             COALESCE(document->'statement'->>'subject', '') || ' ' ||
             COALESCE(document->'statement'->>'predicate', '') || ' ' ||
             COALESCE(document->'statement'->>'value', '')
           ), plainto_tsquery('simple', $2)) AS score
         FROM memory_items
         WHERE user_id = $1 AND memory_id = ANY($3::text[])
           AND to_tsvector('simple',
             COALESCE(document->>'label', '') || ' ' ||
             COALESCE(document->'statement'->>'subject', '') || ' ' ||
             COALESCE(document->'statement'->>'predicate', '') || ' ' ||
             COALESCE(document->'statement'->>'value', '')
           ) @@ plainto_tsquery('simple', $2)
         ORDER BY score DESC LIMIT $4`,
        [userId, queryText, allowedIds, limit]
      );
      return result.rows.map((row) => ({ memory_id: row.memory_id, score: Number(row.score) }));
    },

    async upsertEmbedding(userId, memoryId, vector, modelVersion) {
      if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("Embedding must be a nonempty finite number array");
      }
      await queryable.query(
        `INSERT INTO memory_embeddings (user_id, memory_id, model_version, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (user_id, memory_id) DO UPDATE SET
           model_version = EXCLUDED.model_version,
           embedding = EXCLUDED.embedding,
           updated_at = NOW()`,
        [userId, memoryId, modelVersion, `[${vector.join(",")}]`]
      );
    },

    async searchVector(userId, vector, modelVersion, allowedIds, limit = 30) {
      if (!allowedIds.length) return [];
      const result = await queryable.query(
        `SELECT memory_id, 1 - (embedding <=> $2::vector) AS score
         FROM memory_embeddings
         WHERE user_id = $1 AND model_version = $3 AND memory_id = ANY($4::text[])
         ORDER BY embedding <=> $2::vector LIMIT $5`,
        [userId, `[${vector.join(",")}]`, modelVersion, allowedIds, limit]
      );
      return result.rows.map((row) => ({ memory_id: row.memory_id, score: Number(row.score) }));
    },

    async upsert(memory) {
      await queryable.query(
        `INSERT INTO memory_items (user_id, memory_id, status, memory_tier, memory_domain, memory_kind, document, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
         ON CONFLICT (user_id, memory_id) DO UPDATE SET
           status = EXCLUDED.status,
           memory_tier = EXCLUDED.memory_tier,
           memory_domain = EXCLUDED.memory_domain,
           memory_kind = EXCLUDED.memory_kind,
           document = EXCLUDED.document,
           updated_at = NOW()`,
        [memory.user_id, memory.memory_id, memory.status, memory.memory_tier, memory.memory_domain, memory.memory_kind, json(memory)]
      );
      return memory;
    },

    async appendMutation(mutation) {
      await queryable.query(
        `INSERT INTO memory_mutations (user_id, mutation_id, target_memory_id, operation, document)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (user_id, mutation_id) DO NOTHING`,
        [mutation.user_id, mutation.mutation_id, mutation.target_memory_id, mutation.operation, json(mutation)]
      );
      return mutation;
    },

    async createConflict(conflict) {
      await queryable.query(
        `INSERT INTO memory_conflict_sets (user_id, conflict_id, status, document)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (user_id, conflict_id) DO UPDATE SET status = EXCLUDED.status, document = EXCLUDED.document, updated_at = NOW()`,
        [conflict.user_id, conflict.conflict_id, conflict.status, json(conflict)]
      );
      return conflict;
    },

    async listConflicts(userId) {
      return rows(await queryable.query(
        "SELECT document FROM memory_conflict_sets WHERE user_id = $1 AND status = 'open'",
        [userId]
      ));
    },

    async upsertEdge(edge) {
      await queryable.query(
        `INSERT INTO memory_edges (user_id, edge_id, source_id, relation, target_id, document)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (user_id, edge_id) DO UPDATE SET document = EXCLUDED.document`,
        [edge.user_id, edge.edge_id, edge.source_id, edge.relation, edge.target_id, json(edge)]
      );
      return edge;
    },

    async listEdgesByMemoryIds(userId, memoryIds) {
      if (!memoryIds.length) return [];
      return rows(await queryable.query(
        "SELECT document FROM memory_edges WHERE user_id = $1 AND (source_id = ANY($2::text[]) OR target_id = ANY($2::text[]))",
        [userId, memoryIds]
      ));
    },

    async appendPendingCandidate(record) {
      await queryable.query(
        `INSERT INTO memory_pending_candidates (user_id, pending_id, status, document)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (user_id, pending_id) DO UPDATE SET status = EXCLUDED.status, document = EXCLUDED.document`,
        [record.user_id, record.pending_id, record.status, json(record)]
      );
      return record;
    },

    async listPendingCandidates(userId) {
      return rows(await queryable.query(
        "SELECT document FROM memory_pending_candidates WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC",
        [userId]
      ));
    },

    async expirePendingCandidates(now, limit = 100) {
      if (!transactional) throw new Error("Pending expiry requires a repository transaction");
      const due = rows(await queryable.query(
        `SELECT document FROM memory_pending_candidates
         WHERE status = 'pending' AND (document->>'observation_deadline_at')::timestamptz <= $1
         ORDER BY (document->>'observation_deadline_at')::timestamptz
         LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, limit]
      ));
      for (const item of due) {
        item.status = "expired";
        item.expired_at = now;
        item.status_reason = "OBSERVATION_WINDOW_EXPIRED";
        await repository.appendPendingCandidate(item);
      }
      return due;
    },

    async lockPromotionGroup(userId, groupId) {
      if (!transactional) throw new Error("Promotion group lock requires a repository transaction");
      await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [userId, groupId]);
    },
    async lockPromotionClaim(userId, claimKey) {
      if (!transactional) throw new Error("Promotion claim lock requires a repository transaction");
      await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [userId, `claim:${claimKey}`]);
    },

    async getPromotionGroup(userId, groupId) {
      return rows(await queryable.query(
        "SELECT document FROM memory_promotion_groups WHERE user_id = $1 AND group_id = $2",
        [userId, groupId]
      ))[0] ?? null;
    },

    async listPromotionGroupsByUser(userId) {
      return rows(await queryable.query(
        "SELECT document FROM memory_promotion_groups WHERE user_id = $1",
        [userId]
      ));
    },
    async listPromotionGroupsByClaim(userId, claim, domain, kind) {
      return rows(await queryable.query(
        `SELECT document FROM memory_promotion_groups WHERE user_id = $1
          AND document->'claim'->>'subject' = $2 AND document->'claim'->>'predicate' = $3
          AND document->>'memory_domain' = $4 AND document->>'memory_kind' = $5`,
        [userId, claim.subject, claim.predicate, domain, kind]
      ));
    },
    async getPromotionResult(userId, promotionKey) {
      return rows(await queryable.query(
        "SELECT document FROM memory_promotion_results WHERE user_id = $1 AND promotion_key = $2",
        [userId, promotionKey]
      ))[0] ?? null;
    },
    async recordPromotionResult(record) {
      const result = await queryable.query(
        `INSERT INTO memory_promotion_results (user_id, promotion_key, group_id, generation, memory_id, document)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (user_id, promotion_key) DO NOTHING RETURNING document`,
        [record.user_id, record.promotion_key, record.group_id, record.generation, record.memory_id, json(record)]
      );
      return rows(result)[0] ?? repository.getPromotionResult(record.user_id, record.promotion_key);
    },

    async recordPromotionDecision(record) {
      await queryable.query(
        `INSERT INTO memory_promotion_decisions
          (user_id, decision_id, group_id, generation, action, reason_codes, policy_version,
           target_scope, evidence_event_ids, evidence_hash, evaluated_at, document)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8::jsonb, $9::text[], $10, $11, $12::jsonb)
         ON CONFLICT (user_id, decision_id) DO NOTHING`,
        [record.user_id, record.decision_id, record.group_id, record.generation, record.action,
          record.reason_codes, record.policy_version, record.target_scope ? json(record.target_scope) : null,
          record.evidence_event_ids, record.evidence_hash, record.evaluated_at, json(record)]
      );
      return record;
    },
    async listPromotionDecisions(userId, groupId) {
      return rows(await queryable.query(
        `SELECT document FROM memory_promotion_decisions WHERE user_id = $1
         AND ($2::text IS NULL OR group_id = $2) ORDER BY evaluated_at, decision_id`,
        [userId, groupId ?? null]
      ));
    },

    async upsertPromotionGroup(record) {
      await queryable.query(
        `INSERT INTO memory_promotion_groups (user_id, group_id, status, observation_deadline_at, document)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (user_id, group_id) DO UPDATE SET
           status = EXCLUDED.status, observation_deadline_at = EXCLUDED.observation_deadline_at,
           document = EXCLUDED.document, updated_at = NOW()`,
        [record.user_id, record.group_id, record.status, record.observation_deadline_at, json(record)]
      );
      return record;
    },

    async expirePromotionGroups(now, limit = 100) {
      if (!transactional) throw new Error("Promotion group expiry requires a repository transaction");
      const due = rows(await queryable.query(
        `SELECT document FROM memory_promotion_groups
         WHERE status IN ('collecting', 'eligible', 'needs_confirmation', 'blocked_by_counter_evidence')
           AND observation_deadline_at <= $1
         ORDER BY observation_deadline_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, limit]
      ));
      for (const item of due) {
        item.status = "expired";
        item.expired_at = now;
        item.last_evaluated_at = now;
        item.status_reason = "OBSERVATION_WINDOW_EXPIRED";
        await repository.upsertPromotionGroup(item);
      }
      return due;
    },

    async appendRecallLog(record) {
      await queryable.query(
        `INSERT INTO memory_recall_logs (user_id, trace_id, purpose, document)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (user_id, trace_id) DO NOTHING`,
        [record.user_id, record.trace_id, record.purpose, json(record)]
      );
      return record;
    },

    async getRecallLog(userId, traceId) {
      return rows(await queryable.query(
        "SELECT document FROM memory_recall_logs WHERE user_id = $1 AND trace_id = $2",
        [userId, traceId]
      ))[0] ?? null;
    },

    async isForgottenMemory(userId, memoryId) {
      const result = await queryable.query(
        "SELECT 1 FROM memory_tombstones WHERE user_id = $1 AND memory_id = $2",
        [userId, memoryId]
      );
      return result.rows.length > 0;
    },

    async forgetArtifacts(userId, memoryIds, evidenceEventIds, forgottenAt) {
      if (!transactional) throw new Error("Forgetting requires a repository transaction");
      const vectorTable = await queryable.query("SELECT to_regclass('memory_embeddings') AS table_name");
      if (vectorTable.rows[0]?.table_name) {
        await queryable.query("DELETE FROM memory_embeddings WHERE user_id = $1 AND memory_id = ANY($2::text[])", [userId, memoryIds]);
      }
      await queryable.query(
        "DELETE FROM memory_edges WHERE user_id = $1 AND (source_id = ANY($2::text[]) OR target_id = ANY($2::text[]) OR source_id = ANY($3::text[]) OR target_id = ANY($3::text[]))",
        [userId, memoryIds, evidenceEventIds]
      );
      await queryable.query(
        "DELETE FROM memory_conflict_sets WHERE user_id = $1 AND (document->'memory_ids') ?| $2::text[]",
        [userId, memoryIds]
      );
      await queryable.query(
        `DELETE FROM memory_pending_candidates WHERE user_id = $1 AND
          ((document->'evidence_event_ids') ?| $2::text[] OR (document->'candidate'->'evidence_event_ids') ?| $2::text[])`,
        [userId, evidenceEventIds]
      );
      await queryable.query(
        `DELETE FROM memory_promotion_decisions WHERE user_id = $1 AND
          ((evidence_event_ids && $3::text[]) OR group_id IN (
            SELECT group_id FROM memory_promotion_groups WHERE user_id = $1 AND
              ((document->'source_memory_ids') ?| $2::text[] OR (document->'evidence_event_ids') ?| $3::text[]
                OR document->>'promoted_memory_id' = ANY($2::text[]))))`,
        [userId, memoryIds, evidenceEventIds]
      );
      await queryable.query(
        `DELETE FROM memory_promotion_groups WHERE user_id = $1 AND
          ((document->'source_memory_ids') ?| $2::text[] OR (document->'evidence_event_ids') ?| $3::text[]
            OR document->>'promoted_memory_id' = ANY($2::text[]))`,
        [userId, memoryIds, evidenceEventIds]
      );
      await queryable.query(
        `DELETE FROM memory_promotion_results WHERE user_id = $1 AND
          (memory_id = ANY($2::text[]) OR (document->'evidence_event_ids') ?| $3::text[])`,
        [userId, memoryIds, evidenceEventIds]
      );
      await queryable.query(
        `DELETE FROM memory_recall_logs WHERE user_id = $1 AND (
          (document->'selected_memory_ids') ?| $2::text[]
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(document->'omitted', '[]'::jsonb)) entry
            WHERE entry->>'memory_id' = ANY($2::text[])))`,
        [userId, memoryIds]
      );
      await queryable.query("DELETE FROM observation_events WHERE user_id = $1 AND event_id = ANY($2::text[])",
        [userId, evidenceEventIds]);
      await queryable.query("DELETE FROM memory_items WHERE user_id = $1 AND memory_id = ANY($2::text[])",
        [userId, memoryIds]);
      for (const memoryId of memoryIds) {
        await queryable.query(
          `INSERT INTO memory_tombstones (user_id, memory_id, forgotten_at)
           VALUES ($1, $2, $3) ON CONFLICT (user_id, memory_id) DO UPDATE SET forgotten_at = EXCLUDED.forgotten_at`,
          [userId, memoryId, forgottenAt]
        );
      }
    },

    async healthCheck() {
      const result = await queryable.query("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    }
  };

  if (!transactional) {
    repository.withTransaction = async (work) => {
      const client = typeof queryable.connect === "function" ? await queryable.connect() : queryable;
      try {
        await client.query("BEGIN");
        const result = await work(buildRepository(client, { transactional: true }));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        if (client !== queryable && typeof client.release === "function") client.release();
      }
    };
  }

  return repository;
}

// Accepts either a checked-out pg Client or a pg Pool. Pool transactions are
// pinned to one checked-out connection before the Memory Engine callback runs.
export function createPostgresMemoryRepository(queryable) {
  if (!queryable?.query) throw new Error("Postgres repository requires a pg Client or Pool");
  return buildRepository(queryable);
}
