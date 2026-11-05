// Possible conflicts: two LIVE notes from DIFFERENT writers that are about the same thing and state different values
// for the same key ("deploy target: Fly.io" vs "deploy target: Render", "use pnpm" vs "use npm", a port, a version, a URL).
// FLAG ONLY: nothing is changed, hidden or merged. The human picks: supersede, pin one, or distrust a writer.
// Deterministic (no model): "key: value" lines, a few tool families for "use X", title overlap and the similarity edges.
// ponytail: exact-key matching, so a paraphrase ("we host on Fly" vs "Hosting: Render") is missed on purpose; precision first.
import type { Store, NoteRecord } from "./store.js";
import { printable } from "./security.js";

export interface ConflictNote { id: number; title: string; writer: string; at: string }
export interface Conflict {
  namespace: string;
  /** Older first. */
  a: ConflictNote;
  b: ConflictNote;
  key: string;
  values: [string, string];
  /** high: both titles state the key and value. medium: identical titles, the values are in the bodies. */
  confidence: "high" | "medium";
}

// "use X" tool families: two different members of one family under the same context conflict.
const FAMILIES: string[][] = [
  ["npm", "pnpm", "yarn", "bun"], ["jest", "vitest", "mocha", "ava"], ["postgres", "postgresql", "mysql", "sqlite", "mongodb"],
  ["fly.io", "render", "heroku", "vercel", "railway", "netlify"], ["tabs", "spaces"], ["prettier", "biome"],
  ["eslint", "biome"], ["pip", "poetry", "uv"], ["webpack", "vite", "esbuild", "rollup"], ["react", "vue", "svelte", "angular"],
];
const GENERIC_KEYS = new Set(["decision", "note", "notes", "summary", "todo", "context", "why", "status", "fix", "bug", "idea", "result", "update", "tip", "warning", "reminder", "question", "answer", "problem", "solution", "issue", "rule", "example", "see", "tldr", "http", "https"]);
const MAX_LINES = 40;

interface Stmt { key: string; value: string; fromTitle: boolean }

const clean = (v: string): string => v.toLowerCase().replace(/[`*_"']/g, "").replace(/[.,;\s]+$/, "").replace(/\s+/g, " ").trim();

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
      if (!GENERIC_KEYS.has(key)) out.push({ key, value, fromTitle });
      else rest = value; // "Decision: use pnpm" -> look at what follows the label
    }
  }
  const u = /^(?:we |always |please )?(?:use|using|prefer|run)\s+([\w.\/-]+)(?:\s+(?:for|in|on|with)\s+([\w .-]{1,30}?))?[.!]?$/i.exec(rest);
  if (u) {
    const value = clean(u[1]);
    const fam = family(value);
    if (fam >= 0) out.push({ key: `use ${fam}${u[2] ? " " + clean(u[2]) : ""}`, value, fromTitle });
  }
  return out;
}

function statements(n: NoteRecord): Stmt[] {
  const out = stmtFrom(n.title, true);
  for (const line of n.body.split("\n").slice(0, MAX_LINES)) out.push(...stmtFrom(line, false));
  return out;
}

const writerOf = (n: NoteRecord): string => n.writer_id || n.written_by;
const brief = (n: NoteRecord): ConflictNote => ({ id: n.id, title: n.title, writer: n.written_by, at: n.updated_at });

// "fly.io" vs "fly.io (prod)" is a refinement, not a conflict; "npm" vs "pnpm" is (whole words, not substrings).
const valuesDiffer = (x: string, y: string): boolean => {
  const [a, b] = [x.split(" "), y.split(" ")].sort((m, n) => m.length - n.length);
  return !a.every((w) => b.includes(w));
};

export function findConflicts(store: Store, opts: { namespaces?: string[]; notes?: NoteRecord[] } = {}): Conflict[] {
  const { namespaces } = opts;
  const notes = (opts.notes ?? store.exportAll({ live: true })).filter((n) => !namespaces || namespaces.includes(n.namespace)); // gate-ok: admin-only report
  const groups = new Map<string, Array<{ n: NoteRecord; s: Stmt }>>();
  for (const n of notes) {
    if (!writerOf(n) || n.unreadable) continue;
    const seen = new Set<string>();
    for (const s of statements(n)) {
      const k = `${n.namespace}\u0000${s.key}`;
      if (seen.has(k)) continue; // a note that states a key twice is ambiguous: use its first statement
      seen.add(k);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push({ n, s });
    }
  }
  const out: Conflict[] = [];
  const done = new Set<string>();
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [p, q] = g[i].n.updated_at <= g[j].n.updated_at ? [g[i], g[j]] : [g[j], g[i]];
        if (writerOf(p.n) === writerOf(q.n) || !valuesDiffer(p.s.value, q.s.value)) continue;
        const pair = `${p.n.id}-${q.n.id}`;
        if (done.has(pair)) continue;
        const both = p.s.fromTitle && q.s.fromTitle;
        // Same subject = both titles state the key, or the two titles are identical. ponytail: similarity edges were tried and dropped: they link look-alike notes (two services, same fields) and flooded the list with false flags.
        const same = p.n.title.trim().toLowerCase() === q.n.title.trim().toLowerCase();
        if (!both && !same) continue;
        done.add(pair);
        out.push({ namespace: p.n.namespace, a: brief(p.n), b: brief(q.n), key: p.s.key.replace(/^use \d+/, "use").trim(), values: [p.s.value, q.s.value], confidence: both ? "high" : "medium" });
      }
    }
  }
  return out.sort((x, y) => (x.confidence === y.confidence ? x.a.id - y.a.id : x.confidence === "high" ? -1 : 1));
}

/** Plain-text lines for the CLI; every title and value goes through printable(). The human picks the fix. */
export function conflictLines(conflicts: Conflict[]): string[] {
  const out: string[] = [];
  for (const c of conflicts) {
    out.push(`\n[conflict:${c.confidence}] [${printable(c.namespace)}] ${printable(c.key)}: ${printable(c.values[0])}  vs  ${printable(c.values[1])}`);
    for (const n of [c.a, c.b]) out.push(`    #${n.id} "${printable(n.title)}" by ${printable(n.writer)} (${printable(n.at.slice(0, 10))})`);
    out.push(`    your call: monomem supersede --old ${c.a.id} --new-id ${c.b.id}  |  or the reverse  |  monomem pin <id>  |  monomem trust distrust <writer>`);
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
    else if (!found.length) console.log("No possible conflicts found.");
    else {
      console.log(`${found.length} possible conflict${found.length === 1 ? "" : "s"} (flagged only; nothing was changed)`);
      for (const l of conflictLines(found)) console.log(l);
    }
  } finally {
    store.close();
  }
}
