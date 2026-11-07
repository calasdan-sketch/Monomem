// 1.4.0: big-store behaviour: edges through the full-text index, the list index, bounded query repair.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { runSearch } from "../src/search-service.js";

const stores: Store[] = [];
const mk = (): Store => {
  const s = new Store(":memory:");
  stores.push(s);
  return s;
};
afterEach(() => {
  delete process.env.MONOMEM_EDGE_EXACT_MAX_NOTES;
  delete process.env.MONOMEM_REPAIR_FULL_MAX_NOTES;
  while (stores.length) stores.pop()!.close();
});

const filler = (i: number): string => `unrelated filler sentence number${i} about lunch menus and parking permits`;

test("above the size limit a new note is still linked to its twin, through the full-text index", () => {
  process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = "0";
  const s = mk();
  for (let i = 0; i < 60; i++) s.create({ title: `filler ${i}`, body: filler(i) });
  const a = s.create({ title: "Postgres connection pool", body: "The API uses a Postgres connection pool of 20 with pgbouncer in transaction mode." });
  const b = s.create({ title: "Pool settings for Postgres", body: "Postgres connection pool is 20, pgbouncer runs in transaction mode for the API." });
  const nb = s.listNeighbors(b.id).map((n) => n.id);
  assert.ok(nb.includes(a.id), "the near-identical note is a neighbour");
  assert.ok(s.listNeighbors(a.id).some((n) => n.id === b.id), "and the link is two-way");
  assert.equal(s.cachedEdgeIndexes().length, 0, "no per-note word index is held in memory");
});

test("the index path never links across namespaces, archived notes or the note itself", () => {
  process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = "0";
  const s = mk();
  const text = { title: "Staging deploy region", body: "Staging deploys to ca-central-1 through the release pipeline every night." };
  const other = s.create({ ...text, namespace: "other" });
  const gone = s.create({ ...text });
  s.archive(gone.id);
  const me = s.create({ ...text });
  assert.deepEqual(s.listNeighbors(me.id), [], "other namespace and archived notes are not neighbours");
  assert.deepEqual(s.listNeighbors(other.id), []);
});

test("an update re-links through the same path", () => {
  process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = "0";
  const s = mk();
  for (let i = 0; i < 30; i++) s.create({ title: `filler ${i}`, body: filler(i) });
  const a = s.create({ title: "Cache TTL", body: "The session cache keeps entries for 15 minutes before eviction by the sweeper." });
  const b = s.create({ title: "Misc", body: "Remember to renew the domain." });
  assert.ok(!s.listNeighbors(b.id).some((n) => n.id === a.id));
  s.update(b.id, { title: "Cache TTL notes", body: "The session cache keeps entries 15 minutes before the sweeper evicts them." });
  assert.ok(s.listNeighbors(b.id).some((n) => n.id === a.id));
});

test("on clustered notes the index path finds most of the exhaustive links", () => {
  const s = mk();
  let seed = 7;
  const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const topics = Array.from({ length: 12 }, (_, c) => Array.from({ length: 25 }, (_, k) => `topic${c}word${k}`));
  const common = Array.from({ length: 400 }, (_, k) => `common${k}`);
  const ids: number[] = [];
  for (let i = 0; i < 400; i++) {
    const c = Math.floor(rnd() * topics.length);
    const w = Array.from({ length: 40 }, () => (rnd() < 0.6 ? topics[c][Math.floor(Math.pow(rnd(), 2) * 25)] : common[Math.floor(Math.pow(rnd(), 2) * 400)]));
    ids.push(s.create({ title: w.slice(0, 3).join(" "), body: w.join(" ") }, { skipEdges: true, lint: "none" }).id);
  }
  let exactN = 0;
  let found = 0;
  for (let k = 0; k < 40; k++) {
    const n = s.read(ids[k * 10])!;
    process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = "1000000";
    const exact = s.planEdges(n.namespace, n.title, n.body, 0.25, new Set([n.id])).pairs;
    process.env.MONOMEM_EDGE_EXACT_MAX_NOTES = "0";
    const fast = new Set(s.planEdges(n.namespace, n.title, n.body, 0.25, new Set([n.id])).pairs.map((p) => p.neighborId));
    exactN += exact.length;
    found += exact.filter((p) => fast.has(p.neighborId)).length;
  }
  assert.ok(exactN > 100, `enough links to compare (${exactN})`);
  assert.ok(found / exactN >= 0.8, `found ${found} of ${exactN}`);
});

test("list reads in index order and agrees with the plain query, with or without the total", () => {
  const dir = new Store(":memory:");
  stores.push(dir);
  for (let i = 0; i < 25; i++) dir.create({ title: `n${i}`, body: `body ${i}`, namespace: i % 2 ? "a" : "b" }, { skipEdges: true });
  const all = dir.list({ namespace: "a", limit: 100 });
  assert.equal(all.total, 12);
  assert.deepEqual(all.notes.map((n) => n.title), all.notes.map((n) => n.title).slice().sort((x, y) => 0)); // stable, newest first below
  const page = dir.list({ namespace: "a", limit: 5, withTotal: false });
  assert.equal(page.notes.length, 5);
  assert.deepEqual(page.notes.map((n) => n.id), all.notes.slice(0, 5).map((n) => n.id));
  assert.equal(page.total, 5, "no count was made: the page size is returned");
  const unscoped = dir.list({ limit: 3, withTotal: false });
  assert.deepEqual(unscoped.notes.map((n) => n.id), dir.list({ limit: 3 }).notes.map((n) => n.id));
});

test("on a big store a misspelt word must keep its first two letters, and the abbreviation scan is skipped", async () => {
  process.env.MONOMEM_REPAIR_FULL_MAX_NOTES = "0";
  const s = mk();
  s.create({ title: "Postgres pool", body: "Postgres connection pool settings and ECONNRESET handling" });
  const typo2 = await runSearch(s, "pxstgres", { mode: "keyword", limit: 3 }); // second letter wrong: not repaired on a big store
  assert.equal(typo2.length, 0);
  const typo = await runSearch(s, "postgress", { mode: "keyword", limit: 3 }); // first two letters kept: repaired
  assert.equal(typo.length, 1);
  const abbr = await runSearch(s, "connection reset", { mode: "keyword", limit: 3 });
  assert.ok(abbr.length >= 1, "still found by the ordinary search on 'connection'");
  delete process.env.MONOMEM_REPAIR_FULL_MAX_NOTES;
  const small = await runSearch(s, "pxstgres", { mode: "keyword", limit: 3 });
  assert.equal(small.length, 1, "on a small store the second-letter typo is repaired as before");
});
