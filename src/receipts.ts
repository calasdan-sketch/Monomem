// Memory receipts: which notes a session start showed, and why. Ids, why-tags, rank and approximate tokens only --
// never note text or titles (same rule as the meter). Titles are looked up live from the store when a receipt is read.
// Kept as long as the read-access log (MONOMEM_ACCESS_LOG_DAYS, default 30; 0 = receipts off).
// Same pattern as meter.ts: CREATE TABLE IF NOT EXISTS in the capture database, so no schema version bump; writes are
// best-effort (a receipt that cannot be written never costs a session its context).
// Also here: the shareable savings card (`monomem meter --card`) and the CLI commands that use both.
import { localTimeOffset } from "./asof.js";
import { writeFileSync } from "node:fs";
import { accessLogDays, type Store } from "./store.js";
import { printable } from "./security.js";
import { meterStats, meterLine, type MeterTotals } from "./meter.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS memory_receipts (
  session_id TEXT NOT NULL,
  note_id INTEGER NOT NULL,
  namespace TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  rank INTEGER NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, note_id)
)`;

export interface ReceiptNote {
  id: number;
  rank: number;
  why: string;
  tokens: number;
  /** Looked up live: null when the note is gone or not visible to this reader. */
  title: string | null;
  /** ok = still readable; gone = deleted, archived or hidden by the trust policy since (not told apart: the gate hides the difference). */
  state: "ok" | "gone";
}
export interface ReceiptSummary {
  session_id: string;
  namespace: string;
  client: string;
  at: string;
  notes: number;
  tokens: number;
}
export interface Receipt extends Omit<ReceiptSummary, "notes"> {
  notes: ReceiptNote[];
}

/** Record what one session start showed (fail-silent); also drops receipts past the retention window. */
export function receiptAdd(
  store: Store,
  r: { sessionId: string; namespace: string; client: string; shown: Array<{ id: number; why: string; tokens: number }> },
  now: number = Date.now()
): void {
  const days = accessLogDays();
  if (!r.sessionId || !r.shown.length || days === 0) return;
  try {
    const db = store.captureDb();
    db.exec(SCHEMA);
    db.prepare("DELETE FROM memory_receipts WHERE at < ?").run(new Date(now - days * 86_400_000).toISOString());
    db.prepare("DELETE FROM memory_receipts WHERE session_id = ?").run(r.sessionId);
    const ins = db.prepare("INSERT OR REPLACE INTO memory_receipts (session_id, note_id, namespace, client, at, rank, why, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const at = new Date(now).toISOString();
    r.shown.forEach((n, i) => ins.run(r.sessionId, n.id, r.namespace, r.client, at, i + 1, n.why, Math.max(0, Math.round(n.tokens))));
  } catch (e) {
    process.stderr.write(`monomem: receipt not saved (${(e as Error).message})\n`);
  }
}

function hasTable(store: Store): boolean {
  return !!store.captureDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_receipts'").get();
}
const nsWhere = (ns?: string[]): string => (ns ? ` AND namespace IN (${ns.map(() => "?").join(",") || "NULL"})` : "");

/** Recent sessions, newest first, optionally limited to some namespaces. */
export function receiptList(store: Store, namespaces?: string[], limit = 20): ReceiptSummary[] {
  if (!hasTable(store)) return [];
  const rows = store
    .captureDb()
    .prepare(
      `SELECT session_id, MIN(namespace) AS namespace, MIN(client) AS client, MIN(at) AS at, COUNT(*) AS notes, SUM(tokens) AS tokens
       FROM memory_receipts WHERE 1=1${nsWhere(namespaces)} GROUP BY session_id ORDER BY at DESC, session_id DESC LIMIT ?`
    )
    .all(...(namespaces ?? []), Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as ReceiptSummary[];
  return rows.map((r) => ({ ...r, notes: Number(r.notes), tokens: Number(r.tokens) }));
}

/** One session's receipt with titles looked up now, or null when there is none (or it is outside `namespaces`). */
export function receiptGet(store: Store, sessionId: string, namespaces?: string[]): Receipt | null {
  if (!hasTable(store)) return null;
  const db = store.captureDb();
  const rows = db
    .prepare(`SELECT note_id, namespace, client, at, rank, why, tokens FROM memory_receipts WHERE session_id = ?${nsWhere(namespaces)} ORDER BY rank`)
    .all(sessionId, ...(namespaces ?? [])) as Array<{ note_id: number; namespace: string; client: string; at: string; rank: number; why: string; tokens: number }>;
  if (!rows.length) return null;
  const notes = rows.map((r): ReceiptNote => {
    const n = store.readVisible(Number(r.note_id), { hideArchived: true });
    const state = n ? "ok" : "gone";
    return { id: Number(r.note_id), rank: Number(r.rank), why: r.why, tokens: Number(r.tokens), title: n ? n.title : null, state };
  });
  const f = rows[0];
  return { session_id: sessionId, namespace: f.namespace, client: f.client, at: f.at, tokens: notes.reduce((a, n) => a + n.tokens, 0), notes };
}

// ---- Savings card ----------------------------------------------------------------------------------------------

export const esc = (v: unknown): string =>
  (typeof v === "number" ? v.toLocaleString("en-US") : String(v)).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/&#60;/g, "&lt;").replace(/&#62;/g, "&gt;");

export const CARD_REPO = "github.com/calasdan-sketch/monomem";
const SLATE = "#9FB3C4";

/** Crescent mark (a gold disc with a navy bite; the card is solid navy) and the two-tone lowercase wordmark, as on the dashboard. */
export function cardBrand(label = ""): string {
  return (
    `<circle cx="52" cy="46" r="17" fill="#F0C171"/><circle cx="60" cy="41" r="15" fill="#0B2E45"/>` +
    `<text x="80" y="56" font-size="30" font-weight="700" fill="#FFFFFF">mono<tspan fill="#F0C171">mem</tspan>` +
    (label ? `<tspan font-size="17" font-weight="400" fill="${SLATE}"> ${esc(label)}</tspan>` : "") +
    `</text>`
  );
}

/** One footer line on every card: how to get it, and where it lives. */
export function cardFooter(y = 344): string {
  return `<text x="40" y="${y}" font-size="12" fill="${SLATE}"><tspan font-weight="600" fill="#F0C171">npx monomem setup</tspan> &#183; ${esc(CARD_REPO)}</text>`;
}

/** Greedy word wrap for SVG (which does not wrap): at most `max` characters a line. */
export function wrapText(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (lines.length && lines[lines.length - 1].length + 1 + w.length <= max) lines[lines.length - 1] += " " + w;
    else lines.push(w);
  }
  return lines;
}

/** Wrapped text as one <text> with a <tspan> per line. */
export function svgLines(text: string, x: number, y: number, max: number, attrs: string, lineHeight = 17): string {
  const t = wrapText(text, max).map((l, i) => `<tspan x="${x}"${i ? ` dy="${lineHeight}"` : ""}>${esc(l)}</tspan>`).join("");
  return `<text x="${x}" y="${y}" ${attrs}>${t}</text>`;
}

/** A 640x360 SVG with the meter's real totals. Estimates at ~4 chars/token, exactly as meter.ts computes them. */
export function renderCard(t: MeterTotals): string {
  const stat = (x: number, n: unknown, label: string): string =>
    `<text x="${x}" y="188" font-size="44" font-weight="700" fill="#F0C171">${esc(n)}</text>` +
    `<text x="${x}" y="214" font-size="15" fill="#FFFFFF">${esc(label)}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" font-family="system-ui, -apple-system, Segoe UI, sans-serif">` +
    `<rect width="640" height="360" rx="18" fill="#0B2E45"/>` +
    cardBrand() +
    `<text x="40" y="104" font-size="15" fill="#FFFFFF">What local memory saved my agents</text>` +
    stat(40, t.sessions, Number(t.sessions) === 1 ? "session" : "sessions") +
    stat(230, t.injected_tokens, "tokens injected") +
    stat(430, t.saved_tokens, "est. tokens saved") +
    `<text x="40" y="256" font-size="13" fill="${SLATE}"><tspan x="40">estimate, ~4 chars/token. Saved = captured work the injected memory</tspan><tspan x="40" dy="18">stood in for, minus the tokens injected.</tspan></text>` +
    `<text x="40" y="312" font-size="15" font-weight="600" fill="#F0C171">No network calls by Monomem by default</text>` +
    cardFooter() +
    `</svg>\n`
  );
}

// ---- CLI -------------------------------------------------------------------------------------------------------

async function openStore(): Promise<Store> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  return new Store(DB_PATH);
}

/** `monomem meter [--json] [--card [path]]` */
export async function meterCmd(args: string[]): Promise<void> {
  const store = await openStore();
  try {
    const m = meterStats(store);
    const ci = args.indexOf("--card");
    if (ci >= 0) {
      const next = args[ci + 1];
      const path = next && !next.startsWith("-") ? next : "monomem-card.svg";
      writeFileSync(path, renderCard(m.totals));
      console.log(`wrote ${path}`);
    } else console.log(args.includes("--json") ? JSON.stringify(m, null, 2) : meterLine(m));
  } finally {
    store.close();
  }
}

/** "2026-11-05 14:03:00 -06:00": the reader's local time with its UTC offset (the same format `as-of` prints); the stored string if it does not parse. */
export const localTime = (iso: string): string => localTimeOffset(iso);
/** `{files,kw 3d}` -> "files, kw; 3 days old"; `{recent 0d}` -> "recent; today". Anything else is shown as stored. */
export function whyText(why: string): string {
  const m = /^\{(?:(.*?) )?(\d+)d\}$/.exec(why);
  if (!m) return why;
  const days = Number(m[2]);
  const age = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} old`;
  return `${m[1] ? m[1].split(",").join(", ") + "; " : ""}${age}`;
}
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** `monomem receipts [session-id] [--json]` */
export async function receiptsCmd(args: string[]): Promise<void> {
  const store = await openStore();
  try {
    const json = args.includes("--json");
    const id = args.find((a) => !a.startsWith("-"));
    if (id) {
      const r = receiptGet(store, id);
      if (!r) {
        console.error(`no receipt for session ${printable(id)} (kept ${accessLogDays()} days, MONOMEM_ACCESS_LOG_DAYS)`);
        process.exit(1);
      }
      if (json) return console.log(JSON.stringify(r, null, 2));
      console.log(`session ${printable(r.session_id)}  ${localTime(r.at)}  ${printable(r.client || "-")}${r.namespace ? `  namespace ${printable(r.namespace)}` : ""}`);
      console.log(`  ${plural(r.notes.length, "note")} shown, ~${r.tokens} tokens of note text (the whole injection is a little larger: it adds headers and a footer; see \`monomem meter\`)`);
      for (const n of r.notes) console.log(`  ${n.rank}. #${n.id} ~${n.tokens} tokens, why: ${whyText(n.why)}  ${n.state === "ok" ? printable(n.title) : "(deleted, archived or hidden since)"}`);
      return;
    }
    const list = receiptList(store);
    if (json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log("No receipts yet: they are written by the next session the SessionStart hook runs for.");
    for (const s of list) console.log(`${printable(s.session_id)}  ${localTime(s.at)}  ${plural(s.notes, "note")}, ~${s.tokens} tokens of note text  ${printable(s.client || "-")}`);
  } finally {
    store.close();
  }
}
