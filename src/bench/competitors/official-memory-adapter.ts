// Benchmark adapter for the official MCP reference memory server, @modelcontextprotocol/server-memory.
//
// Internal comparison tooling: not shipped in the npm package (see package.json "files").
//
// The server is spawned with npx as a stdio MCP server (one fresh process and one fresh MEMORY_FILE_PATH in a temp
// folder per scenario) and driven only through its MCP tools, with the MCP SDK Client Monomem already depends on.
// Nothing here reads or writes the server's JSONL file.
//
// Mapping choices (the server stores a knowledge graph of entities, observations and relations, not notes):
//  - One note = one entity, entityType "note". The entity name is the note title plus a unique suffix " #n<k>",
//    because create_entities silently skips a name that already exists, and the benchmark writes several notes with
//    the same title. The suffix is stripped again when the note is reported, so `title` is the title as written.
//  - The body is one observation. Tags and source are stored as extra observations "tags: a, b" and "source: x" and
//    parsed back, so the agent can see them and search finds them (the server has no fields for either).
//  - Note id = the stable "n<k>" the adapter assigned. The server's own identity is the entity name; changing a title
//    therefore means delete_entities + create_entities (the server has no rename), and the adapter keeps the id.
//  - Update: changed body = delete_observations(old body) + add_observations(new body); tags/source likewise.
//  - Delete: delete_entities. Read: open_nodes. List: read_graph.
//  - Search: the server's search_nodes matches the WHOLE query as one case-insensitive substring of a name, type or
//    observation, and returns matches in stored order. Sent as-is, almost none of the multi-word benchmark queries
//    would match anything. Charitably, the adapter calls search_nodes once per query word (words of 3+ letters or
//    digits) and ranks entities by how many words matched, ties in the server's stored order. This is the most an
//    agent could get out of the tool; it is still the server answering every lookup.
//  - Concepts the server does not have, reported as UNSUPPORTED (never as a pass or a fail):
//      * credentials and scopes: a "read" actor's write/update/delete returns "unsupported" (any client can write);
//      * server-stamped writer / creator / taint, timestamps, staleness, trust/distrust, confidence and deletion policy (a write carrying one returns
//        "unsupported"), compare-and-swap, tenants,
//        quarantine (no write-time filter exists, so writes are simply stored), history, replace (supersede), merge,
//        archive/expiry, export/import, attestation, capture, recall, change feed, SessionStart injection.
//    Capabilities declared: read, list. Note fields reported: id, title, body, tags, source.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BenchNote, Capability, MemoryAdapter, OpResult, SearchOpts, UpdateInput, WorldSpec, WriteInput } from "../types.js";

/** Pinned so a run is reproducible. 2.1.0 was published on the day of the first run; its search code is unchanged. */
export const OFFICIAL_MEMORY_PACKAGE = "@modelcontextprotocol/server-memory@2.0.1";

interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

const SUFFIX = / #(n\d+)$/;
const TAGS = "tags: ";
const SOURCE = "source: ";

/** Split an entity back into a note. Exported for the unit test. */
export function entityToNote(e: Entity): BenchNote {
  const m = SUFFIX.exec(e.name);
  const n: BenchNote = { id: m ? m[1] : e.name, title: m ? e.name.slice(0, m.index) : e.name, body: "" };
  const body: string[] = [];
  for (const o of e.observations) {
    if (o.startsWith(TAGS)) n.tags = o.slice(TAGS.length).split(", ").filter(Boolean);
    else if (o.startsWith(SOURCE)) n.source = o.slice(SOURCE.length);
    else body.push(o);
  }
  n.body = body.join("\n");
  return n;
}

/** The query words the adapter sends one by one. Exported for the unit test. */
export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))];
}

function observations(body: string, tags?: string[], source?: string): string[] {
  const o: string[] = [];
  if (body) o.push(body);
  if (tags?.length) o.push(TAGS + tags.join(", "));
  if (source !== undefined && source !== "") o.push(SOURCE + source);
  return o;
}

export class OfficialMemoryAdapter implements MemoryAdapter {
  readonly name = "official-memory";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["read", "list"]);
  readonly fields: ReadonlySet<keyof BenchNote> = new Set<keyof BenchNote>(["id", "title", "body", "tags", "source"]);

  private dir = "";
  private client: Client | undefined;
  private scopes = new Map<string, string>();
  /** note id -> current entity name */
  private names = new Map<string, string>();
  private next = 1;

  constructor(private readonly command = "npx", private readonly args = ["-y", OFFICIAL_MEMORY_PACKAGE]) {}

  async open(world: WorldSpec): Promise<void> {
    await this.close();
    this.dir = mkdtempSync(join(tmpdir(), "official-memory-bench-"));
    for (const [k, a] of Object.entries(world.actors)) this.scopes.set(k, a.scope);
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...getDefaultEnvironment(), MEMORY_FILE_PATH: join(this.dir, "memory.jsonl") },
      stderr: "ignore",
    });
    this.client = new Client({ name: "monomem-bench", version: "1.0.0" });
    await this.client.connect(transport);
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.scopes.clear();
    this.names.clear();
    this.next = 1;
    if (this.dir) {
      try {
        rmSync(this.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      } catch {
        /* a leftover temp folder is not a benchmark result */
      }
      this.dir = "";
    }
  }

  private async call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; json: unknown; text: string }> {
    if (!this.client) throw new Error("adapter not open");
    const res = (await this.client.callTool({ name, arguments: args })) as { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    let json: unknown = res.structuredContent;
    if (json === undefined) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { ok: res.isError !== true, json, text };
  }

  private entities(json: unknown): Entity[] {
    const j = json as { entities?: Entity[] } | Entity[] | undefined;
    return (Array.isArray(j) ? j : j?.entities) ?? [];
  }

  private readOnly(actor: string): boolean {
    return this.scopes.get(actor) === "read";
  }

  private async get(id: string): Promise<Entity | undefined> {
    const name = this.names.get(id);
    if (name === undefined) return undefined;
    const r = await this.call("open_nodes", { names: [name] });
    return this.entities(r.json).find((e) => e.name === name);
  }

  async write(actor: string, input: WriteInput): Promise<OpResult> {
    if (this.readOnly(actor)) return { outcome: "unsupported", detail: "no read-only credentials" };
    if (input.confidence !== undefined || input.forget_after !== undefined) return { outcome: "unsupported", detail: "no confidence or deletion-policy field" };
    const id = `n${this.next++}`;
    const name = `${input.title} #${id}`;
    const r = await this.call("create_entities", { entities: [{ name, entityType: "note", observations: observations(input.body, input.tags, input.source) }] });
    if (!r.ok) return { outcome: "error", detail: r.text.slice(0, 200) };
    this.names.set(id, name);
    const e = await this.get(id);
    return e ? { outcome: "ok", note: entityToNote(e) } : { outcome: "error", detail: "entity not found after create" };
  }

  async update(actor: string, id: string, patch: UpdateInput): Promise<OpResult> {
    if (this.readOnly(actor)) return { outcome: "unsupported", detail: "no read-only credentials" };
    if (patch.confidence !== undefined || patch.if_rev !== undefined) return { outcome: "unsupported", detail: "no confidence field or compare-and-swap" };
    const e = await this.get(id);
    if (!e) return { outcome: "not_found" };
    const cur = entityToNote(e);
    const title = patch.title ?? cur.title;
    const body = patch.body ?? cur.body;
    const tags = patch.tags ?? cur.tags;
    const source = patch.source ?? cur.source;
    const wanted = observations(body, tags, source);
    if (title !== cur.title) {
      // No rename tool: replace the entity under the new name.
      const name = `${title} #${id}`;
      await this.call("delete_entities", { entityNames: [e.name] });
      const r = await this.call("create_entities", { entities: [{ name, entityType: "note", observations: wanted }] });
      if (!r.ok) return { outcome: "error", detail: r.text.slice(0, 200) };
      this.names.set(id, name);
    } else {
      const drop = e.observations.filter((o) => !wanted.includes(o));
      const add = wanted.filter((o) => !e.observations.includes(o));
      if (drop.length) await this.call("delete_observations", { deletions: [{ entityName: e.name, observations: drop }] });
      if (add.length) {
        const r = await this.call("add_observations", { observations: [{ entityName: e.name, contents: add }] });
        if (!r.ok) return { outcome: "error", detail: r.text.slice(0, 200) };
      }
    }
    const after = await this.get(id);
    return after ? { outcome: "ok", note: entityToNote(after) } : { outcome: "error", detail: "entity not found after update" };
  }

  async delete(actor: string, id: string): Promise<OpResult> {
    if (this.readOnly(actor)) return { outcome: "unsupported", detail: "no read-only credentials" };
    const e = await this.get(id);
    if (!e) return { outcome: "not_found" };
    await this.call("delete_entities", { entityNames: [e.name] });
    this.names.delete(id);
    return { outcome: "ok" };
  }

  async search(_actor: string, query: string, opts: SearchOpts = {}): Promise<OpResult> {
    const score = new Map<string, { e: Entity; n: number; first: number }>();
    let order = 0;
    for (const w of queryWords(query)) {
      const r = await this.call("search_nodes", { query: w });
      if (!r.ok) return { outcome: "error", detail: r.text.slice(0, 200) };
      for (const e of this.entities(r.json)) {
        const s = score.get(e.name) ?? { e, n: 0, first: order++ };
        s.n++;
        score.set(e.name, s);
      }
    }
    const hits = [...score.values()].sort((a, b) => b.n - a.n || a.first - b.first).slice(0, opts.limit ?? 10).map((s) => entityToNote(s.e));
    return { outcome: "ok", hits, text: JSON.stringify(hits) };
  }

  async read(_actor: string, id: string): Promise<OpResult> {
    const e = await this.get(id);
    return e ? { outcome: "ok", note: entityToNote(e), text: JSON.stringify(e) } : { outcome: "not_found" };
  }

  async list(): Promise<OpResult> {
    const r = await this.call("read_graph", {});
    const notes = this.entities(r.json).map(entityToNote);
    return { outcome: "ok", notes, text: r.text };
  }
}
