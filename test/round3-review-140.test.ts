// 1.4.0 review fixes: recover never hides a possible loss and cleans up after itself, doctor --deep treats a busy
// server as "skipped", the compact tool schema keeps its safety text, and a re-import picks up changed entities.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { recoverDatabase } from "../src/recover.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { readMcpMemory } from "../src/foreign-import.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const run = (args: string[], home: string): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, MONOMEM_HOME: home, MONOMEM_TOOLS: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

function seeded(total = 300): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "monomem-r3fix-"));
  const db = join(dir, "state.db");
  const s = new Store(db);
  s.transaction(() => {
    for (let i = 0; i < total; i++) s.create({ title: `note ${i}`, body: `body ${i} ${"lorem ".repeat(40)}` }, { skipEdges: true, lint: "none" });
  });
  s.close();
  for (const e of ["-wal", "-shm"]) if (existsSync(db + e)) rmSync(db + e);
  return { dir, db };
}

test("recover (CLI): a recovered count is never printed without either an estimated total or the unknown-loss caveat", () => {
  const d = seeded();
  const cut = join(d.dir, "cut.db");
  copyFileSync(d.db, cut);
  truncateSync(cut, Math.floor(statSync(d.db).size * 0.5));
  const r = run(["recover", "--from", cut, "--out", join(d.dir, "o.db")], d.dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Recovered \d+ note\(s\)( of about \d+|\n  Total unknown)/);
  assert.match(r.out, /of the file present|pages present|of about/);
  const rep = recoverDatabase(cut, join(d.dir, "o2.db"));
  assert.ok(rep.pagesDeclared && rep.pagesPresent && rep.pagesPresent < rep.pagesDeclared);
  assert.ok(rep.estimatedTotal !== null || rep.totalKnown === false);
  if (!rep.totalKnown) assert.notEqual(rep.estimateFrom, "highest-id");
  rmSync(d.dir, { recursive: true, force: true });
});

test("recover: zero notes removes the output and prints no switch-over advice; a failure leaves nothing behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-r3zero-"));
  const empty = join(dir, "empty.db");
  new Store(empty).close();
  const out = join(dir, "o.db");
  const rep = recoverDatabase(empty, out);
  assert.equal(rep.notesRecovered, 0);
  assert.equal(rep.outRemoved, true);
  assert.equal(existsSync(out), false);
  const cli = run(["recover", "--from", empty, "--out", join(dir, "o2.db")], dir);
  assert.equal(cli.code, 2);
  assert.doesNotMatch(cli.out, /move the damaged|rename the new file/);
  assert.match(cli.out, /Recovered 0 notes/);
  assert.equal(existsSync(join(dir, "o2.db")), false);
  const junk = join(dir, "junk.db");
  writeFileSync(junk, Buffer.alloc(9000, 7));
  assert.throws(() => recoverDatabase(junk, join(dir, "o3.db")));
  assert.equal(existsSync(join(dir, "o3.db")), false, "failed run leaves no output");
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".recover-tmp")), []);
  rmSync(dir, { recursive: true, force: true });
});

test("recover: a dangling symlink at the output path is refused and its target is not created", () => {
  const d = seeded(20);
  const target = join(d.dir, "elsewhere.db");
  const link = join(d.dir, "link.db");
  symlinkSync(target, link);
  assert.throws(() => recoverDatabase(d.db, link), /already exists/);
  assert.equal(existsSync(target), false);
  assert.ok(lstatSync(link).isSymbolicLink());
  rmSync(d.dir, { recursive: true, force: true });
});

test("recover: reads a private copy (no -shm beside the damaged file) and uses a -wal beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-r3wal-"));
  const live = join(dir, "live", "state.db");
  const s = new Store(live);
  for (let i = 0; i < 40; i++) s.create({ title: `walnote ${i}`, body: `unique wal body ${i}` }, { skipEdges: true, lint: "none" });
  const copyDir = join(dir, "copy");
  const dmg = join(copyDir, "state.db");
  // Snapshot while the writer is still open: the newest notes live only in the -wal file.
  mkdtempSync(copyDir + "-x");
  rmSync(copyDir + "-x", { recursive: true, force: true });
  require_mkdir(copyDir);
  copyFileSync(live, dmg);
  const hasWal = existsSync(live + "-wal");
  if (hasWal) copyFileSync(live + "-wal", dmg + "-wal");
  s.close();
  const before = readdirSync(copyDir).sort();
  const rep = recoverDatabase(dmg, join(dir, "out.db"));
  assert.deepEqual(readdirSync(copyDir).sort(), before, "nothing was created or removed beside the damaged file");
  assert.equal(rep.notesRecovered, 40);
  if (hasWal) assert.ok(rep.notes.some((n) => /write-ahead log/.test(n)));
  rmSync(dir, { recursive: true, force: true });
});
import { mkdirSync } from "node:fs";
function require_mkdir(p: string): void {
  mkdirSync(p, { recursive: true });
}

test("deepCheck: a live writer holding the lock gives 'skipped', quickly, never 'damaged'; doctor does not suggest recover", () => {
  const d = seeded(50);
  const s = new Store(d.db);
  const other = new DatabaseSync(d.db);
  other.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const t = Date.now();
  const r = s.deepCheck();
  const ms = Date.now() - t;
  other.exec("ROLLBACK");
  other.close();
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.equal(r.skipped, true);
  assert.equal(r.fullText, "skipped");
  assert.notEqual(r.integrity, "damaged");
  assert.equal(s.deepCheck().skipped, false, "and it runs normally once the lock is free");
  s.close();
  // CLI wording with a writer holding the lock.
  const holder = new DatabaseSync(d.db);
  holder.exec("BEGIN IMMEDIATE");
  const cli = run(["doctor", "--deep"], d.dir);
  holder.exec("ROLLBACK");
  holder.close();
  assert.doesNotMatch(cli.out + cli.err, /monomem recover/);
  rmSync(d.dir, { recursive: true, force: true });
});

test("compact schema keeps the safety text of destructive and admin tools", async () => {
  const store = new Store(":memory:");
  const server = createMcpServer(store, "admin", { tools: "all", schema: "compact" } as never, {});
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
  const text = (n: string): string => JSON.stringify(tools.get(n));
  for (const n of ["memory_consolidate", "memory_consolidation_candidates", "memory_rebuild_edges"]) assert.match(text(n), /admin/i, `${n} says admin`);
  assert.match(String(tools.get("memory_consolidate")?.description), /Deletes/);
  assert.match(text("memory_consolidate"), /dry_run/);
  assert.match(text("memory_consolidate"), /keep_sources[^}]*DELETED/);
  assert.match(String(tools.get("memory_rebuild_edges")?.description), /O\(n\^2\)/);
  assert.match(text("state_write"), /advisory only/);
  const props = (n: string): Record<string, { description?: string }> => (tools.get(n)?.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props("state_write").source.description ?? "", /Advisory only/);
  assert.match(props("state_write").confidence.description ?? "", /Advisory only/);
  const ex = props("memory_since").exclude_self.description ?? "";
  assert.ok(/[.)]$/.test(ex) && !ex.endsWith("…"), `exclude_self not cut mid-sentence: ${ex}`);
  assert.match(props("memory_since").ack_mode.description ?? "", /ack_token/);
  assert.match(String(tools.get("memory_since")?.description), /ack_token/);
  await client.close();
  store.close();
});

test("mcp-memory re-import: an entity that gained observations gets a new id, an unchanged one keeps its id", () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-mcpmem2-"));
  const f = join(dir, "memory.json");
  const ent = (obs: string[]): string => JSON.stringify({ type: "entity", name: "Billing service", entityType: "service", observations: obs });
  const other = JSON.stringify({ type: "entity", name: "Auth service", entityType: "service", observations: ["Uses OAuth"] });
  writeFileSync(f, [ent(["Runs on port 8081"]), other].join("\n"));
  const first = readMcpMemory(f);
  writeFileSync(f, [ent(["Runs on port 8081"]), other].join("\n"));
  const same = readMcpMemory(f);
  assert.deepEqual(same.map((i) => i.id), first.map((i) => i.id), "unchanged entities keep their ids");
  writeFileSync(f, [ent(["Runs on port 8081", "Moved to port 9090"]), other].join("\n"));
  const grown = readMcpMemory(f);
  const byTitle = (xs: typeof first, t: string) => xs.find((i) => i.title === t)!;
  assert.notEqual(byTitle(grown, "Billing service").id, byTitle(first, "Billing service").id);
  assert.equal(byTitle(grown, "Auth service").id, byTitle(first, "Auth service").id);
  writeFileSync(f, [ent(["Moved to port 9090", "Runs on port 8081"]), other].join("\n"));
  assert.equal(byTitle(readMcpMemory(f), "Billing service").id, byTitle(grown, "Billing service").id, "observation order does not matter");
  rmSync(dir, { recursive: true, force: true });
});
