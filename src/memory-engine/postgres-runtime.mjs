import { Pool } from "pg";
import { createMemoryEngine } from "./memory-engine.mjs";
import { createDeterministicExtractor } from "./adapters/deterministic-extractor.mjs";
import { createPostgresMemoryRepository } from "./adapters/postgres-repository.mjs";
import { runPostgresMigrations } from "./postgres-migrations.mjs";

export async function createPostgresMemoryRuntime({
  connectionString,
  pool,
  extractor = createDeterministicExtractor(),
  embedder,
  architecture = "hybrid",
  clock,
  migrate = false
} = {}) {
  if (!pool && !connectionString) throw new Error("Postgres runtime requires connectionString or pool");
  const ownsPool = !pool;
  const activePool = pool ?? new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  if (migrate) await runPostgresMigrations(activePool);
  const repository = createPostgresMemoryRepository(activePool);
  const engine = createMemoryEngine({ repository, extractor, embedder, architecture, ...(clock ? { clock } : {}) });

  return {
    engine,
    repository,
    async healthCheck() {
      return repository.healthCheck();
    },
    async close() {
      if (ownsPool) await activePool.end();
    }
  };
}
