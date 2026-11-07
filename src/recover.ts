// `monomem recover`: copy every note that can still be read out of a damaged database file into a new, healthy one.
//
// SQLite stops at the first unreadable page, so a truncated copy, a bad disk sector or a half-synced file can make
// every command fail with "database disk image is malformed" while most notes are still on disk. This reads the notes
// table row by row (a failed read skips that row, not the rest), copies the readable columns as they are (so bodies that
// are encrypted stay encrypted, and ids, timestamps and writer stamps are kept), and lets the new database's own
// triggers rebuild the full-text index. The damaged file is opened read-only and never changed; the output is a new file.
// Similarity links, the change feed and trust settings are not copied: `rebuild-edges` makes the links again.
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.js";

export interface RecoverReport {
  source: string;
  out: string;
  /** Highest note id found in the damaged file (the best guess at how many notes it held), or null when unreadable. */
  highestId: number | null;
  /** True when the size of the original is known (the highest id was read); false means notes may be missing and the loss is unknown. */
  totalKnown: boolean;
  /** Best guess at how many notes the file held: the highest id, the table's id counter, or a page-count estimate. null when nothing gives one. */
  estimatedTotal: number | null;
  /** Where `estimatedTotal` came from. */
  estimateFrom: "highest-id" | "id-counter" | "page-count" | "none";
  /** Pages the header says the file has, and how many were actually present (truncated copies); null when not applicable. */
  pagesDeclared: number | null;
  pagesPresent: number | null;
  notesRecovered: number;
  /** True when nothing could be recovered: the new file was removed and there is nothing to switch to. */
  outRemoved: boolean;
  /** Ids between 1 and highestId that could not be read (some of them were deleted before the damage). */
  idsUnreadable: number;
  historyRecovered: number;
  encryptedRows: number;
  notes: string[];
}

const NOTE_BATCH = 500;
const GIVE_UP_AFTER_EMPTY = 3000;

function columnsOf(db: DatabaseSync, table: string): string[] | null {
  try {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    return cols.length ? cols : null;
  } catch {
    return null;
  }
}

const MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/** True when the schema can be read at all. */
function readable(file: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* never opened */
    }
  }
}

/**
 * Always work on a private copy next to the output file, never on the damaged file itself: opening a database (even
 * read-only) can create `-shm`/`-wal` files beside it, and a write-ahead log beside it holds the newest notes, so the
 * `-wal` file is copied too when it exists. The copy is also padded back to the size the header states (a truncated
 * file) and given its header text back (a damaged first 16 bytes), because SQLite refuses to read either. The damaged
 * file and its sidecars are never touched. Costs temporary disk space equal to the file's size.
 */
function workingCopy(source: string, tmpParent: string): { file: string; done: () => void; notes: string[]; declared: number | null; present: number | null } {
  const dir = mkdtempSync(join(tmpParent, ".recover-tmp-"));
  const copy = join(dir, "damaged.db");
  const done = (): void => rmSync(dir, { recursive: true, force: true });
  const notes: string[] = [];
  try {
    copyFileSync(source, copy);
    if (existsSync(`${source}-wal`)) {
      copyFileSync(`${source}-wal`, `${copy}-wal`);
      notes.push("the write-ahead log (state.db-wal) beside the damaged file was read too, so the newest notes are included when it is intact");
    }
    const fd = openSync(copy, "r");
    const head = Buffer.alloc(100);
    const n = readSync(fd, head, 0, 100, 0);
    closeSync(fd);
    let declared: number | null = null;
    let present: number | null = null;
    if (n >= 100) {
      if (!head.subarray(0, 16).equals(MAGIC)) {
        const wfd = openSync(copy, "r+");
        writeSync(wfd, MAGIC, 0, 16, 0);
        closeSync(wfd);
        notes.push("the file header was damaged and was put back on a private copy");
      }
      const pageSize = head.readUInt16BE(16) === 1 ? 65536 : head.readUInt16BE(16);
      const pages = head.readUInt32BE(28);
      const want = pageSize * pages;
      const size = statSync(copy).size;
      if (pageSize >= 512 && pages > 0 && size < want) {
        truncateSync(copy, want);
        declared = pages;
        present = Math.floor(size / pageSize);
        notes.push(`the file is shorter than its header says (a truncated copy: ${present} of ${pages} pages present): the missing pages count as unreadable`);
      }
    }
    return { file: copy, done, notes, declared, present };
  } catch (e) {
    done();
    throw e;
  }
}

/** Remove the output file and its sidecars. */
function removeOut(out: string): void {
  for (const f of [out, `${out}-wal`, `${out}-shm`, `${out}-journal`]) rmSync(f, { force: true });
}

export function recoverDatabase(source: string, out: string): RecoverReport {
  if (!existsSync(source)) throw new Error(`no database file at ${source}`);
  // lstat, not exists: a dangling symlink at `out` must not be followed (it would create its target).
  let taken = true;
  try {
    lstatSync(out);
  } catch {
    taken = false;
  }
  if (taken) throw new Error(`${out} already exists: recover writes a new file and never overwrites one`);
  try {
    const fd = openSync(out, "wx", 0o600); // exclusive: fails if anything appeared meanwhile, never follows a link
    closeSync(fd);
  } catch (e) {
    throw new Error(`cannot create ${out}: ${(e as Error).message}`);
  }
  let report: RecoverReport;
  try {
    report = recoverInto(source, out);
  } catch (e) {
    removeOut(out); // a failed run leaves nothing half-made behind
    throw e;
  }
  if (report.notesRecovered === 0) {
    removeOut(out);
    report.outRemoved = true;
  }
  return report;
}

function recoverInto(source: string, out: string): RecoverReport {
  const report: RecoverReport = {
    source, out, highestId: null, totalKnown: false, estimatedTotal: null, estimateFrom: "none", pagesDeclared: null, pagesPresent: null,
    notesRecovered: 0, outRemoved: false, idsUnreadable: 0, historyRecovered: 0, encryptedRows: 0, notes: [],
  };
  const work = workingCopy(source, dirname(out));
  report.pagesDeclared = work.declared;
  report.pagesPresent = work.present;
  let src: DatabaseSync;
  try {
    src = new DatabaseSync(work.file, { readOnly: true });
  } catch (e) {
    work.done();
    throw e;
  }
  try {
    src.exec("PRAGMA trusted_schema = OFF"); // a damaged (or hostile) file's views and triggers are not run on our behalf
  } catch {
    /* an older SQLite: the read-only connection still cannot write */
  }
  const dest = new Store(out);
  try {
    chmodSync(out, 0o600); // the new file holds the notes: owner only, like the database
  } catch {
    /* not supported on this file system */
  }
  report.notes.push(...work.notes);
  try {
    const have = columnsOf(src, "notes");
    const want = (dest.captureDb().prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>).map((c) => c.name);
    // When even the table definitions are unreadable, assume this version's own columns and fall back to the basic ones.
    const tryCols = have ? want.filter((c) => have.includes(c)) : want;
    const basic = ["id", "namespace", "title", "body", "tags", "created_at", "updated_at"].filter((c) => want.includes(c));
    let cols = tryCols;
    const select = (c: string[]): ReturnType<DatabaseSync["prepare"]> => src.prepare(`SELECT ${c.join(", ")} FROM notes WHERE id > ? ORDER BY id LIMIT ${NOTE_BATCH}`);
    const one = (c: string[]): ReturnType<DatabaseSync["prepare"]> => src.prepare(`SELECT ${c.join(", ")} FROM notes WHERE id = ?`);
    try {
      select(cols);
    } catch {
      cols = basic;
      report.notes.push("the notes table definition was unreadable: only id, namespace, title, body, tags and dates were copied");
    }
    if (!cols.includes("id") || !cols.includes("title")) throw new Error("the notes table cannot be read at all; nothing to recover");
    const ins = dest.captureDb().prepare(`INSERT OR IGNORE INTO notes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    try {
      report.highestId = Number((src.prepare("SELECT MAX(id) AS m FROM notes").get() as { m: number | null }).m ?? 0);
      report.totalKnown = true;
    } catch {
      report.highestId = null;
    }
    let counter: number | null = null;
    if (report.highestId === null) {
      try {
        const r = src.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'notes'").get() as { seq: number } | undefined;
        if (r && Number.isFinite(Number(r.seq))) counter = Number(r.seq);
      } catch {
        counter = null;
      }
    }
    const sel = select(cols);
    const byId = one(cols);
    let last = 0;
    let emptyRun = 0;
    const seen = new Set<number>();
    const put = (rows: Array<Record<string, unknown>>): void => {
      dest.transaction(() => {
        for (const r of rows) {
          const id = Number(r.id);
          if (seen.has(id)) continue;
          seen.add(id);
          ins.run(...cols.map((c) => (r[c] === undefined ? null : r[c])) as never[]);
          if (r.body_enc !== null && r.body_enc !== undefined && r.body_enc !== "") report.encryptedRows++;
          report.notesRecovered++;
        }
      });
    };
    for (;;) {
      if (report.highestId !== null && last >= report.highestId) break;
      let rows: Array<Record<string, unknown>> | null = null;
      try {
        rows = sel.all(last) as Array<Record<string, unknown>>;
      } catch {
        rows = null;
      }
      if (rows !== null) {
        if (rows.length === 0) break;
        put(rows);
        last = Number(rows[rows.length - 1].id);
        emptyRun = 0;
        continue;
      }
      // The batch read hit damage: take the next ids one at a time and skip what cannot be read.
      const got: Array<Record<string, unknown>> = [];
      const stop = report.highestId !== null ? Math.min(report.highestId, last + NOTE_BATCH) : last + NOTE_BATCH;
      for (let id = last + 1; id <= stop; id++) {
        try {
          const r = byId.get(id) as Record<string, unknown> | undefined;
          if (r) {
            got.push(r);
            emptyRun = 0;
          } else emptyRun++;
        } catch {
          emptyRun++;
        }
      }
      put(got);
      last = stop;
      if (report.highestId === null && emptyRun >= GIVE_UP_AFTER_EMPTY) break;
    }
    report.idsUnreadable = report.highestId === null ? 0 : Math.max(0, report.highestId - report.notesRecovered);
    // How big was the original? The highest id when it could be read; else the table's id counter; else, for a truncated
    // file, scale what was found by the share of pages present. Otherwise unknown, and the caller must say so.
    if (report.highestId !== null) {
      report.estimatedTotal = report.highestId;
      report.estimateFrom = "highest-id";
    } else if (counter !== null && counter >= report.notesRecovered) {
      report.estimatedTotal = counter;
      report.estimateFrom = "id-counter";
    } else if (report.pagesDeclared && report.pagesPresent && report.notesRecovered > 0) {
      report.estimatedTotal = Math.round((report.notesRecovered * report.pagesDeclared) / report.pagesPresent);
      report.estimateFrom = "page-count";
    }
    if (report.estimatedTotal !== null && report.estimateFrom !== "highest-id") report.idsUnreadable = Math.max(0, report.estimatedTotal - report.notesRecovered);

    // Earlier versions of notes (undo history), when that table can be read.
    const hHave = columnsOf(src, "note_history");
    const hWant = (dest.captureDb().prepare("PRAGMA table_info(note_history)").all() as Array<{ name: string }>).map((c) => c.name);
    if (hHave) {
      const hc = hWant.filter((c) => hHave.includes(c));
      try {
        const hins = dest.captureDb().prepare(`INSERT OR IGNORE INTO note_history (${hc.join(", ")}) VALUES (${hc.map(() => "?").join(", ")})`);
        const hsel = src.prepare(`SELECT ${hc.join(", ")} FROM note_history WHERE rowid > ? ORDER BY rowid LIMIT ${NOTE_BATCH}`);
        let at = 0;
        for (;;) {
          const rows = hsel.all(at) as Array<Record<string, unknown>>;
          if (!rows.length) break;
          dest.transaction(() => {
            for (const r of rows) {
              if (!seen.has(Number(r.note_id))) continue; // history of a note that was not recovered is of no use
              hins.run(...hc.map((c) => (r[c] === undefined ? null : r[c])) as never[]);
              report.historyRecovered++;
            }
          });
          const lastRow = src.prepare(`SELECT MAX(rowid) AS m FROM (SELECT rowid FROM note_history WHERE rowid > ? ORDER BY rowid LIMIT ${NOTE_BATCH})`).get(at) as { m: number };
          at = Number(lastRow.m);
        }
      } catch {
        report.notes.push("the undo history was only partly readable");
      }
    }
    return report;
  } finally {
    try {
      src.close();
    } catch {
      /* already closed */
    }
    dest.close();
    work.done();
  }
}
