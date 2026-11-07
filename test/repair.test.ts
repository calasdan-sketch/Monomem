// Query repair from the index vocabulary: typos, compound splits/joins, abbreviations, CJK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { runSearch } from "../src/search-service.js";
import { editDistance, planRepair } from "../src/repair.js";
import { extractKeywords } from "../src/keywords.js";

function seeded(): { store: Store; ids: Record<string, number> } {
  const store = new Store(":memory:");
  const ids: Record<string, number> = {};
  const add = (k: string, title: string, body: string): void => {
    ids[k] = store.create({ title, body }).id;
  };
  add("pg", "Database choice", "We run Postgres 16 on the primary; pgbouncer sits in front for pooling.");
  add("rl", "API throttling", "The gateway applies a rate-limit of 100 requests per minute per token.");
  add("reset", "Upstream flake", "Workers crash with ECONNRESET when the proxy recycles idle sockets.");
  add("tokyo", "旅行计划", "我们决定去东京旅行，预订了迪士尼门票。");
  add("lim", "Limiter class", "The RateLimiter class wraps a token bucket.");
  add("noise", "Lunch", "Pizza on Fridays, salad on Mondays.");
  return { store, ids };
}

test("edit distance counts a swap as one edit and gives up past the cap", () => {
  assert.equal(editDistance("postgress", "postgres", 2), 1);
  assert.equal(editDistance("recieve", "receive", 2), 1);
  assert.equal(editDistance("abcdef", "uvwxyz", 2), 3);
});

test("a typo finds the note it meant, and a word that already matches is left alone", async () => {
  const { store, ids } = seeded();
  assert.equal(store.searchRanked("postgress", {}).length, 0, "plain search misses the typo");
  const hits = await runSearch(store, "postgress", { mode: "keyword", limit: 5 });
  assert.equal(hits[0]?.id, ids.pg);
  // "pool" matches "pooling": no repair is planned, so nothing is added.
  assert.equal(planRepair(store, ["pool"]), null);
});

test("ratelimit finds rate-limit, and 'rate limit' finds RateLimiter", async () => {
  const { store, ids } = seeded();
  const a = await runSearch(store, "ratelimit", { mode: "keyword", limit: 5 });
  assert.ok(a.map((n) => n.id).includes(ids.rl), "split into rate + limit");
  const b = await runSearch(store, "rate limit class", { mode: "keyword", limit: 5 });
  assert.equal(b[0]?.id, ids.lim, "joined to ratelimiter*");
});

test("'connection reset' finds ECONNRESET only when nothing else matched", async () => {
  const { store, ids } = seeded();
  const hits = await runSearch(store, "connection reset", { mode: "keyword", limit: 5 });
  assert.equal(hits[0]?.id, ids.reset);
});

test("a two-character CJK word is a keyword and finds the run that contains it", async () => {
  assert.deepEqual(extractKeywords("东京"), ["东京"]);
  assert.deepEqual(extractKeywords("ab"), []);
  const { store, ids } = seeded();
  const hits = await runSearch(store, "东京", { mode: "keyword", limit: 5 });
  assert.equal(hits[0]?.id, ids.tokyo);
  const sentence = await runSearch(store, "我们去东京旅行吗", { mode: "keyword", limit: 5 });
  assert.equal(sentence[0]?.id, ids.tokyo);
});

test("repair never reaches across namespaces", async () => {
  const store = new Store(":memory:");
  store.create({ title: "secret plan", body: "kubernetes migration", namespace: "other" });
  const hits = await runSearch(store, "kubernates", { mode: "keyword", limit: 5, namespace: "mine" });
  assert.deepEqual(hits, []);
});

test("quotes and FTS syntax in a query cannot break the repaired expression", async () => {
  const { store } = seeded();
  for (const q of ['postgre"ss', "rate AND OR NOT limit", 'NEAR(a b) "', "东京\"", "*:*", "a b c d e f g h"]) {
    await runSearch(store, q, { mode: "keyword", limit: 5 });
  }
});

test("MONOMEM_REPAIR=off restores the old behaviour", async () => {
  const { store } = seeded();
  process.env.MONOMEM_REPAIR = "off";
  try {
    assert.deepEqual(await runSearch(store, "postgress", { mode: "keyword", limit: 5 }), []);
  } finally {
    delete process.env.MONOMEM_REPAIR;
  }
});

test("huge tokens and floods of words stay fast and never throw", async () => {
  const { store } = seeded();
  const t = performance.now();
  for (const q of ["a".repeat(4000), "x".repeat(60) + " " + "y".repeat(60), "东".repeat(4000), Array.from({ length: 60 }, (_, i) => `wrd${i}x`).join(" "), "zz ".repeat(1300)]) {
    await runSearch(store, q, { mode: "keyword", limit: 5 });
  }
  assert.ok(performance.now() - t < 5000, "repair must not make a hostile query slow");
});
