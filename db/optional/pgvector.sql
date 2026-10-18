-- Apply manually after choosing a compatible embedding model.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  embedding vector NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, memory_id),
  FOREIGN KEY (user_id, memory_id) REFERENCES memory_items (user_id, memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS memory_embeddings_user_model_idx
  ON memory_embeddings (user_id, model_version);
