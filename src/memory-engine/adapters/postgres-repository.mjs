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

    async appendRecallLog(record) {
      await queryable.query(
        `INSERT INTO memory_recall_logs (user_id, trace_id, purpose, document)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (user_id, trace_id) DO NOTHING`,
        [record.user_id, record.trace_id, record.purpose, json(record)]
      );
      return record;
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
