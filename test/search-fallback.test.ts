// state_search on a whole question: FTS5 needs every term, so it used to find
// nothing. keywordWithFallback tops up with any-keyword hits, below full matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { anyKeywordHits, keywordCoverage, keywordWithFallback, runSearch } from "../src/search-service.js";
import type { NoteRecord } from "../src/store.js";

test("a natural-language question finds notes that match some of its words", async () => {
  const store = new Store(":memory:");
  const region = store.create({ title: "Deploy region", body: "Production deploys to ca-central-1." });
  store.create({ title: "Lunch", body: "Pizza on Fridays." });
  assert.equal(store.searchRanked("which region do we deploy production to", { limit: 10 }).length, 0);
  const hits = await runSearch(store, "which region do we deploy production to", { mode: "keyword", limit: 5 });
  assert.equal(hits[0]?.id, region.id);
  assert.ok(!hits.some((n) => n.title === "Lunch"), "unrelated note stays out");
});

test("full matches always rank above partial ones, and single words are unchanged", () => {
  const store = new Store(":memory:");
  const partial = store.create({ title: "Stripe", body: "stripe stripe stripe stripe webhook" });
  const full = store.create({ title: "Retry", body: "stripe webhook retry policy" });
  const hits = keywordWithFallback(store, "stripe webhook retry", 10, {});
  assert.equal(hits[0].note.id, full.id);
  assert.equal(hits[1].note.id, partial.id);
  assert.ok(hits[1].score < hits[0].score);
  assert.deepEqual(
    keywordWithFallback(store, "stripe", 10, {}).map((h) => h.note.id),
    store.searchRanked("stripe", { limit: 10 }).map((h) => h.note.id)
  );
});

test("a partial match on a rare word outranks one on a common word", async () => {
  const store = new Store(":memory:");
  for (let i = 0; i < 20; i++) store.create({ title: `Weekend ${i}`, body: `Plans for the weekend number ${i}.` });
  const rare = store.create({ title: "Zoo trip", body: "Saw a giraffe." });
  const hits = await runSearch(store, "what giraffe did we see last weekend", { mode: "keyword", limit: 5 });
  assert.equal(hits[0]?.id, rare.id);
});

test("covering more of the question beats repeating one word", () => {
  const store = new Store(":memory:");
  const repeat = store.create({ title: "Notes", body: "sourdough sourdough sourdough sourdough sourdough recipe" });
  const cover = store.create({ title: "Bake day", body: "sourdough starter needs rye flour feeding" });
  const hits = anyKeywordHits(store, ["sourdough", "starter", "rye", "flour"], 10, {});
  assert.equal(hits[0].note.id, cover.id);
  assert.ok(hits.some((h) => h.note.id === repeat.id));
});

test("keywordCoverage counts prefix matches at word starts and is safe with regex characters", () => {
  const note = { title: "Paint", body: "Painting the c++ shed (blue)", tags: ["#home"] } as unknown as NoteRecord;
  assert.equal(keywordCoverage(note, ["painting", "shed"]), 1);
  assert.equal(keywordCoverage(note, ["aint", "shed"]), 0.5, "mid-word text is not a match");
  assert.equal(keywordCoverage(note, ["c++", "(blue", "#home"]), 1);
  assert.equal(keywordCoverage(note, []), 0);
});

test("a question with only one meaningful word still finds the note", async () => {
  const store = new Store(":memory:");
  const n = store.create({ title: "Deploy", body: "Production deploys to ca-central-1." });
  const hits = await runSearch(store, "where is the deploy?", { mode: "keyword", limit: 5 });
  assert.equal(hits[0]?.id, n.id);
});

test("accents do not zero the keyword coverage and fallback scores stay finite", async () => {
  const note = { title: "Résumé", body: "Updated my résumé for the café job", tags: [] } as unknown as NoteRecord;
  assert.equal(keywordCoverage(note, ["resume", "cafe"]), 1);
  const store = new Store(":memory:");
  store.create({ title: "Résumé", body: "Updated my résumé." });
  const hits = keywordWithFallback(store, "where is my resume file", 10, {});
  assert.ok(hits.length >= 1);
  for (const h of hits) assert.ok(Number.isFinite(h.score));
});
