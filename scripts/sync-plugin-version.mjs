// `npm version x.y.z` runs this (the "version" script): copy the new package.json version into the plugin files and
// server.json so they never drift, then stage them so they land in the version commit.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const write = (f, o) => writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
const v = read("package.json").version;
const pin = (s) => s.replace(/monomem@\d+\.\d+\.\d+[^\s"]*/g, `monomem@${v}`);

const plugin = read(".claude-plugin/plugin.json");
write(".claude-plugin/plugin.json", { ...plugin, version: v });

const mcp = read(".mcp.json");
for (const s of Object.values(mcp.mcpServers)) s.args = s.args.map(pin);
write(".mcp.json", mcp);

const hooks = read("hooks/hooks.json");
for (const list of Object.values(hooks.hooks)) for (const g of list) for (const h of g.hooks) h.command = pin(h.command);
write("hooks/hooks.json", hooks);

const server = read("server.json");
server.version = v;
for (const p of server.packages) p.version = v;
write("server.json", server);

const files = [".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json", "server.json"];
try {
  execFileSync("git", ["add", ...files], { stdio: "ignore" });
} catch {
  /* not a git checkout: the files are still updated */
}
console.log(`plugin files and server.json set to ${v}`);
