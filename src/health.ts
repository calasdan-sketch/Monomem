// `monomem health`: one pass over the checks Monomem already has (doctor essentials, security settings, the poisoning
// drill, the audit chain, held writes, distrust rules, redaction markers, the meter) and one grade with a rule anyone can
// re-compute from the lines. Read-only: the store is opened to count things and drill works on a copy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BIND_HOST, DATA_DIR, DB_PATH } from "./config.js";
import { runDrill, type DrillReport } from "./drill.js";
import { meterStats } from "./meter.js";
import { esc } from "./receipts.js";
import { verifyAuditChain } from "./security.js";
import { Store } from "./store.js";

export type Status = "ok" | "warn" | "fail";
export interface HealthCheck {
  id: string;
  /** Short name, used on the card. */
  label: string;
  status: Status;
  /** One line: what was found and what it means. */
  text: string;
}
export interface HealthReport {
  grade: string;
  rule: string;
  checks: HealthCheck[];
  not_covered: string;
  date: string;
  exit_code: 0 | 1;
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];
export const GRADE_RULE =
  "Start at A. Each warn lowers it one step (A to F). Any fail caps it at D. Unexpected drill reach (an attack other than the two known misses got through) is F. A to C exits 0, D to F exits 1.";
export const NOT_COVERED = "Not covered: the injection check is a pattern linter; reworded attacks and self-poisoning still get through.";

/** The grade, computed only from the check statuses (the drill check failing is the F case). */
export function gradeOf(checks: Pick<HealthCheck, "id" | "status">[]): string {
  if (checks.some((c) => c.id === "drill" && c.status === "fail")) return "F";
  let i = checks.filter((c) => c.status === "warn").length;
  if (checks.some((c) => c.status === "fail")) i = Math.max(i, 3);
  return LETTERS[Math.min(i, LETTERS.length - 1)];
}

/** The settings doctor warns about (doctor's own copy lives in cli.ts; keep the two in step). */
export async function securityWarnings(dataDir: string, bindHost: string): Promise<string[]> {
  const { lintPolicy } = await import("./lint.js");
  const out: string[] = [];
  const p = lintPolicy();
  if (p.secret === "warn" || p.injection === "warn") out.push(`MONOMEM_LINT weakens the memory linter (secrets: ${p.secret}, injection: ${p.injection})`);
  if (process.env.MONOMEM_STDIO_ADMIN_TOOLS === "1") out.push("MONOMEM_STDIO_ADMIN_TOOLS=1 lets an agent approve its own held writes");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(bindHost)) out.push(`MONOMEM_BIND=${bindHost} is not loopback`);
  if (/(?:^|[\\/])(?:OneDrive[^\\/]*|Dropbox[^\\/]*|iCloud Drive[^\\/]*|iCloudDrive|Google Drive[^\\/]*|GoogleDrive[^\\/]*|Mobile Documents)(?:[\\/]|$)/i.test(dataDir)) {
    out.push("data folder is inside a cloud-sync folder");
  }
  return out;
}

function hookWired(settingsPath: string): boolean {
  try {
    const entries = (JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: { SessionStart?: unknown } }).hooks?.SessionStart;
    return Array.isArray(entries) && /(monomem|onememory|cli\.js)[\s\S]{0,60}\b(recall|hook session-start)\b/.test(JSON.stringify(entries));
  } catch {
    return false;
  }
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export interface HealthOpts {
  dbPath?: string;
  dataDir?: string;
  bindHost?: string;
  settingsPath?: string;
  auditPath?: string;
  now?: Date;
  drill?: typeof runDrill;
}

export async function runHealth(o: HealthOpts = {}): Promise<HealthReport> {
  const dbPath = o.dbPath ?? process.env.MONOMEM_DB_PATH ?? DB_PATH;
  const checks: HealthCheck[] = [];
  const add = (id: string, label: string, status: Status, text: string): void => void checks.push({ id, label, status, text });

  const { nodeIsOk, MIN_NODE_TEXT, sqliteHasFts5 } = await import("./setup.js");
  const nodeOk = nodeIsOk(process.versions.node) && sqliteHasFts5();
  add("node", "Node", nodeOk ? "ok" : "fail", nodeOk ? `Node ${process.versions.node} with SQLite FTS5` : `Node ${process.versions.node} needs >= ${MIN_NODE_TEXT} with SQLite FTS5, or search fails`);

  let notes = 0, held = 0, distrust = 0, marked = 0, dbOk = false;
  let meterText = "meter unavailable";
  if (existsSync(dbPath)) {
    try {
      const s = new Store(dbPath);
      try {
        notes = s.countAll();
        held = s.listQuarantine({ limit: 500 }).length;
        distrust = s.distrustRules().length;
        // ponytail: loads every live note to count markers; use SQL if a store gets big enough for this to show up in the runtime
        marked = s.exportAll({ live: true }).filter((n) => /\[REDACTED:/.test(`${n.title}\n${n.body}`)).length; // gate-ok: operator CLI, counts redaction markers only; no note content is returned or printed
        const m = meterStats(s);
        meterText = `${plural(notes, "note")}, database ${(m.db_bytes / 1048576).toFixed(1)} MB; the meter counts ~${m.totals.saved_tokens} tokens saved over ${plural(m.totals.sessions, "session")} (estimate, ~4 characters a token)`;
        dbOk = true;
      } finally {
        s.close();
      }
    } catch (e) {
      add("database", "Database", "fail", `cannot open ${dbPath}: ${(e as Error).message}`);
    }
  } else add("database", "Database", "fail", `no database at ${dbPath} (start Monomem or run monomem setup first)`);
  if (dbOk) add("database", "Database", "ok", `database opens (${plural(notes, "note")})`);

  const hook = hookWired(o.settingsPath ?? join(homedir(), ".claude", "settings.json"));
  add("hooks", "Hooks", hook ? "ok" : "warn", hook ? "SessionStart hook wired in ~/.claude/settings.json" : "no monomem SessionStart hook in ~/.claude/settings.json, so Claude Code gets no memory at session start");

  const sec = await securityWarnings(o.dataDir ?? DATA_DIR, o.bindHost ?? BIND_HOST);
  add("security", "Security settings", sec.length ? "warn" : "ok", sec.length ? `${plural(sec.length, "warning")}: ${sec.join("; ")} (monomem doctor has the detail)` : "no weakening settings found (lint, stdio admin tools, bind address, cloud-sync folder)");

  if (dbOk) {
    try {
      const d: DrillReport = await (o.drill ?? runDrill)({ dbPath });
      const known = d.reached.length - d.unexpected.length;
      add("drill", "Drill", d.ok ? "ok" : "fail", d.ok ? `${d.reached.length} of ${d.attacks} known attacks reached the agent, all known misses (${known})` : `${d.unexpected.length} unexpected of ${d.attacks} attacks reached the agent: ${d.unexpected.map((x) => x.id).join(", ")} (monomem drill has the detail)`);
    } catch (e) {
      add("drill", "Drill", "warn", `could not run: ${(e as Error).message}`);
    }
  } else add("drill", "Drill", "warn", "not run: no usable database");

  try {
    const a = verifyAuditChain(o.auditPath);
    add("audit", "Audit chain", a.breaks > 0 ? "fail" : "ok", a.lines === 0 ? "no audit log yet" : a.breaks > 0 ? `${plural(a.breaks, "break")} (first at line ${a.brokenLine}): a log line was edited or removed` : `${plural(a.lines, "line")}, no breaks, ${plural(a.forks, "fork")} (forks are concurrent writers, not tampering)`);
  } catch (e) {
    add("audit", "Audit chain", "warn", `could not read the audit log: ${(e as Error).message}`);
  }

  if (dbOk) {
    add("held", "Held writes", held ? "warn" : "ok", held ? `${held >= 500 ? "500 or more writes" : plural(held, "write")} held for review (monomem quarantine list)` : "no writes waiting for review");
    add("distrust", "Distrusted writers", "ok", `${plural(distrust, "distrust rule")}${distrust ? " (their notes are hidden from agents)" : ""}`);
    add("redacted", "Redacted notes", "ok", `notes with a [REDACTED:...] marker (secret redaction replaced a credential): ${marked}`);
    add("memory", "Memory size", "ok", meterText);
  }

  const grade = gradeOf(checks);
  return { grade, rule: GRADE_RULE, checks, not_covered: NOT_COVERED, date: (o.now ?? new Date()).toISOString().slice(0, 10), exit_code: grade <= "C" ? 0 : 1 };
}

export function renderHealth(r: HealthReport): string {
  const tag: Record<Status, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]" };
  return [
    "monomem health\n",
    ...r.checks.map((c) => `  ${tag[c.status]} ${c.label}: ${c.text}`),
    "",
    `Grade ${r.grade}`,
    `Rule: ${r.rule}`,
    r.not_covered,
  ].join("\n");
}

/** A 640x360 SVG in the meter card's colours. Every text goes through esc(). */
export function renderHealthCard(r: HealthReport): string {
  const colour: Record<Status, string> = { ok: "#FFFFFF", warn: "#F0C171", fail: "#FF9E8A" };
  const rows = r.checks
    .map((c, i) => `<text x="200" y="${108 + i * 20}" font-size="14" fill="${colour[c.status]}">${esc(`${c.label}: ${c.status}`)}</text>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" font-family="system-ui, -apple-system, Segoe UI, sans-serif">` +
    `<rect width="640" height="360" rx="18" fill="#0B2E45"/>` +
    `<text x="40" y="60" font-size="30" font-weight="700" fill="#F0C171">monomem health</text>` +
    `<text x="40" y="215" font-size="150" font-weight="700" fill="#F0C171">${esc(r.grade)}</text>` +
    rows +
    `<text x="40" y="318" font-size="12" fill="#FFFFFF">${esc(r.not_covered)}</text>` +
    `<text x="40" y="340" font-size="13" font-weight="600" fill="#F0C171">${esc(r.date)}</text>` +
    `</svg>\n`
  );
}

export const HEALTH_USAGE = `monomem health [--json] [--card [file.svg]]

  One line per check (setup, security settings, drill, audit chain, held writes, distrusted writers, redacted notes,
  memory size), then a grade. Your store is only read; drill runs on a copy.

  Grade rule: ${GRADE_RULE}
  ${NOT_COVERED}
  --card writes a shareable SVG (default monomem-health.svg).`;

export async function healthMain(argv: string[], out: (s: string) => void = console.log, opts: HealthOpts = {}): Promise<number> {
  let json = false;
  let card: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return out(HEALTH_USAGE), 0;
    if (a === "--json") json = true;
    else if (a === "--card") card = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "monomem-health.svg";
    else return console.error(`health: unknown option ${a} (try: monomem health --help)`), 2;
  }
  const r = await runHealth(opts);
  if (card) writeFileSync(card, renderHealthCard(r));
  out(json ? JSON.stringify({ ...r, ...(card ? { card } : {}) }, null, 2) : renderHealth(r) + (card ? `\nwrote ${card}` : ""));
  return r.exit_code;
}
