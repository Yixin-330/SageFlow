import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { validateObservationEvent } from "../src/engine.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));

test("all JSON Schema documents are readable and declare required fields", async () => {
  const schemaDir = new URL("../schemas/", import.meta.url);
  const files = (await readdir(schemaDir)).filter((name) => name.endsWith(".json"));
  const expected = [
    "memory-edge.schema.json",
    "procedural-rule.schema.json",
    "recall-request.schema.json",
    "recall-trace.schema.json",
    "state-transition.schema.json",
    "decision-context.schema.json",
    "promotion-source.schema.json",
    "promotion-group.schema.json"
  ];
  assert.ok(expected.every((name) => files.includes(name)));
  assert.equal(files.length, 17);
  for (const file of files) {
    const schema = JSON.parse(await readFile(new URL(file, schemaDir), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok(Array.isArray(schema.required));
    assert.ok(schema.required.length > 0);
  }
});

test("all simulated observation events are complete and IDs are unique", () => {
  const events = catalog.scenarios.flatMap((scenario) => scenario.timeline);
  assert.ok(events.every(validateObservationEvent));
  assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
});

test("all memory fixtures preserve evidence, confidence, scope, and time", () => {
  for (const memory of catalog.memory_catalog) {
    assert.ok(memory.memory_id);
    assert.ok(["short_term", "long_term"].includes(memory.memory_tier));
    assert.ok(["user", "relational", "shared"].includes(memory.memory_domain));
    assert.ok(["episodic", "semantic", "procedural"].includes(memory.memory_kind));
    assert.equal(memory.version, 1);
    assert.ok(memory.lineage_id);
    assert.ok(memory.statement?.predicate);
    assert.ok(memory.scope?.domain);
    assert.ok(memory.confidence >= 0 && memory.confidence <= 1);
    assert.ok(memory.salience >= 0 && memory.salience <= 1);
    assert.ok(memory.evidence_event_ids.length > 0);
    assert.ok(!Number.isNaN(Date.parse(memory.valid_from)));
    assert.ok(!Number.isNaN(Date.parse(memory.last_confirmed_at)));
  }
});

test("memory protocol separates tier, ownership domain, and semantic kind", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/memory-item.schema.json", import.meta.url), "utf8"));
  assert.ok(schema.required.includes("memory_tier"));
  assert.ok(schema.required.includes("memory_domain"));
  assert.ok(schema.required.includes("memory_kind"));
  assert.equal(schema.properties.memory_type.deprecated, true);
});
