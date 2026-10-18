import { Pool } from "pg";
import { runPostgresMigrations } from "../src/memory-engine/postgres-migrations.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 1 });
try {
  const result = await runPostgresMigrations(pool);
  console.log(`PostgreSQL migrations: ${result.applied.length} applied, ${result.total} total`);
  for (const filename of result.applied) console.log(`APPLIED ${filename}`);
} finally {
  await pool.end();
}
