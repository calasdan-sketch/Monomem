# Claude Code plugin and MCP registry entry

## Install as a Claude Code plugin

```
/plugin marketplace add calasdan-sketch/monomem
/plugin install monomem@monomem
```

Nothing is built or installed from the checkout: the plugin only contains config files, and every command it runs is `npx -y monomem@<version> ...`, so Node >= 22.16 and npm access are all it needs. The version is pinned on purpose (a database upgrade is one-way); a test keeps it equal to `package.json`.

What it adds:

- **MCP server** `monomem` (`.mcp.json`): `npx -y monomem@<version> mcp` with `MONOMEM_CLIENT=claude-code`, so writes are stamped `stdio:claude-code`.
- **SessionStart hook** (`hooks/hooks.json`, events `startup|clear`): `npx -y monomem@<version> recall --budget-ms 800`, which shows recent notes at the start of a session.
- **Skills**: the root `SKILL.md` and `skills/monomem-mem/SKILL.md`, loaded from the repo, not copied. The second one needs `MONOMEM_TOOLS=all` on the server, which the plugin does not set.

`claude plugin validate` passes on the plugin folder.

## How it differs from `npx monomem setup`

- The plugin does not touch `~/.claude.json` or `~/.claude/settings.json`; uninstalling the plugin removes it. `setup` edits those files (with a diff, consent and `--undo`).
- The plugin has no automatic capture hooks. `setup` offers them only with consent (`--capture`); to get them, run `npx monomem setup --capture`.
- The plugin serves Claude Code only; `setup` also wires Cursor, Codex, Gemini and others.
- On native Windows, `setup` writes `cmd /c npx ...`; the plugin's `.mcp.json` is static and uses plain `npx`. If `/mcp` shows it failing there, use `setup`.
- Both share the same database (default `~/.monomem`), so they can be used together, but then Claude Code has two `monomem` MCP servers; pick one.

## MCP registry entry

`server.json` follows the schema at `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (see https://github.com/modelcontextprotocol/registry, docs/reference/server-json). `package.json` carries `"mcpName": "io.github.calasdan-sketch/monomem"`, which the registry checks against the npm package. `server.json` `version` and `packages[0].version` must be bumped with every release (the test fails otherwise).

## What is not done

Nothing is published or submitted. Each of these needs the owner's approval: publishing an npm release containing `mcpName` (the registry reads it from the published package), `mcp-publisher publish` to the registry, and listing the plugin in any marketplace or directory beyond this repo's own `marketplace.json`.

## npm package

The plugin files (`.claude-plugin/`, `.mcp.json`, `hooks/`, `server.json`) are not in the npm package: Claude Code installs the plugin from GitHub, and the registry reads `mcpName` from `package.json`. The `files` list already excludes them.
