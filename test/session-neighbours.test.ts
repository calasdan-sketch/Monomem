// memory_index runs the same keyword search as state_search (a whole question works), and a captured row next to another
// hit in the same capture session ranks higher.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { memoryIndex } from "../src/progressive.js";
import { boostSessionNeighbours } from "../src/search-service.js";

const obs = (s: Store, title: string, body: string, session: string, at: string) =>
  s.create({ title, body, created_at: at }, { kind: "observation", sessionId: session, obsType: "discovery", updatedAt: at });

test("memory_index answers a whole question, not only exact words", () => {
  const s = new Store(":memory:");
  const n = obs(s, "Fixed the flaky login test", "The login test failed because the session cookie expired early.", "s1", "2026-11-01T10:00:00Z");
  assert.deepEqual(memoryIndex(s, {}, { query: "why did the login test fail?" }).rows.map((r) => r.id), [n.id]);
});

test("sessionNeighbours gives the rows just before and after, within one session only", () => {
  const s = new Store(":memory:");
  const a = obs(s, "a", "x", "s1", "2026-11-01T10:00:00Z");
  const b = obs(s, "b", "x", "s1", "2026-11-01T10:01:00Z");
  const c = obs(s, "c", "x", "s1", "2026-11-01T10:02:00Z");
  const other = obs(s, "d", "x", "s2", "2026-11-01T10:01:30Z");
  const plain = s.create({ title: "plain note", body: "x" });
  const near = s.sessionNeighbours([b.id, other.id, plain.id]);
  assert.deepEqual(near.get(b.id)?.sort(), [a.id, c.id].sort());
  assert.deepEqual(near.get(other.id), []);
  assert.equal(near.has(plain.id), false);
});

test("a hit next to another hit in its session moves up; ordinary notes are untouched", () => {
  const s = new Store(":memory:");
  const tried = obs(s, "Tried", "tried restarting the cache", "s1", "2026-11-01T10:00:00Z");
  const result = obs(s, "Result", "it worked after that", "s1", "2026-11-01T10:01:00Z");
  const lone = obs(s, "Lone", "unrelated", "s2", "2026-11-01T11:00:00Z");
  const out = boostSessionNeighbours(s, [
    { note: lone, score: 1.0 },
    { note: tried, score: 0.9 },
    { note: result, score: 0.4 },
  ]);
  assert.deepEqual(out.map((h) => h.note.id), [tried.id, lone.id, result.id]);
  const plain = [{ note: s.create({ title: "p", body: "q" }), score: 1 }];
  assert.equal(boostSessionNeighbours(s, plain), plain);
});
