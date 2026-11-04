// Run the provenance benchmark against one system and save the report. Internal comparison tooling.
//
//   npm run build
//   node bench/run-competitors.mjs monomem|official-memory|mem0|mem0-noinfer [--only A01 ...] [--seed 1]
//
// Writes bench/results/<adapter>-<YYYY-MM-DD>.md and .json. Fixed seed 1 unless --seed is given.
// mem0 needs the venv in .venv-bench (pip install mem0ai) and Ollama on localhost:11434; nothing leaves the machine.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => new URL(`file:///${join(root, "dist", "src", "bench", p).replace(/\\/g, "/")}`).href;
const { runBench } = await import(dist("index.js"));
const { renderTable } = await import(dist("report.js"));

const [which, ...rest] = process.argv.slice(2);
const only = [];
let seed = 1;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--only") only.push(rest[++i]);
  else if (rest[i] === "--seed") seed = Number(rest[++i]);
  else throw new Error(`unknown option ${rest[i]}`);
}

let adapter;
let stop = () => undefined;
if (which === "monomem") adapter = undefined;
else if (which === "official-memory") adapter = new (await import(dist("competitors/official-memory-adapter.js"))).OfficialMemoryAdapter();
else if (which === "mem0" || which === "mem0-noinfer") {
  const { Mem0Adapter, pythonBridge } = await import(dist("competitors/mem0-adapter.js"));
  const venvPy = process.platform === "win32" ? join(root, ".venv-bench", "Scripts", "python.exe") : join(root, ".venv-bench", "bin", "python");
  const bridge = pythonBridge(process.env.MEM0_BENCH_PYTHON ?? venvPy, join(root, "bench", "mem0_bridge.py"), {
    MEM0_TELEMETRY: "False",
    MEM0_DIR: join(root, ".venv-bench", "mem0-home"),
  });
  stop = bridge.stop;
  adapter = new Mem0Adapter(which === "mem0", bridge.call);
} else {
  console.error("usage: node bench/run-competitors.mjs monomem|official-memory|mem0|mem0-noinfer [--only ID] [--seed N]");
  process.exit(2);
}

const started = new Date();
try {
  const { report } = await runBench({ adapter, seed, ...(only.length ? { only } : {}), onResult: (id, s) => console.error(`${id} ${s}`) });
  const dir = join(root, "bench", "results");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${which}-${started.toISOString().slice(0, 10)}${only.length ? "-partial" : ""}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${base}.md`, "```\n" + renderTable(report, { verbose: true }) + "\n```\n");
  console.error(`wrote ${base}.md and .json`);
} finally {
  stop();
}
