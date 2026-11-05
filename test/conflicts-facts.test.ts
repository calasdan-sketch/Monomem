// Round 4 conflicts: structured facts (exact tier), trust, the dashboard UI, and honest precision/recall on three sets.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { findConflicts, conflictLines, groupConflicts, conflictReport, reportHeader, MAX_CONFLICTS } from "../src/conflicts.js";
import { factTags, withFacts, noteFacts, writeConflicts, similarKeys, disputedLines, COMMON_FACT_KEYS } from "../src/facts.js";
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
    assert.equal(c.a.kind, "token label, stamped by the server from the token");
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
    const text = conflictLines(groupConflicts(findConflicts(s))).join("\n");
    assert.match(text, /deploy target\n {2}Fly\.io\n/);
    assert.match(text, /\n {2}Render\n/);
    assert.ok(text.includes(`monomem supersede --old ${a} --new-id ${b}`));
    assert.ok(text.includes(`monomem supersede --old ${b} --new-id ${a}`));
    assert.ok(text.includes(`monomem pin ${a}`) && text.includes(`monomem pin ${b}`));
    assert.ok(text.includes('monomem trust distrust "alice" --namespace "default"'));
    assert.ok(!/or the reverse/.test(text));
    assert.match(text, /\[token label, stamped by the server from the token\]/);
    s.close();
  });
});

// ---- the dashboard, run in a stub browser ----
const NOTE_TAGS = ["fact:deploy_target=Render", "fact:node_version=22", "plain"];
function page(groups: unknown[], over: { capped?: boolean; total?: number } = {}) {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, addEventListener() {}, focus() {}, appendChild() {}, setAttribute() {}, removeAttribute() {} });
    return els.get(id);
  };
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {}, setAttribute() {} }) },
    sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, encodeURIComponent, Promise,
    fetch: async (path: string, opts: any = {}) => {
      calls.push({ path, method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
      let json: any = {};
      if (path.startsWith("/quality")) json = { counts: {}, issues: [], conflicts: [], conflict_groups: groups, conflict_total: over.total ?? groups.length, conflict_capped: over.capped ?? false };
      if (path === "/supersede/preview") json = { warning: "ARE YOU SURE?\nSays: \"\"", token: "T", requires_acknowledgement: false };
      if (/^\/notes\/\d+$/.test(path) && !opts.method) json = { note: { id: 2, rev: 3, tags: NOTE_TAGS } };
      return { ok: true, status: 200, json: async () => json };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, calls, el };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const KIND = "token label, stamped by the server from the token";
const G = (over: any = {}) => ({
  namespace: "default", key: "deploy_target", tier: "fact", confidence: "exact",
  values: [
    { value: "Fly.io", notes: [{ id: 1, title: "Hosting", writer: "alice", kind: KIND, pinned: false, at: "2026-10-01T00:00:00Z", otherFacts: 0 }] },
    { value: "Render", notes: [{ id: 2, title: "Runs on", writer: "bob", kind: KIND, pinned: false, at: "2026-10-02T00:00:00Z", otherFacts: 2 }] },
  ], ...over,
});

describe("CLI and report grouping", () => {
  test("N values on one key are ONE block, not N^2 pairs; every value lists its notes and writers", () => {
    const s = new Store(":memory:");
    const ids = ["fly.io", "render", "heroku", "vercel"].map((v, i) => mk(s, `w${i}`, `note ${i}`, "x", { deploy_target: v }));
    const pairs = findConflicts(s);
    assert.equal(pairs.length, 6);
    const groups = groupConflicts(pairs);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].values.length, 4);
    assert.deepEqual(groups[0].values.flatMap((v) => v.notes.map((n) => n.id)).sort(), [...ids].sort());
    const text = conflictLines(groups).join("\n");
    assert.equal((text.match(/\[conflict:/g) ?? []).length, 1);
    assert.match(text, new RegExp(`monomem supersede --old ${[ids[1], ids[2], ids[3]].join(",")} --new-id ${ids[0]}`));
    s.close();
  });
  test("two notes can state one value: both listed under it", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", "x", { database: "postgres" });
    mk(s, "carol", "c", "x", { database: "Postgres" });
    mk(s, "bob", "b", "x", { database: "mysql" });
    const [g] = groupConflicts(findConflicts(s));
    assert.deepEqual(g.values.map((v) => v.notes.length), [2, 1]);
    s.close();
  });
  test("capped: says 'showing N of at least M'; uncapped says the plain count", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 33; i++) mk(s, `w${i}`, `n${i}`, "x", { deploy_target: `host${i}` }); // 528 pairs > MAX_CONFLICTS
    const pairs = findConflicts(s);
    assert.equal(pairs.length, MAX_CONFLICTS);
    const r = conflictReport(pairs, 2);
    assert.equal(r.capped, true);
    assert.equal(reportHeader({ ...r, total: 7 }), "showing 1 of at least 7 conflicts");
    const small = conflictReport(pairs.slice(0, 1), 50);
    assert.equal(small.capped, false);
    assert.equal(reportHeader(small), "1 conflict");
    assert.equal(reportHeader({ groups: small.groups, total: 5, capped: false }), "showing 1 of 5 conflicts");
    s.close();
  });
});

describe("dashboard conflicts UI", () => {
  test("Keep <value> for each value, equal weight, Pin and Distrust, writer kind shown, no Replace", () => {
    const { ctx } = page([]);
    const html: string = ctx.cfRow(G(), 0);
    assert.match(html, /cfKeep\(0,0\)'>Keep Fly\.io</);
    assert.match(html, /cfKeep\(0,1\)'>Keep Render</);
    assert.match(html, /Pin #1/);
    assert.match(html, /Distrust alice/);
    assert.match(html, /alice \(token label, stamped by the server from the token\)/);
    assert.ok(!/Replace #/.test(html));
    const keeps = html.match(/<button[^>]*>Keep /g) ?? [];
    assert.equal(new Set(keeps.map((k) => k.match(/class='[^']*'/)?.[0])).size, 1, "same class on both Keep buttons: neither is primary");
    assert.ok(html.includes("class='ghost'") && !html.includes("<button>"));
    assert.ok(html.includes("id='cfdlg0'"), "the confirmation lives inside the card");
  });
  test("a pinned note hides the Keep that would change it and says to use the CLI", () => {
    const { ctx } = page([]);
    const g = G();
    g.values[1].notes[0].pinned = true;
    const html: string = ctx.cfRow(g, 0);
    assert.ok(!html.includes("Keep Fly.io"), "keeping #1 would change the pinned #2");
    assert.ok(html.includes("Keep Render"));
    assert.ok(html.includes("#2 pinned: change it from the CLI"));
    assert.ok(!html.includes("Pin #2"));
  });
  test("everything from the server is escaped, in the card and in the dialog", async () => {
    const evil = "<img src=x onerror=alert(1)>'\"";
    const g = G({ key: evil });
    for (const v of g.values) { v.value = evil; for (const n of v.notes) Object.assign(n, { writer: evil, title: evil, kind: evil }); }
    const { ctx, el } = page([g]);
    const html: string = ctx.cfRow(g, 0);
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("data-w='&lt;img src=x onerror=alert(1)&gt;&#39;&quot;'"));
    ctx.loadQuality();
    await settle();
    ctx.cfKeep(0, 0);
    assert.ok(!el("cfdlg0").innerHTML.includes("<img"), el("cfdlg0").innerHTML);
  });
  test("a capped report says 'showing N of at least M'", async () => {
    const { ctx, el } = page([G()], { capped: true, total: 9 });
    ctx.loadQuality();
    await settle();
    assert.match(el("list").innerHTML, /Conflicts \(showing 1 of at least 9\)/);
  });
  test("Keep on a fact dispute: plain bullets in the clicked card, no raw fact: tag, no ALL CAPS, no empty Says, nothing sent yet", async () => {
    const { ctx, calls, el } = page([G()]);
    ctx.loadQuality();
    await settle();
    const before = calls.length;
    ctx.cfKeep(0, 0);
    const d: string = el("cfdlg0").innerHTML;
    assert.equal(calls.length, before, "asking changes nothing");
    assert.match(d, /deploy_target = Fly\.io/);
    assert.match(d, /deploy_target = Render/);
    assert.match(d, /That one fact is removed\. The note stays, with its 2 other facts\./);
    assert.match(d, /Remove the disputed fact/);
    assert.match(d, /Replace whole note/);
    assert.ok(!/fact:/.test(d) && !/Says/.test(d) && !/\b[A-Z]{4,}\b/.test(d.replace(/<[^>]*>/g, "")), d);
  });
  test("Remove the disputed fact: only that tag goes, other tags and facts stay, through the ordinary note edit; no supersede", async () => {
    const { ctx, calls } = page([G()]);
    ctx.loadQuality();
    await settle();
    ctx.cfKeep(0, 0);
    ctx.cfAct(0, 0);
    await settle();
    const put = calls.find((c) => c.method === "PUT" && c.path === "/notes/2")!;
    assert.deepEqual(put.body, { tags: ["fact:node_version=22", "plain"], if_rev: 3 });
    assert.ok(!calls.some((c) => c.path.startsWith("/supersede")));
  });
  test("Replace whole note: a preview first, plain bullets that say its other facts go too, then confirm with the code", async () => {
    const { ctx, calls, el } = page([G()]);
    ctx.loadQuality();
    await settle();
    ctx.cfKeep(0, 0);
    ctx.cfAct(0, 1);
    await settle();
    assert.deepEqual(calls.find((c) => c.path === "/supersede/preview")!.body, { old_ids: [2], new_id: 1, gui: true });
    const d: string = el("cfdlg0").innerHTML;
    assert.match(d, /its 2 other facts go with it/);
    assert.match(d, /monomem supersede undo 2/);
    assert.ok(!/Says|ARE YOU SURE/.test(d));
    ctx.cfAct(0, 0);
    await settle();
    assert.deepEqual(calls.find((c) => c.path === "/supersede/confirm")!.body, { token: "T" });
  });
  test("a text-guessed (possible) conflict has no tag to remove: Keep goes to the replace preview", async () => {
    const { ctx, calls, el } = page([G({ tier: "possible", confidence: "high" })]);
    ctx.loadQuality();
    await settle();
    ctx.cfKeep(0, 1);
    await settle();
    assert.deepEqual(calls.find((c) => c.path === "/supersede/preview")!.body, { old_ids: [1], new_id: 2, gui: true });
    assert.ok(!/Remove the disputed fact/.test(el("cfdlg0").innerHTML));
  });
  test("each conflict keeps its buttons inside its own block (phone layout: no .cardhead flattening)", async () => {
    const { ctx, el } = page([G(), G({ key: "other" })]);
    ctx.loadQuality();
    await settle();
    const blocks = el("list").innerHTML.split("<div class='cf'>").slice(1);
    assert.equal(blocks.length, 2);
    for (const b of blocks) assert.match(b, /class='acts'/);
    assert.ok(!/cardhead/.test(el("list").innerHTML));
  });
  test("Pin and Distrust call the existing endpoints", async () => {
    const { ctx, calls } = page([G()]);
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

describe("adoption wording, key drift, session start", () => {
  test("the common keys live in one constant and the tool text uses it", async () => {
    assert.deepEqual([...COMMON_FACT_KEYS], ["deploy_target", "package_manager", "test_runner", "database", "node_version", "base_url", "ci_provider", "formatter"]);
    const s = new Store(":memory:");
    const server = createMcpServer(s, "admin", {}, { label: "alice", authed: true });
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(sv)]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "state_write")!;
    assert.match(tool.description!, /Recording a decision \(deploy target, package manager, test runner, database, a version or URL\)\? Also pass `facts`, so a teammate's different value is caught exactly\./);
    const desc = (tool.inputSchema.properties as any).facts.description as string;
    assert.ok(desc.startsWith(`Use a common key when one fits: ${COMMON_FACT_KEYS.join(", ")}. Prefix a subject only when the project has several (api.deploy_target).`), desc);
    client.close(); s.close();
  });
  test("SKILL.md and the docs repeat the same advice (common keys, subject prefix only when needed; no 'always scope')", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["SKILL.md", "docs/team.md", "docs/replacing-memories.md"]) {
      const t = readFileSync(f, "utf8");
      for (const k of COMMON_FACT_KEYS) assert.ok(t.includes(k), `${f} lacks ${k}`);
      assert.match(t, /api\.deploy_target/, f);
      assert.ok(!/scope (?:a )?keys?( to| \()/i.test(t) && !/always scope/i.test(t), `${f} still says to scope keys`);
    }
  });
  test("similar_keys: a NEW key gets the existing same-last-segment or synonym keys; a known key gets none", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", "x", { hosting: "fly.io", "api.package_manager": "pnpm", database: "postgres" });
    const hit = s.create({ title: "b", body: "x", tags: withFacts(undefined, { deploy_target: "render", pkg_manager: "npm", "web.package_manager": "yarn", database: "mysql", colour: "red" }) }, { writtenBy: "bob" });
    assert.deepEqual(similarKeys(s, hit), { deploy_target: ["hosting"], pkg_manager: ["api.package_manager"], "web.package_manager": ["api.package_manager"] });
    s.close();
  });
  test("similar_keys comes back over state_write only when the key is new and something looks alike", async () => {
    const s = new Store(":memory:");
    const server = createMcpServer(s, "admin", {}, { label: "bob", authed: true });
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(sv)]);
    const call = async (args: Record<string, unknown>): Promise<any> => {
      const r: any = await client.callTool({ name: "state_write", arguments: args });
      const t = r.content[0].text as string;
      return JSON.parse(t.slice(t.indexOf("{")));
    };
    mk(s, "alice", "a", "x", { hosting: "fly.io" });
    assert.deepEqual((await call({ title: "b", body: "y", facts: { deploy_target: "render" } })).similar_keys, { deploy_target: ["hosting"] });
    assert.equal((await call({ title: "c", body: "y", facts: { hosting: "render" } })).similar_keys, undefined, "hosting is already known");
    assert.equal((await call({ title: "d", body: "y", facts: { unrelated_thing: "1" } })).similar_keys, undefined);
    client.close(); s.close();
  });
  test("session start: a dispute is at most 2 short lines; none = no text at all; same writer or same value is no dispute", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", "x", { deploy_target: "fly.io" });
    mk(s, "alice", "a2", "x", { deploy_target: "render" }); // one writer changing their mind
    assert.equal(disputedLines(s, "default"), "");
    mk(s, "bob", "b", "x", { deploy_target: "Render" });
    assert.match(disputedLines(s, "default"), /^Disputed: deploy_target = fly\.io \(alice\) vs render \(alice\/bob\)\. Ask the user before acting\.$/);
    for (const [k, v1, v2] of [["database", "pg", "mysql"], ["test_runner", "jest", "vitest"]] as const) { mk(s, "alice", `x${k}`, "y", { [k]: v1 }); mk(s, "bob", `y${k}`, "y", { [k]: v2 }); }
    assert.equal(disputedLines(s, "default").split("\n").length, 2);
    assert.equal(disputedLines(s, "elsewhere"), "");
    s.close();
  });
  test("injectContext: the Disputed line rides inside the context; absent when nothing is disputed; distrusted writers do not count", async () => {
    const { injectContext } = await import("../src/context-inject.js");
    const s = new Store(":memory:");
    mk(s, "alice", "Deploy", "we deploy", { deploy_target: "fly.io" });
    const quiet = await injectContext(s, { namespace: "default", signals: {} });
    assert.ok(!quiet.includes("Disputed:"));
    mk(s, "bob", "Hosting", "we host", { deploy_target: "render" });
    const loud = await injectContext(s, { namespace: "default", signals: {} });
    assert.match(loud, /Disputed: deploy_target = fly\.io \(alice\) vs render \(bob\)\. Ask the user before acting\./);
    s.distrustAdd("default", "bob");
    assert.ok(!(await injectContext(s, { namespace: "default", signals: {} })).includes("Disputed:"));
    s.close();
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
