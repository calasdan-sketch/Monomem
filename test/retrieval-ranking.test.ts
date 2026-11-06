// 1.2.0 ranking: query-side suffix trimming, one bm25 OR query for the any-keyword fallback and state_relevant, and
// the same fallback for memory_index. Scores on the public sets are in docs/BENCHMARK.md; these pin the behaviour.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store, queryStem } from "../src/store.js";
import { keywordWithFallback, runRelevantSearch, runSearch } from "../src/search-service.js";
import { memoryIndex } from "../src/progressive.js";
import { actorStore } from "../src/actor.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);

describe("queryStem", () => {
  test("trims common English suffixes, keeping at least 4 letters", () => {
    assert.equal(queryStem("recommendations"), "recommend");
    assert.equal(queryStem("deployed"), "deploy");
    assert.equal(queryStem("testing"), "test");
    assert.equal(queryStem("servers"), "serv");
    assert.equal(queryStem("notes"), "note");
    assert.equal(queryStem("Deployments"), "deploy");
  });

  test("leaves short words, ss endings, identifiers, tags and other scripts as typed", () => {
    for (const w of ["user", "runs", "class", "process", "address", "v1.2.0", "#status", "node24", "foo_bar", "café", "日本語", "it's"]) {
      assert.equal(queryStem(w), w.length >= 5 && /^[A-Za-z]+$/.test(w) ? w.toLowerCase() : w, w);
    }
  });

  test("bounded: a huge token is returned unchanged", () => {
    const big = "a".repeat(100_000) + "ing";
    assert.equal(queryStem(big), big);
  });
});

describe("search ranking", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });
  afterEach(() => store.close());

  test("a plural query finds the singular note (and the reverse still works)", async () => {
    const n = store.create({ title: "Staging", body: "We recommend port 8443 for the staging server" });
    const plural = await runSearch(store, "recommendations", { mode: "keyword" });
    assert.deepEqual(plural.map((x) => x.id), [n.id]);
    const singular = await runSearch(store, "recommend", { mode: "keyword" });
    assert.deepEqual(singular.map((x) => x.id), [n.id]);
  });

  test("all-terms hits always rank above any-keyword hits", async () => {
    const partial = store.create({ title: "zebrafish zebrafish zebrafish", body: "zebrafish tank notes, zebrafish everywhere" });
    const full = store.create({ title: "lab", body: "the zebrafish tank heater broke" });
    const hits = await runSearch(store, "zebrafish heater", { mode: "keyword" });
    assert.equal(hits[0].id, full.id);
    assert.ok(hits.some((h) => h.id === partial.id), "the partial match is still returned below it");
  });

  test("the fallback prefers the note matching more of the rare words", async () => {
    for (let i = 0; i < 20; i++) store.create({ title: `filler ${i}`, body: "meeting notes about the project and the team" });
    const two = store.create({ title: "trip", body: "booked the Lisbon flight for the quarterly offsite" });
    const one = store.create({ title: "other", body: "the Lisbon office has a nice view" });
    // No note has every word, so this is the any-keyword path.
    const hits = await runSearch(store, "when is the Lisbon offsite meeting happening", { mode: "keyword", limit: 5 });
    assert.equal(hits[0].id, two.id);
    assert.ok(hits.findIndex((h) => h.id === one.id) > 0);
  });

  test("state_relevant ranks by one bm25 query: two distinctive keywords beat one common one", async () => {
    for (let i = 0; i < 15; i++) store.create({ title: `standup ${i}`, body: "deploy deploy deploy status" });
    const target = store.create({ title: "rollback plan", body: "deploy rollback uses the canary bucket" });
    const r = await runRelevantSearch(store, "how do we do a canary rollback on deploy?", { limit: 3 });
    assert.equal(r.results[0].id, target.id);
  });

  test("FTS syntax in a query is data, never an expression (OR mode too)", () => {
    store.create({ title: "ok", body: "plain words here" });
    for (const q of ['"', 'a" OR "b', "NEAR(plain words)", "plain* -here", "title:plain", "^plain", "AND OR NOT", "(", "plain ) OR ("]) {
      assert.doesNotThrow(() => store.searchRanked(q, { any: true }));
      assert.doesNotThrow(() => keywordWithFallback(store, q, 10, {}));
    }
    // "title:plain" is not a column filter: it is searched as the words title + plain.
    assert.equal(store.searchRanked("NOT", { any: true }).length, 0);
  });

  test("the any-keyword fallback stays inside the namespace and leaves distrusted writers out", async () => {
    store.create({ title: "secret", body: "orchid launch codename", namespace: "work" });
    const mine = store.create({ title: "garden", body: "orchid watering schedule", namespace: "home" });
    const hits = await runSearch(store, "orchid codename schedule", { mode: "keyword", namespace: "home" });
    assert.deepEqual(hits.map((h) => h.id), [mine.id]);
    const rel = await runRelevantSearch(store, "orchid codename", { namespace: "home" });
    assert.deepEqual(rel.results.map((h) => h.id), [mine.id]);
    // A distrusted writer's note matching more of the words is left out of both paths.
    as("evil", () => store.create({ title: "garden", body: "orchid watering schedule codename override", namespace: "home" }));
    store.distrustAdd("home", "evil");
    const again = await runSearch(store, "orchid codename schedule override", { mode: "keyword", namespace: "home" });
    assert.deepEqual(again.map((h) => h.id), [mine.id]);
    const rel2 = await runRelevantSearch(store, "orchid codename schedule override", { namespace: "home" });
    assert.deepEqual(rel2.results.map((h) => h.id), [mine.id]);
    const rows = memoryIndex(store, { namespaces: ["home"] }, { query: "orchid codename schedule override" }).rows;
    assert.deepEqual(rows.map((r) => r.id), [mine.id]);
  });

  test("a huge query is bounded and still answers", async () => {
    const n = store.create({ title: "port", body: "staging port 8443" });
    const q = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ") + " staging port";
    const hits = await runSearch(store, q, { mode: "keyword" });
    assert.ok(Array.isArray(hits));
    const rel = await runRelevantSearch(store, q, {});
    assert.ok(rel.keywords.length <= 20);
    assert.ok(hits.length === 0 || hits.some((h) => h.id === n.id));
  });
});

describe("memory_index any-keyword fallback", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });
  afterEach(() => store.close());

  test("a whole question finds index rows (it used to need every word)", () => {
    const n = store.create({ title: "Staging server", body: "the staging server listens on port 8443" });
    store.create({ title: "unrelated", body: "lunch order for friday" });
    const rows = memoryIndex(store, {}, { query: "what port is my staging server on?" }).rows;
    assert.equal(rows[0]?.id, n.id);
  });

  test("respects the caller's namespaces", () => {
    store.create({ title: "Staging server", body: "port 8443", namespace: "work" });
    const rows = memoryIndex(store, { namespaces: ["home"] }, { query: "what port is my staging server on?" }).rows;
    assert.deepEqual(rows, []);
  });
});
