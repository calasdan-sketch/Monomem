// Round 5: time travel shows the writer/rev of the OLD text, and archive/restore/supersede-undo history.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { asOfView, asOfFields, asOfHeader, localTimeOffset } from "../src/asof.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mark = async (): Promise<Date> => {
  await sleep(5);
  const d = new Date();
  await sleep(5);
  return d;
};

describe("writer and rev of old text", () => {
  test("an edited note shows the old version's writer and rev, not today's", async () => {
    const store = new Store(":memory:");
    const n = as("alice", () => store.create({ title: "plan", body: "one" }));
    await sleep(5);
    as("bob", () => store.update(n.id, { body: "two" }));
    const t = await mark();
    as("carol", () => store.update(n.id, { body: "three" }));
    const h = asOfView(store, t).notes[0];
    assert.equal(h.note.body, "two");
    assert.equal(h.editedSince, true);
    assert.equal(h.writer?.by, "bob");
    const f = asOfFields(h);
    assert.equal(f.written_by, "bob");
    assert.equal(f.rev, 2);
    assert.equal(f.edited_since, true);
  });

  test("an unedited note keeps its own writer; an unknown writer is left out and says so", async () => {
    const store = new Store(":memory:");
    const n = as("alice", () => store.create({ title: "plan", body: "one" }));
    const t = await mark();
    assert.equal(asOfFields(asOfView(store, t).notes[0]).written_by, "alice");
    // a metadata-only edit after T: no history row, so today's writer is not claimed for the old text
    as("mallory", () => store.update(n.id, { tags: ["x"] }));
    const f = asOfFields(asOfView(store, t).notes[0]);
    assert.equal("written_by" in f, false);
    assert.equal("rev" in f, false);
    assert.equal(f.writer_then, "not recorded");
  });
});

describe("archive, restore and supersede-undo history", () => {
  test("a note archived and restored shows as archived for that window only", async () => {
    const store = new Store(":memory:");
    const n = as("a", () => store.create({ title: "flaky", body: "x" }));
    const before = await mark();
    store.archive(n.id);
    const during = await mark();
    store.restore(n.id);
    const after = await mark();
    assert.equal(asOfView(store, before).notes.length, 1);
    assert.equal(asOfView(store, during).notes.length, 0);
    assert.equal(asOfView(store, after).notes.length, 1);
  });

  test("a restored note that was archived before T is hidden at T", async () => {
    const store = new Store(":memory:");
    const n = as("a", () => store.create({ title: "back", body: "x" }));
    store.archive(n.id);
    const during = await mark();
    store.restore(n.id);
    assert.equal(asOfView(store, during).notes.length, 0);
  });

  test("supersede then undo: replaced during the window, live before and after", async () => {
    const store = new Store(":memory:");
    const old = as("a", () => store.create({ title: "old", body: "x" }));
    const repl = as("a", () => store.create({ title: "new", body: "y" }));
    const before = await mark();
    const raw = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    const now = new Date().toISOString();
    raw.prepare("UPDATE notes SET archived_at = ?, superseded_by = ?, superseded_at = ? WHERE id = ?").run(now, repl.id, now, old.id);
    const during = await mark();
    store.supersedeUndo(old.id, "tester");
    const after = await mark();
    const ids = (d: Date) => asOfView(store, d).notes.map((x) => x.note.id).sort();
    assert.deepEqual(ids(before), [old.id, repl.id].sort());
    assert.deepEqual(ids(during), [repl.id]);
    assert.deepEqual(ids(after), [old.id, repl.id].sort());
  });

  test("the header says how far archive history reaches", async () => {
    const store = new Store(":memory:");
    as("a", () => store.create({ title: "n", body: "x" }));
    const early = new Date(Date.now() - 86_400_000);
    assert.match(asOfHeader(asOfView(store, early)), /recorded only since \d{4}-\d\d-\d\d \d\d:\d\d [+-]\d\d:\d\d/);
    assert.match(asOfHeader(asOfView(store, await mark())), /recorded from before this time/);
  });

  test("deleting a note drops its archive rows", () => {
    const store = new Store(":memory:");
    const n = as("a", () => store.create({ title: "n", body: "x" }));
    store.archive(n.id);
    assert.equal(store.archiveEvents().has(n.id), true);
    store.delete(n.id);
    assert.equal(store.archiveEvents().has(n.id), false);
  });
});

test("localTimeOffset prints local time with a UTC offset", () => {
  assert.match(localTimeOffset(new Date("2026-11-05T12:00:00Z")), /^\d{4}-\d\d-\d\d \d\d:\d\d [+-]\d\d:\d\d$/);
});
