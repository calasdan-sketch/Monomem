// Structured facts: an agent states a decision as key/value pairs when it writes ("deploy_target": "render").
// Stored as plain tags `fact:<key>=<value>`: no schema change, and the tag path already runs the secret / injection scan,
// the size limits and history. `fact:` is NOT a reserved prefix: any writer may edit tags, so reserving it would protect nothing.
// Matching is exact (same namespace + same key, different value), so a flagged pair is a real disagreement by construction.
// What it cannot know: whether two notes mean the same subject when an agent reuses one key for two things; scope keys
// ("orders.database", not "database").
import type { Store, NoteRecord } from "./store.js";
import { ValidationError } from "./store.js";
import { printable } from "./security.js";

export const FACT_PREFIX = "fact:";
export const MAX_FACTS = 10;
export const MAX_FACT_VALUE = 80;
const KEY_RE = /^[a-z0-9_.-]{1,40}$/;
const TAG_RE = /^fact:([a-z0-9_.-]{1,40})=(.{1,80})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

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
