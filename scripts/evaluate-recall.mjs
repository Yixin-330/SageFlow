import { readFile } from "node:fs/promises";
import { runRecallEvaluation } from "../src/memory-engine/recall-evaluation.mjs";

const suite = JSON.parse(await readFile(new URL("../evaluation/recall-cases.json", import.meta.url), "utf8"));
const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));
console.log(JSON.stringify(await runRecallEvaluation(suite, catalog.memory_catalog), null, 2));
