// Conflicts: two LIVE notes from DIFFERENT writers that disagree about the same thing ("deploy target: Fly.io" vs "deploy target: Render").
// FLAG ONLY: nothing is changed, hidden or merged. The human picks: supersede, pin one, or distrust a writer.
// Tier 1 (exact): both notes carry the same `fact:` key (facts.ts) with different values. Precision is 1.0 by construction,
//   as long as an agent keeps one key for one subject.
// Tier 2 (possible, deterministic, no model): "key: value" lines, a few tool families for "use X", identical or key-stating titles.
// ponytail: tier 2 is exact-key matching, so a paraphrase ("we host on Fly" vs "Hosting: Render") is missed on purpose; precision first.
import type { Store, NoteRecord } from "./store.js";
import { printable } from "./security.js";
import { noteFacts, normFact } from "./facts.js";
import { writerKind } from "./why.js";

/** kind = what the label is (server-stamped marker or token label), so a spoofed "stdio" label is told apart from a token holder. */
export interface ConflictNote { id: number; title: string; writer: string; kind: string; pinned: boolean; at: string }
export interface Conflict {
  namespace: string;
  /** Older first. */
  a: ConflictNote;
  b: ConflictNote;
  key: string;
  /** Lower-cased, as compared. */
  values: [string, string];
  /** As written (original case), for display. */
  shown: [string, string];
  /** fact: both notes carry the same fact key with different values. possible: the key:value / title rule. */
  tier: "fact" | "possible";
  /** exact (fact tier). high: both titles state the key and value. medium: identical titles, the values are in the bodies. */
  confidence: "exact" | "high" | "medium";
}

// "use X" tool families: two different members of one family under the same context conflict.
const FAMILIES: string[][] = [
  ["npm", "pnpm", "yarn", "bun"], ["jest", "vitest", "mocha", "ava"], ["postgres", "postgresql", "mysql", "sqlite", "mongodb"],
  ["fly.io", "render", "heroku", "vercel", "railway", "netlify"], ["tabs", "spaces"], ["prettier", "biome"],
  ["eslint", "biome"], ["pip", "poetry", "uv"], ["webpack", "vite", "esbuild", "rollup"], ["react", "vue", "svelte", "angular"],
];
const GENERIC_KEYS = new Set(["decision", "note", "notes", "summary", "todo", "context", "why", "status", "fix", "bug", "idea", "result", "update", "tip", "warning", "reminder", "question", "answer", "problem", "solution", "issue", "rule", "example", "see", "tldr", "http", "https"]);
const MAX_LINES = 40;

interface Stmt { key: string; value: string; shown: string; fromTitle: boolean }

const tidy = (v: string): string => v.replace(/[`*_"']/g, "").replace(/[.,;\s]+$/, "").replace(/\s+/g, " ").trim();
const clean = (v: string): string => tidy(v).toLowerCase();

function family(value: string): number {
  const w = value.split(/\s+/)[0];
  return FAMILIES.findIndex((f) => f.includes(w));
}

function stmtFrom(line: string, fromTitle: boolean): Stmt[] {
  // A match needs a key of <= 40 chars and a value of <= 60, so a longer line can never match. Skipping it also keeps a
  // planted line with a long whitespace run from making the lazy regex below quadratic (it froze the server for minutes).
  if (line.length > 200) return [];
  const out: Stmt[] = [];
  const m = /^\s*(?:[-*]\s+)?\**([A-Za-z][\w .\/-]{1,40}?)\**\s*(?::|=|->|→)\s*(?!\/\/)(.+?)\s*$/.exec(line);
  let rest = line.trim();
  if (m) {
    const key = clean(m[1]).replace(/^(the|our|project)\s+/, "");
    const value = clean(m[2]);
    const kw = key.split(" ").length;
    if (kw <= 4 && value && value.length <= 60 && value.split(" ").length <= 6) {
      if (!GENERIC_KEYS.has(key)) out.push({ key, value, shown: tidy(m[2]), fromTitle });
      else rest = value; // "Decision: use pnpm" -> look at what follows the label
    }
  }
  const u = /^(?:we |always |please )?(?:use|using|prefer|run)\s+([\w.\/-]+)(?:\s+(?:for|in|on|with)\s+([\w .-]{1,30}?))?[.!]?$/i.exec(rest);
  if (u) {
    const value = clean(u[1]);
    const fam = family(value);
    if (fam >= 0) out.push({ key: `use ${fam}${u[2] ? " " + clean(u[2]) : ""}`, value, shown: tidy(u[1]), fromTitle });
  }
  return out;
}

function statements(n: NoteRecord): Stmt[] {
  const out = stmtFrom(n.title, true);
  for (const line of n.body.split("\n").slice(0, MAX_LINES)) out.push(...stmtFrom(line, false));
  return out;
}

const writerOf = (n: NoteRecord): string => n.writer_id || n.written_by;
const brief = (n: NoteRecord): ConflictNote => ({
  id: n.id,
  title: n.title,
  writer: n.written_by,
  kind: writerKind(n.written_by, !!n.imported_unverified || !!n.imported_written_by),
  pinned: n.pinned === true,
  at: n.updated_at,
});

// "fly.io" vs "fly.io (prod)" is a refinement, not a conflict; "npm" vs "pnpm" is (whole words, not substrings).
const valuesDiffer = (x: string, y: string): boolean => {
  const [a, b] = [x.split(" "), y.split(" ")].sort((m, n) => m.length - n.length);
  return !a.every((w) => b.includes(w));
};

const oldestFirst = <T extends { n: NoteRecord }>(x: T, y: T): [T, T] => (x.n.updated_at <= y.n.updated_at ? [x, y] : [y, x]);
const group = <T extends { n: NoteRecord }>(m: Map<string, T[]>, key: string, item: T): void => {
  (m.get(key) ?? m.set(key, []).get(key)!).push(item);
};

export function findConflicts(store: Store, opts: { namespaces?: string[]; notes?: NoteRecord[] } = {}): Conflict[] {
  const { namespaces } = opts;
  const all = opts.notes ?? store.exportAll({ live: true }); // gate-ok: admin-only report
  // A distrusted writer's notes are never a "side" the operator is asked to weigh.
  const notes = store.filterVisible(all).filter((n) => (!namespaces || namespaces.includes(n.namespace)) && !n.archived_at && writerOf(n) && !n.unreadable);
  const out: Conflict[] = [];
  const done = new Set<string>();

  const facts = new Map<string, Array<{ n: NoteRecord; v: string }>>();
  for (const n of notes) for (const [k, v] of noteFacts(n.tags)) group(facts, `${n.namespace}\u0000${k}`, { n, v });
  for (const [gk, g] of facts) {
    const key = gk.split("\u0000")[1];
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [p, q] = oldestFirst(g[i], g[j]);
        if (writerOf(p.n) === writerOf(q.n) || normFact(p.v) === normFact(q.v)) continue;
        done.add(`${p.n.id}-${q.n.id}`);
        out.push({ namespace: p.n.namespace, a: brief(p.n), b: brief(q.n), key, values: [normFact(p.v), normFact(q.v)], shown: [p.v, q.v], tier: "fact", confidence: "exact" });
      }
    }
  }

  const groups = new Map<string, Array<{ n: NoteRecord; s: Stmt }>>();
  for (const n of notes) {
    const seen = new Set<string>();
    for (const s of statements(n)) {
      const k = `${n.namespace}\u0000${s.key}`;
      if (seen.has(k)) continue; // a note that states a key twice is ambiguous: use its first statement
      seen.add(k);
      group(groups, k, { n, s });
    }
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [p, q] = oldestFirst(g[i], g[j]);
        if (writerOf(p.n) === writerOf(q.n) || !valuesDiffer(p.s.value, q.s.value)) continue;
        const pair = `${p.n.id}-${q.n.id}`;
        if (done.has(pair)) continue;
        const both = p.s.fromTitle && q.s.fromTitle;
        // Same subject = both titles state the key, or the two titles are identical. ponytail: loosening this (shared words, key synonyms)
        // was measured: it finds paraphrases but floods the list with look-alike notes. Agents that want exact matching attach `facts`.
        const same = p.n.title.trim().toLowerCase() === q.n.title.trim().toLowerCase();
        if (!both && !same) continue;
        done.add(pair);
        out.push({ namespace: p.n.namespace, a: brief(p.n), b: brief(q.n), key: p.s.key.replace(/^use \d+/, "use").trim(), values: [p.s.value, q.s.value], shown: [p.s.shown, q.s.shown], tier: "possible", confidence: both ? "high" : "medium" });
      }
    }
  }
  const rank = { exact: 0, high: 1, medium: 2 };
  return out.sort((x, y) => rank[x.confidence] - rank[y.confidence] || x.a.id - y.a.id);
}

const quoted = (v: string): string => JSON.stringify(printable(v));

/** Plain-text lines for the CLI; every title and value goes through printable(). The human picks the fix. */
export function conflictLines(conflicts: Conflict[]): string[] {
  const out: string[] = [];
  for (const c of conflicts) {
    out.push(`\n[conflict:${c.confidence}] [${printable(c.namespace)}] ${printable(c.key)}: ${printable(c.shown[0])}  vs  ${printable(c.shown[1])}`);
    for (const n of [c.a, c.b]) out.push(`    #${n.id} "${printable(n.title)}" by ${printable(n.writer)} [${printable(n.kind)}] (${printable(n.at.slice(0, 10))})${n.pinned ? " [pinned]" : ""}`);
    out.push(`    keep ${printable(c.shown[1])} (#${c.b.id}): monomem supersede --old ${c.a.id} --new-id ${c.b.id}`);
    out.push(`    keep ${printable(c.shown[0])} (#${c.a.id}): monomem supersede --old ${c.b.id} --new-id ${c.a.id}`);
    out.push(`    or pin one: monomem pin ${c.a.id} | monomem pin ${c.b.id}`);
    out.push(`    or distrust a writer: monomem trust distrust ${quoted(c.a.writer)} --namespace ${quoted(c.namespace)} | monomem trust distrust ${quoted(c.b.writer)} --namespace ${quoted(c.namespace)}`);
  }
  return out;
}

/** `monomem conflicts [--json] [--namespace ns]` */
export async function conflictsCmd(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const i = args.findIndex((a) => a === "--namespace" || a.startsWith("--namespace="));
  const ns = i < 0 ? undefined : args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  if (i >= 0 && !ns) {
    console.error("Usage: monomem conflicts [--json] [--namespace ns]");
    process.exit(1);
  }
  const { DB_PATH } = await import("./config.js");
  const { Store: S } = await import("./store.js");
  const store = new S(DB_PATH);
  try {
    const found = findConflicts(store, { namespaces: ns ? [ns] : undefined });
    if (json) console.log(JSON.stringify({ conflicts: found }, null, 2));
    else if (!found.length) console.log("No conflicts found.");
    else {
      console.log(`${found.length} conflict${found.length === 1 ? "" : "s"} (flagged only; nothing was changed)`);
      for (const l of conflictLines(found)) console.log(l);
    }
  } finally {
    store.close();
  }
}
