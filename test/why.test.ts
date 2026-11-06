// `monomem why`: the story of one note from data already kept.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { receiptAdd } from "../src/receipts.js";
import { noteWhy, writerKind, NOT_RECORDED } from "../src/why.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);

function story() {
  const s = new Store(":memory:");
  const n = as("alice", () => s.create({ title: "Deploy day", body: "SECRET-BODY first" }));
  as("bob", () => s.update(n.id, { title: "Deploy day v2", body: "SECRET-BODY second" }));
  receiptAdd(s, { sessionId: "sess-9", namespace: n.namespace, client: "claude", shown: [{ id: n.id, why: "{files 2d}", tokens: 9 }] });
  return { s, id: n.id, ns: n.namespace };
}

describe("noteWhy", () => {
  test("tells who wrote each version, which session saw it, and what is not recorded", () => {
    const { s, id } = story();
    const w = noteWhy(s, s.read(id)!);
    const text = w.timeline.map((e) => e.what).join("\n");
    assert.match(text, /created by alice \(token\)/);
    assert.match(text, /version 1 .*written by alice.* replaced by bob/);
    assert.match(text, /shown at session start sess-9 \(claude\), rank 1, why: files; 2 days old/);
    assert.equal(w.status, "live");
    assert.equal(w.shown_to.total, 1);
    assert.equal(w.reads.attributable, false);
    assert.equal(w.not_recorded, NOT_RECORDED);
    assert.ok(!JSON.stringify(w).includes("SECRET-BODY"), "no body unless asked");
    assert.ok(noteWhy(s, s.read(id)!, { body: true }).body!.includes("SECRET-BODY second"));
    s.close();
  });

  test("replacement, pin, archive and distrust show up as status facts", () => {
    const { s, id } = story();
    const other = as("bob", () => s.create({ title: "Newer" }));
    s.setPinned(id, true);
    assert.equal(noteWhy(s, s.read(id)!).pinned, true);
    s.archive(other.id);
    assert.equal(noteWhy(s, s.read(other.id)!).status, "archived");
    s.distrustAdd("default", "bob");
    assert.equal(noteWhy(s, s.read(id)!).distrusted_writer, true);
    s.close();
  });

  test("writer wording matches describeWriter; distrusted versions lose their title; JSON title is printable; retention", () => {
    const s = new Store(":memory:");
    const n = as("alice", () => s.create({ title: "Old secret title", body: "b" }));
    as("mallory", () => s.update(n.id, { title: "Newer", body: "c" }));
    as("bob", () => s.update(n.id, { title: "Newest", body: "d" }));
    s.distrustAdd(n.namespace, "mallory");
    const text = noteWhy(s, s.read(n.id)!).timeline.map((e) => e.what).join("\n");
    assert.match(text, /version 1 \("Old secret title", written by alice \(token\)\)/);
    assert.match(text, /version 2 \(title hidden: its writer is distrusted, written by mallory/);
    assert.ok(!text.includes('"Newer"'));
    const m = s.create({ title: "Line\u001b[31m one\ntwo", body: "b" });
    const w = noteWhy(s, s.read(m.id)!);
    assert.ok(!/[\u0000-\u001f]/.test(w.title));
    assert.equal(w.shown_to.retention_days, 30);
    s.close();
  });

  test("a writer label is classified, never trusted", () => {
    assert.match(writerKind("cli"), /server-stamped/);
    assert.match(writerKind("stdio:cursor"), /self-declared by its launch config/);
    assert.match(writerKind("token:cli"), /stamped by the server from the token/);
    assert.match(writerKind("", false), /unknown/);
    assert.match(writerKind("x", true), /claimed/);
  });
});

describe("memory_why MCP tool", () => {
  async function connect(s: Store, tools?: string[]): Promise<Client> {
    const server = createMcpServer(s, "read", tools ? { tools } : {});
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(sv)]);
    return client;
  }
  test("returns the story behind the untrusted banner, hides distrusted notes, errors on unknown ids", async () => {
    const { s, id } = story();
    const client = await connect(s, ["memory_why"]);
    const ok: any = await client.callTool({ name: "memory_why", arguments: { id } });
    assert.match(ok.content[0].text, /UNTRUSTED DATA/);
    assert.match(ok.content[0].text, /sess-9/);
    assert.ok(!ok.content[0].text.includes("SECRET-BODY"));
    const none: any = await client.callTool({ name: "memory_why", arguments: { id: 9999 } });
    assert.equal(none.isError, true);
    s.distrustAdd("default", "bob");
    const hidden: any = await client.callTool({ name: "memory_why", arguments: { id } });
    assert.equal(hidden.isError, true);
    await client.close();
    s.close();
  });
});
