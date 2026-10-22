import { readFile } from "node:fs/promises";
import { runStressEvaluation } from "../src/stress-evaluation.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));
const suite = JSON.parse(await readFile(new URL("../evaluation/stress-cases.json", import.meta.url), "utf8"));
console.log(JSON.stringify(await runStressEvaluation(catalog, suite), null, 2));
