// dirBytes is time-boxed so `doctor` / `uninstall --purge` can't hang on a huge data folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirBytes } from "../src/uninstall.js";

test("dirBytes counts every file when it finishes inside the budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-dirbytes-"));
  try {
    writeFileSync(join(dir, "a"), "12345");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b"), "678");
    assert.deepEqual(dirBytes(dir), { bytes: 8, truncated: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dirBytes stops and says so once the deadline has passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-dirbytes-"));
  try {
    writeFileSync(join(dir, "a"), "12345");
    assert.deepEqual(dirBytes(dir, Date.now() - 1), { bytes: 0, truncated: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing folder is 0 bytes, not truncated", () => {
  assert.deepEqual(dirBytes(join(tmpdir(), "monomem-does-not-exist-" + Date.now())), { bytes: 0, truncated: false });
});
