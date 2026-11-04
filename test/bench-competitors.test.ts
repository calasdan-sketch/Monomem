// The comparison adapters (official MCP memory server, Mem0) and the engine's "unsupported" judging.
// No external process: Mem0 is replaced by an in-memory fake bridge, and the official server's pure mapping helpers are
// tested directly. The real runs live in bench/run-competitors.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "../src/bench/engine.js";
import { entityToNote, queryWords } from "../src/bench/competitors/official-memory-adapter.js";
import { Mem0Adapter, type Bridge } from "../src/bench/competitors/mem0-adapter.js";
import type { Scenario } from "../src/bench/types.js";

/** An in-memory stand-in for bench/mem0_bridge.py (infer=false behaviour: text stored verbatim). */
function fakeMem0(): Bridge {
  let mems = new Map<string, { id: string; memory: string; metadata: unknown }>();
  let n = 0;
  return async (req) => {
    switch (req.op) {
      case "open":
      case "close":
        mems = new Map();
        return null;
      case "add": {
        const m = { id: `m${++n}`, memory: String(req.text), metadata: req.metadata };
        mems.set(m.id, m);
        return [{ id: m.id, memory: m.memory, event: "ADD" }];
      }
      case "get":
        return mems.get(String(req.id)) ?? null;
      case "update": {
        const m = mems.get(String(req.id))!;
        mems.set(m.id, { ...m, memory: String(req.text), metadata: req.metadata });
        return { message: "ok" };
      }
      case "delete":
        mems.delete(String(req.id));
        return { message: "ok" };
      case "search": {
        const words = String(req.query).toLowerCase().split(/\s+/);
        return [...mems.values()].filter((m) => words.some((w) => m.memory.toLowerCase().includes(w)));
      }
      case "list":
        return [...mems.values()];
      default:
        return [];
    }
  };
}

const scenario = (over: Partial<Scenario> & Pick<Scenario, "steps" | "expect">): Scenario => ({
  id: "A99",
  suite: "stale",
  title: "t",
  what: "w",
  actors: { alice: { scope: "write" }, viewer: { scope: "read" } },
  ...over,
});

describe("official memory server mapping", () => {
  test("an entity maps back to the note it was written from", () => {
    const n = entityToNote({ name: "Deploy region #n3", entityType: "note", observations: ["Deploys to x.", "tags: a, b", "source: ci"] });
    assert.deepEqual(n, { id: "n3", title: "Deploy region", body: "Deploys to x.", tags: ["a", "b"], source: "ci" });
  });
  test("a query is sent word by word, short words dropped", () => {
    assert.deepEqual(queryWords("bako42 on-call on call"), ["bako42", "call"]);
  });
});

describe("Mem0 adapter (fake bridge)", () => {
  test("write, update, read and delete round-trip the note", async () => {
    const r = await runScenario(
      new Mem0Adapter(false, fakeMem0()),
      scenario({
        actors: { alice: { scope: "write" } },
        steps: [
          { op: "write", as: "alice", ref: "n", title: "T", body: "old", tags: ["x"] },
          { op: "update", as: "alice", ref: "n", body: "new" },
          { op: "read", as: "alice", ref: "n", id: "r" },
          { op: "delete", as: "alice", ref: "n" },
          { op: "read", as: "alice", ref: "n", id: "gone" },
        ],
        expect: [
          { check: "field", step: "r", path: "title", equals: "T", desc: "title kept" },
          { check: "field", step: "r", path: "body", equals: "new", desc: "body updated" },
          { check: "field", step: "r", path: "tags", equals: ["x"], desc: "tags kept" },
          { check: "outcome", step: "gone", is: "not_found", desc: "deleted" },
        ],
      }),
      {},
      { seed: 1 }
    );
    assert.equal(r.status, "pass", JSON.stringify(r.checks));
  });
});

describe("the engine never passes what an adapter cannot do", () => {
  test("a writer check on a system without writers is unsupported, and the scenario is skipped, not passed", async () => {
    const r = await runScenario(
      new Mem0Adapter(false, fakeMem0()),
      scenario({
        steps: [{ op: "write", as: "alice", ref: "n", title: "T", body: "b" }, { op: "read", as: "alice", ref: "n", id: "r" }],
        expect: [
          { check: "field", step: "r", path: "body", equals: "b", desc: "body" },
          { check: "field", step: "r", path: "writer", equals: "alice", desc: "writer" },
        ],
      }),
      {},
      { seed: 1 }
    );
    assert.equal(r.status, "skipped");
    assert.equal(r.checks[1].unsupported, true);
    assert.equal(r.checks[1].pass, false);
  });

  test("an unsupported step makes its checks unsupported; a real failure elsewhere still FAILS", async () => {
    const r = await runScenario(
      new Mem0Adapter(false, fakeMem0()),
      scenario({
        steps: [
          { op: "write", as: "alice", ref: "n", title: "T", body: "b" },
          { op: "update", as: "viewer", ref: "n", body: "x", id: "u" },
          { op: "read", as: "alice", ref: "n", id: "r" },
        ],
        expect: [
          { check: "outcome", step: "u", is: "denied", desc: "read-only refused" },
          { check: "field", step: "r", path: "body", equals: "WRONG", desc: "a check that genuinely fails" },
        ],
      }),
      {},
      { seed: 1 }
    );
    assert.equal(r.checks[0].unsupported, true);
    assert.equal(r.status, "fail");
  });
});
