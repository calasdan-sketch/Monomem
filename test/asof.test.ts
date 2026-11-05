// Time travel (asOfView / asOfSearch / parseAsOf): the notes as they were at time T, from history.
import "./setup-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { asOfView, asOfSearch, asOfHeader, parseAsOf, NOT_KEPT_TITLE } from "../src/asof.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);
const mark = async (): Promise<Date> => {
  await tick();
  const d = new Date();
  await tick();
  return d;
};

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  delete process.env.MONOMEM_HISTORY_VERSIONS;
});

const titles = (v: ReturnType<typeof asOfView>) => v.notes.map((n) => n.note.title);

describe("asOfView", () => {
  test("a note created after T does not exist at T", async () => {
    const t = await mark();
    as("a", () => store.create({ title: "late", body: "x" }));
    assert.deepEqual(titles(asOfView(store, t)), []);
  });

  test("an archived-after-T note was live; archived-before-T is hidden", async () => {
    const a = as("a", () => store.create({ title: "soon gone", body: "x" }));
    const b = as("a", () => store.create({ title: "already gone", body: "x" }));
    await tick();
    store.archive(b.id);
    const t = await mark();
    store.archive(a.id);
    assert.deepEqual(titles(asOfView(store, t)), ["soon gone"]);
  });

  test("a note edited after T shows the text that was current at T", async () => {
    const n = as("a", () => store.create({ title: "plan", body: "one" }));
    await tick();
    as("a", () => store.update(n.id, { body: "two" }));
    const t = await mark();
    as("a", () => store.update(n.id, { body: "three" }));
    const v = asOfView(store, t);
    assert.equal(v.notes[0].note.body, "two");
    assert.equal(v.notKept, 0);
    assert.equal(asOfView(store, await mark()).notes[0].note.body, "three");
  });

  test("a pruned version is marked not kept, never replaced by newer text", async () => {
    process.env.MONOMEM_HISTORY_VERSIONS = "1";
    const n = as("a", () => store.create({ title: "t", body: "v1" }));
    await tick();
    as("a", () => store.update(n.id, { body: "v2" }));
    const t = await mark(); // v2 is live
    as("a", () => store.update(n.id, { body: "v3" })); // v2 replaced
    as("a", () => store.update(n.id, { body: "v4" })); // limit 1: v2 is pruned
    const v = asOfView(store, t);
    assert.equal(v.notes[0].kept, false);
    assert.equal(v.notes[0].note.title, NOT_KEPT_TITLE);
    assert.equal(v.notes[0].note.body, "");
    assert.equal(v.notKept, 1);
    assert.match(asOfHeader(v), /1 notes' text from that time is no longer kept/);
  });

  test("a purged history is marked not kept", async () => {
    const n = as("a", () => store.create({ title: "t", body: "v1" }));
    await tick();
    as("a", () => store.update(n.id, { body: "v2" }));
    const t = await mark();
    as("a", () => store.update(n.id, { body: "v3" }));
    store.purgeHistory(n.id);
    assert.equal(asOfView(store, t).notKept, 1);
  });

  test("a hard-deleted note is not shown", async () => {
    const n = as("a", () => store.create({ title: "doomed", body: "x" }));
    const t = await mark();
    store.delete(n.id);
    assert.deepEqual(titles(asOfView(store, t)), []);
  });

  test("namespace scope is respected", async () => {
    as("a", () => store.create({ title: "in a", body: "x", namespace: "a" }));
    as("a", () => store.create({ title: "in b", body: "x", namespace: "b" }));
    const t = await mark();
    assert.deepEqual(titles(asOfView(store, t, { namespaces: ["a"] })), ["in a"]);
  });
});

describe("asOfSearch", () => {
  test("matches the OLD text, not the current one", async () => {
    const n = as("a", () => store.create({ title: "region", body: "deploy to frankfurt" }));
    await tick();
    as("a", () => store.update(n.id, { body: "deploy to oregon" }));
    const t = await mark();
    as("a", () => store.update(n.id, { body: "deploy to tokyo" }));
    const v = asOfView(store, t);
    assert.equal(asOfSearch(v, "oregon", 5).length, 1);
    assert.equal(asOfSearch(v, "tokyo", 5).length, 0);
    assert.equal(asOfSearch(v, "frankfurt", 5).length, 0);
  });

  test("ranks by share of keywords and a blank query lists", async () => {
    as("a", () => store.create({ title: "cats", body: "cats are great" }));
    as("a", () => store.create({ title: "cats dogs", body: "cats and dogs" }));
    const v = asOfView(store, await mark());
    assert.equal(asOfSearch(v, "cats dogs", 5)[0].note.title, "cats dogs");
    assert.equal(asOfSearch(v, "", 5).length, 2);
  });
});

describe("parseAsOf", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  test("durations and ISO", () => {
    assert.equal(parseAsOf("2h", now).toISOString(), "2026-11-05T10:00:00.000Z");
    assert.equal(parseAsOf("7d", now).toISOString(), "2026-10-29T12:00:00.000Z");
    assert.equal(parseAsOf("2026-10-01", now).toISOString(), "2026-10-01T00:00:00.000Z");
  });
  test("rejects junk and the future", () => {
    assert.throws(() => parseAsOf("yesterday", now), /cannot read/);
    assert.throws(() => parseAsOf("2027-01-01", now), /future/);
  });
});

describe("cli --as-of", () => {
  test("search --as-of prints the header, old text, and rejects a bad time", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { PROJECT_ROOT } = await import("../src/config.js");
    const home = mkdtempSync(join(tmpdir(), "mm-asof-"));
    const env = { ...process.env, MONOMEM_HOME: home, MONOMEM_DB_PATH: join(home, "t.db"), NO_COLOR: "1" };
    try {
      const db = new Store(join(home, "t.db"));
      const n = as("a", () => db.create({ title: "region", body: "deploy to oregon" }));
      await tick();
      const t = await mark();
      as("a", () => db.update(n.id, { body: "deploy to tokyo" }));
      db.close();
      const cli = join(PROJECT_ROOT, "dist", "src", "cli.js");
      const r = spawnSync(process.execPath, [cli, "search", "oregon", "--as-of", t.toISOString()], { encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^Memory as of .* \(reconstructed from history; 0 notes' text from that time is no longer kept\)/);
      assert.match(r.stdout, /#\d+ \[.*\] region/);
      assert.equal(spawnSync(process.execPath, [cli, "search", "tokyo", "--as-of", t.toISOString()], { encoding: "utf8", env }).stdout.includes("#"), false);
      assert.equal(spawnSync(process.execPath, [cli, "search", "x", "--as-of", "soon"], { encoding: "utf8", env }).status, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
