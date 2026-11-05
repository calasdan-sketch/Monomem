// Round 4 conflicts: structured facts (exact tier), trust, the dashboard UI, and honest precision/recall on three sets.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { findConflicts, conflictLines } from "../src/conflicts.js";
import { factTags, withFacts, noteFacts, writeConflicts } from "../src/facts.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { DASHBOARD_JS } from "../src/dashboard.js";
import { buildFixture } from "./conflicts-fixture.js";
import { REAL_POS, REAL_NEG, B_PAIRS, type Pair } from "./conflicts-realistic.js";

const mk = (s: Store, writer: string, title: string, body: string, facts?: Record<string, string>, ns = "default"): number =>
  s.create({ title, body, namespace: ns, tags: withFacts(undefined, facts) }, { writtenBy: writer }).id;
const key = (x: number, y: number): string => (x < y ? `${x}-${y}` : `${y}-${x}`);

describe("facts validation", () => {
  test("good facts become fact: tags, trimmed", () => {
    assert.deepEqual(factTags({ deploy_target: " render ", "a.b-c": "x" }), ["fact:deploy_target=render", "fact:a.b-c=x"]);
    assert.deepEqual(factTags(undefined), []);
  });
  test("refused: more than 10 keys, bad keys, long or empty or multi-line or non-string values, non-objects", () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
    assert.throws(() => factTags(many), ValidationError);
    assert.doesNotThrow(() => factTags(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "v"]))));
    for (const bad of [{ Deploy: "x" }, { "a b": "x" }, { "": "x" }, { ["k".repeat(41)]: "x" }, { k: "x".repeat(81) }, { k: "" }, { k: "  " }, { k: "a\nb" }, { k: 5 }]) {
      assert.throws(() => factTags(bad), ValidationError, JSON.stringify(bad));
    }
    assert.doesNotThrow(() => factTags({ k: "x".repeat(80) }));
    for (const bad of [null, [], "x", 3]) assert.throws(() => factTags(bad), ValidationError);
  });
  test("a secret in a value is refused by the existing secret scan", () => {
    const s = new Store(":memory:");
    assert.throws(() => mk(s, "alice", "t", "b", { token: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" }), ValidationError);
    s.close();
  });
  test("facts replace a note's fact tags and keep other tags; facts: {} clears them", () => {
    assert.deepEqual(withFacts(["x"], { a: "1" }, ["old"]), ["x", "fact:a=1"]);
    assert.deepEqual(withFacts(undefined, { a: "2" }, ["keep", "fact:a=1", "fact:b=2"]), ["keep", "fact:a=2"]);
    assert.deepEqual(withFacts(undefined, {}, ["keep", "fact:a=1"]), ["keep"]);
    const same = ["x"];
    assert.equal(withFacts(same, undefined), same);
    assert.deepEqual(noteFacts(["fact:a=1", "fact:a=2", "fact:Bad=1", "plain"]), [["a", "1"]]);
  });
});

describe("write-time conflicts", () => {
  test("a different writer's different value is reported; the write still succeeds", () => {
    const s = new Store(":memory:");
    const first = mk(s, "alice", "Deploy", "x", { deploy_target: "fly.io" });
    const second = s.create({ title: "Hosting", body: "y", tags: withFacts(undefined, { deploy_target: "Render" }) }, { writtenBy: "bob" });
    assert.ok(s.read(second.id));
    const c = writeConflicts(s, second);
    assert.equal(c.length, 1);
    assert.match(c[0], new RegExp(`^conflicts with #${first} by alice: deploy_target fly\\.io \\(theirs\\) vs Render \\(yours\\)`));
    s.close();
  });
  test("not reported: same writer, same value in other case, other namespace, other key, archived, distrusted writer", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", "x", { k: "Same Value" });
    mk(s, "carol", "c", "x", { k: "other" }, "elsewhere");
    mk(s, "dave", "d", "x", { other_key: "v" });
    const gone = mk(s, "erin", "e", "x", { k: "gone" });
    s.archive(gone);
    s.distrustAdd("default", "mallory");
    mk(s, "mallory", "m", "x", { k: "evil" });
    const agree = s.create({ title: "agree", body: "x", tags: withFacts(undefined, { k: "same  value" }) }, { writtenBy: "bob" });
    assert.deepEqual(writeConflicts(s, agree), []);
    s.delete(agree.id);
    const own = s.create({ title: "same writer", body: "x", tags: withFacts(undefined, { k: "different" }) }, { writtenBy: "alice" });
    assert.deepEqual(writeConflicts(s, own), []);
    s.close();
  });
  test("over MCP state_write: reply carries `conflicts`, an update with facts too; no facts, no field", async () => {
    const s = new Store(":memory:");
    const connect = async (label: string) => {
      const server = createMcpServer(s, "admin", {}, { label, authed: true });
      const [c, sv] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1.0.0" });
      await Promise.all([client.connect(c), server.connect(sv)]);
      return client;
    };
    const call = async (c: Client, args: Record<string, unknown>): Promise<any> => {
      const r: any = await c.callTool({ name: "state_write", arguments: args });
      const t = r.content[0].text as string;
      return { isError: r.isError, ...JSON.parse(t.slice(t.indexOf("{"))) };
    };
    const alice = await connect("alice"), bob = await connect("bob");
    const a = await call(alice, { title: "Deploy", body: "x", facts: { deploy_target: "fly.io" } });
    assert.equal(a.conflicts, undefined);
    assert.ok(a.note.tags.includes("fact:deploy_target=fly.io"));
    const b = await call(bob, { title: "Hosting", body: "y", facts: { deploy_target: "render" } });
    assert.ok(!b.isError && b.note.id);
    assert.equal(b.conflicts.length, 1);
    assert.match(b.conflicts[0], /by alice/);
    const plain = await call(bob, { title: "No facts", body: "z" });
    assert.equal(plain.conflicts, undefined);
    const bad = await call(bob, { title: "bad", body: "z", facts: { "Bad Key": "v" } });
    assert.ok(bad.isError || bad.error, "bad facts are refused");
    const upd = await call(bob, { id: plain.note.id, facts: { deploy_target: "heroku" } });
    assert.equal(upd.conflicts.length, 1); // alice's fly.io; bob's own render note is the same writer
    alice.close(); bob.close();
    s.close();
  });
  test("over REST POST /notes: 201 with conflicts; bad facts 400; facts never stored as a body field", async () => {
    const s = new Store(":memory:");
    mk(s, "alice", "Deploy", "x", { deploy_target: "fly.io" });
    const server = createApiServer(s, [{ token: "t", scope: "write", label: "bob" }]);
    await new Promise<void>((ok) => server.listen(0, ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (b: unknown) => fetch(base + "/notes", { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify(b) });
    try {
      const r = await post({ title: "Hosting", body: "y", facts: { deploy_target: "render" } });
      assert.equal(r.status, 201);
      const j = (await r.json()) as { note: { tags: string[] }; conflicts: string[] };
      assert.equal(j.conflicts.length, 1);
      assert.ok(j.note.tags.includes("fact:deploy_target=render"));
      assert.equal((await post({ title: "x", facts: { A: "v" } })).status, 400);
      assert.equal((await post({ title: "x", facts: [1] })).status, 400);
    } finally {
      server.close();
      s.close();
    }
  });
});

describe("findConflicts: facts tier and trust", () => {
  test("facts are exact: natural, different titles; original case kept; kind and pinned carried", () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice", "Hosting", "We host the app on Fly.", { deploy_target: "Fly.io" });
    const b = mk(s, "bob", "Where the app runs", "Production runs on Render.", { deploy_target: "Render" });
    s.setPinned(a, true);
    const [c, ...rest] = findConflicts(s);
    assert.equal(rest.length, 0);
    assert.deepEqual([c.tier, c.confidence, c.key], ["fact", "exact", "deploy_target"]);
    assert.deepEqual(c.shown, ["Fly.io", "Render"]);
    assert.deepEqual(c.values, ["fly.io", "render"]);
    assert.deepEqual([c.a.id, c.b.id], [a, b]);
    assert.equal(c.a.pinned, true);
    assert.equal(c.b.pinned, false);
    assert.equal(c.a.kind, "token label from your config");
    s.close();
  });
  test("a pair already flagged by facts is not listed again as possible", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "Deploy target: Fly.io", "x", { deploy_target: "fly.io" });
    mk(s, "bob", "Deploy target: Render", "y", { deploy_target: "render" });
    const found = findConflicts(s);
    assert.equal(found.length, 1);
    assert.equal(found[0].tier, "fact");
    s.close();
  });
  test("a distrusted writer's notes are not compared; same writer or same value is no conflict", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", "x", { k: "1" });
    mk(s, "mallory", "m", "x", { k: "2" });
    mk(s, "alice", "a2", "x", { j: "1" });
    mk(s, "alice", "a3", "x", { j: "2" });
    mk(s, "bob", "b", "x", { i: "A  b" });
    mk(s, "carol", "c", "x", { i: "a B" });
    assert.equal(findConflicts(s).length, 1); // k (mallory not yet distrusted)
    s.distrustAdd("default", "mallory");
    assert.deepEqual(findConflicts(s), []);
    s.close();
  });
  test("a fact: tag that is not a valid fact is ignored", () => {
    const s = new Store(":memory:");
    s.create({ title: "x", body: "y", tags: ["fact:Bad Key=1"] }, { writtenBy: "alice" });
    s.create({ title: "x2", body: "y", tags: ["fact:Bad Key=2"] }, { writtenBy: "bob" });
    assert.deepEqual(findConflicts(s), []);
    s.close();
  });
});

describe("CLI lines", () => {
  test("values in original case; both keep-commands are real; pin and distrust commands carry real arguments", () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice", "Deploy target: Fly.io", "x");
    const b = mk(s, "bob", "Deploy target: Render", "y");
    const text = conflictLines(findConflicts(s)).join("\n");
    assert.match(text, /deploy target: Fly\.io {2}vs {2}Render/);
    assert.ok(text.includes(`monomem supersede --old ${a} --new-id ${b}`));
    assert.ok(text.includes(`monomem supersede --old ${b} --new-id ${a}`));
    assert.ok(text.includes(`monomem pin ${a}`) && text.includes(`monomem pin ${b}`));
    assert.ok(text.includes('monomem trust distrust "alice" --namespace "default"'));
    assert.ok(!/or the reverse/.test(text));
    assert.match(text, /\[token label from your config\]/);
    s.close();
  });
});

// ---- the dashboard, run in a stub browser ----
function page(conflicts: unknown[]) {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, addEventListener() {}, focus() {}, appendChild() {}, setAttribute() {}, removeAttribute() {} });
    return els.get(id);
  };
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {}, setAttribute() {} }) },
    sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, encodeURIComponent,
    fetch: async (path: string, opts: any = {}) => {
      calls.push({ path, method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
      let json: any = {};
      if (path.startsWith("/quality")) json = { counts: {}, issues: [], conflicts };
      if (path === "/supersede/preview") json = { warning: "Replace #1 with #2?", token: "T", requires_acknowledgement: false };
      return { ok: true, status: 200, json: async () => json };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, calls, el };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const C = (over: any = {}) => ({
  namespace: "default", key: "deploy_target", values: ["fly.io", "render"], shown: ["Fly.io", "Render"], tier: "fact", confidence: "exact",
  a: { id: 1, title: "Hosting", writer: "alice", kind: "token label from your config", pinned: false, at: "2026-10-01T00:00:00Z" },
  b: { id: 2, title: "Runs on", writer: "bob", kind: "token label from your config", pinned: false, at: "2026-10-02T00:00:00Z" }, ...over,
});

describe("dashboard conflicts UI", () => {
  test("Keep <value> buttons for both sides, equal weight, Pin and Distrust, writer kind shown, no Replace", () => {
    const { ctx } = page([]);
    const html: string = ctx.cfRow(C());
    assert.match(html, /qReplace\(2,1\)'>Keep Fly\.io</);
    assert.match(html, /qReplace\(1,2\)'>Keep Render</);
    assert.match(html, /Pin #1/);
    assert.match(html, /Distrust alice/);
    assert.match(html, /alice \(token label from your config\)/);
    assert.ok(!/Replace #/.test(html));
    const keeps = html.match(/<button[^>]*>Keep /g) ?? [];
    assert.equal(new Set(keeps.map((k) => k.match(/class='[^']*'/)?.[0])).size, 1, "same class on both Keep buttons: neither is primary");
    assert.ok(html.includes("class='ghost'") && !html.includes("<button>"));
  });
  test("a pinned note hides the Keep that would replace it and says to use the CLI", () => {
    const { ctx } = page([]);
    const html: string = ctx.cfRow(C({ b: { ...C().b, pinned: true } }));
    assert.ok(!html.includes("Keep Fly.io"), "keeping #1 would replace the pinned #2");
    assert.ok(html.includes("Keep Render"));
    assert.ok(html.includes("#2 pinned: change it from the CLI"));
    assert.ok(!html.includes("Pin #2"));
  });
  test("everything from the server is escaped", () => {
    const { ctx } = page([]);
    const evil = "<img src=x onerror=alert(1)>'\"";
    const html: string = ctx.cfRow(C({ shown: [evil, evil], key: evil, a: { ...C().a, writer: evil, title: evil, kind: evil }, b: { ...C().b, writer: evil, title: evil, kind: evil } }));
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("data-w='&lt;img src=x onerror=alert(1)&gt;&#39;&quot;'"));
  });
  test("Keep asks the server for a GUI-worded preview, then confirms with the code", async () => {
    const { ctx, calls, el } = page([C()]);
    ctx.loadQuality();
    await settle();
    assert.match(el("list").innerHTML, /Conflicts \(1\)/);
    ctx.qReplace(2, 1);
    await settle();
    const p = calls.find((c) => c.path === "/supersede/preview")!;
    assert.deepEqual(p.body, { old_ids: [2], new_id: 1, gui: true });
  });
  test("each conflict keeps its buttons inside its own block (phone layout: no .cardhead flattening)", async () => {
    const { ctx, el } = page([C(), C({ key: "other" })]);
    ctx.loadQuality();
    await settle();
    const blocks = el("list").innerHTML.split("<div class='cf'>").slice(1);
    assert.equal(blocks.length, 2);
    for (const b of blocks) assert.match(b, /class='acts'/);
    assert.ok(!/cardhead/.test(el("list").innerHTML));
  });
  test("Pin and Distrust call the existing endpoints", async () => {
    const { ctx, calls } = page([C()]);
    ctx.qPin(1);
    ctx.qDistrust({ getAttribute: (k: string) => (k === "data-ns" ? "default" : "alice") });
    await settle();
    assert.deepEqual(calls.find((c) => c.path === "/pinned")!.body, { id: 1, pinned: true });
    assert.deepEqual(calls.find((c) => c.path === "/trust/distrust")!.body, { namespace: "default", writer: "alice" });
  });
});

describe("supersede preview for the dashboard", () => {
  test("gui:true: no POST / code / acknowledge_risk wording; default stays as before", async () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice", "Deploy target: Fly.io", "x");
    const b = mk(s, "bob", "Deploy target: Render", "y");
    const server = createApiServer(s, [{ token: "adm", scope: "admin", label: "op" }]);
    await new Promise<void>((ok) => server.listen(0, ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const prev = async (extra: object) => (await (await fetch(base + "/supersede/preview", { method: "POST", headers: { Authorization: "Bearer adm" }, body: JSON.stringify({ old_ids: [a], new_id: b, ...extra }) })).json()) as { warning: string };
    try {
      const gui = (await prev({ gui: true })).warning;
      assert.ok(!/POST|\/supersede|code:|acknowledge_risk|\{token\}/.test(gui), gui);
      assert.match(gui, /Press Confirm/);
      assert.match((await prev({})).warning, /POST \/supersede\/confirm/);
    } finally {
      server.close();
      s.close();
    }
  });
});

// ---- honest numbers ----
function score(found: Array<{ a: { id: number }; b: { id: number } }>, truth: Set<string>) {
  const keys = new Set(found.map((c) => key(c.a.id, c.b.id)));
  const tp = [...keys].filter((k) => truth.has(k)).length;
  return { flagged: keys.size, tp, truth: truth.size, precision: keys.size ? tp / keys.size : 1, recall: truth.size ? tp / truth.size : 1 };
}
const fmt = (n: number): string => n.toFixed(2);
let tAdd = 400;
const addPair = (s: Store, [t1, b1, t2, b2, f1, f2]: Pair, w: [string, string], withFactsOn: boolean): [number, number] => {
  const at = (): string => new Date(Date.now() - (tAdd -= 0.3) * 864e5).toISOString();
  const mkOne = (writer: string, t: string, b: string, f: Record<string, string>): number =>
    s.create({ title: t, body: b, tags: withFactsOn ? withFacts(undefined, f) : undefined }, { writtenBy: writer, updatedAt: at() }).id;
  return [mkOne(w[0], t1, b1, f1), mkOne(w[1], t2, b2, f2)];
};

describe("precision and recall by tier", () => {
  const rows: string[] = [];
  const run = (name: string, withFactsOn: boolean, pos: Pair[], neg: Pair[]) => {
    const s = new Store(":memory:");
    const P = new Set(pos.map((p) => key(...addPair(s, p, ["alice", "bob"], withFactsOn))));
    const N = new Set(neg.map((p) => key(...addPair(s, p, ["carol", "dave"], withFactsOn))));
    const all = findConflicts(s);
    const out = (["fact", "possible"] as const).map((tier) => {
      const r = score(all.filter((c) => c.tier === tier), P);
      const lookalike = all.filter((c) => c.tier === tier && N.has(key(c.a.id, c.b.id))).length;
      rows.push(`${name.padEnd(26)} ${tier.padEnd(9)} flagged=${r.flagged} TP=${r.tp}/${r.truth} lookalike-FP=${lookalike}/${N.size} P=${fmt(r.precision)} R=${fmt(r.recall)}`);
      return { ...r, lookalike };
    });
    s.close();
    return out;
  };
  test("realistic pairs (20 real, 12 look-alikes) and bench B (7 contradictions)", () => {
    const [realFacts] = run("realistic, facts attached", true, REAL_POS, REAL_NEG);
    const [, realPossible] = run("realistic, no facts", false, REAL_POS, REAL_NEG);
    const [bFacts] = run("bench B, facts attached", true, B_PAIRS, []);
    const [, bPossible] = run("bench B, no facts", false, B_PAIRS, []);
    assert.equal(realFacts.precision, 1);
    assert.equal(realFacts.recall, 1);
    assert.equal(realFacts.lookalike, 0);
    assert.equal(bFacts.precision, 1);
    assert.equal(bFacts.recall, 1);
    assert.equal(realPossible.lookalike, 0, "the possible tier raises no look-alike false flag");
    // Not asserted: the possible tier's recall here (0/20, the reviewer's finding) and one flag between two unrelated pairs that both
    // happen to title a note "Node version" with different values (counted as a false positive in the table).
    assert.ok(realPossible.flagged <= 1);
    assert.ok(bPossible.flagged <= bPossible.truth);
    // the fixture: the possible tier as before; facts are attached to the planted pairs
    const { store, planted, missed } = buildFixture();
    const truth = new Set([...planted, ...missed].map(([x, y]) => key(x, y)));
    const fx = score(findConflicts(store).filter((c) => c.tier === "possible"), truth);
    rows.push(`${"builder fixture".padEnd(26)} possible  flagged=${fx.flagged} TP=${fx.tp}/${fx.truth} P=${fmt(fx.precision)} R=${fmt(fx.recall)}`);
    assert.ok(fx.precision >= 0.9 && fx.recall >= 0.75);
    store.close();
    console.log(rows.join("\n"));
  });
  test("builder fixture with facts on the planted pairs: facts tier exact", () => {
    const { store, planted, missed } = buildFixture();
    // an agent following SKILL.md would attach facts to every decision: do so for all 15 truth pairs, then re-run
    const truth = [...planted, ...missed];
    truth.forEach(([x, y], i) => {
      for (const [id, v] of [[x, "a"], [y, "b"]] as const) {
        const n = store.read(id)!;
        store.update(id, { tags: withFacts(n.tags, { [`planted.t${i}`]: v }, n.tags) }, {});
      }
    });
    const found = findConflicts(store).filter((c) => c.tier === "fact");
    const r = score(found, new Set(truth.map(([x, y]) => key(x, y))));
    console.log(`builder fixture            fact      flagged=${r.flagged} TP=${r.tp}/${r.truth} P=${fmt(r.precision)} R=${fmt(r.recall)}`);
    assert.equal(r.precision, 1);
    assert.equal(r.recall, 1);
    store.close();
  });
  test("honest limit: one key reused for two subjects IS flagged (keys must be scoped)", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "auth service", "x", { database: "postgres" });
    mk(s, "bob", "analytics service", "x", { database: "sqlite" });
    assert.equal(findConflicts(s).length, 1);
    s.close();
  });
});
