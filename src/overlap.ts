// "You may be repeating yourself": after a NEW note is written, name the existing notes that cover much the same ground.
// Agents re-store the same fact in new words all the time; each copy competes with the others in search and none is
// the current one. The hint costs nothing extra (the similarity links were just computed for the write) and changes
// nothing: the note is saved either way, the agent chooses whether to update the older note instead.
import type { Store, NoteRecord, NeighborEntry } from "./store.js";

/** Similarity score (TF-IDF cosine, 0..1) from which an existing note is named. Chosen on bench/recall (see docs/BENCHMARK.md). */
export const OVERLAP_MIN_SCORE = 0.4;
export const OVERLAP_MAX_NOTES = 3;

export const OVERLAP_HINT =
  "These existing notes cover much the same ground as the note just saved. If it restates or corrects one of them, " +
  "update that note in place (write again with its id) or replace it, so search keeps one current answer.";

/** MONOMEM_OVERLAP_HINT=off turns the hint off. */
export function overlapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MONOMEM_OVERLAP_HINT ?? "").trim().toLowerCase() !== "off";
}

export interface OverlapInfo {
  similar: NeighborEntry[];
  similar_hint: string;
}

/** The overlap hint for a note that was just created, or null when nothing similar exists (or the hint is off). */
export function overlapFor(store: Store, note: Pick<NoteRecord, "id" | "kind">): OverlapInfo | null {
  if (!overlapEnabled()) return null;
  if (note.kind && note.kind !== "note") return null;
  try {
    const similar = store.similarNotes(note.id, OVERLAP_MIN_SCORE, OVERLAP_MAX_NOTES);
    return similar.length ? { similar, similar_hint: OVERLAP_HINT } : null;
  } catch {
    return null; // a hint must never fail a write that already succeeded
  }
}
