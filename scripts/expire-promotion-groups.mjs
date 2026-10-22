import { Pool } from "pg";
import { createPostgresMemoryRepository } from "../src/memory-engine/adapters/postgres-repository.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString, max: 1 });
try {
  const repository = createPostgresMemoryRepository(pool);
  const expired = await repository.withTransaction(async (transaction) => {
    const now = new Date().toISOString();
    return {
      groups: await transaction.expirePromotionGroups(now, 1000),
      pending: await transaction.expirePendingCandidates(now, 1000)
    };
  });
  console.log(JSON.stringify({ expired_groups: expired.groups.length, expired_pending: expired.pending.length }));
} finally {
  await pool.end();
}
