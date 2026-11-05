// Time travel: the notes as they were at time T, rebuilt from what the store already keeps (read-only, no schema change).
//  - created_at / archived_at / superseded_at say whether a note existed and was live at T.
//  - note_history says what a note's text was: a row holds the text of one version and `saved_at` = when that version was
//    REPLACED, so the version live at T is the kept row with the smallest saved_at after T (else the note's current text).
//  - note_history_dropped says when versions were pruned or purged. If a dropped version could have been the one live at T,
//    the note is shown as "text from that time not kept" -- never the newer text passed off as old.
//  - archive_log (a trigger on archived_at, see Store.ensureArchiveLog) and supersede_log say when a note was archived, restored or
//    replaced and brought back. archive_log only reaches back to its `archive_log_since`; before that a restore is not known.
//  - The writer and rev shown with old text come from note_history (the version's own writer / number), never today's.
// Cannot reconstruct: hard-deleted notes (no text survives), tag/source changes that made no new history row, an archive and
// restore from before archive_log began (shows live), and anything from before history was on (MONOMEM_HISTORY_VERSIONS=0).
import { historyLimits, type NoteRecord, type Store } from "./store.js";
import { extractKeywords } from "./keywords.js";
import { keywordCoverage } from "./search-service.js";

export const NOT_KEPT_TITLE = "(text from that time not kept)";

export interface AsOfNote {
  /** The note as of T. When `kept` is false the title is NOT_KEPT_TITLE and the body is empty. */
  note: NoteRecord;
  kept: boolean;
  /** The note was changed after T: the writer / rev are those of the old version, or unknown (null), never today's. */
  editedSince: boolean;
  /** Who wrote the text shown and which version it was. null = not recorded. For an unedited note this is the note's own. */
  writer: { by: string; rev: number } | null;
}
export interface AsOfView {
  when: Date;
  notes: AsOfNote[];
  /** Notes that existed and were live at T but whose text from then is gone. */
  notKept: number;
  /** Notes that existed at T but were archived or replaced then, so they are not in `notes`. */
  archivedThen: number;
  /** When archive/restore recording began (null = unknown). Before it, a restored note shows as live. */
  archiveSince: string | null;
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

type Content = Pick<NoteRecord, "title" | "body" | "tags"> & { writer: { by: string; rev: number } | null };
const who = (by: string, rev: number): Content["writer"] => (by ? { by, rev } : null);

/** The note's text at T (with its writer / rev from history): current text, a kept older version, or null when it cannot be told. */
function contentAt(store: Store, n: NoteRecord, t: number): Content | null {
  if (ms(n.updated_at) <= t) return { ...n, writer: who(n.written_by, n.rev) }; // not edited since T
  const after = store
    .historyOf(n.id)
    .filter((h) => ms(h.saved_at) > t)
    .sort((a, b) => ms(a.saved_at) - ms(b.saved_at))[0];
  const horizon = after ? ms(after.saved_at) : Infinity;
  // A dropped version replaced inside (T, horizon) might be the one that was live at T.
  if (store.historyDropped(n.id).some((d) => ms(d.last_at) > t && ms(d.first_at) < horizon)) return null;
  if (after) return { ...after, writer: who(after.written_by, after.version) };
  // Edited after T but no history row after T: a metadata-only edit, unless history was off and a text edit left no trace.
  // Today's writer / rev may belong to that later edit, so they are not claimed for the old text.
  return historyLimits().versions === 0 ? null : { ...n, writer: null };
}

type ArchEv = Array<{ at: string; archived: boolean }>;
type SupEv = Array<{ at: string; retired: boolean }>;

/** Was the note archived or replaced at T? Recorded flips first; with none, the note's current archived_at. */
function goneAt(n: NoteRecord, t: number, arch: ArchEv = [], sup: SupEv = []): boolean {
  const before = arch.filter((e) => ms(e.at) <= t);
  const next = arch.find((e) => ms(e.at) > t);
  let gone: boolean;
  if (before.length) gone = before[before.length - 1].archived;
  else if (next) gone = !next.archived; // the first recorded flip after T says what the state was before it
  else gone = ms(n.archived_at) <= t;
  const s = sup.filter((e) => ms(e.at) <= t);
  if (s.length && s[s.length - 1].retired) gone = true; // replaced (supersede_log reaches back further than archive_log)
  return gone || ms(n.superseded_at) <= t;
}

export function asOfView(store: Store, when: Date, opts: AsOfOpts = {}): AsOfView {
  const t = when.getTime();
  const scope = { ...(opts.namespaces ? { namespaces: opts.namespaces } : opts.namespace ? { namespace: opts.namespace } : {}), ...(opts.includeDistrusted ? { includeDistrusted: true } : {}) };
  const notes: AsOfNote[] = [];
  const arch = store.archiveEvents();
  const sup = store.supersedeEvents();
  let notKept = 0;
  let archivedThen = 0;
  for (let offset = 0; ; offset += 500) {
    const page = store.list({ ...scope, includeArchived: true, limit: 500, offset });
    for (const n of page.notes) {
      if (ms(n.created_at) > t) continue; // did not exist yet
      if (goneAt(n, t, arch.get(n.id), sup.get(n.id))) {
        archivedThen++; // archived or replaced at T
        continue;
      }
      const c = contentAt(store, n, t);
      const editedSince = ms(n.updated_at) > t;
      if (c) notes.push({ note: { ...n, title: c.title, body: c.body, tags: c.tags }, kept: true, editedSince, writer: c.writer });
      else {
        notKept++;
        notes.push({ note: { ...n, title: NOT_KEPT_TITLE, body: "", tags: [] }, kept: false, editedSince, writer: null });
      }
    }
    if (offset + 500 >= page.total) break;
  }
  notes.sort((a, b) => ms(b.note.created_at) - ms(a.note.created_at) || b.note.id - a.note.id);
  return { when, notes, notKept, archivedThen, archiveSince: store.archiveLogSince() };
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

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** Local time with seconds and its UTC offset: "2026-11-05 09:30:15 -06:00". */
export function localTimeOffset(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return String(d);
  const off = -x.getTimezoneOffset();
  const a = Math.abs(off);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())} ${pad2(x.getHours())}:${pad2(x.getMinutes())}:${pad2(x.getSeconds())} ${off < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

export const WRITER_NOT_RECORDED = "not recorded";

/**
 * One note of a past view as a plain object for MCP / --json. Old text never carries today's writer or rev: an edited-since note
 * gets the old version's own (from history) or `writer_then: "not recorded"` with those fields left out.
 */
export function asOfFields(h: AsOfNote, decorate: (n: NoteRecord) => object = (n) => n): Record<string, unknown> {
  const {
    written_by, rev, updated_at, merged_from_writers, writer_id, attested_writer, attested_by, attested_writer_id,
    confidence, confidence_claimed_by, imported_written_by, imported_created_by, ...rest
  } = decorate(h.note) as NoteRecord;
  const base = { ...rest, text_kept: h.kept, edited_since: h.editedSince };
  // Edited since T: today's provenance and confidence claim belong to the newer text and history keeps neither, so they are dropped.
  if (!h.editedSince) {
    const kept = { written_by, rev, updated_at, merged_from_writers, writer_id, attested_writer, attested_by, attested_writer_id, confidence, confidence_claimed_by, imported_written_by, imported_created_by };
    return { ...base, ...Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)) };
  }
  return h.writer ? { ...base, written_by: h.writer.by, rev: h.writer.rev } : { ...base, writer_then: WRITER_NOT_RECORDED };
}

export function asOfHeader(view: AsOfView): string {
  const since = view.archiveSince;
  const arch = since && Date.parse(since) <= view.when.getTime()
    ? "Archive and restore times are recorded from before this time."
    : `Archive and restore times are recorded only since ${since ? localTimeOffset(since) : "(unknown)"}: a note archived and restored before then shows as live.`;
  const archived = view.archivedThen ? `
${view.archivedThen} ${view.archivedThen === 1 ? "note was" : "notes were"} archived or replaced then and ${view.archivedThen === 1 ? "is" : "are"} not shown.` : "";
  return `Memory as of ${localTimeOffset(view.when)} (reconstructed from history; ${view.notKept} notes' text from that time is no longer kept)${archived}
Notes deleted for good are not shown: a hard delete leaves no text to rebuild.
${arch}`;
}
