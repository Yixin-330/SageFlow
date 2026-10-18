import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const defaultDirectory = new URL("../../db/migrations/", import.meta.url);

export async function runPostgresMigrations(queryable, { directory = defaultDirectory } = {}) {
  if (!queryable?.query && !queryable?.connect) throw new Error("Migration runner requires a pg Client or Pool");
  const client = typeof queryable.connect === "function" ? await queryable.connect() : queryable;
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const filenames = (await readdir(directory))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    const applied = [];

    for (const filename of filenames) {
      const sql = await readFile(new URL(filename, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query("SELECT checksum FROM schema_migrations WHERE filename = $1", [filename]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${filename}`);
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [filename, checksum]);
        await client.query("COMMIT");
        applied.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { applied, total: filenames.length };
  } finally {
    if (client !== queryable && typeof client.release === "function") client.release();
  }
}
