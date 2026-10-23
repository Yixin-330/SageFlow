import test from "node:test";
import assert from "node:assert/strict";
import { runPostgresMigrations } from "../src/memory-engine/postgres-migrations.mjs";

test("migration runner applies ordered SQL files transactionally", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(text, params = []) {
      statements.push({ text: text.trim(), params });
      if (text.includes("SELECT checksum FROM schema_migrations")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; }
  };
  const pool = { async connect() { return client; } };

  const result = await runPostgresMigrations(pool);

  assert.deepEqual(result.applied, [
    "001_memory_engine.sql",
    "002_typed_memory_graph.sql",
    "003_persistence_runtime.sql",
    "004_retrieval_text_index.sql",
    "005_memory_forgetting.sql",
    "006_promotion_groups.sql",
    "007_promotion_results.sql",
    "008_promotion_result_generations.sql",
    "009_promotion_decisions.sql"
  ]);
  assert.equal(statements.filter((item) => item.text === "BEGIN").length, 9);
  assert.equal(statements.filter((item) => item.text === "COMMIT").length, 9);
  assert.equal(released, true);
});

test("migration runner refuses a changed migration checksum", async () => {
  const client = {
    async query(text) {
      if (text.includes("SELECT checksum FROM schema_migrations")) return { rows: [{ checksum: "wrong" }] };
      return { rows: [], rowCount: 1 };
    }
  };

  await assert.rejects(runPostgresMigrations(client), /Applied migration changed/);
});
