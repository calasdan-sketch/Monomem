// The "you may be repeating yourself" hint (overlap.ts), measured on the committed coding-agent notes
// (bench/recall/coding-agent.json). Two kinds of restatement per note, each written into a store that holds the
// originals: a PARTIAL COPY (two thirds of the sentences, shuffled, new title) and a CORRECTED COPY (every number changed).
// Detected = the hint names the original. FALSE ALARMS = the first write of each distinct note names any earlier note.
// Copies are made by rule, not by a person or a model: real rewordings are harder, so read detection as an upper bound.
import { BENCH_HOME } from "./retrieval-env.js";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../store.js";
import { OVERLAP_MIN_SCORE } from "../overlap.js";
import { defaultRecallFile } from "./passages-bench.js";

export interface OverlapReport {
  notes: number;
  threshold: number;
  partialCopy: { n: number; detectedPct: number };
  correctedCopy: { n: number; detectedPct: number };
  falseAlarm: { n: number; flaggedPct: number };
  /** The same three numbers at other thresholds, to show the trade. */
  sweep: Array<{ threshold: number; partialPct: number; correctedPct: number; falseAlarmPct: number }>;
}

const sentences = (body: string): string[] => body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((s / 4294967296) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function runOverlap(file = defaultRecallFile()): OverlapReport {
  const data = JSON.parse(readFileSync(file, "utf8")) as { notes: Array<{ title: string; body: string; tags?: string[] }> };
  const dir = join(BENCH_HOME, "overlap");
  const store = new Store(join(dir, "state.db"));
  const thresholds = [...new Set([0.3, 0.4, 0.5, OVERLAP_MIN_SCORE, 0.6, 0.7, 0.8])].sort((a, b) => a - b);
  try {
    const originals: number[] = [];
    const firstScores: number[] = []; // best score against any earlier note, per original, as the write sees it
    for (const n of data.notes) {
      const r = store.create({ title: n.title, body: n.body, tags: n.tags ?? [] }, { lint: "none" });
      originals.push(r.id);
      firstScores.push(Math.max(0, ...store.listNeighbors(r.id, 10).map((x) => x.score)));
    }
    const best = (id: number, target: number): number => store.listNeighbors(id, 100).find((x) => x.id === target)?.score ?? 0;
    const partial: number[] = [];
    const corrected: number[] = [];
    data.notes.forEach((n, i) => {
      const ss = sentences(n.body);
      const keep = shuffled(ss, 7 + i).slice(0, Math.max(2, Math.ceil((ss.length * 2) / 3)));
      const p = store.create({ title: `Notes on ${n.title.toLowerCase()}`, body: keep.join(" ") }, { lint: "none" });
      partial.push(best(p.id, originals[i]));
      const c = store.create({ title: n.title, body: n.body.replace(/\d+/g, (m) => String(Number(m) + 1)) }, { lint: "none" });
      corrected.push(best(c.id, originals[i]));
    });
    const pct = (xs: number[], t: number): number => Math.round((1000 * xs.filter((x) => x + 1e-9 >= t).length) / xs.length) / 10;
    return {
      notes: data.notes.length,
      threshold: OVERLAP_MIN_SCORE,
      partialCopy: { n: partial.length, detectedPct: pct(partial, OVERLAP_MIN_SCORE) },
      correctedCopy: { n: corrected.length, detectedPct: pct(corrected, OVERLAP_MIN_SCORE) },
      falseAlarm: { n: firstScores.length, flaggedPct: pct(firstScores, OVERLAP_MIN_SCORE) },
      sweep: thresholds.map((t) => ({ threshold: t, partialPct: pct(partial, t), correctedPct: pct(corrected, t), falseAlarmPct: pct(firstScores, t) })),
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderOverlap(r: OverlapReport): string {
  const L = [`Repeat-write hint on ${r.notes} coding-agent notes (named from score ${r.threshold}):`];
  L.push(`  partial copy detected    ${r.partialCopy.detectedPct}% of ${r.partialCopy.n}`);
  L.push(`  corrected copy detected  ${r.correctedCopy.detectedPct}% of ${r.correctedCopy.n}`);
  L.push(`  false alarms on distinct notes  ${r.falseAlarm.flaggedPct}% of ${r.falseAlarm.n}`);
  L.push("  threshold   partial  corrected  false alarm");
  for (const s of r.sweep) L.push(`  ${String(s.threshold).padEnd(10)} ${String(s.partialPct).padStart(7)}% ${String(s.correctedPct).padStart(9)}% ${String(s.falseAlarmPct).padStart(10)}%`);
  return L.join("\n");
}
