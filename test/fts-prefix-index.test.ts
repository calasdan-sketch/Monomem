// The search index carries FTS5's 1-character prefix index (fast "i"* style query words). New stores are created
// with it; a store made without it is rebuilt once on open, keeping search, update triggers and secure-delete.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";

type Db = { prepare(sql: string): { get(): unknown }; exec(sql: string): void };
const db = (s: Store): Db => (s as unknown as { db: Db }).db;
const ftsSql = (s: Store): string => (db(s).prepare("SELECT sql FROM sqlite_master WHERE name = 'notes_fts'").get() as { sql: string }).sql;

test("new and older stores end up with the prefix index, and search still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-fts-prefix-"));
  const file = join(dir, "state.db");
  try {
    let s = new Store(file);
    const n = s.create({ title: "Deploy", body: "goes to ca-central-1 in iceland" });
    assert.match(ftsSql(s), /prefix='1'/);
    // An index made by an older build: no prefix option.
    db(s).exec(`DROP TABLE notes_fts;
      CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tags, content='notes', content_rowid='id');
      INSERT INTO notes_fts(notes_fts) VALUES('rebuild');`);
    s.close();
    s = new Store(file);
    assert.match(ftsSql(s), /prefix='1'/);
    assert.equal(s.search("i").length, 1);
    s.update(n.id, { body: "moved to eu-west" });
    assert.equal(s.search("iceland").length, 0, "the update trigger still re-indexes");
    assert.equal(s.search("west").length, 1);
    const sd = db(s).prepare("SELECT v FROM notes_fts_config WHERE k = 'secure-delete'").get() as { v: number };
    assert.equal(Number(sd.v), 1);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
