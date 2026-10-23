CREATE TABLE IF NOT EXISTS memory_promotion_decisions (
  user_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  action TEXT NOT NULL,
  reason_codes TEXT[] NOT NULL,
  policy_version TEXT NOT NULL,
  target_scope JSONB,
  evidence_event_ids TEXT[] NOT NULL,
  evidence_hash TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  document JSONB NOT NULL,
  PRIMARY KEY (user_id, decision_id)
);

CREATE INDEX IF NOT EXISTS memory_promotion_decisions_group_idx
  ON memory_promotion_decisions (user_id, group_id, generation, evaluated_at);
