// as_of brings back earlier versions and forgotten notes, so over MCP it is admin-only, like note history.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

async function connect(store: Store, scope: "read" | "admin") {
  const server = createMcpServer(store, scope, {}, {});
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

test("a read token cannot use as_of; an admin can", async () => {
  const store = new Store(":memory:");
  const n = store.create({ title: "creds", body: "password is hunter2" });
  const t = new Date(Date.now() - 1000).toISOString();
  const reader = await connect(store, "read");
  const r: any = await reader.callTool({ name: "state_search", arguments: { query: "password", as_of: t } });
  assert.ok(r.isError, "read token refused");
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  const admin = await connect(store, "admin");
  const a: any = await admin.callTool({ name: "state_search", arguments: { query: "password", as_of: t } });
  assert.ok(!a.isError, JSON.stringify(a).slice(0, 200));
  assert.ok(n.id > 0);
  await reader.close();
  await admin.close();
  store.close();
});
