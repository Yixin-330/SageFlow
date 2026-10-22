CREATE TABLE IF NOT EXISTS memory_promotion_groups (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'collecting', 'eligible', 'needs_confirmation', 'blocked_by_counter_evidence',
    'promoted', 'expired', 'rejected_by_policy'
  )),
  observation_deadline_at TIMESTAMPTZ NOT NULL,
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS memory_promotion_groups_due_idx
  ON memory_promotion_groups (observation_deadline_at)
  WHERE status IN ('collecting', 'eligible', 'needs_confirmation', 'blocked_by_counter_evidence');
