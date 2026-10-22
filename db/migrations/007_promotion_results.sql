CREATE TABLE IF NOT EXISTS memory_promotion_results (
  user_id TEXT NOT NULL,
  promotion_key TEXT NOT NULL,
  group_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, promotion_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_promotion_results_group_idx
  ON memory_promotion_results (user_id, group_id);

CREATE INDEX IF NOT EXISTS memory_promotion_groups_claim_idx
  ON memory_promotion_groups (user_id, (document->'claim'->>'subject'),
    (document->'claim'->>'predicate'), (document->>'memory_domain'), (document->>'memory_kind'));
