// PROTOTYPE — local-only static server. Start with `npm start`.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresMemoryRuntime } from "../src/memory-engine/postgres-runtime.mjs";

const root = normalize(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL;
let runtimePromise;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function postgresRuntime() {
  if (!databaseUrl) return null;
  runtimePromise ??= createPostgresMemoryRuntime({
    connectionString: databaseUrl,
    migrate: process.env.SAGEFLOW_AUTO_MIGRATE === "1"
  });
  return runtimePromise;
}

function authorized(request) {
  const token = process.env.SAGEFLOW_API_TOKEN;
  return !token || request.headers.authorization === `Bearer ${token}`;
}

async function handleMemoryRequest(request, response, pathname) {
  if (!pathname.startsWith("/api/memory/")) return false;
  const runtime = postgresRuntime();
  if (!runtime) {
    sendJson(response, 503, { error: "POSTGRES_NOT_CONFIGURED", hint: "Set DATABASE_URL before starting the server." });
    return true;
  }
  if (!authorized(request)) {
    sendJson(response, 401, { error: "UNAUTHORIZED" });
    return true;
  }

  try {
    const activeRuntime = await runtime;
    if (pathname === "/api/memory/health" && request.method === "GET") {
      sendJson(response, 200, { ok: await activeRuntime.healthCheck(), storage: "postgres" });
      return true;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    const body = await readJson(request);
    const tenantUserId = request.headers["x-sageflow-user-id"];
    if (!tenantUserId) {
      sendJson(response, 400, { error: "USER_ID_HEADER_REQUIRED" });
      return true;
    }
    if (pathname === "/api/memory/observe") {
      if (!Array.isArray(body.events) || body.events.some((event) => event.user_id !== tenantUserId)) {
        sendJson(response, 400, { error: "TENANT_MISMATCH" });
        return true;
      }
      sendJson(response, 200, await activeRuntime.engine.observe(body.events, body.options ?? {}));
      return true;
    }
    if (pathname === "/api/memory/recall") {
      if (body.request?.user_id !== tenantUserId) {
        sendJson(response, 400, { error: "TENANT_MISMATCH" });
        return true;
      }
      sendJson(response, 200, await activeRuntime.engine.recall(body.request));
      return true;
    }
    sendJson(response, 404, { error: "NOT_FOUND" });
    return true;
  } catch (error) {
    const status = error.message === "REQUEST_TOO_LARGE" ? 413 : error instanceof SyntaxError ? 400 : 500;
    sendJson(response, status, { error: status === 500 ? "MEMORY_RUNTIME_ERROR" : error.message });
    if (status === 500) console.error(error);
    return true;
  }
}

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  if (await handleMemoryRequest(request, response, pathname)) return;
  if (pathname === "/") {
    response.writeHead(302, { Location: "/prototype/" });
    response.end();
    return;
  }

  const relative = pathname === "/prototype/" ? "prototype/index.html" : pathname.replace(/^\//, "");
  const filePath = normalize(join(root, relative));
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mime[extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, host, () => {
  console.log(`SageFlow prototype: http://${host}:${port}/prototype/`);
  console.log(`Memory persistence: ${databaseUrl ? "PostgreSQL" : "disabled (set DATABASE_URL)"}`);
});

