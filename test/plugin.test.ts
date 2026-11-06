// The Claude Code plugin files and server.json must not drift from what `monomem setup` writes or from package.json.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCaptureCommand, buildServerEntry, hookHosts, type SetupEnv } from "../src/setup.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (f: string): any => JSON.parse(readFileSync(join(ROOT, f), "utf8"));
const pkg = json("package.json");
const e: SetupEnv = { home: "/h", platform: "linux", env: {}, cwd: "/h", nodeVersion: "24.4.1", execPath: "node", cliPath: "/x/cli.js", version: pkg.version, now: () => new Date(0) };

test("plugin .mcp.json is the entry setup writes for Claude Code (npx, pinned, MONOMEM_CLIENT)", () => {
  const want = buildServerEntry(e, { command: "npx" }, { MONOMEM_CLIENT: "claude-code" });
  assert.deepEqual(json(".mcp.json").mcpServers.monomem, want);
});

test("plugin hooks.json is the session-start hook setup --capture writes for Claude Code (reads the session id, so receipts and the meter work), plus a timeout", () => {
  const host = hookHosts(e)[0];
  assert.equal(host.client, "claude-code");
  const want = { [host.start.on]: [{ matcher: host.start.matcher, hooks: [{ type: "command", command: buildCaptureCommand(e, { command: "npx" }, "session-start"), timeout: 20 }] }] };
  assert.deepEqual(json("hooks/hooks.json").hooks, want);
});

test("plugin and marketplace manifests agree with package.json", () => {
  const p = json(".claude-plugin/plugin.json");
  const m = json(".claude-plugin/marketplace.json");
  assert.equal(p.name, "monomem");
  assert.equal(p.version, pkg.version);
  assert.equal(p.license, pkg.license);
  assert.equal(m.plugins[0].name, p.name);
  assert.equal(m.plugins[0].source, "./");
});

test("server.json matches package.json and registry limits", () => {
  const s = json("server.json");
  assert.equal(s.name, pkg.mcpName);
  assert.ok(s.description.length > 0 && s.description.length <= 100, `description is ${s.description.length} chars`);
  assert.equal(s.version, pkg.version);
  const pk = s.packages[0];
  assert.deepEqual([pk.registryType, pk.identifier, pk.version, pk.transport.type], ["npm", pkg.name, pkg.version, "stdio"]);
  assert.deepEqual(pk.packageArguments, [{ type: "positional", value: "mcp" }]);
  assert.deepEqual(pk.environmentVariables.map((v: { name: string }) => v.name), ["MONOMEM_CLIENT", "MONOMEM_HOME", "MONOMEM_DB_PATH"]);
});

test("scripts/sync-plugin-version.mjs rewrites every pinned version (npm version hook)", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-sync-"));
  try {
    for (const f of ["package.json", ".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json", "server.json"]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), readFileSync(join(ROOT, f)));
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version: "9.8.7" }));
    execFileSync(process.execPath, [join(ROOT, "scripts", "sync-plugin-version.mjs")], { cwd: dir, stdio: "ignore" });
    const at = (f: string): string => readFileSync(join(dir, f), "utf8");
    assert.equal(JSON.parse(at(".claude-plugin/plugin.json")).version, "9.8.7");
    assert.match(at(".mcp.json"), /monomem@9\.8\.7"/);
    assert.match(at("hooks/hooks.json"), /monomem@9\.8\.7 hook session-start/);
    assert.equal(JSON.parse(at("hooks/hooks.json")).hooks.SessionStart[0].hooks[0].timeout, 20);
    const s = JSON.parse(at("server.json"));
    assert.deepEqual([s.version, s.packages[0].version], ["9.8.7", "9.8.7"]);
    assert.ok(!/1\.1\.1/.test(at(".mcp.json") + at("hooks/hooks.json") + at("server.json")), "no stale version left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
