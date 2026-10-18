CREATE TABLE IF NOT EXISTS memory_edges (
  user_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, edge_id)
);

CREATE INDEX IF NOT EXISTS memory_edges_user_source_idx
  ON memory_edges (user_id, source_id);

CREATE INDEX IF NOT EXISTS memory_edges_user_target_idx
  ON memory_edges (user_id, target_id);

CREATE TABLE IF NOT EXISTS memory_pending_candidates (
  user_id TEXT NOT NULL,
  pending_id TEXT NOT NULL,
  status TEXT NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, pending_id)
);

CREATE INDEX IF NOT EXISTS memory_pending_candidates_user_status_idx
  ON memory_pending_candidates (user_id, status, created_at DESC);
