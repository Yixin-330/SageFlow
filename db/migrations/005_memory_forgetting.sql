CREATE TABLE IF NOT EXISTS memory_tombstones (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  forgotten_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, memory_id)
);
