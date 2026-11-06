// Hybrid search blends min-max-scaled keyword and semantic scores (0.5 / 0.5) instead of rank-only RRF,
// so a clear keyword winner is not pulled down by a flat semantic list.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { blendHybrid } from "../src/search-service.js";
import type { NoteRecord } from "../src/store.js";

const n = (id: number): NoteRecord => ({ id }) as unknown as NoteRecord;

test("a confident keyword winner stays first when the semantic side is nearly flat", () => {
  // Keyword: note 1 far ahead. Semantic: note 2 a hair above note 1. RRF would tie them; the blend keeps 1.
  const out = blendHybrid(
    [{ note: n(1), score: 10 }, { note: n(2), score: 1 }, { note: n(3), score: 0.9 }],
    [{ note: n(2), score: 0.71 }, { note: n(1), score: 0.7 }, { note: n(3), score: 0.2 }]
  );
  assert.deepEqual(out.map((h) => h.note.id), [1, 2, 3]);
});

test("notes found by only one side are kept, scores stay in 0..1, empty sides are fine", () => {
  const out = blendHybrid([{ note: n(1), score: 5 }], [{ note: n(2), score: 0.9 }, { note: n(3), score: 0.1 }]);
  assert.deepEqual(new Set(out.map((h) => h.note.id)), new Set([1, 2, 3]));
  for (const h of out) assert.ok(h.score >= 0 && h.score <= 1);
  assert.deepEqual(blendHybrid([], []), []);
  assert.deepEqual(blendHybrid([], [{ note: n(4), score: 0.3 }]).map((h) => h.note.id), [4]);
});

test("a pure-noise semantic list cannot outrank a clear keyword winner", () => {
  // Every semantic score is ~equal (noise); min-max still stretches them to 0..1, so the keyword side must carry the order.
  const kw = [{ note: n(1), score: 9 }, { note: n(2), score: 3 }, { note: n(3), score: 1 }];
  const sem = [{ note: n(3), score: 0.3002 }, { note: n(2), score: 0.3001 }, { note: n(1), score: 0.3 }];
  assert.equal(blendHybrid(kw, sem)[0].note.id, 1);
});
