// Deleting a note must remove its text from the database FILE, not just from
// every table. Without `PRAGMA secure_delete`, SQLite only marks the freed
// pages as reusable: the deleted title and body stay readable with any hex
// viewer or `strings t.db` until something happens to overwrite them.
// Measured 2026-11-02: create + edit + delete left the text in the file.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

test("a deleted note's text is gone from the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-del-"));
  try {
    // Built at runtime so this source file never contains the marker itself.
    const marker = ["Zebra", "Pineapple", "4417"].join("");
    const store = new Store(join(dir, "t.db"));
    const note = store.create({ title: `title ${marker}`, body: `body ${marker}` });
    store.update(note.id, { body: `edited ${marker}` });
    assert.equal(store.delete(note.id), true);
    store.close();

    // Lower-cased compare: the FTS index stores tokens folded, so a case-sensitive scan misses it.
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f)).toString("latin1").toLowerCase();
      assert.equal(text.includes(marker.toLowerCase()), false, `${f} still holds the deleted text`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
