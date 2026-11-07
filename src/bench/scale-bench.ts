// `monomem bench --scale [--notes N]`: what does a big store cost? Writes, searches, a cold command line start, the
// session-start pack, disk and memory, on a synthetic store of N notes (default 20,000; the 1.4.0 numbers in
// docs/BENCHMARK.md were taken at 100,000). Plus how closely the large-store edge path (full-text index) agrees with
// the exhaustive one on a smaller clustered store. No model, no network. Runs on a throwaway folder.
import { BENCH_HOME } from "./retrieval-env.js";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../store.js";
import { runSearch } from "../search-service.js";
import { percentile } from "./retrieval-metrics.js";

/** Small deterministic generator, so a run on another machine builds the same notes. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const POOL = Array.from({ length: 30_000 }, (_, i) => "w" + ((Math.imul(i, 2654435761) >>> 0).toString(36).slice(0, 6) || "0"));
const zipf = (r: () => number, vocab: readonly string[]): string => vocab[Math.min(vocab.length - 1, Math.floor(Math.pow(r(), 3.2) * vocab.length))];

interface Gen {
  note(i: number): { title: string; body: string; cluster: number };
}

/** Notes drawn from `clusters` topics: 60% of a note's words come from its topic's own 40-word vocabulary. */
export function makeGen(seed: number, clusters: number): Gen {
  const r = rng(seed);
  const topics = Array.from({ length: clusters }, (_, c) => Array.from({ length: 40 }, (_, k) => `t${c.toString(36)}x${k.toString(36)}${POOL[(c * 41 + k) % POOL.length]}`));
  return {
    note(i: number) {
      const c = Math.floor(r() * clusters);
      const words = (n: number): string => Array.from({ length: n }, () => (r() < 0.6 ? zipf(r, topics[c]) : zipf(r, POOL))).join(" ");
      const lines = 3 + Math.floor(r() * 4);
      let body = "";
      for (let s = 0; s < lines; s++) body += words(10 + Math.floor(r() * 12)) + ". ";
      return { title: words(3) + ` #${i}`, body: body.trim(), cluster: c };
    },
  };
}

export interface ScaleReport {
  notes: number;
  writes: { measured: number; p50Ms: number; p95Ms: number };
  search: { queries: number; p50Ms: number; p95Ms: number };
  coldStartMs: { search: number | null; remember: number | null; recall: number | null };
  dbMB: number;
  peakRssMB: number;
  edgeAgreement: { notes: number; sampled: number; exactPairs: number; foundPct: number; top3Pct: number };
  node: string;
}

function edgeAgreement(): ScaleReport["edgeAgreement"] {
  const dir = join(BENCH_HOME, "agree");
  const store = new Store(join(dir, "state.db"));
  const total = 3000;
  const gen = makeGen(5, 60);
  try {
    store.transaction(() => {
      for (let i = 0; i < total; i++) {
        const n = gen.note(i);
        store.create({ title: n.title, body: n.body }, { skipEdges: true, lint: "none" });
      }
    });
    const saved = process.env.MONOMEM_EDGE_EXACT_MAX_NOTES;
    const threshold = store.getEdgeThreshold();
    let exactPairs = 0;
    let found = 0;
    let top3 = 0;
    let top3Of = 0;
    const sampled = 150;
    for (let k = 0; k < sampled; k++) {
      const id = 1 + Math.floor((k * total) / sampled);
      const n = store.read(id);
      if (!n) continue;
      process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = "1000000000";
      const exact = store.planEdges(n.namespace, n.title, n.body, threshold, new Set([id])).pairs;
      process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = "0";
      const fast = store.planEdges(n.namespace, n.title, n.body, threshold, new Set([id])).pairs;
      const have = new Set(fast.map((p) => p.neighborId));
      exactPairs += exact.length;
      for (const p of exact) if (have.has(p.neighborId)) found++;
      const best = [...exact].sort((a, b) => b.score - a.score).slice(0, 3);
      top3Of += best.length;
      for (const p of best) if (have.has(p.neighborId)) top3++;
    }
    if (saved === undefined) delete process.env.MONOMEM_EDGE_EXACT_MAX_NOTES;
    else process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = saved;
    return {
      notes: total,
      sampled,
      exactPairs,
      foundPct: exactPairs ? Math.round((1000 * found) / exactPairs) / 10 : 100,
      top3Pct: top3Of ? Math.round((1000 * top3) / top3Of) / 10 : 100,
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function cliPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const f = resolve(here, "..", "cli.js");
  return existsSync(f) ? f : null;
}

function timeCli(args: string[], home: string): number | null {
  const cli = cliPath();
  if (!cli) return null;
  const t = performance.now();
  const r = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, MONOMEM_HOME: home }, encoding: "utf8", timeout: 120_000 });
  return r.status === 0 ? Math.round(performance.now() - t) : null;
}

export async function runScale(o: { notes?: number; writes?: number } = {}): Promise<ScaleReport> {
  const n = Math.max(1000, Math.floor(o.notes ?? 20_000));
  const writes = Math.max(20, Math.floor(o.writes ?? 300));
  const dir = join(BENCH_HOME, "scale");
  const dbPath = join(dir, "state.db");
  const store = new Store(dbPath);
  const gen = makeGen(11, 200);
  const stamp = (): number => performance.now();
  let writeMs: number[] = [];
  let searchMs: number[] = [];
  try {
    // The bulk of the store goes in without similarity links (a restore or an import does the same), in big transactions.
    const bulk = n - writes;
    for (let b = 0; b < bulk; b += 1000) {
      store.transaction(() => {
        for (let i = b; i < Math.min(bulk, b + 1000); i++) {
          const x = gen.note(i);
          store.create({ title: x.title, body: x.body }, { skipEdges: true, lint: "none" });
        }
      });
    }
    // The last `writes` notes are ordinary writes, links and all, at full size: this is the latency an agent sees.
    for (let i = bulk; i < n; i++) {
      const x = gen.note(i);
      const t = stamp();
      store.create({ title: x.title, body: x.body }, { lint: "none" });
      writeMs.push(stamp() - t);
    }
    const r = rng(99);
    for (let q = 0; q < 200; q++) {
      const x = gen.note(n + q);
      const words = x.body.split(" ").slice(0, 3 + Math.floor(r() * 3)).join(" ");
      const t = stamp();
      await runSearch(store, words, { mode: "keyword", limit: 5 });
      searchMs.push(stamp() - t);
    }
    store.close();
    const coldStartMs = {
      search: timeCli(["search", "tabc timeout retry"], BENCH_HOME + "/scale"),
      remember: timeCli(["remember", "scale bench probe note about connection retry"], BENCH_HOME + "/scale"),
      recall: timeCli(["recall"], BENCH_HOME + "/scale"),
    };
    const dbMB = Math.round(statSync(dbPath).size / 1e5) / 10;
    const agreement = edgeAgreement();
    return {
      notes: n,
      writes: { measured: writeMs.length, p50Ms: Math.round(percentile(writeMs, 50) * 10) / 10, p95Ms: Math.round(percentile(writeMs, 95) * 10) / 10 },
      search: { queries: searchMs.length, p50Ms: Math.round(percentile(searchMs, 50) * 100) / 100, p95Ms: Math.round(percentile(searchMs, 95) * 100) / 100 },
      coldStartMs,
      dbMB,
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
      edgeAgreement: agreement,
      node: process.version,
    };
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderScale(r: ScaleReport): string {
  const ms = (v: number | null): string => (v === null ? "n/a" : `${v} ms`);
  return [
    `Synthetic store of ${r.notes.toLocaleString("en-US")} notes (${r.dbMB} MB on disk), Node ${r.node}`,
    `  write (links included) over the last ${r.writes.measured} notes   p50 ${r.writes.p50Ms} ms   p95 ${r.writes.p95Ms} ms`,
    `  keyword search, ${r.search.queries} queries                          p50 ${r.search.p50Ms} ms   p95 ${r.search.p95Ms} ms`,
    `  new process, first command   search ${ms(r.coldStartMs.search)}   remember ${ms(r.coldStartMs.remember)}   recall ${ms(r.coldStartMs.recall)}`,
    `  peak memory of this run ${r.peakRssMB} MB`,
    `  similar-note links through the full-text index vs the exhaustive scan (${r.edgeAgreement.notes} clustered notes, ${r.edgeAgreement.sampled} sampled):`,
    `    ${r.edgeAgreement.foundPct}% of the ${r.edgeAgreement.exactPairs} exhaustive links found, ${r.edgeAgreement.top3Pct}% of each note's 3 best`,
  ].join("\n");
}
