// Structured facts: an agent states a decision as key/value pairs when it writes ("deploy_target": "render").
// Stored as plain tags `fact:<key>=<value>`: no schema change, and the tag path already runs the secret / injection scan,
// the size limits and history. `fact:` is NOT a reserved prefix: any writer may edit tags, so reserving it would protect nothing.
// Matching is exact (same namespace + same key, different value), so a flagged pair is a real disagreement by construction.
// What it cannot know: whether two notes mean the same subject when an agent reuses one key for two things. Use a common key
// (COMMON_FACT_KEYS) when one fits, and prefix a subject ("api.deploy_target") only when the project has several.
import type { Store, NoteRecord } from "./store.js";
import { ValidationError } from "./store.js";
import { printable } from "./security.js";

export const FACT_PREFIX = "fact:";
export const MAX_FACTS = 10;
export const MAX_FACT_VALUE = 80;
const KEY_RE = /^[a-z0-9_.-]{1,40}$/;
const TAG_RE = /^fact:([a-z0-9_.-]{1,40})=(.{1,80})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The keys agents are told to reuse, so two writers state one decision under one key. One list: the tool text, SKILL.md and the docs repeat it. */
export const COMMON_FACT_KEYS = ["deploy_target", "package_manager", "test_runner", "database", "node_version", "base_url", "ci_provider", "formatter"] as const;

// Spellings agents drift to. The first entry of each group is the common key. Deterministic: no model, no fuzzy matching.
const KEY_SYNONYMS: readonly (readonly string[])[] = [
  ["deploy_target", "hosting", "host", "runs_on", "deploy_to", "deployment_target", "deploy_host"],
  ["package_manager", "pkg_manager", "pkg_mgr", "package_mgr"],
  ["test_runner", "test_framework", "testing_framework", "test_tool"],
  ["database", "db", "datastore", "db_engine"],
  ["node_version", "node", "nodejs_version"],
  ["base_url", "api_url", "api_base_url", "site_url"],
  ["ci_provider", "ci", "ci_service", "ci_system"],
  ["formatter", "code_formatter", "format_tool"],
];

/** Same value, compared the way a person would: case and runs of spaces do not count. */
export const normFact = (v: string): string => v.toLowerCase().replace(/\s+/g, " ").trim();

/** Validate `facts` and return its tags. undefined -> []. Throws ValidationError. Secret / injection scanning happens when the tags are stored. */
export function factTags(facts: unknown): string[] {
  if (facts === undefined) return [];
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) throw new ValidationError('facts must be an object like {"deploy_target": "render"}');
  const entries = Object.entries(facts as Record<string, unknown>);
  if (entries.length > MAX_FACTS) throw new ValidationError(`too many facts (max ${MAX_FACTS})`);
  return entries.map(([k, v]) => {
    if (!KEY_RE.test(k)) throw new ValidationError(`fact key "${printable(k, 40)}" is not allowed: use 1-40 characters from a-z 0-9 _ . -`);
    if (typeof v !== "string" || !v.trim()) throw new ValidationError(`fact "${k}": the value must be a non-empty string`);
    if (v.trim().length > MAX_FACT_VALUE) throw new ValidationError(`fact "${k}": the value is longer than ${MAX_FACT_VALUE} characters`);
    if (CONTROL.test(v)) throw new ValidationError(`fact "${k}": the value must be one line of plain text`);
    return `${FACT_PREFIX}${k}=${v.trim()}`;
  });
}

/**
 * The tags to store when a write carries `facts`. No `facts` -> `tags` unchanged. With facts, they REPLACE the note's fact tags
 * (`facts: {}` clears them); on an update that passes no tags, the note's other existing tags are kept.
 */
export function withFacts(tags: string[] | undefined, facts: unknown, existing?: readonly string[]): string[] | undefined {
  if (facts === undefined) return tags;
  const add = factTags(facts);
  return [...(tags ?? existing ?? []).filter((t) => !t.startsWith(FACT_PREFIX)), ...add];
}

/** The facts a note carries (first tag wins per key). Tags that are not a valid fact are ignored. */
export function noteFacts(tags: readonly string[]): Array<[string, string]> {
  const out = new Map<string, string>();
  for (const t of tags) {
    const m = TAG_RE.exec(t.trim());
    if (m && !out.has(m[1]) && m[2].trim()) out.set(m[1], m[2].trim());
  }
  return [...out];
}

const writerOf = (n: NoteRecord): string => n.writer_id || n.written_by;
const MAX_REPORTED = 5;

/**
 * Right after a write: live notes from a DIFFERENT writer, in the same namespace, that state another value for one of this
 * note's fact keys. The write has already succeeded; these lines go back to the agent so it can ask the user. Distrusted writers are skipped.
 */
export function writeConflicts(store: Store, note: NoteRecord): string[] {
  const mine = noteFacts(note.tags);
  if (!mine.length) return [];
  const out: string[] = [];
  for (const [key, value] of mine) {
    for (const o of store.liveFactNotes(note.namespace, key, note.id)) {
      const theirs = noteFacts(o.tags).find(([k]) => k === key)?.[1];
      if (theirs === undefined || writerOf(o) === writerOf(note) || normFact(theirs) === normFact(value)) continue;
      out.push(`conflicts with #${o.id} by ${printable(o.written_by, 60)}: ${key} ${printable(theirs, MAX_FACT_VALUE)} (theirs) vs ${printable(value, MAX_FACT_VALUE)} (yours). Both are kept; ask the user which is right.`);
      if (out.length >= MAX_REPORTED) return out;
    }
  }
  return out;
}

const lastSegment = (k: string): string => k.slice(k.lastIndexOf(".") + 1);
const groupOf = (seg: string): readonly string[] | undefined => KEY_SYNONYMS.find((g) => g.includes(seg));

/**
 * Key drift: the fact keys of `note` that no other live note in its namespace uses yet, each with the existing keys that look
 * like the same thing (same last segment, or the same synonym group), so the agent can reuse one. Deterministic. {} when none.
 */
export function similarKeys(store: Store, note: NoteRecord): Record<string, string[]> {
  const mine = noteFacts(note.tags).map(([k]) => k);
  if (!mine.length) return {};
  const existing = new Set<string>();
  for (const o of store.liveFactNotesIn(note.namespace)) if (o.id !== note.id) for (const [k] of noteFacts(o.tags)) existing.add(k);
  const out: Record<string, string[]> = {};
  for (const key of mine) {
    if (existing.has(key)) continue;
    const seg = lastSegment(key);
    const group = groupOf(seg);
    const like = [...existing].filter((k) => k !== key && (lastSegment(k) === seg || (group !== undefined && group.includes(lastSegment(k))))).sort().slice(0, 3);
    if (like.length) out[key] = like;
  }
  return out;
}

/**
 * Session start: at most MAX_DISPUTE_LINES short lines naming keys on which different writers' live notes disagree
 * ("Disputed: deploy_target = render (bob) vs fly.io (alice). Ask the user before acting."). "" when there are none.
 * One indexed-by-namespace lookup of notes that carry facts, not findConflicts over every note.
 */
const MAX_DISPUTE_LINES = 2;
export function disputedLines(store: Store, namespace: string): string {
  const byKey = new Map<string, Map<string, { shown: string; writers: Map<string, string> }>>();
  for (const n of store.liveFactNotesIn(namespace)) {
    for (const [k, v] of noteFacts(n.tags)) {
      const vals = byKey.get(k) ?? byKey.set(k, new Map()).get(k)!;
      const e = vals.get(normFact(v)) ?? vals.set(normFact(v), { shown: v, writers: new Map() }).get(normFact(v))!;
      e.writers.set(writerOf(n), n.written_by);
    }
  }
  const lines: string[] = [];
  for (const [key, vals] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const sides = [...vals.values()];
    // Disputed = two different values stated by different writers. A lone writer who changed their mind is not a dispute.
    const writers = new Set(sides.flatMap((s) => [...s.writers.keys()]));
    if (sides.length < 2 || writers.size < 2) continue;
    const text = sides.slice(0, 3).map((s) => `${printable(s.shown, 40)} (${printable([...new Set(s.writers.values())].sort().join("/"), 30)})`).join(" vs ");
    lines.push(`Disputed: ${printable(key, 40)} = ${text}. Ask the user before acting.`);
    if (lines.length >= MAX_DISPUTE_LINES) break;
  }
  return lines.join("\n");
}
