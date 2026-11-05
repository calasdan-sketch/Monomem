// Writes evals/poisoning-corpus.json from the bench poison scenarios plus the self-poisoning case (run `npm run build` first).
// `--stdout` prints instead of writing (the test compares the two).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGNED_MISSES, attackScenarios } from "../dist/src/drill.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const attacks = attackScenarios(join(root, "bench", "scenarios")).map((s) => ({
  id: s.id,
  title: s.title,
  what: s.what,
  actors: s.actors,
  ...(s.needs ? { needs: s.needs } : {}),
  steps: s.steps,
  expect: s.expect,
  ...(DESIGNED_MISSES[s.id] ? { designed_miss: DESIGNED_MISSES[s.id] } : {}),
}));
const text = JSON.stringify({ format: "poisoning-corpus/1", license: "MIT", attacks }, null, 2) + "\n";
if (process.argv.includes("--stdout")) process.stdout.write(text);
else writeFileSync(join(root, "evals", "poisoning-corpus.json"), text);
