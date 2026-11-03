// 1.1.0: an agent can never permanently erase memory or approve its own risks.
// - state_delete over MCP archives (restorable); permanent delete is for a person (dashboard, CLI).
// - On the local stdio transport (admin by default) the operator-only tools stay off unless
//   MONOMEM_STDIO_ADMIN_TOOLS=1, even under MONOMEM_TOOLS=all.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer, OPERATOR_ONLY_TOOLS } from "../src/mcp-server-core.js";

async function connect(store: Store, conn = {}, opts: any = { tools: "all" }) {
  const server = createMcpServer(store, "admin", opts, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("state_delete archives instead of erasing", () => {
  test("the note survives, archived, and can be restored", async () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "forget me", body: "my staging port is 8443" });
    const c = await connect(store);
    const r: any = await c.callTool({ name: "state_delete", arguments: { id: n.id } });
    assert.ok(!r.isError);
    const out = parse(r);
    assert.equal(out.archived, n.id);
    assert.equal(out.deleted, undefined, "must not claim a permanent delete");
    assert.ok(store.read(n.id)?.archived_at, "row kept, archived");
    // Hidden from search like any archived note.
    const s: any = await c.callTool({ name: "state_search", arguments: { query: "staging" } });
    assert.ok(!JSON.stringify(s).includes("forget me"));
    // ...and by id: a forgotten note reads as missing, its text never comes back to an agent.
    const byId: any = await c.callTool({ name: "state_read", arguments: { id: n.id } });
    assert.equal(byId.isError, true);
    assert.doesNotMatch(JSON.stringify(byId), /8443/);
    assert.ok(store.restore(n.id) && !store.read(n.id)?.archived_at);
    const back: any = await c.callTool({ name: "state_read", arguments: { id: n.id } });
    assert.ok(!back.isError, "restored note is readable again");
    await c.close();
    store.close();
  });

  test("a forgotten note's text cannot come back through an edit or its history", async () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "secret-ish", body: "vault code 7731" });
    store.update(n.id, { body: "vault code 7731, updated" });
    const c = await connect(store);
    await c.callTool({ name: "state_delete", arguments: { id: n.id } });
    const w: any = await c.callTool({ name: "state_write", arguments: { id: n.id, tags: ["x"] } });
    assert.equal(w.isError, true, "editing a forgotten note must fail");
    assert.doesNotMatch(JSON.stringify(w), /7731/);
    for (const name of ["memory_history", "memory_restore_version"]) {
      const r: any = await c.callTool({ name, arguments: name === "memory_history" ? { id: n.id } : { id: n.id, version: 1 } });
      assert.doesNotMatch(JSON.stringify(r), /7731/, name);
    }
    assert.ok(store.read(n.id)?.archived_at, "still archived, untouched");
    await c.close();
    store.close();
  });

  test("forgetting drops the note's embedding (a lossy copy of its text)", () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "v", body: "w" });
    store.setVector(n.id, new Float32Array([0.1, 0.2, 0.3]), "m");
    assert.equal(store.vectorCount(), 1);
    store.archive(n.id);
    assert.equal(store.vectorCount(), 0);
    store.close();
  });

  test("archiving twice says it is already archived", async () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "x", body: "y" });
    const c = await connect(store);
    await c.callTool({ name: "state_delete", arguments: { id: n.id } });
    const again: any = await c.callTool({ name: "state_delete", arguments: { id: n.id } });
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /already archived/);
    await c.close();
    store.close();
  });
});

describe("stdio keeps operator-only tools away from the agent", () => {
  const SAVE = process.env.MONOMEM_STDIO_ADMIN_TOOLS;
  afterEach(() => {
    if (SAVE === undefined) delete process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    else process.env.MONOMEM_STDIO_ADMIN_TOOLS = SAVE;
  });

  test("operator-only tools are not registered over stdio, even with all tools on", async () => {
    delete process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    const store = new Store(":memory:");
    const c = await connect(store, { local: true });
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of OPERATOR_ONLY_TOOLS) assert.ok(!names.includes(t), `${t} must be off over stdio`);
    assert.ok(names.includes("state_write") && names.includes("state_delete"));
    await c.close();
    store.close();
  });

  test("include_distrusted and task approve:true are refused over stdio", async () => {
    delete process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    const store = new Store(":memory:");
    const c = await connect(store, { local: true });
    const r: any = await c.callTool({ name: "state_list", arguments: { include_distrusted: true } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /MONOMEM_STDIO_ADMIN_TOOLS/);
    const t: any = await c.callTool({ name: "task_put", arguments: { title: "x", command: { action: "echo" }, target: "pc", approve: true } });
    assert.equal(t.isError, true);
    assert.match(t.content[0].text, /MONOMEM_STDIO_ADMIN_TOOLS/);
    await c.close();
    store.close();
  });

  test("an operator can opt back in with MONOMEM_STDIO_ADMIN_TOOLS=1", async () => {
    process.env.MONOMEM_STDIO_ADMIN_TOOLS = "1";
    const store = new Store(":memory:");
    const c = await connect(store, { local: true });
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of OPERATOR_ONLY_TOOLS) assert.ok(names.includes(t), `${t} back on with the flag`);
    await c.close();
    store.close();
  });

  test("HTTP admin tokens are unchanged (explicitly provisioned by the operator)", async () => {
    delete process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    const store = new Store(":memory:");
    const c = await connect(store, { label: "ops", authed: true });
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of OPERATOR_ONLY_TOOLS) assert.ok(names.includes(t));
    await c.close();
    store.close();
  });
});
