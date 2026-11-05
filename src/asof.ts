// Time travel: the notes as they were at time T, rebuilt from what the store already keeps (read-only, no schema change).
//  - created_at / archived_at / superseded_at say whether a note existed and was live at T.
//  - note_history says what a note's text was: a row holds the text of one version and `saved_at` = when that version was
//    REPLACED, so the version live at T is the kept row with the smallest saved_at after T (else the note's current text).
//  - note_history_dropped says when versions were pruned or purged. If a dropped version could have been the one live at T,
//    the note is shown as "text from that time not kept" -- never the newer text passed off as old.
// Cannot reconstruct: hard-deleted notes (no text survives), tag/source changes that made no new history row, a note archived
// and later restored (shows live the whole time), and anything from before history was on (MONOMEM_HISTORY_VERSIONS=0).
import { historyLimits, type NoteRecord, type Store } from "./store.js";
import { extractKeywords } from "./keywords.js";
import { keywordCoverage } from "./search-service.js";

export const NOT_KEPT_TITLE = "(text from that time not kept)";

export interface AsOfNote {
  /** The note as of T. When `kept` is false the title is NOT_KEPT_TITLE and the body is empty. */
  note: NoteRecord;
  kept: boolean;
}
export interface AsOfView {
  when: Date;
  notes: AsOfNote[];
  /** Notes that existed and were live at T but whose text from then is gone. */
  notKept: number;
}
export interface AsOfOpts {
  namespace?: string;
  namespaces?: string[];
  includeDistrusted?: boolean;
}

const DURATION = /^(\d+)\s*([mhdw])$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "7d", "2h", "30m", "2w" (ago) or an ISO date / timestamp. Throws a plain message on anything else or a future time. */
export function parseAsOf(raw: string, now: Date = new Date()): Date {
  const s = raw.trim();
  const d = DURATION.exec(s);
  const t = d ? new Date(now.getTime() - Number(d[1]) * UNIT_MS[d[2].toLowerCase()]) : /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s) : new Date(NaN);
  if (Number.isNaN(t.getTime())) throw new Error(`cannot read "${raw}" as a time: use an ISO date/time (2026-10-01 or 2026-10-01T12:00:00Z) or an age like 7d, 2h, 30m, 2w`);
  if (t.getTime() > now.getTime()) throw new Error(`"${raw}" is in the future`);
  return t;
}

const ms = (s: string | undefined | null): number => (s ? Date.parse(s) : NaN);

/** The note's text at T: current text, a kept older version, or null when it cannot be told. */
function contentAt(store: Store, n: NoteRecord, t: number): Pick<NoteRecord, "title" | "body" | "tags"> | null {
  if (ms(n.updated_at) <= t) return n; // not edited since T
  const after = store
    .historyOf(n.id)
    .filter((h) => ms(h.saved_at) > t)
    .sort((a, b) => ms(a.saved_at) - ms(b.saved_at))[0];
  const horizon = after ? ms(after.saved_at) : Infinity;
  // A dropped version replaced inside (T, horizon) might be the one that was live at T.
  if (store.historyDropped(n.id).some((d) => ms(d.last_at) > t && ms(d.first_at) < horizon)) return null;
  if (after) return after;
  // Edited after T but no history row after T: a metadata-only edit, unless history was off and a text edit left no trace.
  return historyLimits().versions === 0 ? null : n;
}

export function asOfView(store: Store, when: Date, opts: AsOfOpts = {}): AsOfView {
  const t = when.getTime();
  const scope = { ...(opts.namespaces ? { namespaces: opts.namespaces } : opts.namespace ? { namespace: opts.namespace } : {}), ...(opts.includeDistrusted ? { includeDistrusted: true } : {}) };
  const notes: AsOfNote[] = [];
  let notKept = 0;
  for (let offset = 0; ; offset += 500) {
    const page = store.list({ ...scope, includeArchived: true, limit: 500, offset });
    for (const n of page.notes) {
      if (ms(n.created_at) > t) continue; // did not exist yet
      const gone = Math.min(ms(n.archived_at) || Infinity, ms(n.superseded_at) || Infinity);
      if (gone <= t) continue; // already archived or replaced
      const c = contentAt(store, n, t);
      if (c) notes.push({ note: { ...n, title: c.title, body: c.body, tags: c.tags }, kept: true });
      else {
        notKept++;
        notes.push({ note: { ...n, title: NOT_KEPT_TITLE, body: "", tags: [] }, kept: false });
      }
    }
    if (offset + 500 >= page.total) break;
  }
  notes.sort((a, b) => ms(b.note.created_at) - ms(a.note.created_at) || b.note.id - a.note.id);
  return { when, notes, notKept };
}

/**
 * Search the reconstructed notes with the keyword scorer the CLI already uses (share of query keywords found, newest first on a tie).
 * Not the FTS index: that holds only today's text, so it would miss a note whose OLD text matched. Limits: no bm25, no semantic
 * ranking, no time phrases; notes whose text from then is not kept cannot match. A blank query lists the notes, newest first.
 */
export function asOfSearch(view: AsOfView, query: string, limit: number): AsOfNote[] {
  const q = query.trim();
  if (!q) return view.notes.slice(0, limit);
  const kw = extractKeywords(q);
  const words = kw.length > 0 ? kw : q.split(/\s+/);
  return view.notes
    .map((x) => ({ x, score: x.kept ? keywordCoverage(x.note, words) : 0 }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score) // stable: ties stay newest first
    .slice(0, limit)
    .map((r) => r.x);
}

export function asOfHeader(view: AsOfView): string {
  return `Memory as of ${view.when.toISOString()} (reconstructed from history; ${view.notKept} notes' text from that time is no longer kept)\nNotes deleted for good are not shown: a hard delete leaves no text to rebuild.`;
}
