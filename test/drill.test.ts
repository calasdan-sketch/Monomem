// `monomem drill`: replays the poisoning attacks on a COPY of the user's store with the user's own settings.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";
import { Store } from "../src/store.js";
import { drillMain, renderDrill, runDrill } from "../src/drill.js";

const tidy = (p: string): void => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const leftovers = (): string[] => readdirSync(tmpdir()).filter((f) => f.startsWith("monomem-drill-"));

/** A throwaway store with `n` ordinary notes. */
function makeStore(n: number): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "drill-test-"));
  const db = join(dir, "state.db");
  const s = new Store(db);
  for (let i = 0; i < n; i++) s.create({ title: `Ordinary note ${i}`, body: `Nothing special about item ${i} in the warehouse.` });
  s.close();
  return { dir, db };
}

async function withEnv<T>(k: string, v: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[k];
  process.env[k] = v;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
}

describe("monomem drill", () => {
  test("default settings: only the two known misses get through, exit code 0, real store untouched, copy deleted", async () => {
    const { dir, db } = makeStore(300);
    try {
      const before = { size: statSync(db).size, bytes: readFileSync(db) };
      const r = await runDrill({ dbPath: db });
      assert.equal(r.notes, 300);
      assert.equal(r.attacks, 20);
      assert.deepEqual(r.reached.map((x) => x.id).sort(), ["E16", "SELF"]);
      assert.deepEqual(r.unexpected, []);
      assert.equal(r.ok, true);
      assert.ok(r.rows.some((x) => x.verdict === "warned"));
      const v = (id: string): string => r.rows.find((x) => x.id === id)?.verdict ?? "";
      assert.equal(v("E01"), "held", "quarantined = held");
      assert.equal(v("E07"), "blocked", "a blocked secret is not quarantine");
      assert.match(renderDrill(r), /Poison reached the agent: 2 of 20 attacks \(known misses: E16 reworded override, self-poisoning\)/);
      assert.equal(statSync(db).size, before.size);
      assert.ok(readFileSync(db).equals(before.bytes), "the real database file is byte-for-byte unchanged");
      assert.deepEqual(leftovers(), []);
    } finally {
      tidy(dir);
    }
  });

  test("the user's settings decide the result: MONOMEM_LINT=warn lets an injection through and exits 1", async () => {
    const { dir, db } = makeStore(5);
    try {
      const r = await withEnv("MONOMEM_LINT", "warn", () => runDrill({ dbPath: db }));
      assert.ok(r.unexpected.some((x) => x.id === "E01"), "E01 reached the agent");
      assert.equal(r.ok, false);
      assert.match(renderDrill(r), /unexpected: .*E01/);
    } finally {
      tidy(dir);
    }
  });

  test("drillMain: --json is machine output, exit codes, missing store is exit 2 and creates nothing", async () => {
    const { dir, db } = makeStore(5);
    try {
      const lines: string[] = [];
      const code = await withEnv("MONOMEM_DB_PATH", db, () => drillMain(["--json"], (s) => lines.push(s)));
      assert.equal(code, 0);
      const j = JSON.parse(lines.join("\n")) as { attacks: number; ok: boolean; rows: unknown[] };
      assert.equal(j.attacks, 20);
      assert.equal(j.ok, true);
      assert.equal(j.rows.length, 20);

      const gone = join(dir, "nope.db");
      const code2 = await withEnv("MONOMEM_DB_PATH", gone, () => drillMain([], () => undefined));
      assert.equal(code2, 2);
      assert.throws(() => statSync(gone));
      assert.equal(await drillMain(["--wat"], () => undefined), 2);
    } finally {
      tidy(dir);
    }
  });

  test("a store of a few thousand notes finishes in seconds", async () => {
    const { dir, db } = makeStore(3000);
    try {
      const t = Date.now();
      const r = await runDrill({ dbPath: db });
      assert.equal(r.ok, true);
      assert.ok(Date.now() - t < 60000, `took ${Date.now() - t} ms`);
    } finally {
      tidy(dir);
    }
  });

  test("evals/poisoning-corpus.json is what the export script produces and names the designed misses", () => {
    const out = spawnSync(process.execPath, [join(PROJECT_ROOT, "scripts", "export-poison-corpus.mjs"), "--stdout"], { encoding: "utf8", cwd: PROJECT_ROOT });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readFileSync(join(PROJECT_ROOT, "evals", "poisoning-corpus.json"), "utf8"), out.stdout);
    const c = JSON.parse(out.stdout) as { attacks: Array<{ id: string; designed_miss?: string }> };
    assert.equal(c.attacks.length, 20);
    assert.deepEqual(c.attacks.filter((a) => a.designed_miss).map((a) => a.id), ["E16", "SELF"]);
  });
});
