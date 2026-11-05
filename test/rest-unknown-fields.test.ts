// Round 5: REST note routes reject unknown top-level fields (a client sent `content` for `body` and got an empty note).
import "./setup-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";

let store: Store;
let srv: Server;
let base = "";
const TOKEN = "unknown-field-token-0123456789abcdef";
before(async () => {
  store = new Store(":memory:");
  srv = createApiServer(store, [{ token: TOKEN, scope: "write", label: "writer" }]);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => {
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
  store.close();
});
const call = async (method: string, path: string, body: unknown) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

test("POST with `content` instead of `body` is a 400 naming it, and stores nothing", async () => {
  const r = await call("POST", "/notes", { title: "t", content: "hello" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /unknown field: content/);
  assert.equal(store.list({ limit: 10 }).total, 0);
});

test("known fields still work on POST and PUT; unknown ones on PUT are named", async () => {
  const c = await call("POST", "/notes", { title: "t", body: "b", tags: ["x"], source: "s", forget_after: 5, confidence: 0.5 });
  assert.equal(c.status, 201);
  const u = await call("PUT", `/notes/${c.json.note.id}`, { body: "b2", if_rev: c.json.note.rev });
  assert.equal(u.status, 200);
  const bad = await call("PUT", `/notes/${c.json.note.id}`, { content: "x", text: "y" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown fields: content, text/);
});
