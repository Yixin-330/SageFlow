-- Upgrade installations created before tenant-scoped composite keys existed.
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS memory_tier TEXT;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS memory_domain TEXT;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS memory_kind TEXT;

UPDATE memory_items SET
  memory_tier = COALESCE(memory_tier, document->>'memory_tier', CASE WHEN document->>'memory_type' = 'short_term' THEN 'short_term' ELSE 'long_term' END),
  memory_domain = COALESCE(memory_domain, document->>'memory_domain', CASE WHEN document->>'memory_type' = 'relationship' THEN 'relational' ELSE 'user' END),
  memory_kind = COALESCE(memory_kind, document->>'memory_kind', CASE WHEN document->>'memory_type' = 'episodic' THEN 'episodic' WHEN document->>'memory_type' = 'procedural' THEN 'procedural' ELSE 'semantic' END);

ALTER TABLE memory_items ALTER COLUMN memory_tier SET NOT NULL;
ALTER TABLE memory_items ALTER COLUMN memory_domain SET NOT NULL;
ALTER TABLE memory_items ALTER COLUMN memory_kind SET NOT NULL;

ALTER TABLE memory_mutations ADD COLUMN IF NOT EXISTS user_id TEXT;
UPDATE memory_mutations SET user_id = COALESCE(user_id, document->>'user_id', 'legacy') WHERE user_id IS NULL;
ALTER TABLE memory_mutations ALTER COLUMN user_id SET NOT NULL;

DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('memory_items', 'memory_items_pkey', 'user_id, memory_id'),
      ('memory_mutations', 'memory_mutations_pkey', 'user_id, mutation_id'),
      ('memory_conflict_sets', 'memory_conflict_sets_pkey', 'user_id, conflict_id'),
      ('memory_recall_logs', 'memory_recall_logs_pkey', 'user_id, trace_id'),
      ('memory_edges', 'memory_edges_pkey', 'user_id, edge_id'),
      ('memory_pending_candidates', 'memory_pending_candidates_pkey', 'user_id, pending_id')
    ) AS keys(table_name, constraint_name, columns_sql)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = item.table_name::regclass
        AND conname = item.constraint_name
        AND array_length(conkey, 1) = 1
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', item.table_name, item.constraint_name);
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (%s)', item.table_name, item.columns_sql);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS observation_events (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  trip_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS observation_events_user_trip_time_idx
  ON observation_events (user_id, trip_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS procedural_rules (
  user_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'expired')),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, rule_id)
);

CREATE TABLE IF NOT EXISTS state_snapshots (
  user_id TEXT NOT NULL,
  state_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  document JSONB NOT NULL,
  PRIMARY KEY (user_id, state_id)
);

CREATE INDEX IF NOT EXISTS state_snapshots_user_trip_time_idx
  ON state_snapshots (user_id, trip_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS state_transitions (
  user_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  document JSONB NOT NULL,
  PRIMARY KEY (user_id, transition_id)
);

CREATE INDEX IF NOT EXISTS state_transitions_user_trip_time_idx
  ON state_transitions (user_id, trip_id, occurred_at DESC);
