import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  createMemoryEngine,
  createPostgresMemoryRepository,
  createScriptedExtractor
} from "../src/memory-engine/index.mjs";
import { runPostgresMigrations } from "../src/memory-engine/postgres-migrations.mjs";

const connectionString = process.env.SAGEFLOW_TEST_DATABASE_URL;

test("PostgreSQL persists memories across engine instances and isolates tenants", { skip: !connectionString }, async () => {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const schema = `sageflow_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const fixedNow = "2026-10-15T10:00:00+08:00";
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await runPostgresMigrations(client);

    const candidate = (eventId, value) => ({
      candidate_id: "same_candidate_id",
      statement: { subject: "user", predicate: "prefers_travel_pace", value },
      memory_tier: "long_term",
      memory_domain: "user",
      memory_kind: "semantic",
      scope: { domain: "travel", topic: "travel_pacing" },
      evidence_event_ids: [eventId],
      evidence_kind: "explicit_statement",
      confidence: 0.9,
      salience: 0.8,
      retention: "long_term_candidate",
      sensitivity: "normal"
    });
    const event = (userId, eventId) => ({
      schema_version: "1.0",
      event_id: eventId,
      event_type: "dialogue.user_statement",
      user_id: userId,
      trip_id: "trip_test",
      occurred_at: fixedNow,
      recorded_at: fixedNow,
      source: { type: "integration_test" },
      payload: {},
      trace_id: `trace_${eventId}`
    });
    const extractor = createScriptedExtractor({
      evt_a: [candidate("evt_a", "slow")],
      evt_b: [candidate("evt_b", "fast")]
    });
    const repository = createPostgresMemoryRepository(client);
    const engine = createMemoryEngine({ repository, extractor, clock: { now: () => fixedNow } });
    await engine.observe([event("usr_a", "evt_a")]);
    await engine.observe([event("usr_b", "evt_b")]);

    const reloaded = createMemoryEngine({
      repository: createPostgresMemoryRepository(client),
      extractor,
      clock: { now: () => fixedNow }
    });
    const recalledA = await reloaded.recall({ user_id: "usr_a", purpose: "decision" });
    const recalledB = await reloaded.recall({ user_id: "usr_b", purpose: "decision" });

    assert.deepEqual(recalledA.memories.map((item) => item.memory.statement.value), ["slow"]);
    assert.deepEqual(recalledB.memories.map((item) => item.memory.statement.value), ["fast"]);
    assert.equal(recalledA.memories[0].memory.memory_id, recalledB.memories[0].memory.memory_id);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
