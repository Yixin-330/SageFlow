CREATE TABLE IF NOT EXISTS memory_items (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'expired')),
  memory_tier TEXT NOT NULL CHECK (memory_tier IN ('short_term', 'long_term')),
  memory_domain TEXT NOT NULL CHECK (memory_domain IN ('user', 'relational', 'shared')),
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('episodic', 'semantic', 'procedural')),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, memory_id)
);

CREATE INDEX IF NOT EXISTS memory_items_user_status_idx ON memory_items (user_id, status);
CREATE INDEX IF NOT EXISTS memory_items_document_idx ON memory_items USING GIN (document);

CREATE TABLE IF NOT EXISTS memory_mutations (
  user_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  target_memory_id TEXT,
  operation TEXT NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS memory_mutations_target_idx ON memory_mutations (target_memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_conflict_sets (
  user_id TEXT NOT NULL,
  conflict_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conflict_id)
);

CREATE INDEX IF NOT EXISTS memory_conflicts_user_status_idx ON memory_conflict_sets (user_id, status);

CREATE TABLE IF NOT EXISTS memory_recall_logs (
  user_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, trace_id)
);

-- pgvector is intentionally optional in this phase. Add an embedding column only
-- when a production embedding adapter and measured retrieval baseline exist.
