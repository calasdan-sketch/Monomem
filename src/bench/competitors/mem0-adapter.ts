// Benchmark adapter for Mem0 open source (pip package `mem0ai`), run fully locally.
//
// Internal comparison tooling: not shipped in the npm package (see package.json "files").
//
// Mem0 is a Python library, so the adapter drives it through bench/mem0_bridge.py: one Python child process for the
// whole run, speaking JSON lines over stdin/stdout. Each scenario gets a fresh Memory in a fresh temp folder
// (Mem0's default vector store, Qdrant in local on-disk mode, no server; history SQLite in the same folder).
// LLM: Ollama (default qwen2.5:7b, temperature 0). Embeddings: Ollama nomic-embed-text. Telemetry: MEM0_TELEMETRY=False
// and MEM0_DIR inside the temp folder (the user's ~/.mem0 is never touched). No cloud key is used or needed.
//
// Two variants:
//  - "mem0" (infer=true, Mem0's DEFAULT): on add, an LLM extracts facts from the text and stores those, so a note may
//    become zero, one or several memories, reworded. This is what a user of Memory.add() gets by default.
//  - "mem0-noinfer" (infer=false): the text is stored verbatim as one memory.
//
// Mapping choices:
//  - A note is written as the message "<title>\n<body>" (so the title is searchable), with metadata
//    {title, tags, source}. Metadata is a Mem0 feature; the title is reported from it, the body from the memory text
//    (minus the "<title>\n" prefix when the text still starts with it).
//  - Note id = an adapter-assigned "n<k>", mapped to the list of Mem0 memory ids that write produced. Search hits are
//    mapped back to their note (best rank kept). With infer=true a write that extracts nothing leaves a note with no
//    memories (Mem0 said ok; the note cannot be read or found afterwards).
//  - Update: Mem0's update(memory_id, text) on the note's first memory (direct, no LLM, which is how Mem0's update
//    works), with the merged "<title>\n<body>" and metadata; the note's other memories are deleted.
//  - Delete: delete every memory of the note. Read: get(first memory). List: get_all.
//  - History: Mem0 has history(memory_id), but every history scenario also needs restoring a version, admin-only
//    access to history, or writer names in it, none of which Mem0 has; the capability is not declared (skipped).
//  - Search: Mem0's search with its defaults (threshold 0.1), top_k = the scenario's limit, all in one shared scope
//    (user_id "bench"). Plain `pip install mem0ai` has no spaCy/fastembed, so Mem0 logs that BM25 keyword search is
//    disabled: search is vector similarity only. That is the default install, so it is what is measured.
//  - Concepts Mem0 does not have, reported as UNSUPPORTED: credentials/scopes (a "read" actor's write/update/delete
//    returns "unsupported"); server-stamped writer/creator/taint; staleness flags; trust/distrust; confidence;
//    enforced tenants (user_id/agent_id are caller-chosen filters, not access control); quarantine (no write-time
//    filter exists); compare-and-swap; replace (supersede), merge, archive, export/import, attestation, capture, recall, change feed,
//    SessionStart injection; placing notes in the past.
//    Capabilities declared: read, list. Note fields reported: id, title, body, tags, source, created_at, updated_at.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { BenchNote, Capability, MemoryAdapter, OpResult, SearchOpts, UpdateInput, WorldSpec, WriteInput } from "../types.js";

interface Mem {
  id: string;
  memory: string;
  metadata?: { title?: string; tags?: string[]; source?: string } | null;
  created_at?: string;
  updated_at?: string;
}

/** Something that answers bridge requests (the Python process, or a fake in tests). */
export type Bridge = (req: Record<string, unknown>) => Promise<unknown>;

/** Start bench/mem0_bridge.py and return a request function plus a stopper. */
export function pythonBridge(python: string, script: string, env: Record<string, string>): { call: Bridge; stop: () => void } {
  const child: ChildProcessWithoutNullStreams = spawn(python, [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); // Mem0 logs to stderr; drop it
  const lines: Interface = createInterface({ input: child.stdout });
  const waiting: Array<(l: string) => void> = [];
  lines.on("line", (l) => waiting.shift()?.(l));
  let queue = Promise.resolve();
  const call: Bridge = (req) => {
    const p = queue.then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          if (child.exitCode !== null) return reject(new Error("mem0 bridge exited"));
          waiting.push((l) => {
            const r = JSON.parse(l) as { ok: boolean; result?: unknown; error?: string };
            if (r.ok) resolve(r.result);
            else reject(new Error(r.error));
          });
          child.stdin.write(JSON.stringify(req) + "\n");
        })
    );
    queue = p.then(() => undefined, () => undefined);
    return p;
  };
  return { call, stop: () => child.kill() };
}

export class Mem0Adapter implements MemoryAdapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["read", "list"]);
  readonly fields: ReadonlySet<keyof BenchNote> = new Set<keyof BenchNote>(["id", "title", "body", "tags", "source", "created_at", "updated_at"]);

  private dir = "";
  private scopes = new Map<string, string>();
  private notes = new Map<string, string[]>();
  private next = 1;

  constructor(private readonly infer: boolean, private readonly bridge: Bridge) {
    this.name = infer ? "mem0" : "mem0-noinfer";
  }

  async open(world: WorldSpec): Promise<void> {
    await this.close();
    this.dir = mkdtempSync(join(tmpdir(), "mem0-bench-"));
    for (const [k, a] of Object.entries(world.actors)) this.scopes.set(k, a.scope);
    await this.bridge({ op: "open", dir: this.dir });
  }

  async close(): Promise<void> {
    if (this.dir) {
      await this.bridge({ op: "close" }).catch(() => undefined);
      try {
        rmSync(this.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      } catch {
        /* a leftover temp folder is not a benchmark result */
      }
      this.dir = "";
    }
    this.scopes.clear();
    this.notes.clear();
    this.next = 1;
  }

  private noteOf(memId: string): string {
    for (const [n, ids] of this.notes) if (ids.includes(memId)) return n;
    return memId;
  }

  private toNote(m: Mem): BenchNote {
    const title = m.metadata?.title ?? "";
    const prefix = title + "\n";
    const n: BenchNote = { id: this.noteOf(m.id), title, body: title && m.memory.startsWith(prefix) ? m.memory.slice(prefix.length) : m.memory };
    if (m.metadata?.tags) n.tags = m.metadata.tags;
    if (m.metadata?.source !== undefined) n.source = m.metadata.source;
    if (m.created_at) n.created_at = m.created_at;
    if (m.updated_at) n.updated_at = m.updated_at;
    return n;
  }

  private readOnly(actor: string): boolean {
    return this.scopes.get(actor) === "read";
  }

  private async first(id: string): Promise<Mem | undefined> {
    const memId = this.notes.get(id)?.[0];
    if (memId === undefined) return undefined;
    return ((await this.bridge({ op: "get", id: memId })) as Mem | null) ?? undefined;
  }

  private static meta(title: string, tags?: string[], source?: string): Record<string, unknown> {
    return { title, ...(tags ? { tags } : {}), ...(source !== undefined ? { source } : {}) };
  }

  async write(actor: string, input: WriteInput): Promise<OpResult> {
    if (this.readOnly(actor)) return { outcome: "unsupported", detail: "no read-only credentials" };
    if (input.confidence !== undefined || input.forget_after !== undefined) return { outcome: "unsupported", detail: "no confidence or deletion-policy field" };
    try {
      const res = (await this.bridge({ op: "add", text: `${input.title}\n${input.body}`, infer: this.infer, metadata: Mem0Adapter.meta(input.title, input.tags, input.source) })) as Mem[];
      const id = `n${this.next++}`;
      this.notes.set(id, res.map((m) => m.id));
      const m = await this.first(id);
      return { outcome: "ok", note: m ? this.toNote(m) : { id, title: input.title, body: "" }, data: { memories: res.length } };
    } catch (e) {
      return { outcome: "error", detail: (e as Error).message.slice(0, 200) };
    }
  }

  async update(actor: string, id: string, patch: UpdateInput): Promise<OpResult> {
    if (this.readOnly(actor)) return { outcome: "unsupported", detail: "no read-only credentials" };
    if (patch.confidence !== undefined || patch.if_rev !== undefined) return { outcome: "unsupported", detail: "no confidence field or compare-and-swap" };
    const m = await this.first(id);
    if (!m) return { outcome: "not_found" };
    const cur = this.toNote(m);
    const title = patch.title ?? cur.title;
    const body = patch.body ?? cur.body;
    try {
      await this.bridge({ op: "update", id: m.id, text: `${title}\n${body}`, metadata: Mem0Adapter.meta(title, patch.tags ?? cur.tags, patch.source ?? cur.source) });
      const ids = this.notes.get(id) ?? [];
      for (const other of ids.slice(1)) await this.bridge({ op: "delete", id: other });
      this.notes.set(id, [m.id]);
      const after = await this.first(id);
      return after ? { outcome: "ok", note: this.toNote(after) } : { outcome: "error", detail: "memory gone after update" };
    } catch (e) {
      return { outcome: "error", detail: (e as Error).message.slice(0, 200) };
    }
  }

  async delete(actor: string, id: string): Promise<OpResult> {
    if (this.readOnly(actor)) return { outcome: "unsupported", detail: "no read-only credentials" };
    const ids = this.notes.get(id);
    if (!ids?.length) return { outcome: "not_found" };
    for (const m of ids) await this.bridge({ op: "delete", id: m }).catch(() => undefined);
    this.notes.delete(id);
    return { outcome: "ok" };
  }

  async search(_actor: string, query: string, opts: SearchOpts = {}): Promise<OpResult> {
    try {
      const res = (await this.bridge({ op: "search", query, limit: opts.limit ?? 10 })) as Mem[];
      const seen = new Set<string>();
      const hits: BenchNote[] = [];
      for (const m of res) {
        const n = this.toNote(m);
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        hits.push(n);
      }
      return { outcome: "ok", hits, text: JSON.stringify(res) };
    } catch (e) {
      return { outcome: "error", detail: (e as Error).message.slice(0, 200) };
    }
  }

  async read(_actor: string, id: string): Promise<OpResult> {
    const m = await this.first(id);
    return m ? { outcome: "ok", note: this.toNote(m), text: JSON.stringify(m) } : { outcome: "not_found" };
  }

  async list(): Promise<OpResult> {
    const res = (await this.bridge({ op: "list" })) as Mem[];
    return { outcome: "ok", notes: res.map((m) => this.toNote(m)), text: JSON.stringify(res) };
  }

}
