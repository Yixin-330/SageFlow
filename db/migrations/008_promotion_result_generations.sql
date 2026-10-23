ALTER TABLE memory_promotion_results
  ADD COLUMN IF NOT EXISTS generation INTEGER;

UPDATE memory_promotion_results
SET generation = COALESCE(generation, NULLIF(document->>'generation', '')::integer, 1)
WHERE generation IS NULL;

ALTER TABLE memory_promotion_results
  ALTER COLUMN generation SET NOT NULL;

DROP INDEX IF EXISTS memory_promotion_results_group_idx;

CREATE UNIQUE INDEX IF NOT EXISTS memory_promotion_results_group_generation_idx
  ON memory_promotion_results (user_id, group_id, generation);
