// First-impression CLI behaviour: short grouped help, a helpful unknown-command message, old-Node workaround.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("cli help", () => {
  test("default help is short and grouped; --all keeps the full text", () => {
    const short = run(["help"]).stdout;
    for (const g of ["Get started", "Daily", "Trust", "Maintenance"]) assert.match(short, new RegExp(g));
    assert.match(short, /help --all/);
    assert.doesNotMatch(short, /rebuild-edges/);
    assert.match(run(["help", "--all"]).stdout, /rebuild-edges/);
  });
  test("an unknown command suggests the closest one and exits non-zero without dumping help", () => {
    const r = run(["stat"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command 'stat'\. Did you mean 'start'\?/);
    assert.match(r.stderr, /monomem help/);
    assert.equal(r.stdout, "");
    assert.match(run(["doctr"]).stderr, /Did you mean 'doctor'\?/);
    assert.doesNotMatch(run(["xyzxyzxyz"]).stderr, /Did you mean/);
  });
  test("old Node gets the one-line workaround", () => {
    const root = mkdtempSync(join(tmpdir(), "om-clihelp-"));
    try {
      const shim = join(root, "shim.mjs");
      writeFileSync(shim, `Object.defineProperty(process.versions, "node", { value: "22.1.0" });\nawait import(${JSON.stringify("file://" + CLI.replace(/\\/g, "/"))});\n`);
      const r = spawnSync(process.execPath, [shim, "setup", "--dry-run"], { encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root, MONOMEM_HOME: join(root, "om") } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /npx -y -p node@24 -p monomem monomem setup/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("every command main() handles is on the known-command list (no 'Unknown command' for a real one)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(PROJECT_ROOT, "src", "cli.ts"), "utf8");
  const listed = src.slice(src.indexOf("const COMMANDS = ["), src.indexOf("];", src.indexOf("const COMMANDS = [")));
  const cases = [...src.matchAll(/^ {4}case "([a-z][a-z:-]*)":/gm)].map((m) => m[1]); // the top-level switch only
  const missing = [...new Set(cases)].filter((c) => !listed.includes(`"${c}"`));
  assert.deepEqual(missing, []);
});
