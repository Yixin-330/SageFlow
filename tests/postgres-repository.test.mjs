import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresMemoryRepository } from "../src/memory-engine/adapters/postgres-repository.mjs";

function fakePool() {
  const statements = [];
  let released = false;
  const client = {
    async query(text, params = []) {
      statements.push({ text: text.trim(), params });
      if (text.includes("SELECT 1 AS ok")) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (text.includes("SELECT document")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; }
  };
  return {
    statements,
    get released() { return released; },
    async connect() { return client; },
    async query(...args) { return client.query(...args); }
  };
}

const memory = {
  user_id: "usr_a",
  memory_id: "mem_shared",
  status: "active",
  memory_tier: "long_term",
  memory_domain: "user",
  memory_kind: "semantic"
};

test("Postgres repository pins a transaction to one checked-out connection", async () => {
  const pool = fakePool();
  const repository = createPostgresMemoryRepository(pool);

  await repository.withTransaction(async (transactionRepository) => {
    assert.equal(transactionRepository.withTransaction, undefined);
    await transactionRepository.upsert(memory);
  });

  assert.equal(pool.statements[0].text, "BEGIN");
  assert.match(pool.statements[1].text, /ON CONFLICT \(user_id, memory_id\)/);
  assert.equal(pool.statements.at(-1).text, "COMMIT");
  assert.equal(pool.released, true);
});

test("Postgres repository rolls back and releases the connection on failure", async () => {
  const pool = fakePool();
  const repository = createPostgresMemoryRepository(pool);

  await assert.rejects(repository.withTransaction(async () => {
    throw new Error("write failed");
  }), /write failed/);

  assert.deepEqual(pool.statements.map((item) => item.text), ["BEGIN", "ROLLBACK"]);
  assert.equal(pool.released, true);
});

test("Postgres writes and reads are tenant-scoped", async () => {
  const pool = fakePool();
  const repository = createPostgresMemoryRepository(pool);

  await repository.upsert(memory);
  await repository.listByUser("usr_a");
  await repository.appendRecallLog({
    user_id: "usr_a",
    trace_id: "recall_a",
    purpose: "decision"
  });

  const upsert = pool.statements.find((item) => item.text.startsWith("INSERT INTO memory_items"));
  const read = pool.statements.find((item) => item.text.startsWith("SELECT document FROM memory_items"));
  const log = pool.statements.find((item) => item.text.startsWith("INSERT INTO memory_recall_logs"));
  assert.equal(upsert.params[0], "usr_a");
  assert.equal(read.params[0], "usr_a");
  assert.equal(log.params[0], "usr_a");
  assert.match(log.text, /ON CONFLICT \(user_id, trace_id\)/);
});

test("Postgres health check is exposed through the repository seam", async () => {
  const pool = fakePool();
  assert.equal(await createPostgresMemoryRepository(pool).healthCheck(), true);
});

test("Postgres retrieval channels receive tenant and prefiltered memory IDs", async () => {
  const pool = fakePool();
  const repository = createPostgresMemoryRepository(pool);
  await repository.searchText("usr_a", "quiet cafe", ["mem_allowed"], 10);
  await repository.upsertEmbedding("usr_a", "mem_allowed", [0.5, 0.5], "test-v1");
  await repository.searchVector("usr_a", [0.5, 0.5], "test-v1", ["mem_allowed"], 10);

  const textQuery = pool.statements.find((item) => item.text.includes("ts_rank_cd"));
  const vectorWrite = pool.statements.find((item) => item.text.startsWith("INSERT INTO memory_embeddings"));
  const vectorQuery = pool.statements.find((item) => item.text.includes("embedding <=>"));
  assert.deepEqual(textQuery.params.slice(0, 3), ["usr_a", "quiet cafe", ["mem_allowed"]]);
  assert.deepEqual(vectorWrite.params, ["usr_a", "mem_allowed", "test-v1", "[0.5,0.5]"]);
  assert.deepEqual(vectorQuery.params.slice(0, 4), ["usr_a", "[0.5,0.5]", "test-v1", ["mem_allowed"]]);
  assert.match(vectorQuery.text, /model_version = \$3/);
});
