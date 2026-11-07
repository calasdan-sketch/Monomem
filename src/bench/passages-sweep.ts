// `monomem bench --passages --sweep`: the passage settings, tuned on one half of LongMemEval-S and judged on the other.
//
// 1.3.0 chose its passage settings by running the whole dataset, so its numbers were tuned on the data they were reported
// on. This is the honest version: questions are split in two by a fixed hash of the question id (splitOf); a coordinate
// search over the settings maximises evidence coverage on the DEV half only; the shipped defaults and the DEV-tuned settings
// are then both scored on the TEST half, which no choice ever saw, with a bootstrap 95% interval on the difference.
// No model, no judge. Needs the cached LongMemEval download (`monomem bench --longmemeval`).
import { BENCH_HOME } from "./retrieval-env.js";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../store.js";
import { LIMITS } from "../security.js";
import { runSearch } from "../search-service.js";
import { estTokens, selectPassages, PASSAGE_DEFAULTS, type PassageOpts } from "../passages.js";
import { CACHE_DIR, SOURCES, fetchOnce } from "./retrieval.js";
import { splitOf } from "./passages-bench.js";

interface Case {
  question: string;
  notes: Array<{ id: number; title: string; body: string }>;
  gold: Array<{ note: number; start: number; end: number }>;
  split: "dev" | "test";
}

const BUDGETS = [500, 2000];

/** The settings the sweep varies, with the values tried for each (the shipped default is always among them). */
const GRID: Record<string, number[]> = {
  rankPrior: [0, 0.1, 0.25, 0.5, 1],
  k1: [0.9, 1.2, 1.6, 2],
  b: [0.5, 0.75, 1],
  context: [0, 1, 2],
  maxPerNote: [2, 4, 8],
  roleBoost: [0, 0.3, 0.6],
  coveragePower: [0, 0.5, 1],
  window: [0, 400, 700],
};
/** The settings 1.3.0 shipped (chosen on the whole dataset). The sweep starts from them and compares against them. */
export const SHIPPED: Required<Pick<PassageOpts, "rankPrior" | "k1" | "b" | "context" | "maxPerNote" | "roleBoost" | "coveragePower" | "window">> = {
  rankPrior: 0.25,
  k1: 1.2,
  b: 1,
  context: 1,
  maxPerNote: 8,
  roleBoost: 0,
  coveragePower: 0,
  window: 0,
};

function covered(c: Case, opts: PassageOpts): boolean {
  const sel = selectPassages(c.notes, c.question, opts);
  for (const g of c.gold) {
    const len = g.end - g.start;
    const got = sel.picked.filter((p) => p.noteId === g.note).reduce((a, p) => a + Math.max(0, Math.min(p.end, g.end) - Math.max(p.start, g.start)), 0);
    if (got >= Math.min(len * 0.5, 300)) return true;
  }
  return false;
}

const rate = (cs: Case[], opts: PassageOpts): number => cs.filter((c) => covered(c, opts)).length / (cs.length || 1);

function bootstrapDiff(cs: Case[], a: PassageOpts, b: PassageOpts, rounds = 1000): { lo: number; hi: number } {
  const da = cs.map((c) => (covered(c, a) ? 1 : 0));
  const db = cs.map((c) => (covered(c, b) ? 1 : 0));
  let s = 12345;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const diffs: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let d = 0;
    for (let i = 0; i < cs.length; i++) {
      const k = Math.floor(rnd() * cs.length);
      d += db[k] - da[k];
    }
    diffs.push((100 * d) / cs.length);
  }
  diffs.sort((x, y) => x - y);
  return { lo: Math.round(diffs[Math.floor(rounds * 0.025)] * 10) / 10, hi: Math.round(diffs[Math.floor(rounds * 0.975)] * 10) / 10 };
}

export interface SweepReport {
  questions: { dev: number; test: number };
  budget: number;
  shipped: typeof SHIPPED;
  tuned: Record<string, number>;
  devCoverage: { shipped: number; tuned: number };
  testCoverage: { shipped: number; tuned: number };
  /** Bootstrap 95% interval of (tuned - shipped) coverage on the TEST half, in percentage points. */
  testDiffCI95: { lo: number; hi: number };
  /** The defaults this build uses (PASSAGE_DEFAULTS) on the TEST half: equal to `tuned` when they were taken from this search. */
  currentDefaultsTestCoverage: number;
  wholeNotesTestCoverage: number;
  /** The same two settings on the TEST half at other budgets (tuned at `budget` only, so these are not tuned for them). */
  otherBudgets: Array<{ budget: number; shipped: number; tuned: number; diffCI95: { lo: number; hi: number } }>;
  node: string;
}

async function loadCases(data?: string, limit?: number): Promise<Case[]> {
  const file = data ?? (await fetchOnce(SOURCES.longmemeval.url, join(CACHE_DIR, SOURCES.longmemeval.file)));
  const raw = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const cases: Case[] = [];
  for (const q of raw) {
    if (limit && cases.length >= limit) break;
    const id = str(q.question_id);
    const goldSessions = new Set(arr(q.answer_session_ids).map(str).filter(Boolean));
    if (!id || id.endsWith("_abs") || goldSessions.size === 0 || !str(q.question)) continue;
    const dir = join(BENCH_HOME, `s${cases.length}`);
    const store = new Store(join(dir, "state.db"));
    try {
      const sids = arr(q.haystack_session_ids).map(str);
      const goldNote = new Map<number, Array<[number, number]>>();
      store.transaction(() => {
        arr(q.haystack_sessions).forEach((s, i) => {
          const sid = sids[i] || `session_${i}`;
          let body = "";
          const spans: Array<[number, number]> = [];
          (arr(s) as Array<Record<string, unknown>>).forEach((t, j) => {
            const text = `${str(t.role)}: ${str(t.content)}`;
            const start = body.length + (j ? 1 : 0);
            body += (j ? "\n" : "") + text;
            if (t.has_answer === true) spans.push([start, start + text.length]);
          });
          body = body.slice(0, LIMITS.body);
          const n = store.create({ title: sid, body }, { skipEdges: true, lint: "none" });
          if (goldSessions.has(sid) && spans.length) goldNote.set(n.id, spans.filter(([st]) => st < body.length));
        });
      });
      const gold = [...goldNote.entries()].flatMap(([note, sp]) => sp.map(([start, end]) => ({ note, start, end })));
      if (!gold.length) continue;
      const hits = await runSearch(store, str(q.question), { mode: "keyword", limit: 5 });
      cases.push({ question: str(q.question), notes: hits.map((h) => ({ id: h.id, title: h.title, body: h.body })), gold, split: splitOf(id) });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
    if (cases.length % 100 === 0) process.stderr.write(`${cases.length} questions loaded\n`);
  }
  return cases;
}

export async function runPassagesSweep(o: { data?: string; limit?: number; budget?: number } = {}): Promise<SweepReport> {
  const budget = o.budget ?? 500;
  const cases = await loadCases(o.data, o.limit);
  const dev = cases.filter((c) => c.split === "dev");
  const test = cases.filter((c) => c.split === "test");
  const withBudget = (cfg: Record<string, number>): PassageOpts => ({ maxTokens: budget, ...cfg });
  // Coordinate search on DEV only: change one setting at a time, keep a change that raises DEV coverage, two passes.
  let cur: Record<string, number> = { ...SHIPPED };
  let curDev = rate(dev, withBudget(cur));
  for (let pass = 0; pass < 2; pass++) {
    for (const [key, values] of Object.entries(GRID)) {
      for (const v of values) {
        if (v === cur[key]) continue;
        const r = rate(dev, withBudget({ ...cur, [key]: v }));
        if (r > curDev + 1e-9) {
          curDev = r;
          cur = { ...cur, [key]: v };
        }
      }
    }
  }
  const pct = (x: number): number => Math.round(x * 1000) / 10;
  const whole = test.filter((c) => c.gold.some((g) => c.notes.some((n) => n.id === g.note))).length / (test.length || 1);
  return {
    questions: { dev: dev.length, test: test.length },
    budget,
    shipped: SHIPPED,
    tuned: cur,
    devCoverage: { shipped: pct(rate(dev, withBudget(SHIPPED))), tuned: pct(curDev) },
    testCoverage: { shipped: pct(rate(test, withBudget(SHIPPED))), tuned: pct(rate(test, withBudget(cur))) },
    testDiffCI95: bootstrapDiff(test, withBudget(SHIPPED), withBudget(cur)),
    currentDefaultsTestCoverage: pct(rate(test, { maxTokens: budget, ...PASSAGE_DEFAULTS })),
    wholeNotesTestCoverage: pct(whole),
    otherBudgets: [250, 1000, 2000].map((b) => ({
      budget: b,
      shipped: pct(rate(test, { maxTokens: b, ...SHIPPED })),
      tuned: pct(rate(test, { maxTokens: b, ...cur })),
      diffCI95: bootstrapDiff(test, { maxTokens: b, ...SHIPPED }, { maxTokens: b, ...cur }),
    })),
    node: process.version,
  };
}

export function renderSweep(r: SweepReport): string {
  const diff = Object.entries(r.tuned).filter(([k, v]) => (r.shipped as Record<string, number>)[k] !== v).map(([k, v]) => `${k} ${(r.shipped as Record<string, number>)[k]} -> ${v}`);
  return [
    `Passage settings, tuned on the dev half (${r.questions.dev} questions) and judged on the test half (${r.questions.test}), budget ${r.budget} tokens (~${estTokens(r.budget * 4)} est.)`,
    `  evidence coverage   dev: 1.3.0 settings ${r.devCoverage.shipped}%  tuned ${r.devCoverage.tuned}%    TEST: 1.3.0 settings ${r.testCoverage.shipped}%  tuned ${r.testCoverage.tuned}%`,
    `  tuned minus 1.3.0 settings on TEST: ${(r.testCoverage.tuned - r.testCoverage.shipped).toFixed(1)} points (bootstrap 95% interval ${r.testDiffCI95.lo} to ${r.testDiffCI95.hi})`,
    ...r.otherBudgets.map((o) => `  TEST at ${o.budget} tokens (settings not tuned for it): 1.3.0 ${o.shipped}%  tuned ${o.tuned}%  (${(o.tuned - o.shipped).toFixed(1)} points, 95% interval ${o.diffCI95.lo} to ${o.diffCI95.hi})`),
    `  this build's defaults on TEST: ${r.currentDefaultsTestCoverage}%${r.currentDefaultsTestCoverage === r.testCoverage.tuned ? " (the tuned settings)" : ""}`,
    `  whole top-5 notes on TEST: ${r.wholeNotesTestCoverage}%`,
    `  settings the search changed: ${diff.length ? diff.join(", ") : "none (the 1.3.0 settings were already the dev optimum)"}`,
  ].join("\n");
}
