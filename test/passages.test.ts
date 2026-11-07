// Passage retrieval: split, score, budget, and the MCP / REST surfaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { splitPassages, selectPassages, estTokens, MAX_PASSAGE_CHARS } from "../src/passages.js";

const filler = (n: number, seed: string): string => `${seed} `.repeat(n).trim();

test("a chat-style body splits at each turn, a document at blank lines", () => {
  const chat = "user: my dog is called Biscuit and he is four\nassistant: Nice name, how long have you had him?\nuser: since he was a puppy, about three years";
  const p = splitPassages(chat);
  assert.equal(p.length, 3);
  assert.ok(p[0].text.startsWith("user: my dog"));
  assert.equal(chat.slice(p[1].start, p[1].end), p[1].text);
  const doc = "## Heading\nFirst paragraph with enough words to stand alone as a passage.\n\nSecond paragraph, also long enough to be its own passage here.";
  assert.equal(splitPassages(doc).length, 2, "the heading line is joined to the paragraph after it");
});

test("an over-long block is cut, nothing is lost and offsets line up", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something about topic ${i}.`).join(" ");
  const ps = splitPassages(long);
  assert.ok(ps.length > 2);
  for (const p of ps) {
    assert.ok(p.text.length <= MAX_PASSAGE_CHARS);
    assert.equal(long.slice(p.start, p.end), p.text);
  }
  assert.equal(ps.map((p) => p.text).join(""), long);
  assert.deepEqual(splitPassages(""), []);
  assert.deepEqual(splitPassages("   \n\n  "), []);
});

test("one enormous line and a flood of blank lines stay bounded", () => {
  const t = performance.now();
  const ps = splitPassages("x".repeat(300_000) + "\n\n\n\n".repeat(50_000) + "tail");
  assert.ok(ps.length < 2000);
  assert.ok(performance.now() - t < 2000);
});

test("the passage that answers is chosen, within the token budget", () => {
  const body = [
    "Intro paragraph about the weather and other unrelated chatter that fills space. " + filler(40, "blah"),
    "The deploy region for production is ca-central-1 because data must stay in Canada.",
    "Another unrelated paragraph about lunch menus. " + filler(40, "pizza"),
  ].join("\n\n");
  const sel = selectPassages([{ id: 1, title: "Infra", body }], "which region do we deploy to", { maxTokens: 60 });
  assert.equal(sel.picked.length >= 1, true);
  assert.ok(sel.picked.some((p) => p.text.includes("ca-central-1")));
  assert.ok(sel.tokens <= 60);
  assert.ok(sel.picked.every((p) => !p.text.includes("pizza")));
});

test("the budget is a hard ceiling, even when the best passage is bigger than it", () => {
  const body = "needle " + filler(300, "haystack");
  const sel = selectPassages([{ id: 1, title: "t", body }], "needle", { maxTokens: 25 });
  assert.equal(sel.picked.length, 1);
  assert.ok(sel.tokens <= 25);
  assert.ok(estTokens(sel.picked[0].text.length) <= 25);
});

test("a title-only match still returns the note's opening", () => {
  const sel = selectPassages([{ id: 7, title: "Zebra protocol", body: "Opening line of the note, which never repeats the title word." }], "zebra", { maxTokens: 100 });
  assert.equal(sel.picked.length, 1);
});

test("CJK queries match inside long runs", () => {
  const body = "数据库迁移前必须备份。\n\n东京区域的备份保留30天，大阪区域保留14天。";
  const sel = selectPassages([{ id: 1, title: "t", body }], "东京", { maxTokens: 50, context: 0 });
  assert.equal(sel.picked.length, 1);
  assert.ok(sel.picked[0].text.includes("东京"));
});

test("a 200-note result with huge bodies is bounded", () => {
  const notes = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, title: `n${i}`, body: ("lorem ipsum dolor sit amet needle " + "x".repeat(60)).repeat(3000) }));
  const t = performance.now();
  const sel = selectPassages(notes, "needle", { maxTokens: 500 });
  assert.ok(performance.now() - t < 3000);
  assert.ok(sel.tokens <= 500);
});

test("passages are grouped by note in search order and never mix up note ids", () => {
  const a = { id: 1, title: "A", body: "alpha beta gamma details about quokkas in the first note" };
  const b = { id: 2, title: "B", body: "second note also discusses quokkas, at greater length than the first" };
  const sel = selectPassages([a, b], "quokkas", { maxTokens: 200 });
  assert.deepEqual(sel.picked.map((p) => p.noteId), [1, 2]);
});

async function mcpClient(store: Store): Promise<Client> {
  const server = createMcpServer(store);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}
const payload = (r: any): any => {
  const text = r.content[0].text as string;
  return JSON.parse(text.slice(text.indexOf("{")));
};

test("state_search with passages drops the body and keeps id, provenance and staleness fields", async () => {
  const store = new Store(":memory:");
  const note = store.create({
    title: "Runbook",
    body: ["Preamble. " + filler(80, "words"), "To rotate the signing key run rotate-keys and wait fifteen minutes.", "Epilogue. " + filler(80, "more")].join("\n\n"),
  });
  const client = await mcpClient(store);
  const plain = payload(await client.callTool({ name: "state_search", arguments: { query: "rotate signing key" } }));
  const shaped = payload(await client.callTool({ name: "state_search", arguments: { query: "rotate signing key", passages: true, max_tokens: 80 } }));
  assert.ok(plain.results[0].body.length > 500, "default is unchanged: whole body");
  const r = shaped.results[0];
  assert.equal(r.id, note.id);
  assert.equal(r.body, undefined);
  assert.equal(r.body_omitted, true);
  assert.ok(r.passages.some((p: { text: string }) => p.text.includes("rotate-keys")));
  assert.ok(shaped.passage_tokens <= 80);
  assert.ok(JSON.stringify(shaped).length < JSON.stringify(plain).length / 2);
  await client.close();
  store.close();
});

test("GET /search?passages=1 shapes results and rejects a bad max_tokens", async () => {
  const store = new Store(":memory:");
  store.create({ title: "Runbook", body: "First part. " + filler(100, "pad") + "\n\nThe migration needs the flag --dry-run before it is applied." });
  const server = createApiServer(store, "tok");
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { authorization: "Bearer tok" };
  const ok = await (await fetch(`${base}/search?q=migration+dry-run&passages=1&max_tokens=60`, { headers: h })).json();
  assert.equal(ok.results[0].body, undefined);
  assert.ok(ok.results[0].passages[0].text.includes("--dry-run"));
  const bad = await fetch(`${base}/search?q=migration&passages=1&max_tokens=abc`, { headers: h });
  assert.equal(bad.status, 400);
  const plain = await (await fetch(`${base}/search?q=migration+dry-run`, { headers: h })).json();
  assert.ok(typeof plain.results[0].body === "string");
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
});
