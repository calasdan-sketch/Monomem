// `monomem bench --recall` and `monomem bench --passages`: how many tokens does it cost to hand an agent the evidence?
//
//   --recall     committed coding-agent set (bench/recall/coding-agent.json): synthetic notes and queries, offline, no
//                download. Reports note hit@1/@5 and "evidence coverage" (did the text the agent is handed contain the
//                answer sentence?) for whole notes vs passages, and for search with query repair on vs off.
//   --passages   LongMemEval-S (cached by `monomem bench --longmemeval`): the dataset marks the evidence turns, so the
//                same comparison runs on real long conversations. Whole top-5 notes vs passages at several budgets.
//
// No model, no judge. Imported first so MONOMEM_HOME moves to a throwaway folder before config.js loads.
import { BENCH_HOME } from "./retrieval-env.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../store.js";
import { LIMITS } from "../security.js";
import { repairEnabled, runSearch } from "../search-service.js";
import { rememberedTerms } from "../repair.js";
import { extractKeywords } from "../keywords.js";
import { estTokens, selectPassages } from "../passages.js";
import { CACHE_DIR, SOURCES, fetchOnce } from "./retrieval.js";
import { percentile } from "./retrieval-metrics.js";

const BUDGETS_RECALL = [150, 300, 600];
const BUDGETS_LME = [250, 500, 1000, 2000];

interface Arm {
  /** Estimated tokens handed to the agent, per question. */
  tokens: number[];
  /** Questions where the text contained the answer (any gold turn / the evidence sentence). */
  covered: number;
  /** Mean share of gold turns covered (LongMemEval); equals covered / n on the recall set. */
  share: number;
}
const newArm = (): Arm => ({ tokens: [], covered: 0, share: 0 });
const summ = (a: Arm, n: number): ArmSummary => ({
  coveragePct: n ? Math.round((1000 * a.covered) / n) / 10 : 0,
  turnSharePct: n ? Math.round((1000 * a.share) / n) / 10 : 0,
  tokensP50: percentile(a.tokens, 50),
  tokensP95: percentile(a.tokens, 95),
  tokensMean: a.tokens.length ? Math.round(a.tokens.reduce((x, y) => x + y, 0) / a.tokens.length) : 0,
});
export interface ArmSummary {
  coveragePct: number;
  turnSharePct: number;
  tokensP50: number;
  tokensP95: number;
  tokensMean: number;
}

// ---------------------------------------------------------------------------------------------------------------
// coding-agent recall set

interface RecallFile {
  name: string;
  about: string;
  notes: Array<{ id: string; title: string; body: string; tags?: string[] }>;
  queries: Array<{ category: string; query: string; expect: string; evidence: string }>;
}

export interface RecallReport {
  dataset: string;
  notes: number;
  queries: number;
  /** Per category plus "all": hit rates and evidence coverage for each arm. */
  rows: Record<string, { n: number; repairOn: ModeRow; repairOff: ModeRow }>;
  searchMs: { p50: number; p95: number };
  node: string;
}
interface ModeRow {
  hit1: number;
  hit5: number;
  wholeNotes: ArmSummary;
  passages: Record<string, ArmSummary>;
}

export function defaultRecallFile(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/src/bench -> package root is three levels up
  for (const up of ["../../..", "../.."]) {
    const f = resolve(here, up, "bench", "recall", "coding-agent.json");
    if (existsSync(f)) return f;
  }
  throw new Error("bench/recall/coding-agent.json not found");
}

export async function runRecall(file = defaultRecallFile()): Promise<RecallReport> {
  const data = JSON.parse(readFileSync(file, "utf8")) as RecallFile;
  const dir = join(BENCH_HOME, "recall");
  const store = new Store(join(dir, "state.db"));
  const lat: number[] = [];
  try {
    const noteOf = new Map<number, string>();
    store.transaction(() => {
      for (const n of data.notes) {
        const r = store.create({ title: n.title, body: n.body, tags: n.tags ?? [] }, { skipEdges: true, lint: "none" });
        noteOf.set(r.id, n.id);
      }
    });
    const cats = ["all", ...new Set(data.queries.map((x) => x.category))];
    const acc = new Map<string, { n: number; on: Acc; off: Acc }>();
    for (const c of cats) acc.set(c, { n: 0, on: newAcc(), off: newAcc() });
    const prev = process.env.MONOMEM_REPAIR;
    try {
      for (const x of data.queries) {
        for (const repair of [true, false]) {
          if (repair) delete process.env.MONOMEM_REPAIR;
          else process.env.MONOMEM_REPAIR = "off";
          const t = performance.now();
          const hits = await runSearch(store, x.query, { mode: "keyword", limit: 5 });
          if (repair) lat.push(performance.now() - t);
          const ids = hits.map((h) => noteOf.get(h.id) ?? "");
          const ev = x.evidence.toLowerCase();
          const whole = hits.map((h) => `${h.title}\n${h.body}`);
          const wholeText = whole.join("\n");
          const arms: Array<[string, string, number]> = [["whole", wholeText, estTokens(wholeText.length)]];
          for (const b of BUDGETS_RECALL) {
            const extraTerms = repairEnabled() ? rememberedTerms(store, extractKeywords(x.query)) : [];
            const sel = selectPassages(hits.map((h) => ({ id: h.id, title: h.title, body: h.body })), x.query, { maxTokens: b, extraTerms });
            const txt = sel.picked.map((p) => p.text).join("\n");
            arms.push([`passages@${b}`, txt, sel.tokens]);
          }
          for (const c of ["all", x.category]) {
            const a = acc.get(c)!;
            if (repair) a.n++;
            const m = repair ? a.on : a.off;
            if (ids[0] === x.expect) m.hit1++;
            if (ids.includes(x.expect)) m.hit5++;
            for (const [name, text, tok] of arms) {
              const arm = (m.arms[name] ??= newArm());
              arm.tokens.push(tok);
              if (text.toLowerCase().includes(ev)) {
                arm.covered++;
                arm.share++;
              }
            }
          }
        }
      }
    } finally {
      if (prev === undefined) delete process.env.MONOMEM_REPAIR;
      else process.env.MONOMEM_REPAIR = prev;
    }
    const rows: RecallReport["rows"] = {};
    for (const [c, a] of acc) rows[c] = { n: a.n, repairOn: modeRow(a.on, a.n), repairOff: modeRow(a.off, a.n) };
    return { dataset: data.name, notes: data.notes.length, queries: data.queries.length, rows, searchMs: { p50: percentile(lat, 50), p95: percentile(lat, 95) }, node: process.version };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
interface Acc {
  hit1: number;
  hit5: number;
  arms: Record<string, Arm>;
}
const newAcc = (): Acc => ({ hit1: 0, hit5: 0, arms: {} });
function modeRow(a: Acc, n: number): ModeRow {
  const pct = (x: number): number => (n ? Math.round((1000 * x) / n) / 10 : 0);
  const passages: Record<string, ArmSummary> = {};
  for (const [k, v] of Object.entries(a.arms)) if (k !== "whole") passages[k] = summ(v, n);
  return { hit1: pct(a.hit1), hit5: pct(a.hit5), wholeNotes: summ(a.arms.whole ?? newArm(), n), passages };
}

// ---------------------------------------------------------------------------------------------------------------
// LongMemEval-S evidence turns

export interface LmeReport {
  dataset: string;
  questions: number;
  split?: "dev" | "test" | "all";
  /** Questions whose gold session is in the top 5 notes (session recall@5, the existing headline). */
  sessionHit5Pct: number;
  wholeNotes: ArmSummary;
  passages: Record<string, ArmSummary>;
  node: string;
}

interface Span {
  note: number;
  start: number;
  end: number;
}

/** Deterministic dev/test split by question id (FNV-1a, low bit): tune on "dev", report "test" untouched. */
export function splitOf(id: string): "dev" | "test" {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return (h >>> 7) & 1 ? "test" : "dev";
}

export async function runPassagesLme(o: { data?: string; limit?: number; split?: "dev" | "test" | "all"; tune?: { rankPrior?: number; maxPerNote?: number; context?: number; k1?: number; b?: number; coveragePower?: number; roleBoost?: number; window?: number } } = {}): Promise<LmeReport> {
  const file = o.data ?? (await fetchOnce(SOURCES.longmemeval.url, join(CACHE_DIR, SOURCES.longmemeval.file)));
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const raw = (Array.isArray(parsed) ? parsed : []) as Array<Record<string, unknown>>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const whole = newArm();
  const per = new Map<number, Arm>(BUDGETS_LME.map((b) => [b, newArm()]));
  let nq = 0;
  let sessHit = 0;
  for (const q of raw) {
    if (o.limit && nq >= o.limit) break;
    const id = str(q.question_id);
    const goldSessions = new Set(arr(q.answer_session_ids).map(str).filter(Boolean));
    if (!id || id.endsWith("_abs") || goldSessions.size === 0 || !str(q.question)) continue;
    if (o.split && o.split !== "all" && splitOf(id) !== o.split) continue;
    const dir = join(BENCH_HOME, `p${nq}`);
    const store = new Store(join(dir, "state.db"));
    try {
      const sids = arr(q.haystack_session_ids).map(str);
      const sessions = arr(q.haystack_sessions);
      const docs: Array<{ title: string; body: string; spans: Array<[number, number]>; gold: boolean }> = [];
      sessions.forEach((s, i) => {
        const sid = sids[i] || `session_${i}`;
        const turns = arr(s) as Array<Record<string, unknown>>;
        let body = "";
        const spans: Array<[number, number]> = [];
        turns.forEach((t, j) => {
          const text = `${str(t.role)}: ${str(t.content)}`;
          const start = body.length + (j ? 1 : 0);
          body += (j ? "\n" : "") + text;
          if (t.has_answer === true) spans.push([start, start + text.length]);
        });
        docs.push({ title: sid, body: body.slice(0, LIMITS.body), spans, gold: goldSessions.has(sid) });
      });
      const goldNote = new Map<number, Array<[number, number]>>();
      const idOf = store.transaction(() =>
        docs.map((d) => {
          const n = store.create({ title: d.title, body: d.body }, { skipEdges: true, lint: "none" });
          if (d.gold && d.spans.length) goldNote.set(n.id, d.spans.filter(([s]) => s < d.body.length));
          return n.id;
        })
      );
      void idOf;
      const gold = [...goldNote.entries()].flatMap(([note, sp]) => sp.map(([start, end]): Span => ({ note, start, end })));
      if (gold.length === 0) continue;
      nq++;
      const hits = await runSearch(store, str(q.question), { mode: "keyword", limit: 5 });
      if (hits.some((h) => goldNote.has(h.id))) sessHit++;
      const inTop = new Set(hits.map((h) => h.id));
      const wholeTok = hits.reduce((a, h) => a + estTokens(h.title.length + h.body.length), 0);
      whole.tokens.push(wholeTok);
      const wc = gold.filter((g) => inTop.has(g.note)).length;
      if (wc > 0) whole.covered++;
      whole.share += wc / gold.length;
      for (const b of BUDGETS_LME) {
        const sel = selectPassages(hits.map((h) => ({ id: h.id, title: h.title, body: h.body })), str(q.question), { maxTokens: b, ...(o.tune ?? {}) });
        const arm = per.get(b)!;
        arm.tokens.push(sel.tokens);
        let c = 0;
        for (const g of gold) {
          const len = g.end - g.start;
          const got = sel.picked
            .filter((p) => p.noteId === g.note)
            .reduce((a, p) => a + Math.max(0, Math.min(p.end, g.end) - Math.max(p.start, g.start)), 0);
          if (got >= Math.min(len * 0.5, 300)) c++;
        }
        if (c > 0) arm.covered++;
        arm.share += c / gold.length;
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
    if (nq % 50 === 0) process.stderr.write(`${nq} questions\n`);
  }
  const passages: Record<string, ArmSummary> = {};
  for (const b of BUDGETS_LME) passages[`passages@${b}`] = summ(per.get(b)!, nq);
  return {
    dataset: "LongMemEval-S (cleaned), evidence turns (has_answer)",
    questions: nq,
    split: o.split ?? "all",
    sessionHit5Pct: nq ? Math.round((1000 * sessHit) / nq) / 10 : 0,
    wholeNotes: summ(whole, nq),
    passages,
    node: process.version,
  };
}

// ---------------------------------------------------------------------------------------------------------------

const f1 = (x: number): string => x.toFixed(1).padStart(5);
const armLine = (name: string, s: ArmSummary): string =>
  `  ${name.padEnd(16)} evidence ${f1(s.coveragePct)}%  gold-turn share ${f1(s.turnSharePct)}%  tokens p50 ${String(s.tokensP50).padStart(6)}  p95 ${String(s.tokensP95).padStart(6)}  mean ${String(s.tokensMean).padStart(6)}`;

export function renderRecall(r: RecallReport): string {
  const L = [`${r.dataset}: ${r.queries} queries over ${r.notes} notes (search p50 ${r.searchMs.p50.toFixed(2)} ms, p95 ${r.searchMs.p95.toFixed(2)} ms)`];
  for (const [c, row] of Object.entries(r.rows)) {
    L.push("", `${c} (n=${row.n})`);
    L.push(`  note hit@1 / hit@5   repair on ${f1(row.repairOn.hit1)} / ${f1(row.repairOn.hit5)}    repair off ${f1(row.repairOff.hit1)} / ${f1(row.repairOff.hit5)}`);
    L.push(armLine("whole top-5 notes", row.repairOn.wholeNotes));
    for (const [k, v] of Object.entries(row.repairOn.passages)) L.push(armLine(k, v));
  }
  return L.join("\n");
}

export function renderLme(r: LmeReport): string {
  const L = [`${r.dataset}${r.split && r.split !== "all" ? ` [${r.split} half]` : ""}: ${r.questions} questions; gold session in top 5: ${r.sessionHit5Pct}%`];
  L.push(armLine("whole top-5 notes", r.wholeNotes));
  for (const [k, v] of Object.entries(r.passages)) L.push(armLine(k, v));
  L.push("evidence = at least one gold turn handed over; gold-turn share = mean fraction of the gold turns handed over; tokens ~ chars / 4");
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// tool schema size (`--schema`)

export interface SchemaReport {
  node: string;
  rows: Array<{ tools: string; count: number; fullTokens: number; compactTokens: number; savedPct: number }>;
}

/** Estimated tokens of a tools/list answer (JSON length / 4), full vs compact, for the default tools and for all of them. */
export async function runSchemaSize(): Promise<SchemaReport> {
  const { createMcpServer } = await import("../mcp-server-core.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const dir = join(BENCH_HOME, "schema");
  const store = new Store(join(dir, "state.db"));
  const measure = async (tools: "all" | undefined, schema: "compact" | "full"): Promise<{ n: number; tokens: number }> => {
    const server = createMcpServer(store, "admin", { ...(tools ? { tools } : { tools: undefined }), schema });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "schema-bench", version: "1" });
    await client.connect(a);
    const r = await client.listTools();
    await client.close();
    return { n: r.tools.length, tokens: Math.round(JSON.stringify(r).length / 4) };
  };
  try {
    const rows: SchemaReport["rows"] = [];
    for (const [label, t] of [["default (core)", undefined], ["all", "all"]] as const) {
      const full = await measure(t, "full");
      const compact = await measure(t, "compact");
      rows.push({ tools: label, count: full.n, fullTokens: full.tokens, compactTokens: compact.tokens, savedPct: Math.round((1000 * (full.tokens - compact.tokens)) / full.tokens) / 10 });
    }
    return { node: process.version, rows };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderSchema(r: SchemaReport): string {
  const L = ["Tool schema the model reads every turn (tools/list JSON length / 4, estimated tokens)"];
  for (const x of r.rows) L.push(`  ${x.tools.padEnd(15)} ${String(x.count).padStart(2)} tools   full ${String(x.fullTokens).padStart(6)}   compact ${String(x.compactTokens).padStart(6)}   saved ${x.savedPct}%`);
  L.push("compact = MONOMEM_SCHEMA=compact: same tools, parameters and types, shorter descriptions");
  return L.join("\n");
}

export async function passagesMain(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  try {
    const json = argv.includes("--json");
    let limit: number | undefined;
    let data: string | undefined;
    let scaleNotes: number | undefined;
    let sweepBudget: number | undefined;
    let split: "dev" | "test" | "all" | undefined;
    let tune: { rankPrior?: number; maxPerNote?: number; context?: number; k1?: number; b?: number; coveragePower?: number; roleBoost?: number; window?: number } | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--limit") {
        limit = Number(argv[++i]);
        if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a whole number above 0");
      } else if (argv[i] === "--tune") {
        tune = JSON.parse(argv[++i] ?? "{}"); // for tuning runs: {"rankPrior":0.5,"maxPerNote":4,"context":1}
      } else if (argv[i] === "--split") {
        const v = argv[++i];
        if (v !== "dev" && v !== "test" && v !== "all") throw new Error("--split must be dev, test or all");
        split = v;
      } else if (argv[i] === "--data") {
        data = resolve(argv[++i] ?? "");
      } else if (argv[i] === "--budget") {
        sweepBudget = Number(argv[++i]);
        if (!Number.isInteger(sweepBudget) || sweepBudget < 50) throw new Error("--budget must be a whole number of tokens, 50 or more");
      } else if (argv[i] === "--notes") {
        scaleNotes = Number(argv[++i]);
        if (!Number.isInteger(scaleNotes) || scaleNotes < 1000) throw new Error("--notes must be a whole number of at least 1000");
      } else if (!["--json", "--recall", "--passages", "--schema", "--scale", "--sweep", "--"].includes(argv[i])) throw new Error(`unknown option ${argv[i]}`);
    }
    if (argv.includes("--recall")) {
      const r = await runRecall();
      const { runOverlap, renderOverlap } = await import("./overlap-bench.js");
      const ov = runOverlap();
      out(json ? JSON.stringify({ ...r, overlap: ov }, null, 2) : renderRecall(r) + "\n\n" + renderOverlap(ov));
    }
    if (argv.includes("--schema")) {
      const r = await runSchemaSize();
      out(json ? JSON.stringify(r, null, 2) : renderSchema(r));
    }
    if (argv.includes("--scale")) {
      const { runScale, renderScale } = await import("./scale-bench.js");
      const r = await runScale({ notes: scaleNotes });
      out(json ? JSON.stringify(r, null, 2) : renderScale(r));
    }
    if (argv.includes("--passages") && argv.includes("--sweep")) {
      const { runPassagesSweep, renderSweep } = await import("./passages-sweep.js");
      const r = await runPassagesSweep({ data, limit, budget: sweepBudget });
      out(json ? JSON.stringify(r, null, 2) : renderSweep(r));
    } else if (argv.includes("--passages")) {
      const r = await runPassagesLme({ data, limit, tune, split });
      out(json ? JSON.stringify(r, null, 2) : renderLme(r));
    }
    return 0;
  } catch (e) {
    console.error(`bench: ${(e as Error).message}`);
    return 2;
  }
}
