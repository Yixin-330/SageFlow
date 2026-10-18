import { readFile } from "node:fs/promises";
import { runDecisionCycleEvaluation } from "../src/decision-cycle-evaluation.mjs";

const catalog = JSON.parse(await readFile(new URL("../scenarios/catalog.json", import.meta.url), "utf8"));
console.log(JSON.stringify(await runDecisionCycleEvaluation(catalog), null, 2));
