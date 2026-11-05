#!/usr/bin/env node
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import "./legacy-env.js"; // second: read the old CLAUDE_BRIDGE_* variables as MONOMEM_*
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { setProcessWriter } from "./actor.js";
// monomem CLI: one command to run, check, or wire up the bridge.
//   monomem [start]   start the API + dashboard AND MCP-over-HTTP (default)
//   monomem mcp       start the MCP server over stdio (for Claude Code/Cursor/...)
//   monomem doctor    check Node, database, and token
//   monomem init      print the config snippet to wire it into your agent
//   monomem help      show help

/** Every command main() accepts, for the unknown-command check and the "did you mean" hint. */
const COMMANDS = [
  "start", "serve", "mcp", "mcp:stdio", "doctor", "init", "setup", "uninstall", "sync", "reindex", "recall", "hook",
  "consolidate", "rebuild-edges", "relevant", "search", "token", "changes", "backup", "runner-status", "watch", "export", "import", "trust",
  "quarantine", "approve-first", "access", "flood", "resume", "decay", "archive", "restore", "delete", "quality", "conflicts",
  "encrypt", "meter", "receipts", "never-show", "supersede", "history", "pin", "unpin", "rollback", "bench", "drill", "health", "audit",
  "help", "--help", "-h", "--version", "-v", "version",
];

/** Plain edit distance; the command list is tiny, so the simple version is fine. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** The closest known command, or undefined when nothing is plausibly what the person meant. */
function suggestCommand(cmd: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3; // 1 or 2 edits; farther is a guess, not a hint
  for (const c of COMMANDS.filter((x) => !x.startsWith("-"))) {
    const d = editDistance(cmd.toLowerCase(), c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function shortUsage(): void {
  console.log(
    [
      "monomem <command>      (the most-used commands; 'monomem help --all' lists every one)",
      "",
      "Get started",
      "  setup [--dry-run]       Connect Monomem to the AI apps on this computer (shows the changes, asks first)",
      "  doctor                  Check Node, the database, the token and the setup",
      "  import --claude         Bring in what Claude Code already remembers (add --dry-run to look first)",
      "  start                   Run the dashboard, REST API and MCP-over-HTTP (the default)",
      "  mcp                     Run the MCP server over stdio (what your apps launch)",
      "",
      "Daily",
      "  relevant \"message\"      Show the notes that relate to a sentence (search \"words\" does the same)",
      "  changes                 What changed while you were away",
      "  history <id>            A note's earlier versions (history restore <id> <version> puts one back)",
      "  pin <id> | unpin <id>   Pin a note so agents can read it but not change it",
      "",
      "Trust",
      "  quarantine              Review writes that were held (by the linter or an approve-first namespace)",
      "  approve-first           Hold every agent write to a namespace until you approve it",
      "  trust                   Distrust a writer; decide which other servers' exports to believe",
      "  token                   Make, list or remove access tokens for your apps (add needs a terminal)",
      "  rollback --writer w --since 2h   Undo what one writer did (shows a plan first)",
      "  access                  Who read memory, and when",
      "  drill [--json]          Replay known memory-poisoning attacks on a copy of your store and your settings",
      "  health [--json] [--card [file.svg]]   One grade A-F: setup, settings, drill, audit chain, held writes (rule: health --help)",
      "",
      "Maintenance",
      "  backup [--out <dir>]    Copy the database safely, even while the server runs",
      "  export | import         Move notes in and out (JSON or Markdown)",
      "  quality                 Duplicates, stale notes and flagged notes worth a look",
      "  conflicts               Notes from different writers that disagree (flag only)",
      "  delete <id>             Delete a note permanently, with its earlier versions",
      "  uninstall               Take Monomem out of every app setup connected",
      "",
      "Per-command options: 'monomem help --all'. Docs: https://github.com/calasdan-sketch/monomem",
      "",
    ].join("\n")
  );
}

function usage(all = false): void {
  if (!all) return shortUsage();
  console.log(
    [
      "monomem <command>",
      "",
      "  start     Start the API + dashboard AND MCP-over-HTTP (default).",
      "            When: always-on. Local by default (127.0.0.1); to reach it from a phone or claude.ai,",
      "            put your own authenticated tunnel in front of it (see INFRA.md).",
      "  mcp       Start the MCP server over stdio.",
      "            When: wiring a local agent (Claude Code / Cursor / Copilot). See: monomem init",
      "  --version, -v   Print the installed version.",
      "  doctor    Check Node, database, token, namespace config, and the recall hook.",
      "            When: something isn't working, or after changing config.",
      "  init      Print the config snippet to wire monomem into your agent.",
      "            When: you want to see the config before using it, or to copy it by hand.",
      "  uninstall [--dry-run] [--yes] [--purge] [--no-backup]",
      "            Take Monomem out of every app setup connected (same as setup --undo, for every setup run).",
      "            --purge also deletes the data folder, after a final backup it names (unless --no-backup).",
      "  setup [--dry-run] [--yes] [--only claude-code,claude-desktop,cursor,codex,gemini,muse,vscode,zed] [--project] [--hook|--no-hook] [--capture|--no-capture] [--db <file>] [--undo]",
      "            Connect monomem to Claude Code / Claude Desktop / Cursor for you. Shows the plan and the exact lines it will",
      "            change, saves a backup of each file first, writes only after you type y. An old \"claude-bridge\" entry is offered",
      "            for migration with your data kept. --dry-run only shows; --undo puts back what it changed.",
      "            When: first install (npx monomem setup), or moving from claude-bridge.",
      "  reindex   Backfill semantic embeddings for notes missing them.",
      "            When: after enabling embeddings, or after changing the embedding model.",
      "  recall [--limit 10] [--written-by w] [--not-written-by w] [--include-distrusted]",
      "            SessionStart hook: print recent memory as hook JSON (fail-silent).",
      "            Notes from writers on the distrust list are left out unless --include-distrusted.",
      "            When: wired into Claude Code settings.json. See:",
      "            https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md",
      "  hook <session-start|user-prompt|post-tool|post-tool-failure|stop|subagent-stop|session-end|file-context> [--db <file>]",
      "            Automatic memory: the agent's lifecycle hooks (hook JSON on stdin). Records what the agent does, redacted,",
      "            on this machine only, and distills it into observations and a session summary. Always exits 0.",
      "            Off switch: MONOMEM_CAPTURE=off. When: installed by `monomem setup --capture`.",
      "            file-context (PreToolUse on Read) lists what memory knows about the file, once per session; it never",
      "            blocks or changes the Read.",
      "  receipts [session-id] [--json]",
      "            List recent sessions, or show which memories one session start showed and why (ids and tags are stored, never note text).",
      "  meter [--json] [--card [file.svg]]",
      "            What Monomem costs, as numbers. --card writes a shareable SVG savings card (default monomem-card.svg).",
      "  never-show <id> [--undo]",
      "            Keep one note out of the session-start context for good (tags it never-show; it stays searchable).",
      "            When: a memory keeps being shown that does not help. The dashboard has the same button.",
      "  consolidate [--dry-run] [--yes] [--threshold 0.95] [--namespace ns]",
      "            Find near-duplicate notes and merge them. Without --yes",
      "            (or with --dry-run) this only reports — nothing is merged.",
      "            When: periodic cleanup of duplicated agent notes.",
      "  rebuild-edges [--threshold 0.25] [--yes] [--force]",
      "            Recalculate the note similarity graph from scratch: every",
      "            note is re-scored against same-namespace notes and pairs",
      "            at/above the threshold get bidirectional edges. Prints the",
      "            pair count first and asks for confirmation on large",
      "            rebuilds (--yes skips); refuses while another process",
      "            holds the write lock (--force overrides); streams",
      "            progress to stderr. Reports {created, removed} edge",
      "            counts. O(n^2) — maintenance, not interactive.",
      "            When: after a bulk import, or after changing the threshold.",
      "  relevant|search \"some natural language message\" [--limit 5] [--namespace ns] [--written-by w] [--not-written-by w] [--include-distrusted]",
      "            Extract keywords from a message and show the relevant notes.",
      "            Prints the keywords used alongside the results.",
      "            When: you have a vague message and want the memory it touches.",
      "  changes [--since 24h|ISO|last] [--consumer name] [--namespace ns] [--source s] [--limit 100]",
      "          [--written-by w] [--not-written-by w] [--note-written-by w] [--not-note-written-by w] [--include-distrusted]",
      "  changes --purge             delete the whole change log (titles of past changes) and all markers",
      "            What changed while you were away: created/updated/deleted notes",
      "            grouped by source. --since last uses (and advances) a per-consumer marker.",
      "  backup [--out <dir>] [--include-approval-key] [--include-attest-key] | backup --prune-premigration",
      "            Consistent hot copy of the database (works while the server runs)",
      "            into <dir>/state.db, plus a copy of the encryption key (.key) if",
      "            at-rest encryption is on. Default dir: ~/monomem-backup-<time>.",
      "            WARNING: store the key SEPARATELY from the backup; a backup without",
      "            its key is unreadable, and one stored with it is not encrypted.",
      "            --include-attest-key also copies the signing key (.attest-key) so a restore keeps",
      "            this server's signing identity. --prune-premigration deletes EVERY copy an",
      "            upgrade left next to the database: <db>.pre-v*-backup and the dated copies",
      "            (<db>.pre-v*-backup-YYYYMMDD-HHMMSS) kept from earlier upgrades.",
      "            When: before upgrades, and on a schedule.",
      "  runner-status [--namespace ns] [--json]",
      "            Is the PC's command runner listening, and how many approved commands are",
      "            waiting for it (and how many approvals expire soon or already did)?",
      "            Reads the local store; never prints command text.",
      "            When: an approved phone command has not run yet.",
      "  watch [--consumer name] [--wait 25] [--namespace ns] [--written-by w] [--not-written-by w] [--include-distrusted] [--exec <program> [args...]]",
      "            Long-poll loop on this store: prints each new change as it happens.",
      "            With --exec, runs <program> (no shell) per batch with the changes as",
      "            JSON on stdin and MONOMEM_CHANGE_COUNT in the environment.",
      "            When: you want a script or notifier to react to a phone/other-session write.",
      "  export --format md --dir <path> [--namespace ns] [--no-prune] [--force] [--include-distrusted]",
      "            Write one Markdown file per note (YAML front-matter) into",
      "            namespace folders. Deterministic and git-friendly; prunes",
      "            files of deleted notes it wrote earlier (--no-prune keeps them).",
      "  export --format json [--out file] [--attest]",
      "            Full JSON backup (same shape as GET /export) to stdout or a file: {\"notes\": [...]},",
      "            as in every release before 1.4.0. --attest adds an `export` header (this server and",
      "            its public key) and a signed attestation per note, for another server to verify.",
      "  import --file backup.json [--no-dedupe] [--json] [--require-attestation]",
      "            Restore a JSON backup (streamed, so big files are fine). Notes whose attestation verifies against a",
      "            trusted key keep their original writer; everything else is stamped as imported by 'cli' and flagged",
      "            imported_unverified. --require-attestation (or MONOMEM_IMPORT_REQUIRE_ATTESTATION=1) rejects those instead.",
      "  trust [list | identity | distrust <writer> [--namespace ns|*] | undistrust <writer> [--namespace ns|*]",
      "         | attester-add <public-key> --server-id id [--label text] [--not-after time] [--any-server]",
      "         | attester-remove <key-id> | attester-revoke <key-id> | attester-unrevoke <key-id>",
      "         | export-key --out file | rotate] [--json]   (monomem trust --help)",
      "            The trust policy: writers whose notes are left out of every read (and never run),",
      "            and the other servers whose signed exports an import will believe. See docs/trust.md.",
      "  token add --label <name> --scope read|write|admin [--namespace ns] | token list | token remove <label>",
      "            Make a random access token for an app and save it in tokens.json (shown once; restart a running server after).",
      "            list shows labels and scopes only. Commands that lower protection (token add, trust undistrust/attester-add/",
      "            attester-unrevoke, quarantine approve, unpin, approve-first off, resume) need a real terminal and a typed yes.",
      "  sync --git <repo-folder> [--remote name] [--encrypt] [--key-file f] [--dry-run] [--no-push] [--yes]",
      "            Keep your notes in step across your own computers through a PRIVATE git repository you own: fetch, merge,",
      "            three-way merge into the database, write back, commit, push. No Monomem server. --encrypt seals every",
      "            file before it is committed; the key stays on your computers and never goes in the repository.",
      "  import --claude [--dry-run] [--yes] [--update] [--project <folder>[,<folder>]] [--namespace ns] [--include-index]",
      "            Import what Claude Code already remembers: CLAUDE.md files (user, this folder or --project) and auto memory",
      "            (~/.claude/projects/*/memory). Cut into separate notes at headings, tagged with their source file and project; running",
      "            it again adds only what is new. Anything that looks like a secret is skipped and never shown. Local only.",
      "  import --from claude-mem|mem0|basic-memory|mcp-memory [--path p] [--dry-run] [--yes] [--namespace ns]",
      "            Import another memory tool's notes: claude-mem's database (~/.claude-mem/claude-mem.db, opened read only;",
      "            observations and session summaries keep their type, files, project and dates), a mem0 JSON export (--path),",
      "            or a basic-memory folder (~/basic-memory). Same rules as --claude: secrets skipped, re-runs add only what is new.",
      "            How to switch over and uninstall the old tool: docs/switching.md.",
      "  import --dir <path> [--dry-run] [--allow-move]",
      "            Merge Markdown files back: newer side wins, conflicts are",
      "            reported and the losing version is saved under <dir>/.conflicts/.",
      "            Runs through the memory linter.",
      "  quarantine [list | approve <id> | reject <id>]",
      "            Review writes the memory linter held (MONOMEM_LINT) or an approve-first namespace held.",
      "  approve-first [<namespace> on|off]",
      "            Hold every agent write to a namespace in the quarantine queue until you approve it.",
      "            No arguments: list the namespaces with it on. Writes from monomem commands are not held.",
      "  access [--since 24h|ISO] [--writer label] [--limit 100] [--json]",
      "            Who read memory: time, writer label, tool or route, result count, namespaces and a short",
      "            redacted query preview (never note text). Kept MONOMEM_ACCESS_LOG_DAYS (30; 0 = off).",
      "  flood | resume <label>",
      "            Writers the flood guard paused (more than MONOMEM_FLOOD_WRITES_PER_HOUR writes, default 500,",
      "            in an hour) / let one write again. Local stdio apps all share the label \"stdio\".",
      "  quality [--json] [--namespace ns]",
      "            What is worth a look: near-duplicates, stale notes with a newer twin, quarantined writes, notes",
      "            the linter flags, and captured rows about to decay. Each comes with the command that fixes it.",
      "  conflicts [--json] [--namespace ns]",
      "            Live notes from different writers that give different values for the same key (deploy target, package",
      "            manager, a version, a URL). Flag only: you choose supersede, pin or distrust.",
      "  decay [--dry-run] [--namespace ns]",
      "            Archive (never delete) captured observations idle MONOMEM_DECAY_DAYS (30) and summaries idle",
      "            MONOMEM_DECAY_SUMMARY_DAYS (180). Never: your own notes, decisions, anything tagged \"pinned\".",
      "            Also runs on its own in the expiry sweep and at the end of a captured session.",
      "  archive <id> | restore <id>",
      "            Soft-archive a note, or bring an archived one back (the undo for decay and archive).",
      "  audit verify",
      "            Walk the audit log's hash chain and report the first broken line (edits/deletions inside the chain).",
      "  delete <id> [--yes]",
      "            Delete a note permanently, with all its earlier versions. Asks first; cannot be undone.",
      "  encrypt <enable|status|disable>",
      "            enable   Create the AES-256-GCM key and encrypt every note",
      "                     body at rest. Keyword search then covers title+tags",
      "                     only (bodies cannot be indexed as ciphertext).",
      "            status   Report whether at-rest encryption is on, the key",
      "                     path, and how many bodies are encrypted.",
      "            disable  Decrypt every body and remove the key file.",
      "            When: running Monomem as a shared / multi-agent store.",
      "            See: docs/encryption-retention.md for the real tradeoffs.",
      "  supersede --old <ids> (--title T --body B [--tags a,b] [--confidence 0-1] | --new-id N)",
      "            Replace one or more notes with a newer one, SAFELY. It first shows exactly what would stop appearing in",
      "            search and what is not lost, then asks you to type the number of notes (or yes). Nothing is ever deleted:",
      "            the old note is kept, marked replaced, and can be brought back. From a script it only previews and prints a",
      "            one-time code: run again with --confirm-token <code> (same --title/--body) to go ahead.",
      "  supersede undo <id>",
      "            Bring a replaced note back exactly as it was (recorded).",
      "  history <id> [--json] [--include-distrusted] | history restore <id> <version> [--if-rev n] | history purge <id> [--yes]",
      "            A note's earlier versions: list them, put one back (as a new version, nothing is overwritten), or forget them.",
      "  pin [<id>] | unpin <id>",
      "            Pin a note so agents can read it but only this CLI can change, archive, replace or restore it. No id: list pins.",
      "  rollback --writer <name> --since <iso|30m|2h|7d> [--include-conflicts] [--yes] [--json]",
      "            Undo what one writer did since then: archive notes it created, put back the text of notes it changed.",
      "            Shows the plan first; notes others changed later are skipped unless --include-conflicts. \"stdio\" = every local app.",
      "  bench [--json] [--suite name] [--only id] [--seed n] [--dir folder] [--strict-gaps] [--verbose]",
      "            Run the provenance benchmark on a throwaway store: stale memory, contradiction recovery,",
      "            permission isolation, provenance retention. Offline, deterministic, exits 1 on a failure.",
      "            Your own data is never touched. See docs/BENCHMARK.md.",
      "  bench --longmemeval | --locomo [--data file] [--limit n] [--mode keyword|hybrid] [--granularity session|turn] [--json]",
      "            Retrieval benchmark (recall@k, nDCG, MRR) on a public dataset, in a temp folder. No LLM.",
      "  help      Show this help",
      "",
    ].join("\n")
  );
}

/** doctor warns above these (docs/footprint.md). */
const DOCTOR_MAX_DATA_BYTES = 1e9;
const DOCTOR_MAX_BACKLOG = 10_000;

/** doctor: settings that weaken protection, plus a data folder a cloud-sync client may copy. Warnings only. */
async function doctorSecurityChecks(dataDir: string, bindHost: string, warn: (m: string) => void): Promise<void> {
  const { lintPolicy } = await import("./lint.js");
  const policy = lintPolicy();
  if (policy.secret === "warn" || policy.injection === "warn") {
    warn(`MONOMEM_LINT="${process.env.MONOMEM_LINT}" stores notes the memory linter would otherwise hold or refuse (secrets: ${policy.secret}, injection: ${policy.injection}). Remove it unless you chose this.`);
  }
  if (process.env.MONOMEM_STDIO_ADMIN_TOOLS === "1") {
    warn("MONOMEM_STDIO_ADMIN_TOOLS=1 lets an agent on the stdio server use the admin tools (approve its own quarantined writes, unpin, delete). Unset it unless you want that.");
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(bindHost)) {
    warn(`MONOMEM_BIND=${bindHost} is not a loopback address: anything that can reach this machine on the network can reach the API, so it must be behind your own authenticated tunnel (INFRA.md).`);
  }
  if (/(?:^|[\\/])(?:OneDrive[^\\/]*|Dropbox[^\\/]*|iCloud Drive[^\\/]*|iCloudDrive|Google Drive[^\\/]*|GoogleDrive[^\\/]*|Mobile Documents)(?:[\\/]|$)/i.test(dataDir)) {
    warn(`data dir ${dataDir} is inside a cloud-sync folder (OneDrive, Dropbox, iCloud or Google Drive): the sync client uploads the database and token, and can corrupt a live SQLite file. See SECURITY.md; set MONOMEM_HOME to a local folder.`);
  }
}

async function doctor(): Promise<void> {
  const {
    DB_PATH,
    BIND_HOST,
    API_PORT,
    MCP_HTTP_PORT,
    resolveToken,
    DATA_DIR,
    DATA_DIR_SOURCE,
    LEGACY_DATA_DIR,
    TOKEN_FILE,
    insideNodeModules,
  } = await import("./config.js");
  const { existsSync } = await import("node:fs");
  const { resolve: resolvePath } = await import("node:path");
  const { Store } = await import("./store.js");
  // Colour only for a person at a terminal: not when piped, and not when NO_COLOR is set (no-color.org).
  // FORCE_COLOR=0 / false means off (even on a terminal); any other value forces colour on.
  const force = process.env.FORCE_COLOR;
  const colour = (force === undefined || force === "" ? process.stdout.isTTY : force !== "0" && force !== "false") && !process.env.NO_COLOR;
  const tag = (t: string, code: number) => (colour ? `\x1b[${code}m${t}\x1b[0m` : t);
  const ok = (m: string) => console.log("  " + tag("[ok]", 32) + "   " + m);
  const warn = (m: string) => console.log("  " + tag("[warn]", 33) + " " + m);
  console.log("monomem doctor\n");

  const { nodeIsOk, MIN_NODE_TEXT, sqliteHasFts5 } = await import("./setup.js");
  if (nodeIsOk(process.versions.node)) {
    ok("Node " + process.versions.node);
  } else {
    warn("Node " + process.versions.node + ` — need >= ${MIN_NODE_TEXT} (for the built-in SQLite). Node 23.x is not supported at any version: it has no FTS5.`);
  }
  // Asked, not inferred: a distro or custom build can lack FTS5 at any version,
  // and every search needs it. This is the check that cannot be wrong.
  if (sqliteHasFts5()) {
    ok("SQLite has FTS5 (search works)");
  } else {
    warn("SQLite has NO FTS5 — every search will fail with \"no such module: fts5\". Install Node 22.16+ or 24 LTS from nodejs.org.");
  }

  const why =
    DATA_DIR_SOURCE === "env"
      ? "MONOMEM_HOME"
      : DATA_DIR_SOURCE === "checkout"
        ? "git checkout with an existing ./data/state.db — kept as-is; set MONOMEM_HOME to move it"
        : "default";
  ok(`data dir ${DATA_DIR} (${why})`);
  // On Windows the token file and database get the folder's inherited permissions (chmod does nothing
  // there). Inside the user profile that means "this user only"; elsewhere (D:\, a shared folder) often not.
  // Changing ACLs automatically could break backup or indexing tools, so this says how instead of doing it.
  if (process.platform === "win32") {
    const { homedir } = await import("node:os");
    const { resolve } = await import("node:path");
    const home = resolve(homedir()).toLowerCase();
    if (!resolve(DATA_DIR).toLowerCase().startsWith(home + "\\")) {
      warn(
        `data dir is outside your user folder, so other accounts on this PC may be able to read the token and notes. ` +
          `To limit it to you: icacls "${DATA_DIR}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`
      );
    }
  }
  const { MAPPED_LEGACY_ENV } = await import("./legacy-env.js");
  if (MAPPED_LEGACY_ENV.length) {
    warn(
      `old-style setting(s) ${MAPPED_LEGACY_ENV.join(", ")} (from claude-bridge) are being read as MONOMEM_*; they still work. ` +
        "Rename them to MONOMEM_* when convenient (`monomem setup` does this for an old claude-bridge entry)."
    );
  }
  if (insideNodeModules(DB_PATH) || insideNodeModules(DATA_DIR)) {
    warn(
      "your data is inside node_modules — npm update / npx cache cleanup will delete it. " +
        "Set MONOMEM_HOME (or MONOMEM_DB_PATH) to a directory outside the package."
    );
  }
  if (
    resolvePath(LEGACY_DATA_DIR) !== resolvePath(DATA_DIR) &&
    existsSync(`${LEGACY_DATA_DIR}/state.db`) &&
    !process.env.MONOMEM_DB_PATH
  ) {
    warn(`an old 1.0.x database is still at ${LEGACY_DATA_DIR} (migrated copy is in ${DATA_DIR}); delete it when you're happy`);
  }

  let dbProblem = false;
  let distrustCount = 0;
  try {
    const s = new Store(DB_PATH);
    const r = s.list({ limit: 1 });
    const edges = s.edgeCount();
    const sample = edges === 0 && r.total >= 2 ? s.list({ limit: 60 }).notes : [];
    distrustCount = s.distrustRules().length;
    const { meterStats, meterLine } = await import("./meter.js");
    const footprint = meterLine(meterStats(s));
    s.close();
    ok(`database OK at ${DB_PATH} (${r.total} notes)`);
    ok(footprint);
    // Migration v4 adds the similarity-edge table but does not score
    // existing notes: a store upgraded from 1.0.0 has notes and no edges
    // until a one-time rebuild.
    // A new store of unrelated notes also has no edges, so warn only when two notes ARE similar enough
    // to have been linked. ponytail: looks at the 60 newest notes only; widen if old stores slip through.
    const { cosineSimilarity } = await import("./consolidate.js");
    const { EDGE_SIMILARITY_THRESHOLD } = await import("./store.js");
    const similarPair = sample.some((a, i) =>
      sample.slice(i + 1).some((b) => a.namespace === b.namespace && cosineSimilarity(`${a.title} ${a.body}`, `${b.title} ${b.body}`) >= EDGE_SIMILARITY_THRESHOLD)
    );
    if (similarPair) {
      warn(
        "notes but no similarity edges (store created before 1.1?) — run " +
          "`monomem rebuild-edges` once to link existing notes"
      );
    }
  } catch (e) {
    dbProblem = true;
    warn("database problem: " + (e as Error).message);
  }

  await doctorSecurityChecks(DATA_DIR, BIND_HOST, warn);

  // Pre-upgrade copies (`<db>.pre-v*-backup`) hold the notes as they were before an upgrade, outside
  // retention, deletes and at-rest encryption. Say that they exist, how big and how old, and how to remove them.
  for (const b of Store.preMigrationBackups(DB_PATH)) {
    const mb = (b.bytes / 1e6).toFixed(1);
    if (/\.partial(-journal|-wal|-shm)?$/.test(b.path)) {
      warn(`unfinished pre-upgrade copy ${b.path} (${mb} MB, ${b.age_days} day(s) old): a copy that was interrupted. It is safe to delete (monomem backup --prune-premigration).`);
      continue;
    }
    warn(
      `pre-upgrade copy ${b.path} (${mb} MB, ${b.age_days} day(s) old). It still holds notes you may since have deleted or encrypted. ` +
        "Keep it until you have checked the upgrade, then remove it: monomem backup --prune-premigration"
    );
  }
  try {
    const { peekSigningKey, attestKeyPath } = await import("./attest.js");
    const { dirname } = await import("node:path");
    const { statSync } = await import("node:fs");
    const kp = attestKeyPath(dirname(DB_PATH));
    if (peekSigningKey(dirname(DB_PATH))) {
      const mode = statSync(kp).mode & 0o077;
      if (process.platform !== "win32" && mode !== 0) warn(`${kp} is readable by other users (it is tightened to 0600 when the server starts)`);
      else ok(`attestation key present (${kp}); back it up with --include-attest-key if you rely on signed exports`);
    }
  } catch {
    /* no key yet */
  }

  if (distrustCount > 0) {
    // include_distrusted is an ADMIN switch, and the primary token is always admin: an agent wired with it can ask for the
    // notes the policy hides (e.g. after a hostile note talks it into it). Agents should hold a write or read token.
    try {
      const { resolveTokens } = await import("./config.js");
      const scoped = resolveTokens().filter((t) => t.scope !== "admin");
      if (scoped.length === 0) {
        warn(
          `${distrustCount} distrust rule(s) exist, but the only token is the primary one, which is always admin: an agent holding it can pass include_distrusted ` +
            "and read the hidden notes. Give agents a write or read token (MONOMEM_TOKENS / tokens.json, see docs/token-namespaces.md) and keep the primary token off them."
        );
      } else {
        ok(`${distrustCount} distrust rule(s); ${scoped.length} non-admin token(s) configured (keep the primary admin token off agents)`);
      }
    } catch {
      /* token configuration unreadable: reported below */
    }
  }
  try {
    resolveToken();
    ok(
      `bearer token present (${process.env.MONOMEM_TOKEN?.trim() ? "MONOMEM_TOKEN" : TOKEN_FILE})`
    );
  } catch (e) {
    warn("token: " + (e as Error).message);
  }

  // Server-side namespace resolution (opt-in): validate the spaces config
  // and report this directory's resolved namespace.
  const {
    loadNamespaceConfig,
    namespaceConfigSource,
    validateSpacePaths,
    resolveNamespace,
  } = await import("./namespace.js");
  const nsSource = namespaceConfigSource();
  if (nsSource) {
    const nsWhere = nsSource === "env" ? "MONOMEM_SPACES" : `${DATA_DIR}/spaces.json`;
    const nsCfg = loadNamespaceConfig();
    if (!nsCfg) {
      warn(`namespace config present (${nsWhere}) but invalid -- resolution disabled`);
    } else {
      const n = Object.keys(nsCfg.spaces).length;
      const missing = validateSpacePaths(nsCfg);
      if (missing.length === 0) {
        ok(`namespace resolution: ${n} space(s) configured, all paths exist`);
      }
      for (const p of missing) {
        warn(
          `namespace space path missing on disk: ${p} — create the directory, ` +
            `or remove the space from ${nsWhere}`
        );
      }
      try {
        const here = resolveNamespace(process.cwd(), nsCfg);
        ok(`namespace resolution: this directory -> "${here}"`);
      } catch (e) {
        warn("namespace resolution: " + (e as Error).message);
      }
    }
  }

  // Recall hook smoke test: run the real SessionStart path against this
  // database and check the payload shape. Also budget-check it: the hook
  // blocks session start, so a slow recall is worth knowing about.
  try {
    const { runRecall } = await import("./recall.js");
    const t0 = Date.now();
    const out = await runRecall({ budgetMs: 800, limit: 1, dbPath: DB_PATH });
    const elapsed = Date.now() - t0;
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { hookEventName?: string };
    };
    if (dbProblem) {
      // The hook fails silent by design, so its "success" proves nothing here.
      warn("recall hook smoke test FAILED: the database could not be opened (see the database problem above); the hook only looks healthy because it fails silent");
    } else if (parsed?.hookSpecificOutput?.hookEventName === "SessionStart") {
      ok(`recall hook smoke test passed (${elapsed}ms)`);
    } else {
      warn("recall hook returned an unexpected payload shape");
    }
    if (elapsed > 800) {
      warn(`recall hook took ${elapsed}ms — over the 800ms soft budget`);
    }
  } catch (e) {
    warn("recall hook smoke test failed: " + (e as Error).message);
  }

  // Is the hook actually wired into Claude Code? A working `recall` that
  // never fires is the common silent failure.
  try {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync } = await import("node:fs");
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      hooks?: { SessionStart?: unknown };
    };
    const entries = parsed?.hooks?.SessionStart;
    const wired =
      Array.isArray(entries) &&
      /(monomem|onememory|cli\.js)[\s\S]{0,60}\b(recall|hook session-start)\b/.test(JSON.stringify(entries));
    // The old package's hook line (`npx -y onememory-mcp@<v> recall`) still runs, but it is the old code: setup rewrites it.
    if (wired && /npx\s+(?:-y\s+)?onememory-mcp\b/.test(JSON.stringify(entries))) {
      warn("SessionStart hook is the old onememory-mcp one: old hook, run `monomem setup --hook` to update it");
    } else if (wired) {
      ok("SessionStart hook wired in ~/.claude/settings.json");
    } else {
      warn(
        "~/.claude/settings.json has no monomem SessionStart hook — " +
          "see https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md"
      );
    }
    const captureWired = /(monomem|onememory|cli\.js)[\s\S]{0,60}\bhook post-tool\b/.test(JSON.stringify(parsed?.hooks ?? {}));
    console.log(`  [info] ${captureWired ? "automatic memory hooks wired" : "automatic memory hooks not installed (monomem setup --capture)"}`);
  } catch {
    warn(
      "~/.claude/settings.json not found or unreadable — hook not installed " +
        "(see https://github.com/calasdan-sketch/monomem/blob/main/docs/sessionstart-hook.md)"
    );
  }

  // Automatic memory: when did a hook last record something, and is anything waiting in the spool?
  // Footprint: how big the data folder is, and is anything piling up (docs/footprint.md).
  try {
    const { Store } = await import("./store.js");
    const { lastCaptureAt, captureBacklog, spoolSize, captureSettings, SPOOL_MAX_BYTES } = await import("./capture.js");
    const { dirBytes, DIR_BYTES_BUDGET_MS } = await import("./uninstall.js");
    const { DATA_DIR } = await import("./config.js");
    const spool = spoolSize(DATA_DIR);
    const set = captureSettings(DATA_DIR);
    let last: string | null = null;
    let backlog = 0;
    if (!dbProblem) {
      const s = new Store(DB_PATH);
      try {
        last = lastCaptureAt(s);
        backlog = captureBacklog(s);
      } finally {
        s.close();
      }
    }
    console.log(`  [info] capture: ${set.enabled ? "on" : "off (MONOMEM_CAPTURE / capture.json)"}; last event ${last ?? "never"}; spool ${spool} bytes; ${backlog} event(s) not yet distilled`);
    if (spool >= SPOOL_MAX_BYTES) warn(`the capture spool is full (${spool} bytes): new events are dropped until a hook can open the database`);
    else if (spool > 0) warn(`${spool} bytes of captured events are waiting in the spool; the next hook that can open the database stores them`);
    if (backlog > DOCTOR_MAX_BACKLOG) {
      warn(`${backlog} captured events are waiting to be distilled (over ${DOCTOR_MAX_BACKLOG}); that happens when a session starts or ends, so a failing session hook is the likely cause`);
    }
    const size = dirBytes(DATA_DIR);
    const mb = (size.bytes / 1e6).toFixed(1);
    if (size.truncated) {
      warn(`data folder ${DATA_DIR} is at least ${mb} MB and still growing — the scan stopped after ${DIR_BYTES_BUDGET_MS}ms instead of hanging; something unrelated to monomem may be using this folder, see docs/footprint.md`);
    } else if (size.bytes > DOCTOR_MAX_DATA_BYTES) {
      warn(`data folder ${DATA_DIR} is ${mb} MB (over ${DOCTOR_MAX_DATA_BYTES / 1e9} GB); docs/footprint.md says what is in it and what is safe to remove`);
    } else {
      ok(`data folder ${DATA_DIR} is ${mb} MB`);
    }
  } catch (e) {
    warn("capture status unavailable: " + (e as Error).message);
  }

  console.log(`\n  bind ${BIND_HOST}   api :${API_PORT}   mcp :${MCP_HTTP_PORT}`);
}

async function init(): Promise<void> {
  // `monomem mcp` (the installed bin), not an absolute path into the
  // package: that path changes on every update / npx cache refresh.
  console.log("Wire monomem into your agent (local, over stdio):\n");
  console.log("Claude Code:");
  console.log("  claude mcp add monomem -- monomem mcp\n");
  console.log("Claude Desktop / Cursor / Copilot — add to the MCP config:");
  console.log(
    JSON.stringify({ mcpServers: { monomem: { command: "monomem", args: ["mcp"] } } }, null, 2)
  );
  console.log(
    "\nNot installed globally? Use npx instead: command \"npx\", args [\"-y\", \"monomem\", \"mcp\"]."
  );
  console.log("See INSTALL.md for every client, and INFRA.md to reach your phone.");
}

async function reindex(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { embeddingsEnabled, embeddingsConfig, embed, noteEmbeddingText } = await import(
    "./embeddings.js"
  );

  if (!embeddingsEnabled()) {
    console.error(
      "Embeddings are off. Set MONOMEM_EMBEDDINGS=on (and, if needed, " +
        "MONOMEM_EMBED_URL / MONOMEM_EMBED_MODEL) before reindexing."
    );
    return;
  }

  const cfg = embeddingsConfig();
  const store = new Store(DB_PATH);
  // `reindex all` recomputes every note's vector -- use it after changing the
  // embedding model or its dimension. Plain `reindex` only fills missing ones.
  const all = process.argv[3] === "all";
  const ids = all
    ? store.exportAll().map((n) => n.id) // gate-ok: local shell command (reindex): the operator owns the database file
    : store.noteIdsMissingVectors();
  console.error(
    `monomem reindex${all ? " all" : ""}: ${ids.length} note(s) to embed (model ${cfg.model}).`
  );

  let done = 0;
  let failed = 0;
  for (const id of ids) {
    const note = store.read(id); // gate-ok: local shell command (show): the operator owns the database file
    if (!note) continue;
    const vec = await embed(noteEmbeddingText(note.title, note.body), cfg);
    if (vec) {
      store.setVector(id, vec, cfg.model);
      done += 1;
    } else {
      failed += 1;
    }
  }
  store.close();
  console.error(
    `Done. Embedded ${done}, failed ${failed}. Total vectors now: see 'doctor'.`
  );
}

async function recall(): Promise<void> {
  // Claude Code SessionStart hook. FAIL-SILENT by design: always prints a
  // valid hook JSON payload and exits 0, whatever happens -- including a
  // module-load failure (broken install), which degrades to the
  // empty-context payload instead of a crash.
  const emptyHookJson =
    '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}';
  const recallMod: typeof import("./recall.js") | undefined = await import(
    "./recall.js"
  ).catch((e: Error) => {
    console.error(
      `monomem recall: failed to load recall module (${e.message}); returning empty context`
    );
    return undefined;
  });
  if (!recallMod) {
    console.log(emptyHookJson);
    process.exit(0);
  }

  const args = process.argv.slice(3);
  const flag = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(name + "="));
    if (eq) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  // A typo like --limt silently degrades the hook (the flag is ignored);
  // say so on stderr instead. Exit code stays 0 -- fail-silent by design.
  for (const a of args) {
    if (
      a.startsWith("-") &&
      !a.startsWith("--budget-ms") &&
      !a.startsWith("--limit") &&
      !a.startsWith("--db") &&
      !a.startsWith("--written-by") &&
      !a.startsWith("--not-written-by") &&
      a !== "--include-distrusted"
    ) {
      console.error(`monomem recall: unknown option "${a}" ignored`);
    }
  }
  const numFlag = (name: string, fallback: number): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      // --budget-ms 0 (or garbage) used to silently become the default.
      console.error(
        `monomem recall: ignoring invalid ${name} "${raw}" (using ${fallback})`
      );
      return fallback;
    }
    return Math.floor(n);
  };
  console.log(
    await recallMod.runRecall({
      budgetMs: numFlag("--budget-ms", 800),
      limit: numFlag("--limit", 10),
      writtenBy: flag("--written-by"),
      notWrittenBy: flag("--not-written-by"),
      includeDistrusted: args.includes("--include-distrusted"),
      ...(flag("--db") ? { dbPath: flag("--db") } : {}),
    })
  );
  process.exit(0);
}

// The capture hooks: `monomem hook <event>` with the agent's hook JSON on stdin. FAIL-OPEN by design (see hook.ts):
// prints nothing or one valid hook JSON object, and exits 0 whatever happens, including a module that fails to load.
async function hookCmd(): Promise<void> {
  const event = process.argv[3] ?? "";
  let out = "";
  try {
    const { runHook, readStdin } = await import("./hook.js");
    const args = process.argv.slice(4);
    const i = args.indexOf("--db");
    out = await runHook(event, await readStdin(), i >= 0 && args[i + 1] ? { dbPath: args[i + 1] } : {});
  } catch (e) {
    console.error(`monomem hook: ${(e as Error).message}`);
    out = event === "session-start" ? '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}' : "";
  }
  if (out) process.stdout.write(out + "\n", () => process.exit(0));
  else process.exit(0);
}

// Find near-duplicate notes and merge them. Safe by default: without --yes
// (or with --dry-run) this only reports candidates and previews merges —
// nothing is written. Pass --yes to actually merge.
async function consolidate(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const {
    findCandidatesCooperative,
    consolidateNotes,
    buildConsolidationPreview,
    groupCandidateIds,
    clampThreshold,
    thresholdWasClamped,
    THRESHOLD_MIN,
    THRESHOLD_MAX,
  } = await import("./consolidate.js");
  const { maybeEmbed } = await import("./search-service.js");

  const args = process.argv.slice(3);
  let dryRun = false;
  let yes = false;
  let namespace: string | undefined;
  let thresholdRaw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--namespace" && i + 1 < args.length) namespace = args[++i];
    else if (a.startsWith("--namespace=")) namespace = a.slice("--namespace=".length);
    else if (a === "--threshold" && i + 1 < args.length) thresholdRaw = args[++i];
    else if (a.startsWith("--threshold=")) thresholdRaw = a.slice("--threshold=".length);
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
  }
  const rawThreshold =
    thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;
  const threshold = clampThreshold(rawThreshold, 0.95);
  if (thresholdWasClamped(rawThreshold)) {
    // Don't silently rewrite user input: say what happened.
    console.error(
      `Warning: --threshold "${thresholdRaw}" is outside ${THRESHOLD_MIN}..${THRESHOLD_MAX}; using ${threshold}`
    );
  }

  const store = new Store(DB_PATH);
  try {
    const notes = store
      .exportAll({ live: true }) // gate-ok: local shell command (lint scan): the operator owns the database file
      .filter((n) => !namespace || n.namespace === namespace);
    // Cooperative scan: yields to the event loop so a large sweep doesn't
    // stall; identical results to the sync version.
    const candidates = await findCandidatesCooperative(notes, { threshold });
    if (candidates.length === 0) {
      console.log("No duplicate candidates found.");
      return;
    }
    const byId = new Map(notes.map((n) => [n.id, n]));
    console.log(
      `Found ${candidates.length} duplicate candidate pair(s) (threshold ${threshold}):`
    );
    for (const c of candidates) {
      console.log(
        `  #${c.idA} "${byId.get(c.idA)?.title}" <-> #${c.idB} "${byId.get(c.idB)?.title}" ` +
          `(score ${c.score.toFixed(3)})`
      );
    }

    // Connected components: an A-B, B-C chain merges as one group so the
    // second pair never trips over the first pair's deleted note.
    const groups = groupCandidateIds(candidates);

    if (dryRun) {
      for (const g of groups) {
        const gnotes = g.map((id) => byId.get(id)!).filter(Boolean);
        const p = buildConsolidationPreview(gnotes);
        // The preview shows the FULL merged body: approving a destructive
        // merge from title/tag-count/body-length alone is approving blind.
        console.log(
          `\nWould merge [${g.join(", ")}] -> title "${p.title}" ` +
            `(${p.tags.length} tag(s), namespace "${p.namespace}")`
        );
        console.log("--- merged body ---");
        console.log(p.body);
        console.log("--- end merged body ---");
      }
      return;
    }
    if (!yes) {
      console.log("\nRe-run with --yes to merge these, or --dry-run for a merge preview.");
      return;
    }

    await gatePinned(store, groups.flat(), "merge (it deletes the source notes)");
    let mergedCount = 0;
    for (const g of groups) {
      try {
        const merged = consolidateNotes(store, g, { deleteSources: true });
        // Make the merged note visible to semantic search (consolidateNotes
        // itself doesn't embed; store.create is embedding-agnostic).
        await maybeEmbed(store, merged);
        console.log(`Merged [${g.join(", ")}] -> #${merged.id} "${printable(merged.title)}"`);
        mergedCount += 1;
      } catch (e) {
        console.error(`Skipped [${g.join(", ")}]: ${(e as Error).message}`);
      }
    }
    console.log(`Done: ${mergedCount} merge(s).`);
  } finally {
    store.close();
  }
}

// `monomem relevant "message" [--limit 5] [--namespace ns]`: keyword
// extraction + permissive search over the local store. Prints the keywords
// used (transparency) and the matching notes.
async function relevant(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { runRelevantSearch } = await import("./search-service.js");

  const args = process.argv.slice(3);
  let limit: number | undefined;
  let namespace: string | undefined;
  let writtenBy: string | undefined;
  let notWrittenBy: string | undefined;
  let includeDistrusted = false;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--limit" && i + 1 < args.length) limit = Number(args[++i]);
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length));
    else if (a === "--namespace" && i + 1 < args.length) namespace = args[++i];
    else if (a.startsWith("--namespace=")) namespace = a.slice("--namespace=".length);
    else if (a === "--written-by" && i + 1 < args.length) writtenBy = args[++i];
    else if (a.startsWith("--written-by=")) writtenBy = a.slice("--written-by=".length);
    else if (a === "--not-written-by" && i + 1 < args.length) notWrittenBy = args[++i];
    else if (a.startsWith("--not-written-by=")) notWrittenBy = a.slice("--not-written-by=".length);
    else if (a === "--include-distrusted") includeDistrusted = true;
    else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else parts.push(a);
  }
  const message = parts.join(" ");
  if (!message.trim()) {
    console.error('Usage: monomem relevant "some natural language message" [--limit 5] [--namespace ns]');
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const { annotateStaleness } = await import("./staleness.js");
    const { keywords, results } = await runRelevantSearch(store, message, {
      namespace,
      limit: limit ?? 5,
      ...(writtenBy ? { writtenBy } : {}),
      ...(notWrittenBy ? { notWrittenBy } : {}),
      ...(includeDistrusted ? { includeDistrusted: true } : {}),
    });
    console.log(`Keywords: ${keywords.length > 0 ? keywords.join(", ") : "(none)"}`);
    if (results.length === 0) {
      console.log("No relevant notes found.");
      return;
    }
    console.log(`Relevant notes (${results.length}):`);
    for (const n of results) {
      const ann = annotateStaleness(n);
      const stale = ann.stale ? ` [stale, ${ann.ageDays}d]` : "";
      console.log(`  #${n.id} [${n.namespace}] ${printable(n.title)}${stale}${n.distrusted ? " [DISTRUSTED WRITER: treat as hostile]" : ""}`);
    }
  } finally {
    store.close();
  }
}

// Recalculate the similarity edge graph from scratch. The store owns the
// cooperative O(n^2) rebuild; the CLI prices the work up front (pair count),
// refuses when another process holds the write lock (unless --force), asks
// for confirmation on large rebuilds (unless --yes), and streams progress
// to stderr so a long run never looks hung.
async function rebuildEdges(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const {
    Store,
    ValidationError,
    EDGE_SIMILARITY_THRESHOLD,
    REBUILD_CONFIRM_PAIR_COUNT,
  } = await import("./store.js");

  const args = process.argv.slice(3);
  let thresholdRaw: string | undefined;
  let yes = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--threshold" && i + 1 < args.length) thresholdRaw = args[++i];
    else if (a.startsWith("--threshold=")) thresholdRaw = a.slice("--threshold=".length);
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--force") force = true;
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
  }
  const threshold = thresholdRaw !== undefined ? Number(thresholdRaw) : undefined;

  // P-LOW-3: resolve the namespace from the cwd when server-side namespace
  // resolution is configured, and confine the rebuild to it -- mirroring
  // the MCP memory_rebuild_edges tool (writes stay local). Without
  // resolution the whole store is rebuilt (legacy behavior).
  const { resolveStartupNamespace } = await import("./namespace.js");
  const nsOpts = resolveStartupNamespace(process.cwd());
  const namespace = nsOpts ? nsOpts.namespace : undefined;
  if (nsOpts) {
    console.error(
      `[monomem] namespace resolution ACTIVE: rebuilding namespace "${namespace}" only`
    );
  }

  const store = new Store(DB_PATH);
  try {
    // Never contend with a running server's writes: a second process
    // holding BEGIN IMMEDIATE used to starve the server (SQLITE_BUSY for
    // clients). Probe a few times to ride out transient writes; refuse if
    // the lock stays held. --force overrides for operators who know the
    // server is down.
    if (!force) {
      let busy = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (store.writeLockHeld()) {
          busy = true;
          await new Promise((r) => setTimeout(r, 250));
        } else {
          busy = false;
          break;
        }
      }
      if (busy) {
        console.error(
          "Refusing: another process holds the database write lock (is the server running?). " +
            "Re-run when it is idle, or pass --force if you are sure nothing is writing."
        );
        process.exit(1);
      }
    }

    const plan = store.rebuildPlan({ namespace });
    const notes = plan.reduce((s, g) => s + g.notes, 0);
    const pairs = plan.reduce((s, g) => s + g.pairs, 0);
    console.error(
      `Rebuilding similarity edges${namespace ? ` (namespace "${namespace}")` : ""}: ` +
        `${notes} notes, ~${pairs.toLocaleString("en-US")} pairs to score.`
    );
    if (pairs > REBUILD_CONFIRM_PAIR_COUNT && !yes) {
      if (!process.stdin.isTTY) {
        console.error(
          `Refusing: ~${pairs.toLocaleString("en-US")} pairs exceeds the ` +
            `${REBUILD_CONFIRM_PAIR_COUNT.toLocaleString("en-US")}-pair confirmation threshold ` +
            "and stdin is not interactive. Re-run with --yes to proceed non-interactively."
        );
        process.exit(1);
      }
      const ok = await askYesNo(
        `Score ~${pairs.toLocaleString("en-US")} pairs across ${notes} notes? [y/N] `
      );
      if (!ok) {
        console.error("Aborted.");
        process.exit(1);
      }
    }

    const t0 = Date.now();
    const { created, removed } = await store.rebuildEdgesCooperative({
      threshold,
      namespace,
      onProgress: (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
        process.stderr.write(
          `\rRebuilding edges: ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")} pairs (${pct}%)`
        );
      },
    });
    process.stderr.write("\n");
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `Rebuilt similarity edges (threshold ${threshold ?? EDGE_SIMILARITY_THRESHOLD}): ` +
        `${created} created, ${removed} removed ` +
        `(${pairs.toLocaleString("en-US")} pairs scored in ${secs}s).`
    );
  } catch (e) {
    // A bad threshold is a usage error, not a crash: say so and exit 1.
    if (e instanceof ValidationError) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

/** Tiny flag parser: --name value / --name=value / boolean flags. */
function parseFlags(
  args: string[],
  spec: { values: string[]; bools: string[] }
): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  // A value is never swallowed from a KNOWN following flag (`--label --any-server` is a missing value), but a value
  // that merely starts with "--" (a base64url key can) is still a value.
  const looksLikeFlag = (t: string): boolean => {
    if (!t.startsWith("--") || t.length <= 2) return false;
    const n = t.slice(2, t.indexOf("=") > 0 ? t.indexOf("=") : undefined);
    return spec.values.includes(n) || spec.bools.includes(n);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // everything after a bare -- is positional (a base64url key or a label may start with "-")
      rest.push(...args.slice(i + 1));
      break;
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    if (name && spec.values.includes(name)) {
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (i + 1 < args.length && !looksLikeFlag(args[i + 1])) flags[name] = args[++i];
      else {
        console.error(`Missing value for --${name}`);
        process.exit(1);
      }
    } else if (name && spec.bools.includes(name)) {
      flags[name] = true;
    } else if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else rest.push(a); // a base64url key id may start with a single "-"; that is a value, not an option
  }
  return { flags, rest };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

// `monomem backup [--out dir]`: hot copy via VACUUM INTO (see backup.ts).
async function backupCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { backupStore } = await import("./backup.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["out"], bools: ["include-approval-key", "include-attest-key", "prune-premigration"] });
  if (flags["prune-premigration"] === true) {
    // Remove the copies the upgrade made (`<db>.pre-v*-backup`): they hold the notes as they were before
    // the upgrade, including any deleted or forgotten since, and are outside encryption and retention.
    const { unlinkSync } = await import("node:fs");
    const found = Store.preMigrationBackups(DB_PATH);
    if (found.length === 0) {
      console.log("No pre-upgrade copies found next to the database.");
      return;
    }
    for (const f of found) {
      unlinkSync(f.path);
      console.log(`Removed ${f.path} (${f.bytes} bytes, ${f.age_days} day(s) old).`);
    }
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  // Default in the home folder, never the current one: run inside a repo, a backup (notes + key) there could get committed.
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const out = str(flags.out) ?? join(homedir(), `monomem-backup-${stamp}`);
  const store = new Store(DB_PATH);
  try {
    const r = backupStore(store, DB_PATH, out, {
      includeApprovalKey: flags["include-approval-key"] === true,
      includeAttestKey: flags["include-attest-key"] === true,
    });
    console.log(`Backed up ${r.notes} note(s) (${r.bytes} bytes) to ${r.db}`);
    console.log(
      r.approvalKey
        ? "Included the command-task approval key (--include-approval-key): guard this backup like the encryption key."
        : "The command-task approval key was NOT copied: after a restore, existing approvals read as stale (fail closed) and an admin re-approves queued command tasks."
    );
    if (r.attestKey) {
      console.log(`Included the attestation signing key (--include-attest-key): guard this backup like the encryption key.`);
    } else if (r.attestKeyLeftOut) {
      console.log(
        "The attestation signing key (.attest-key) was NOT copied: a restore keeps the server_id but creates a NEW signing key, so peers that\n" +
          "trusted the old one must be told the new key. Use --include-attest-key to keep the identity."
      );
    }
    if (r.key) {
      console.log(`Copied the encryption key to ${r.key} (mode 0600).`);
      console.log(
        "WARNING: this backup is only readable with that key, and anyone holding both can read everything.\n" +
          "         Move the key out of this folder and store it separately (password manager / another drive)."
      );
    }
  } catch (e) {
    console.error(`Backup failed: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    store.close();
  }
}

// `monomem runner-status [--namespace ns] [--json]`
async function runnerStatusCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { runnerStatus, ago } = await import("./liveness.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["namespace"], bools: ["json"] });
  const store = new Store(DB_PATH);
  try {
    const ns = str(flags.namespace);
    const st = runnerStatus(store, ns ? [ns] : undefined);
    if (flags.json) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    const r = st.runner;
    console.log(
      r.state === "never_seen"
        ? "Runner: no heartbeat seen"
        : `Runner: ${r.state} (last heartbeat ${ago(r.age_seconds ?? 0)} ago; counted offline after ${ago(r.stale_after_seconds)})`
    );
    const more = st.truncated ? "at least " : "";
    console.log(`Commands waiting: ${more}${st.waiting_total} (${st.expiring_soon_total} expiring within 1 h), expired approvals: ${more}${st.expired_total}`);
    for (const t of st.targets) {
      console.log(
        `  runner "${t.target}": ${t.state}` +
          (t.age_seconds !== null ? ` (last heartbeat ${ago(t.age_seconds)} ago)` : "") +
          `, waiting ${t.waiting}, expiring soon ${t.expiring_soon}, expired ${t.expired}` +
          (t.oldest_waiting_seconds !== null ? `, oldest waited ${ago(t.oldest_waiting_seconds)} (task #${t.oldest_waiting_task_id})` : "")
      );
    }
    for (const n of st.namespaces) {
      console.log(
        `  [${n.namespace}] waiting ${n.waiting}, expiring soon ${n.expiring_soon}, expired ${n.expired}` +
          (n.oldest_waiting_seconds !== null ? `, oldest waited ${ago(n.oldest_waiting_seconds)} (task #${n.oldest_waiting_task_id})` : "")
      );
    }
    if (st.notice) console.log(st.notice);
  } finally {
    store.close();
  }
}

// `monomem watch [--consumer c] [--wait 25] [--namespace ns] [--exec prog args...]`
async function watchCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { watchLoop } = await import("./watch.js");
  const argv = process.argv.slice(3);
  // Everything after --exec is the program and its arguments, verbatim.
  const at = argv.indexOf("--exec");
  const exec = at >= 0 ? argv.slice(at + 1) : undefined;
  if (at >= 0 && (!exec || exec.length === 0)) {
    console.error("--exec needs a program, e.g. --exec notify-send Monomem");
    process.exit(1);
  }
  const { flags } = parseFlags(at >= 0 ? argv.slice(0, at) : argv, { values: ["consumer", "wait", "namespace", "written-by", "not-written-by"], bools: ["include-distrusted"] });
  const wait = str(flags.wait) !== undefined ? Number(flags.wait) : 25;
  if (!Number.isInteger(wait) || wait < 1 || wait > 55) {
    console.error("--wait must be a whole number of seconds from 1 to 55 (25 recommended)");
    process.exit(1);
  }
  const abort = new AbortController();
  // First signal: stop cleanly (kill the running handler, finish). A second one exits at once.
  const onSignal = (sig: NodeJS.Signals): void => {
    if (abort.signal.aborted) process.exit(sig === "SIGINT" ? 130 : 143);
    abort.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  const store = new Store(DB_PATH);
  try {
    console.error(`watching as "${str(flags.consumer) ?? "watch"}" (Ctrl+C to stop)`);
    await watchLoop(store, {
      consumer: str(flags.consumer) ?? "watch",
      waitSeconds: wait,
      namespaces: str(flags.namespace) ? [str(flags.namespace)!] : undefined,
      filter: {
        ...(str(flags["written-by"]) ? { writtenBy: str(flags["written-by"])! } : {}),
        ...(str(flags["not-written-by"]) ? { notWrittenBy: str(flags["not-written-by"])! } : {}),
        ...(flags["include-distrusted"] ? { includeDistrusted: true } : {}),
      },
      exec,
      signal: abort.signal,
    });
  } finally {
    store.close();
  }
}

// `monomem never-show <id> [--undo]`: keep a note out of the session-start context for good (it stays searchable).
async function neverShowCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { setNeverShow } = await import("./context-inject.js");
  const args = process.argv.slice(3);
  const id = Number(args.find((a) => !a.startsWith("-")));
  if (!Number.isInteger(id) || id < 1) {
    console.error("usage: monomem never-show <note id> [--undo]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const n = setNeverShow(store, id, !args.includes("--undo"));
    if (!n) {
      console.error(`no note with id ${id}`);
      process.exit(1);
    }
    console.log(args.includes("--undo") ? `#${id} can be shown at session start again` : `#${id} will not be shown at session start again (undo: monomem never-show ${id} --undo)`);
  } finally {
    store.close();
  }
}

// `monomem changes`: the change feed over the local store (full local
// trust, like every CLI command). Prints every page.
async function changes(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { runChanges } = await import("./changes.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["since", "consumer", "namespace", "source", "limit", "written-by", "not-written-by", "note-written-by", "not-note-written-by"],
    bools: ["json", "purge", "include-distrusted"],
  });
  const store = new Store(DB_PATH);
  try {
    if (flags.purge) {
      const n = store.purgeChangeLogAll();
      console.log(`Purged ${n} change-log row(s) and every "last" marker.`);
      return;
    }
    const base = {
      namespaces: str(flags.namespace) ? [str(flags.namespace)!] : undefined,
      source: str(flags.source),
      limit: str(flags.limit) ? Number(flags.limit) : undefined,
      ...(str(flags["written-by"]) ? { writtenBy: str(flags["written-by"])! } : {}),
      ...(str(flags["not-written-by"]) ? { notWrittenBy: str(flags["not-written-by"])! } : {}),
      ...(str(flags["note-written-by"]) ? { noteWrittenBy: str(flags["note-written-by"])! } : {}),
      ...(str(flags["not-note-written-by"]) ? { notNoteWrittenBy: str(flags["not-note-written-by"])! } : {}),
      ...(flags["include-distrusted"] ? { includeDistrusted: true } : {}),
    };
    let page = runChanges(store, {
      ...base,
      since: str(flags.since) ?? "24h",
      consumer: str(flags.consumer),
    });
    if (flags.json) {
      const all = [...page.changes];
      while (page.nextCursor) {
        page = runChanges(store, { ...base, cursor: page.nextCursor });
        all.push(...page.changes);
      }
      console.log(JSON.stringify({ ...page, changes: all, nextCursor: null }, null, 2));
      return;
    }
    const c = page.counts;
    console.log(
      `Changes ${page.since} -> ${page.until}: ${c.created} created, ${c.updated} updated, ${c.deleted} deleted` +
        (page.quarantined ? `, ${page.quarantined} quarantined` : "")
    );
    for (const [src, n] of Object.entries(page.bySource)) {
      console.log(`  ${src || "(no source)"}: +${n.created} ~${n.updated} -${n.deleted}`);
    }
    for (;;) {
      for (const e of page.changes) {
        const mark = e.kind === "created" ? "+" : e.kind === "updated" ? "~" : "-";
        console.log(`${mark} #${e.id} [${e.namespace}] ${printable(e.title)}  (${e.at}${e.source ? `, ${printable(e.source)}` : ""})${e.distrusted ? " [DISTRUSTED WRITER]" : ""}`);
      }
      if (!page.nextCursor) break;
      page = runChanges(store, { ...base, cursor: page.nextCursor });
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem export --format md --dir <path>` / `--format json [--out f]`.
async function exportCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["format", "dir", "namespace", "out"],
    // --no-attest is accepted and does nothing: attestations are opt-in (--attest) since 1.4.1.
    bools: ["no-prune", "force", "attest", "no-attest", "include-distrusted", "no-history"],
  });
  const format = str(flags.format) ?? (str(flags.dir) ? "md" : undefined);
  const { EXPORT_PAGE_SIZE } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    if (format === "json") {
      const ns = str(flags.namespace);
      // STREAMED export: the old path called exportAll() then JSON.stringify
      // on the whole array, holding every row + record + the finished string
      // in memory at once (~3x the backup). With months of notes that spikes
      // hard on a small box. exportBatch pages by primary key so peak memory
      // is one page. The output is still valid {"notes":[...]} JSON, only
      // pretty-printed with one note per line so diffs stay readable.
      const { createWriteStream, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const { chmodQuiet } = await import("./config.js");

      const outPath = str(flags.out);
      let out: NodeJS.WritableStream;
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        out = createWriteStream(outPath, { mode: 0o600 });
      } else {
        out = process.stdout;
      }
      const write = (s: string): Promise<void> =>
        out.write(s) ? Promise.resolve() : new Promise((r) => out.once("drain", r));

      // Attestations are OPT-IN (--attest): without it the file is byte-compatible with
      // every release before 1.4.0, `{"notes": [...]}`. With it, an `export` header
      // (this server and its public key) and a signed attestation per note (see
      // attest.ts). If the signing key cannot be created the backup is still
      // written, without them: a backup must not fail over a signature.
      let attest = flags.attest === true;
      let header = "";
      if (attest) {
        try {
          header = `  "export": ${JSON.stringify(store.exportHeader())},\n`;
        } catch (e) {
          attest = false;
          console.error(`Exporting without attestations: ${(e as Error).message}`);
        }
      }
      await write(`{\n${header}  "notes": [\n`);
      let afterId = 0;
      let first = true;
      let count = 0;
      for (;;) {
        const page = store.exportBatch(afterId, EXPORT_PAGE_SIZE, { attest, history: flags["no-history"] !== true }); // gate-ok: local shell command (export): the operator owns the database file
        if (page.length === 0) break;
        afterId = page[page.length - 1].id;
        for (const note of page) {
          if (ns && note.namespace !== ns) continue;
          await write((first ? "" : ",\n") + "    " + JSON.stringify(note));
          first = false;
          count++;
        }
        if (page.length < EXPORT_PAGE_SIZE) break;
      }
      await write("\n  ]\n}\n");
      if (outPath && "end" in out) {
        await new Promise<void>((resolve, reject) => {
          out.end(() => resolve());
          out.on("error", reject);
        });
        chmodQuiet(outPath, 0o600); // mode only applies on create
        console.error(`Exported ${count} note(s) to ${outPath}`);
      }
      return;
    }
    if (format !== "md" || !str(flags.dir)) {
      console.error("Usage: monomem export --format md --dir <path> [--namespace ns] [--no-prune] [--force] [--include-distrusted]");
      console.error("       monomem export --format json [--out file] [--attest]");
      process.exit(1);
    }
    const { exportMarkdown } = await import("./sync.js");
    const r = exportMarkdown(store, str(flags.dir)!, {
      namespace: str(flags.namespace),
      prune: !flags["no-prune"],
      force: flags.force === true,
      includeDistrusted: flags["include-distrusted"] === true,
    });
    console.log(
      `Exported ${r.notes} note(s) to ${r.dir}: ${r.written} written, ${r.unchanged} unchanged, ${r.removed} removed.`
    );
    for (const s of r.skipped ?? []) console.error(`skipped     ${s.file} — ${s.detail}`);
    if (r.skipped?.length) {
      console.error(
        `${r.skipped.length} file(s) were edited outside Monomem since the last sync and were NOT overwritten. ` +
          "Run `monomem import` first, or re-run export with --force (the edited files are saved to .conflicts/)."
      );
    }
  } finally {
    store.close();
  }
}

// `monomem import --dir <path> [--dry-run]`: merge Markdown files back.
async function importCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { importMarkdown } = await import("./sync.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["dir", "file", "project", "namespace", "from", "path"],
    bools: ["dry-run", "json", "allow-move", "dedupe", "no-dedupe", "require-attestation", "claude", "yes", "update", "include-index"],
  });
  if (str(flags.from)) {
    const { runForeignImport, FOREIGN_SOURCES } = await import("./foreign-import.js");
    const from = str(flags.from) as (typeof FOREIGN_SOURCES)[number];
    if (!FOREIGN_SOURCES.includes(from)) {
      console.error(`Usage: monomem import --from ${FOREIGN_SOURCES.join("|")} [--path p] [--dry-run] [--yes] [--namespace ns]`);
      process.exit(1);
    }
    const { realEnv } = await import("./setup.js");
    const { PACKAGE_VERSION } = await import("./config.js");
    process.exitCode = await runForeignImport(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url)), terminalIO(), {
      from,
      path: str(flags.path),
      dryRun: flags["dry-run"] === true,
      yes: flags.yes === true,
      namespace: str(flags.namespace),
      dbPath: DB_PATH,
    });
    return;
  }
  if (flags.claude === true) {
    const { runClaudeImport } = await import("./claude-import.js");
    const { realEnv } = await import("./setup.js");
    const { PACKAGE_VERSION } = await import("./config.js");
    const e = realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url));
    process.exitCode = await runClaudeImport(e, terminalIO(), {
      dryRun: flags["dry-run"] === true,
      yes: flags.yes === true,
      update: flags.update === true,
      projects: (str(flags.project) ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      namespace: str(flags.namespace),
      includeIndex: flags["include-index"] === true,
      dbPath: DB_PATH,
    });
    return;
  }
  if (str(flags.file)) {
    // Duplicate protection is ON unless --no-dedupe. It used to be `flags["dedupe"] === true`,
    // which passed an explicit `dedupe: false` whenever the flag was absent and so beat the
    // store default -- `monomem import` twice still doubled every note.
    await importJsonFile(str(flags.file)!, flags["no-dedupe"] !== true, flags.json === true, flags["require-attestation"] === true);
    return;
  }
  if (!str(flags.dir)) {
    console.error("Usage: monomem import --dir <path> [--dry-run] [--allow-move]");
    console.error("       monomem import --file backup.json [--no-dedupe] [--json] [--require-attestation]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const r = await importMarkdown(store, str(flags.dir)!, { dryRun: flags["dry-run"] === true, allowMove: flags["allow-move"] === true });
    if (r.counts.rejected > 0) process.exitCode = 1;
    if (flags.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    for (const e of r.entries) {
      if (e.action === "unchanged") continue;
      console.log(`${e.action.padEnd(11)} ${e.file}${e.id ? ` (#${e.id})` : ""}${e.detail ? ` — ${e.detail}` : ""}`);
    }
    const c = r.counts;
    console.log(
      `${flags["dry-run"] ? "[dry run] " : ""}Imported from ${r.dir}: ${c.created} created, ${c.updated} updated, ` +
        `${c.restored} restored, ${c.unchanged} unchanged, ${c.skipped} skipped, ${c.conflict} conflict(s), ` +
        `${c.quarantined} quarantined, ${c.rejected} rejected.`
    );
    if (c.rejected > 0) {
      console.error(
        `\n!!! ${c.rejected} FILE(S) WERE REJECTED AND NOT IMPORTED (see the "rejected" lines above). ` +
          `Nothing was dropped silently; fix those files and import again. Exit status 1.`
      );
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem import --file backup.json`: restore a JSON backup (the shape of
// `export --format json` / GET /export). Attestations in it are checked
// against the trusted attesters; see docs/trust.md.
async function importJsonFile(file: string, dedupe: boolean, json: boolean, requireAttestation = false): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError, attestationsToShow } = await import("./store.js");
  const { printable } = await import("./security.js");
  const { streamBackupNotes, StreamJsonError, checkBackupNote } = await import("./stream-json.js");
  const { statSync } = await import("node:fs");
  try {
    statSync(file);
  } catch (e) {
    console.error(`Cannot read ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  // PASS 1, before anything is written (or the database is even opened): stream the WHOLE file and check its structure and
  // the shape of every note (valid JSON to the end, depth, element size, text fields, tag lists). A truncated, corrupt or
  // hostile file therefore imports NOTHING, and says so. Memory stays flat: one note at a time.
  let elements = 0;
  let notObjects = 0;
  const scalarStats = { scalars: 0 };
  try {
    for await (const note of streamBackupNotes(file, scalarStats)) {
      const bad = checkBackupNote(note);
      if (bad === "skip") {
        notObjects++;
        continue;
      }
      elements++;
      if (bad) throw new StreamJsonError(`note #${elements}: ${bad}`);
    }
  } catch (e) {
    if (e instanceof StreamJsonError) {
      console.error(`Cannot import ${file}: ${e.message}. Nothing was imported: the whole file is checked before anything is written.`);
      process.exit(1);
    }
    throw e;
  }
  notObjects += scalarStats.scalars;
  const store = new Store(DB_PATH);
  // The file is STREAMED: notes are read, parsed and written IMPORT_FILE_BATCH at a time, so memory stays flat
  // however big the backup is (both shapes: {"notes":[...]} with or without the `export` header, and a bare [...]).
  const IMPORT_FILE_BATCH = 500;
  const total: import("./store.js").ImportReport = { quarantined: [], rejected: [] };
  const att = { verified: 0, unverified: 0, reasons: {} as Record<string, number>, untrusted_keys: new Map<string, { key_id: string; server_id: string; notes: number }>() };
  let imported = 0;
  let skipped = 0;
  let batch: import("./store.js").ImportNote[] = [];
  let batchWeight = 0;
  let handled = 0; // elements that went through importNotes (imported, skipped or rejected)
  // A batch is also bounded by size, not only by count: 500 notes of several MB each would otherwise sit in memory at once.
  const IMPORT_FILE_BATCH_CHARS = 32_000_000;
  const weigh = (n: import("./store.js").ImportNote): number =>
    (typeof n.title === "string" ? n.title.length : 0) + (typeof n.body === "string" ? n.body.length : 0) + (Array.isArray(n.tags) ? n.tags.reduce((a, t) => a + String(t).length + 4, 0) : 0) + 400;
  let batches = 0;
  let deferred = false;
  const flush = async (last: boolean): Promise<void> => {
    if (batch.length === 0) return;
    // A restore that fits in one batch links its notes inline (the graph is complete at once); a bigger one defers the
    // O(n^2) similarity linking, like the HTTP import does, and tells the operator to run `rebuild-edges`.
    const defer = !(last && batches === 0);
    if (defer) deferred = true;
    const report: import("./store.js").ImportReport = { quarantined: [], rejected: [] };
    const created = await store.importNotes(batch, { report, dedupe, deferEdges: defer, ...(requireAttestation ? { requireAttestation: true } : {}) });
    batches++;
    handled += batch.length;
    batch = [];
    batchWeight = 0;
    imported += created.length;
    skipped += report.skipped ?? 0;
    total.quarantined.push(...report.quarantined);
    total.rejected.push(...report.rejected);
    const a = report.attestations;
    if (a) {
      att.verified += a.verified;
      att.unverified += a.unverified;
      for (const [k, v] of Object.entries(a.reasons)) att.reasons[k] = (att.reasons[k] ?? 0) + v;
      for (const u of a.untrusted_keys) {
        const k = `${u.key_id}|${u.server_id}`;
        const seen = att.untrusted_keys.get(k);
        if (seen) seen.notes += u.notes;
        else att.untrusted_keys.set(k, { ...u });
      }
    }
  };
  try {
    try {
      for await (const note of streamBackupNotes(file)) {
        if (checkBackupNote(note) === "skip") continue;
        batch.push(note as import("./store.js").ImportNote);
        batchWeight += weigh(note as import("./store.js").ImportNote);
        if (batch.length >= IMPORT_FILE_BATCH || batchWeight >= IMPORT_FILE_BATCH_CHARS) await flush(false);
      }
      await flush(true);
    } catch (e) {
      // The file passed the whole-file check, so this is a fault while writing (the disk, a lock) or a file that changed
      // since. Batches written earlier stay written: say exactly how far it got and how to continue safely.
      const msg = e instanceof Error ? e.message : String(e);
      const left = Math.max(0, elements - handled);
      console.error(
        `Import stopped: ${msg}\n` +
          `${imported} note(s) were imported before the error, ${left} were not. ` +
          (imported + (skipped || 0) > 0 || handled > 0
            ? "Nothing is rolled back. Fix the cause and run the SAME command again: notes already imported are skipped (recognised by title, body and created_at, which every export carries) rather than duplicated."
            : "Nothing was written.") +
          (deferred ? " Run `monomem rebuild-edges` afterwards." : "")
      );
      process.exit(1);
    }
    total.attestations = { verified: att.verified, unverified: att.unverified, reasons: att.reasons, untrusted_keys: [...att.untrusted_keys.values()] };
    if (skipped) total.skipped = skipped;
    if (json) {
      console.log(JSON.stringify({ imported, ...total, ...(notObjects ? { ignored_entries: notObjects } : {}), attestations: attestationsToShow(total.attestations) }, null, 2));
      return;
    }
    console.log(`Imported ${imported} note(s)${total.skipped ? `, skipped ${total.skipped} already present` : ""}.`);
    if (notObjects) console.log(`${notObjects} entr${notObjects === 1 ? "y" : "ies"} in the file ${notObjects === 1 ? "was" : "were"} not a note (not an object) and ${notObjects === 1 ? "was" : "were"} ignored.`);
    const a = attestationsToShow(total.attestations);
    if (a) {
      console.log(`Attestations: ${a.verified} verified, ${a.unverified} unverified (stamped as imported by this command, flagged imported_unverified).`);
      for (const [why, n] of Object.entries(a.reasons)) console.log(`  ${n} x ${printable(why)}`);
      for (const k of a.untrusted_keys) {
        // key_id / server_id come from the file: shown quoted and stripped of control characters, never as part of a command to paste.
        console.log(`  key ${printable(k.key_id)} (server ${printable(k.server_id)}) signed ${k.notes} note(s) but is not trusted. To trust it you must get its public key from that server's admin (monomem trust identity there).`);
      }
    }
    if (deferred) console.log("The similarity graph was not rebuilt for this large import: run `monomem rebuild-edges` when convenient.");
    if (total.quarantined.length) console.log(`${total.quarantined.length} note(s) held by the linter (monomem quarantine).`);
    if (total.rejected.length) {
      console.error(`${total.rejected.length} note(s) rejected:`);
      for (const r of total.rejected.slice(0, 200)) console.error(`  ${printable(r.title)}: ${printable(r.error)}`);
      if (total.rejected.length > 200) console.error(`  ... and ${total.rejected.length - 200} more (use --json for the full list)`);
      process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

function trustHelp(): void {
  console.log(
    [
      "monomem trust: whom this store does not believe.",
      "",
      "  trust [list] [--json]                    the distrust list, trusted attesters, recent changes, this server's id",
      "  trust identity [--json]                  this server's id and public key (creates the signing key if needed)",
      "  trust distrust <writer> --namespace <ns|'*'>     leave a writer's notes out of every read and never run them",
      "  trust undistrust <writer> --namespace <ns|'*'>",
      "        <writer> is a token label, or a writer id <server_id>/<label>. Quote the star: --namespace '*'.",
      "  trust attester-add <public-key> --server-id <id> [--label text] [--not-after <ISO time>] [--any-server]",
      "        Believe signed exports from that server. A key is trusted for ONE server (--server-id);",
      "        --any-server accepts a key for any server id (discouraged). --not-after ends trust in the key",
      "        at that time: afterwards it is believed for nothing, old exports too (re-import first, or keep the key without it). A key starting with '-': --public-key <key>.",
      "  trust attester-remove <key-id>",
      "  trust attester-revoke <key-id> [--reason text]   stop believing anything signed by that key, whatever date it claims",
      "        (not_after only EXPIRES trust; a leaked key needs revoking). trust attester-unrevoke <key-id> undoes it.",
      "  trust export-key --out <file>            copy this server's signing key (mode 0600) to move its identity",
      "  trust rotate [--keep-old-private]        make a new signing key. The old PUBLIC key is recorded so this server still",
      "        recognises its earlier exports; the old private key is deleted unless --keep-old-private.",
      "        Running servers switch to the new key at their next signed export, no restart needed.",
      "",
      "Attestations (signed exports), cross-server writer ids, `rotate` and `--any-server` are EXPERIMENTAL in 1.4.x:",
      "their wire format and commands may change. See docs/trust.md.",
    ].join("\n")
  );
}

// `monomem trust ...`: the trust policy (docs/trust.md). Local, like every CLI command.
async function trustCmd(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.some((a) => a === "--help" || a === "-h") || args[0] === "help") {
    trustHelp();
    return;
  }
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { flags, rest } = parseFlags(args, {
    values: ["namespace", "server-id", "label", "public-key", "writer", "key-id", "not-after", "out", "reason"],
    bools: ["json", "any-server", "keep-old-private"],
  });
  const action = rest[0] ?? "list";
  const known = ["list", "identity", "distrust", "undistrust", "attester-add", "attester-remove", "attester-revoke", "attester-unrevoke", "export-key", "rotate"];
  if (!known.includes(action)) {
    console.error(`Unknown trust action: ${action}\n`);
    trustHelp();
    process.exit(1);
  }
  const maxRest = action === "list" || action === "identity" || action === "rotate" || action === "export-key" ? 1 : 2;
  if (rest.length > maxRest) {
    console.error(
      `Unexpected extra argument(s): ${rest.slice(maxRest).map((x) => JSON.stringify(x.slice(0, 40))).join(" ")}. ` +
        "If you typed --namespace * the shell expanded the star into file names: write --namespace '*'."
    );
    process.exit(1);
  }
  const nsFlag = str(flags.namespace);
  if (nsFlag && nsFlag !== "*") {
    const { existsSync } = await import("node:fs");
    if (existsSync(nsFlag)) {
      console.error(`Note: "${nsFlag}" is also a file or folder in this directory. If you meant every namespace, quote the star: --namespace '*'.`);
    }
  }
  const store = new Store(DB_PATH);
  const show = (v: unknown, text: string): void => console.log(flags.json ? JSON.stringify(v, null, 2) : text);
  try {
    switch (action) {
      case "list": {
        // Read-only: never creates the signing key.
        const identity = store.peekIdentity();
        const view = store.trustView();
        const out = { ...identity, distrust: view.distrust, attesters: view.attesters, revoked: view.revoked, log: view.log };
        if (flags.json) {
          console.log(JSON.stringify(out, null, 2));
          return;
        }
        console.log(`This server: ${identity.server_id}${identity.key_id ? ` (signing key ${identity.key_id})` : " (no signing key yet: `monomem trust identity` creates it)"}`);
        console.log(`Distrusted writers (${out.distrust.length}):`);
        for (const r of out.distrust) console.log(`  [${r.namespace}] ${r.writer}  (added ${r.added_at} by ${r.added_by})`);
        console.log(`Trusted attesters (${out.attesters.length}):`);
        for (const a of out.attesters) {
          console.log(
            `  ${a.key_id} server=${a.server_id || "(ANY - unpinned)"} ${a.label ? `"${a.label}" ` : ""}${a.not_after ? `not_after=${a.not_after} ` : ""}[${a.source}]`
          );
        }
        if (out.revoked.length) {
          console.log(`Revoked keys (${out.revoked.length}):`);
          for (const r of out.revoked) console.log(`  ${r.key_id}  (revoked ${r.at} by ${r.by}${r.reason ? `: ${r.reason}` : ""})`);
        }
        if (out.log.length) {
          console.log("Recent changes:");
          for (const l of out.log) console.log(`  ${l.at} ${l.actor} ${l.action} [${l.namespace}] ${l.subject}`);
        }
        return;
      }
      case "export-key": {
        const out = str(flags.out);
        if (!out) {
          console.error("Usage: monomem trust export-key --out <file>");
          process.exit(1);
        }
        const r = store.exportSigningKey(out!);
        show(r, `Copied signing key ${r.key_id} to ${r.path} (${process.platform === "win32" ? "Windows: file modes do not apply, so protect the folder's permissions" : "mode 0600"}). Guard it: whoever holds it can sign as this server. Do not run two live servers with the same key.`);
        return;
      }
      case "rotate": {
        const r = store.rotateSigningKey({ keepOldPrivate: flags["keep-old-private"] === true });
        show(
          r,
          `New signing key ${r.new_key_id}${r.old_key_id ? ` (replaces ${r.old_key_id})` : ""}.\n` +
            (r.old_key_id
              ? `The old PUBLIC key is recorded as a retired key of this server, so exports it signed still verify here. ` +
                (r.old_key_file ? `The old private key was kept as ${r.old_key_file} (guard it or delete it).` : "The old private key was deleted.") +
                "\nIf the old key LEAKED, also run: monomem trust attester-revoke " + r.old_key_id + " (and tell your peers to do the same).\n"
              : "") +
            "Running servers and MCP processes pick up the new key at their next signed export; no restart is needed.\n" +
            `Give the new public key to the peers that verify this server's exports:\n  monomem trust attester-add --public-key ${r.public_key} --server-id ${store.serverId()}\n` +
            (r.old_key_id ? "A peer keeps believing the old key until it removes it (attester-remove) or revokes it (attester-revoke); not_after only expires trust." : "")
        );
        return;
      }
      case "identity": {
        const i = store.identity();
        show(i, `server_id:  ${i.server_id}\nkey_id:     ${i.key_id}\npublic_key: ${i.public_key}\n\nGive the public_key (and server_id) to the admin of the server that should believe this server's exports:\n  monomem trust attester-add --public-key ${i.public_key} --server-id ${i.server_id} --label "<name>"`);
        return;
      }
      case "distrust":
      case "undistrust": {
        const writer = str(flags.writer) ?? rest[1];
        if (!writer) {
          console.error(`Usage: monomem trust ${action} <writer> --namespace <ns|*>   (writer: a token label or <server_id>/<label>; --writer <w> or -- <w> if it starts with "-")`);
          process.exit(1);
        }
        const ns = str(flags.namespace);
        if (!ns) {
          console.error('--namespace is required (use --namespace "*" for every namespace)');
          process.exit(1);
        }
        if (action === "distrust") {
          const r = store.distrustAdd(ns!, writer);
          const matched = store.distrustMatchCount(r.namespace, r.writer);
          show(
            { ...r, matched_notes: matched },
            `Distrusting "${r.writer}" in [${r.namespace}]: its notes are now left out of every read and never run (${matched} existing note(s) match` +
              `${matched === 0 ? " - none yet: check the spelling against the written_by of a note (`monomem recall --include-distrusted`): labels are exact and case-sensitive" : ""}).`
          );
        } else {
          await requireOperator(`trust undistrust ${writer} [${ns}]`);
          const removed = store.distrustRemove(ns!, writer);
          show({ removed }, removed ? `No longer distrusting "${writer}" in [${ns}].` : `"${writer}" was not on the list for [${ns}].`);
        }
        return;
      }
      case "attester-add": {
        const key = str(flags["public-key"]) ?? rest[1];
        if (!key) {
          console.error("Usage: monomem trust attester-add <public-key> --server-id <id> [--label <text>] [--not-after <ISO time>] [--any-server]   (a key starting with \"-\": --public-key <key>)");
          process.exit(1);
        }
        await requireOperator("trust attester-add");
        const r = store.attesterAdd({
          public_key: key,
          server_id: str(flags["server-id"]),
          label: str(flags.label),
          any_server: flags["any-server"] === true,
          not_after: str(flags["not-after"]),
        });
        show(
          r,
          `Trusting key ${r.key_id}${r.server_id ? ` for server ${r.server_id}` : " for ANY server id (the key's holder can claim to be any peer)"}` +
            `${r.not_after ? `, until ${r.not_after} (afterwards for nothing, old exports included)` : ""}.` +
            (r.replaced ? ` (This replaced an earlier entry: pin ${r.replaced.server_id || "any"}, not_after ${r.replaced.not_after || "none"}.)` : "")
        );
        return;
      }
      case "attester-remove": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-remove <key-id>");
          process.exit(1);
        }
        const removed = store.attesterRemove(id);
        show({ removed }, removed ? `Removed key ${id}.` : `Key ${id} was not on the list (a key set in MONOMEM_TRUSTED_ATTESTERS is removed there).`);
        return;
      }
      case "attester-revoke": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-revoke <key-id> [--reason <text>]");
          process.exit(1);
        }
        const r = store.attesterRevoke(id, str(flags.reason) ?? "");
        show(r, r.already ? `Key ${r.key_id} was already revoked.` : `Revoked key ${r.key_id}: nothing signed by it is believed any more, whatever date the signature claims.`);
        return;
      }
      case "attester-unrevoke": {
        const id = str(flags["key-id"]) ?? rest[1];
        if (!id) {
          console.error("Usage: monomem trust attester-unrevoke <key-id>");
          process.exit(1);
        }
        await requireOperator(`trust attester-unrevoke ${id}`);
        const removed = store.attesterUnrevoke(id);
        show({ removed }, removed ? `Key ${id} is no longer revoked (add it with attester-add if you want to trust it).` : `Key ${id} was not on the revocation list.`);
        return;
      }
      default:
        console.error(`Unknown trust action: ${action}`);
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem token add --label <name> --scope read|write|admin [--namespace ns] | list | remove <label>`: edits tokens.json.
// `add` hands out access, so it needs the operator gate; `list` and `remove` lower nothing.
async function tokenCmd(): Promise<void> {
  const { DATA_DIR } = await import("./config.js");
  const { addToken, listTokens, removeToken, envTokenLabels, TokenFileError, tokensPath } = await import("./token-file.js");
  const { flags, rest } = parseFlags(process.argv.slice(3), { values: ["label", "scope", "namespace"], bools: [] });
  const action = rest[0];
  try {
    if (action === "add") {
      const label = str(flags.label);
      const scope = str(flags.scope);
      if (!label || !scope) throw new TokenFileError("Usage: monomem token add --label <name> --scope read|write|admin [--namespace ns]");
      await requireOperator(`token add (${scope} token "${label}")`);
      const row = addToken(DATA_DIR, label, scope, str(flags.namespace));
      console.log(`Added token "${row.label}" (${row.scope}${row.namespace ? `, pinned to namespace "${row.namespace}"` : ""}) to ${tokensPath(DATA_DIR)}.`);
      console.log(`\n  ${row.token}\n`);
      console.log("This is shown ONCE and cannot be shown again: copy it into the app that will use it now. Anyone holding it has that access.");
      console.log("A running server reads tokens.json at start-up: restart it for the new token to work.");
      const { MCP_HTTP_PORT } = await import("./config.js");
      console.log(`\nFor the app that will use it (change the host if it is not on this computer):\n  MCP URL: http://127.0.0.1:${MCP_HTTP_PORT}/mcp\n  Header:  Authorization: Bearer ${row.token}`);
    } else if (action === "list" && rest.length === 1) {
      const rows = listTokens(DATA_DIR);
      const fromEnv = envTokenLabels();
      if (!rows.length) console.log(`No tokens in ${tokensPath(DATA_DIR)} (the primary token is not listed here).`);
      for (const r of rows) console.log(`${printable(r.label)}  ${r.scope}${r.namespace ? `  namespace=${printable(r.namespace)}` : ""}`);
      if (fromEnv?.length) console.log(`${fromEnv.length} more token(s) come from MONOMEM_TOKENS (labels: ${fromEnv.map((l) => printable(l, 40)).join(", ")}). They are not editable here.`);
    } else if (action === "remove" && rest.length === 2) {
      console.log(removeToken(DATA_DIR, rest[1]) ? `Removed token "${printable(rest[1])}". The server reads tokens.json once at start-up: RESTART a running server, or the token keeps working until you do.` : `No token labelled "${printable(rest[1])}" in ${tokensPath(DATA_DIR)}.`);
    } else {
      throw new TokenFileError("Usage: monomem token add --label <name> --scope read|write|admin [--namespace ns] | token list | token remove <label>");
    }
  } catch (e) {
    if (!(e instanceof TokenFileError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

// `monomem quarantine [list | approve <id> | reject <id>]`.
async function quarantineCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { maybeEmbed } = await import("./search-service.js");
  const [action = "list", idRaw] = process.argv.slice(3);
  const store = new Store(DB_PATH);
  try {
    if (action === "list") {
      const items = store.listQuarantine({ limit: 500 });
      if (items.length === 0) {
        console.log("Quarantine is empty.");
        return;
      }
      for (const q of items) {
        const what = q.op === "update" ? `update of #${q.target_id}` : "new note";
        console.log(`#${q.id} [${q.namespace}] ${what}: ${q.title == null ? "(title unchanged)" : printable(q.title)}  (${q.created_at})`);
        console.log(`    reasons: ${q.reasons.map((r) => `${r.label} in ${r.field}`).join("; ")}`);
        if (q.body) {
          const preview = q.body.length > 200 ? q.body.slice(0, 200) + "…" : q.body;
          console.log(`    body: ${preview.replace(/\n/g, "\n          ")}`);
        }
      }
      return;
    }
    const id = Number(idRaw);
    if ((action !== "approve" && action !== "reject") || !Number.isInteger(id)) {
      console.error("Usage: monomem quarantine [list | approve <id> | reject <id>]");
      process.exit(1);
    }
    if (action === "reject") {
      if (!store.rejectQuarantine(id)) {
        console.error(`No quarantined write with id ${id}`);
        process.exit(1);
      }
      console.log(`Rejected quarantined write #${id}.`);
      return;
    }
    await requireOperator(`quarantine approve ${id}`);
    const note = store.approveQuarantine(id);
    await maybeEmbed(store, note);
    console.log(`Approved #${id} -> note #${note.id} "${printable(note.title)}"`);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem approve-first [<namespace> on|off]`: operator-only switch (no MCP tool sets it).
async function approveFirstCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const [ns, state] = process.argv.slice(3);
  if (ns !== undefined && (!ns.trim() || (state !== "on" && state !== "off"))) {
    console.error("Usage: monomem approve-first [<namespace> on|off]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    if (ns === undefined) {
      const list = store.approveFirstNamespaces();
      console.log(list.length ? `Approve-first namespaces: ${list.join(", ")}` : "No namespace is approve-first.");
      return;
    }
    if (state === "off") await requireOperator(`approve-first off for "${ns.trim()}"`);
    store.setApproveFirst(ns, state === "on");
    console.log(
      state === "on"
        ? `Approve-first is on for "${ns.trim()}": agent writes there now wait in \`monomem quarantine\`.`
        : `Approve-first is off for "${ns.trim()}". Writes already held stay in \`monomem quarantine\`.`
    );
  } finally {
    store.close();
  }
}

// `monomem access [--since <iso|duration>] [--writer <label>] [--limit N] [--json]`: the read access log (operator only).
async function accessCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const { resolveSince } = await import("./changes.js");
  const { printable } = await import("./security.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["since", "writer", "limit"], bools: ["json"] });
  const store = new Store(DB_PATH);
  try {
    const since = typeof flags.since === "string" ? resolveSince(flags.since) ?? undefined : undefined;
    const entries = store.accessLog({
      ...(since ? { since } : {}),
      ...(typeof flags.writer === "string" ? { writer: flags.writer } : {}),
      ...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
    });
    const paused = store.pausedWriters();
    if (flags.json) {
      console.log(JSON.stringify({ entries, paused }, null, 2));
      return;
    }
    if (!entries.length) console.log("No reads logged" + (since || flags.writer ? " for that filter." : " yet."));
    for (const e of entries) {
      const q = e.query ? `  "${printable(e.query, 120)}"` : "";
      console.log(`${e.at.slice(0, 19).replace("T", " ")}  ${printable(e.writer || "(unknown)", 40).padEnd(16)} ${e.tool.padEnd(18)} ${String(e.results).padStart(4)} result(s)  ${printable(e.namespaces || "-", 60)}${q}`);
    }
    if (paused.length) console.log(`\nPaused by the flood guard: ${paused.join(", ")} (monomem resume <label>)`);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem flood`: writers the flood guard paused. `monomem resume <label>`: lift a pause (operator only).
async function floodCmd(resume: boolean): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, floodWritesPerHour } = await import("./store.js");
  const label = process.argv[3];
  if (resume && !label?.trim()) {
    console.error("Usage: monomem resume <writer label>   (see `monomem flood` for the paused ones)");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    if (resume) {
      await requireOperator(`resume ${label.trim()}`);
      console.log(store.resumeWriter(label) ? `Resumed "${label.trim()}": its writes are accepted again.` : `"${label.trim()}" was not paused.`);
      return;
    }
    const limit = floodWritesPerHour();
    const paused = store.pausedWriters();
    console.log(limit ? `Flood guard: a writer is paused after ${limit} writes in an hour.` : "Flood guard: off (MONOMEM_FLOOD_WRITES_PER_HOUR=0).");
    console.log(paused.length ? `Paused: ${paused.join(", ")}. Resume with: monomem resume <label>` : "No writer is paused.");
  } finally {
    store.close();
  }
}

// `monomem decay [--dry-run] [--namespace ns]`: archive (never delete) idle captured rows now; --dry-run only lists them.
async function decayCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, decayConfig } = await import("./store.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["namespace"], bools: ["dry-run"] });
  const ns = str(flags.namespace);
  const namespaces = ns ? [ns] : undefined;
  const store = new Store(DB_PATH);
  try {
    const cfg = decayConfig();
    if (cfg.days === 0) {
      console.log("Decay is off (MONOMEM_DECAY_DAYS=0).");
      return;
    }
    if (flags["dry-run"]) {
      const rows = store.decayCandidates(Date.now(), namespaces);
      if (!rows.length) {
        console.log("Nothing would be archived.");
        return;
      }
      for (const r of rows) console.log(`#${r.id} [${r.namespace}] ${r.obs_type || r.kind}: ${printable(r.title)}  (idle ${r.idleDays} days)`);
      console.log(`${rows.length} row(s) would be archived. Run \`monomem decay\` to archive them; \`monomem restore <id>\` brings one back.`);
      return;
    }
    const n = store.sweepDecay(Date.now(), namespaces);
    console.log(`Archived ${n} idle captured row(s). Nothing was deleted: \`monomem restore <id>\` brings one back.`);
  } finally {
    store.close();
  }
}

// `monomem delete <id> [--yes]`: the permanent delete, for a person. An agent's state_delete only archives.
async function deleteCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { audit } = await import("./security.js");
  const id = Number(process.argv[3]);
  if (!Number.isInteger(id)) {
    console.error("Usage: monomem delete <id> [--yes]");
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const note = store.read(id); // gate-ok: local shell command (permanent delete): the operator owns the database file
    if (!note) {
      console.error(`No note #${id}.`);
      process.exit(1);
    }
    await gatePinned(store, [id], "delete");
    if (!process.argv.includes("--yes")) {
      if (!process.stdin.isTTY) {
        console.error("A permanent delete cannot be undone: run it at a terminal and answer the question, or add --yes.");
        process.exit(1);
      }
      const ok = await askYesNo(`Permanently delete note #${id} "${note.title}" and all its earlier versions? This cannot be undone. [y/N] `);
      if (!ok) {
        console.log("Nothing deleted.");
        return;
      }
    }
    store.delete(id);
    audit({ op: "note.delete", id, namespace: note.namespace, label: "cli", kind: "note" });
    console.log(`Deleted #${id} "${note.title}" permanently.`);
  } finally {
    store.close();
  }
}

// `monomem archive <id>` / `monomem restore <id>`: the same soft archive and restore as POST /notes/:id/archive|restore.
async function archiveCmd(action: "archive" | "restore"): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError } = await import("./store.js");
  const id = Number(process.argv[3]);
  if (!Number.isInteger(id)) {
    console.error(`Usage: monomem ${action} <id>`);
    process.exit(1);
  }
  const store = new Store(DB_PATH);
  try {
    const before = store.read(id); // gate-ok: local shell command (archive/restore): the operator owns the database file
    if (!before || (action === "archive") !== !before.archived_at) {
      console.error(before ? `Note #${id} is ${action === "archive" ? "already archived" : "not archived"}.` : `No note #${id}.`);
      process.exit(1);
    }
    await gatePinned(store, [id], action);
    const note = action === "archive" ? store.archive(id) : store.restore(id);
    console.log(`${action === "archive" ? "Archived" : "Restored"} #${id} "${printable(note?.title)}".${action === "archive" ? ` Undo: monomem restore ${id}` : ""}`);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

// `monomem quality [--json] [--namespace ns]`: what in the store is worth a look, with the command that fixes each.
async function qualityCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { qualityReport, QUALITY_TYPES } = await import("./quality.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: ["namespace"], bools: ["json"] });
  const ns = str(flags.namespace);
  const store = new Store(DB_PATH);
  try {
    const report = await qualityReport(store, ns ? [ns] : undefined);
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const { conflictLines } = await import("./conflicts.js");
    if (!report.issues.length && !report.conflicts.length) {
      console.log("No quality issues found.");
      return;
    }
    console.log(QUALITY_TYPES.map((t) => `${report.counts[t]} ${t}`).join(", ") + `, ${report.conflicts.length} possible conflicts`);
    for (const l of conflictLines(report.conflicts)) console.log(l);
    for (const i of report.issues) {
      console.log(`\n[${i.type}] [${i.namespace}] ${i.detail}`);
      console.log(`    fix: ${i.fix}${i.alt ? `   (or: ${i.alt})` : ""}`);
    }
  } finally {
    store.close();
  }
}

/**
 * `monomem encrypt <enable|status|disable>` -- at-rest body encryption.
 *
 * enable  creates the AES-256-GCM key (if absent) and encrypts every
 *         plaintext body in place. disable decrypts them and removes the key.
 * Both open the store AFTER touching the key file, so the Store constructor
 * picks up the new encryption state. See docs/encryption-retention.md.
 */
async function encryptCmd(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const crypto = await import("./crypto.js");
  const { dirname } = await import("node:path");
  const { existsSync, renameSync, rmSync } = await import("node:fs");
  // ONE key resolver: the same directory the Store itself looks in (beside
  // the database), so MONOMEM_DB_PATH pointing elsewhere cannot split the
  // key from the data.
  const keyDir = dirname(DB_PATH);
  const [action] = process.argv.slice(3);

  if (action !== "enable" && action !== "status" && action !== "disable") {
    console.error("Usage: monomem encrypt <enable|status|disable>");
    process.exit(1);
  }

  if (action === "status") {
    const store = new Store(DB_PATH); // opening restores a key stranded by a crashed `disable`
    const enabled = crypto.encryptionEnabled(keyDir);
    const keyFile = crypto.keyPath(keyDir);
    try {
      console.log(`encryption: ${enabled ? "on" : "off"}`);
      console.log(`key file:   ${keyFile}${enabled ? "" : " (not present)"}`);
      console.log(`encrypted bodies: ${store.encryptedCount()}`);
      if (enabled) {
        console.log(
          "note: keyword search covers title+tags only for encrypted notes " +
            "(bodies are not indexed as ciphertext)."
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  if (action === "enable") {
    // Create the key, then encrypt. A running server notices the key file on
    // its next write (it checks per write, under the write lock), so notes
    // written meanwhile are sealed too -- and encryptAll picks up any that
    // slipped in as plaintext before the key existed.
    const key = crypto.ensureKey(keyDir);
    const store = new Store(DB_PATH);
    try {
      // Verify the Store sees the very key we just made before touching data.
      if (!existsSync(crypto.keyPath(keyDir))) throw new Error("key file vanished after creation");
      const n = store.encryptAll(key);
      console.log(`Enabled at-rest encryption. Encrypted ${n} note ${n === 1 ? "body" : "bodies"}.`);
      console.log(`Key file: ${crypto.keyPath(keyDir)} -- back it up; losing it loses the bodies.`);
      console.log("Keyword search now covers title+tags only (bodies cannot be indexed as ciphertext).");
      const copies = Store.preMigrationBackups(DB_PATH);
      if (copies.length) {
        console.log(
          `WARNING: ${copies.length} pre-upgrade copy(ies) of this database exist and were made BEFORE encryption, so their note bodies are PLAINTEXT:\n` +
            copies.map((c) => `         ${c.path}`).join("\n") +
            "\n         Remove them once you are happy with the upgrade: monomem backup --prune-premigration"
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  // disable: decrypt everything BEFORE removing the key, so a failure leaves
  // the store untouched and still readable. The key file is moved aside
  // INSIDE the decrypting transaction (under the write lock): a running
  // server's next write then sees "no key" and stores plaintext, instead of
  // sealing a body with a key that is about to be deleted.
  new Store(DB_PATH).close(); // opening restores a key stranded by a crashed `disable`
  const key = crypto.loadKey(keyDir);
  if (!key) {
    console.error("Encryption is not enabled (no key file); nothing to disable.");
    process.exit(1);
  }
  const keyFile = crypto.keyPath(keyDir);
  const aside = `${keyFile}.disabling-${process.pid}`;
  let moved = false;
  const store = new Store(DB_PATH);
  let decrypted: number;
  try {
    decrypted = store.decryptAll(key, {
      beforeCommit: () => {
        renameSync(keyFile, aside);
        moved = true;
      },
    });
  } catch (e) {
    if (moved && !existsSync(keyFile)) renameSync(aside, keyFile); // commit failed: keep the key
    throw e;
  } finally {
    store.close();
  }
  // Delete the key only after every body decrypted and the transaction committed.
  rmSync(aside, { force: true });
  console.log(`Disabled at-rest encryption. Decrypted ${decrypted} note ${decrypted === 1 ? "body" : "bodies"}.`);
  console.log("Key file removed. Keyword search again covers full body text.");
}

/** `monomem supersede ...` and `monomem history ...` (see supersede-cli.ts). */
async function supersedeCmd(kind: "supersede" | "history" | "pin" | "unpin" | "rollback"): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { supersedeCli, historyCli, pinCli, rollbackCli } = await import("./supersede-cli.js");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const io = {
    out: (t: string): void => console.log(t),
    err: (t: string): void => console.error(t),
    ask: (prompt: string): Promise<string> =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (a: string) => {
          rl.close();
          resolve(a);
        });
      }),
    interactive,
  };
  const store = new Store(DB_PATH);
  try {
    const args = process.argv.slice(3);
    if (kind === "unpin") await requireOperator(`unpin ${args[0] ?? ""}`.trim());
    if (kind === "supersede" || kind === "history") await gatePinned(store, pinnedTargets(kind, args), kind === "supersede" ? "supersede" : `history ${args[0]}`);
    process.exitCode =
      kind === "supersede"
        ? await supersedeCli(store, args, io)
        : kind === "history"
          ? await historyCli(store, args, io)
          : kind === "rollback"
            ? await rollbackCli(store, args, io)
            : await pinCli(store, kind, args, io);
  } finally {
    store.close();
  }
}

/** Note ids a supersede / history command would change or retire (empty for reads and for arguments it cannot parse). */
function pinnedTargets(kind: "supersede" | "history", args: string[]): number[] {
  const first = args.find((a) => !a.startsWith("--"));
  if (kind === "history") {
    if (first !== "restore" && first !== "purge") return [];
    return [Number(args.filter((a) => !a.startsWith("--"))[1])].filter(Number.isInteger);
  }
  if (first === "undo") return [Number(args.filter((a) => !a.startsWith("--"))[1])].filter(Number.isInteger);
  const i = args.findIndex((a) => a === "--old" || a.startsWith("--old="));
  const v = i < 0 ? "" : args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : (args[i + 1] ?? "");
  return v.split(",").map(Number).filter(Number.isInteger);
}

/** TTY yes/no prompt; anything but y/yes aborts. */
function terminalIO(): import("./setup.js").SetupIO {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (prompt) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (a: string) => {
          rl.close();
          resolve(a);
        });
      }),
  };
}

// `monomem sync --git <repo>`: see sync-git.ts.
async function syncCmd(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["git", "remote", "key-file"],
    bools: ["encrypt", "dry-run", "no-push", "yes"],
  });
  if (!str(flags.git)) {
    console.error("Usage: monomem sync --git <repo-folder> [--remote name] [--encrypt] [--key-file f] [--dry-run] [--no-push] [--yes]");
    process.exit(1);
  }
  const { DB_PATH, DATA_DIR } = await import("./config.js");
  const { runGitSync } = await import("./sync-git.js");
  const io = terminalIO();
  process.exitCode = await runGitSync(io, {
    repo: str(flags.git)!,
    remote: str(flags.remote),
    encrypt: flags.encrypt === true,
    keyFile: str(flags["key-file"]),
    dryRun: flags["dry-run"] === true,
    noPush: flags["no-push"] === true,
    yes: flags.yes === true,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    env: process.env,
  });
}

// `monomem setup`: see setup.ts.
async function setupCmd(): Promise<void> {
  const { runSetup, realEnv, DEFAULT_OPTIONS } = await import("./setup.js");
  const { flags } = parseFlags(process.argv.slice(3), {
    values: ["only", "db", "command"],
    bools: ["dry-run", "yes", "undo", "hook", "no-hook", "capture", "no-capture", "project", "no-test-note", "no-doctor", "force-empty"],
  });
  const command = str(flags.command) ?? "auto";
  if (!["auto", "node", "npx"].includes(command)) {
    console.error("--command must be auto, node or npx");
    process.exit(1);
  }
  if (flags.hook === true && flags["no-hook"] === true) {
    console.error("Choose one of --hook and --no-hook");
    process.exit(1);
  }
  if (flags.capture === true && flags["no-capture"] === true) {
    console.error("Choose one of --capture and --no-capture");
    process.exit(1);
  }
  const { PACKAGE_VERSION } = await import("./config.js");
  const e = realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url));
  process.exitCode = await runSetup(e, terminalIO(), {
    ...DEFAULT_OPTIONS,
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    undo: flags.undo === true,
    hook: flags.hook === true ? "yes" : flags["no-hook"] === true ? "no" : "ask",
    capture: flags.capture === true ? "yes" : flags["no-capture"] === true ? "no" : "ask",
    project: flags.project === true,
    noTestNote: flags["no-test-note"] === true,
    noDoctor: flags["no-doctor"] === true,
    forceEmpty: flags["force-empty"] === true,
    only: str(flags.only)?.split(",").map((x) => x.trim()).filter(Boolean),
    db: str(flags.db),
    command: command as "auto" | "node" | "npx",
  });
}

// `monomem uninstall`: see uninstall.ts.
async function uninstallCmd(): Promise<void> {
  const { realEnv } = await import("./setup.js");
  const { runUninstall } = await import("./uninstall.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: [], bools: ["purge", "dry-run", "yes", "no-backup"] });
  const { PACKAGE_VERSION } = await import("./config.js");
  process.exitCode = await runUninstall(realEnv(PACKAGE_VERSION, fileURLToPath(import.meta.url)), terminalIO(), {
    purge: flags.purge === true,
    dryRun: flags["dry-run"] === true,
    yes: flags.yes === true,
    noBackup: flags["no-backup"] === true,
  });
}

// Untrusted text (note titles, imported text) printed to the terminal goes through this; bound in main() once config is loaded.
let printable: typeof import("./security.js").printable = (s) => String(s ?? "");

/**
 * Operator gate for commands that LOWER protection (undistrust, attester-add/unrevoke, quarantine approve).
 * Needs a real terminal on both ends and a typed "yes"; there is no --yes. This raises the bar against an
 * agent running the CLI through a non-interactive shell tool. It is not a guarantee: a tool that allocates
 * a pseudo-terminal can pass it (SECURITY.md).
 */
/**
 * Pinned notes are the operator's: changing or retiring one from the CLI needs the same terminal + typed yes as the commands that lower
 * protection. Without it an agent with a shell tool (`</dev/null`) could use the CLI's writer `cli` to get past the pin. Done here, not in
 * the Store, so library callers and tests that act as `cli` are unaffected.
 */
async function gatePinned(store: import("./store.js").Store, ids: number[], what: string): Promise<void> {
  if (!ids.length) return;
  const pinned = new Set(store.pinnedNotes().map((n) => n.id));
  const hit = ids.find((i) => pinned.has(i));
  if (hit !== undefined) await requireOperator(`${what} on pinned note #${hit}`);
}

async function requireOperator(what: string): Promise<void> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(
      `Refused: ${what} lowers this store's protection, so a person must run it in a terminal and type a confirmation. ` +
        "This is not a terminal (an agent's shell tool, a script or a pipe), and there is no --yes for it. Open a terminal and run the same command there."
    );
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${what} lowers protection. Type "yes" to continue: `, resolve));
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.error("Not confirmed; nothing changed.");
    process.exit(1);
  }
}

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || "start";
  // Old Node: say so in plain words BEFORE anything loads node:sqlite (which would crash with a stack trace).
  // setup.js is safe to load here -- it never imports node:sqlite.
  if (!["help", "--help", "-h"].includes(cmd)) {
    const { nodeIsOk, MIN_NODE_TEXT } = await import("./setup.js");
    if (!nodeIsOk(process.versions.node)) {
      console.error(
        `Monomem needs Node.js ${MIN_NODE_TEXT} or newer, and this computer has Node ${process.versions.node}.\n` +
          "  Fix: install Node 22.16+ or 24 LTS (https://nodejs.org), open a NEW terminal, check with:  node -v\n" +
          "  Just want to set it up now? This runs setup with a temporary Node 24 (nothing to install):\n" +
          "      npx -y -p node@24 -p monomem monomem setup\n" +
          "  Your apps will still start Monomem with the Node on this computer, so upgrade Node before relying on it.\n" +
          "  Nothing was changed. (Can't upgrade Node? Docker works too: see INSTALL.md.)"
      );
      process.exit(1);
    }
  }
  if (!COMMANDS.includes(cmd)) {
    const guess = suggestCommand(cmd);
    console.error(`Unknown command '${cmd}'.${guess ? ` Did you mean '${guess}'?` : ""}\nRun 'monomem help' to see the commands.`);
    process.exit(1);
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const { PACKAGE_VERSION } = await import("./config.js");
    console.log(PACKAGE_VERSION);
    return;
  }
  // Move 1.0.x state out of the package before anything opens the DB.
  // (`bench` runs on a throwaway store and must never touch the real data directory.)
  // A dry run of `import --claude` / `import --from` or `sync` must not create anything, not even the data folder.
  const dry = process.argv.includes("--dry-run") && ((cmd === "import" && (process.argv.includes("--claude") || process.argv.includes("--from"))) || cmd === "sync");
  // The capture hooks (`hook`) never move or create data folders: they run on every tool call and must stay quick and quiet.
  if (!dry && !["help", "--help", "-h", "init", "bench", "setup", "uninstall", "hook"].includes(cmd)) {
    (await import("./config.js")).prepareDataDir();
    printable = (await import("./security.js")).printable;
  }
  // Fixed writer marker for notes this process writes with no token behind
  // them (written_by): the long-running server's own jobs, the stdio MCP
  // server, or an `monomem ...` command run by the machine owner.
  setProcessWriter(
    cmd === "start" || cmd === "serve" ? "server" : cmd === "mcp" || cmd === "mcp:stdio" ? "stdio" : cmd === "hook" ? "capture" : "cli"
  );
  switch (cmd) {
    case "start":
    case "serve":
      await import("./start.js");
      break;
    case "mcp":
    case "mcp:stdio":
      await import("./mcp-stdio.js");
      break;
    case "doctor":
      await doctor();
      break;
    case "init":
      await init();
      break;
    case "setup":
      await setupCmd();
      break;
    case "uninstall":
      await uninstallCmd();
      break;
    case "sync":
      await syncCmd();
      break;
    case "reindex":
      await reindex();
      break;
    case "recall":
      await recall();
      break;
    case "hook":
      await hookCmd();
      break;
    case "consolidate":
      await consolidate();
      break;
    case "rebuild-edges":
      await rebuildEdges();
      break;
    case "relevant":
    case "search":
      await relevant();
      break;
    case "changes":
      await changes();
      break;
    case "backup":
      await backupCmd();
      break;
    case "runner-status":
      await runnerStatusCmd();
      break;
    case "watch":
      await watchCmd();
      break;
    case "export":
      await exportCmd();
      break;
    case "import":
      await importCmd();
      break;
    case "trust":
      await trustCmd();
      break;
    case "token":
      await tokenCmd();
      break;
    case "quarantine":
      await quarantineCmd();
      break;
    case "approve-first":
      await approveFirstCmd();
      break;
    case "access":
      await accessCmd();
      break;
    case "flood":
      await floodCmd(false);
      break;
    case "resume":
      await floodCmd(true);
      break;
    case "decay":
      await decayCmd();
      break;
    case "archive":
    case "restore":
      await archiveCmd(cmd);
      break;
    case "delete":
      await deleteCmd();
      break;
    case "audit": {
      if (process.argv[3] !== "verify") {
        console.error("Usage: monomem audit verify");
        process.exit(1);
      }
      const { verifyAuditChain } = await import("./security.js");
      const r = verifyAuditChain();
      const extra = `${r.forks} fork(s) (two processes writing at once, or a line inserted), ${r.unchained} line(s) from before the chain`;
      if (r.ok) {
        console.log(`Audit chain intact: ${r.lines} line(s), ${extra}.`);
        console.log(`Head ${r.head ?? "(empty)"}: note it somewhere else to detect a later rewrite or cut-off.`);
        console.log("Detects lines edited or removed inside the chain. Not: a line inserted (it looks like a fork), the newest lines cut off, rotated files deleted, or a full rewrite by anyone who can write the file.");
      } else {
        console.error(`Audit chain BROKEN: ${r.breaks} break(s), first at line ${r.brokenLine} of ${r.file} (it follows from none of the lines before it). ${extra}.`);
        process.exit(1);
      }
      break;
    }
    case "quality":
      await qualityCmd();
      break;
    case "conflicts":
      await (await import("./conflicts.js")).conflictsCmd(process.argv.slice(3));
      break;
    case "encrypt":
      await encryptCmd();
      break;
    case "receipts":
    case "meter": {
      const r = await import("./receipts.js");
      await (cmd === "meter" ? r.meterCmd : r.receiptsCmd)(process.argv.slice(3));
      break;
    }
    case "never-show":
      await neverShowCmd();
      break;
    case "supersede":
      await supersedeCmd("supersede");
      break;
    case "history":
      await supersedeCmd("history");
      break;
    case "pin":
    case "unpin":
    case "rollback":
      await supersedeCmd(cmd);
      break;
    case "drill": {
      const { drillMain } = await import("./drill.js");
      process.exitCode = await drillMain(process.argv.slice(3));
      break;
    }
    case "health": {
      const { healthMain } = await import("./health.js");
      process.exitCode = await healthMain(process.argv.slice(3));
      break;
    }
    case "bench": {
      const args = process.argv.slice(3);
      if (args.includes("--longmemeval") || args.includes("--locomo")) {
        // Imported before anything loads config.js: it moves MONOMEM_HOME to a temp folder first.
        const { retrievalMain } = await import("./bench/retrieval.js");
        process.exitCode = await retrievalMain(args);
        break;
      }
      const { benchMain } = await import("./bench/index.js");
      process.exitCode = await benchMain(args);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      usage(process.argv.includes("--all"));
      break;
    default:
      console.error(`Unknown command '${cmd}'. Run 'monomem help' to see the commands.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
