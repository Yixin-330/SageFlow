import { readFile } from "node:fs/promises";
import { evaluateHumanReviews } from "../src/human-review-evaluation.mjs";

const parseJsonl = (value) => value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const args = process.argv.slice(2);
const queuePath = args[0] === "--queue" ? args[1] : new URL("../evaluation/human-memory-review-v2.jsonl", import.meta.url);
if (!queuePath) throw new Error("--queue requires a JSONL path");
const paths = args[0] === "--queue" ? args.slice(2) : args;
const queue = parseJsonl(await readFile(queuePath, "utf8"));
if (paths.length > 2) throw new Error("Provide at most two independent reviewer JSONL files");
const reviews = await Promise.all(paths.map(async (path) => parseJsonl(await readFile(path, "utf8"))));
console.log(JSON.stringify(evaluateHumanReviews(queue, reviews), null, 2));
