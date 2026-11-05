# Security & Threat Model — Monomem

Monomem is a note store exposed over MCP + HTTP. **Treat all stored
content as untrusted input to your agents** — see "Memory safety" below.

## Controls

- **Network:** binds `127.0.0.1` by default. Public exposure is opt-in
  (`MONOMEM_BIND`) and the server **refuses to start** on a non-loopback
  address unless you set an explicit `MONOMEM_TOKEN`. Public deployments
  are expected to sit behind an authenticated tunnel (e.g. Cloudflare Tunnel +
  Cloudflare Access). The **Origin** header is validated (DNS-rebinding
  defense); browser origins are blocked unless listed in
  `MONOMEM_ALLOWED_ORIGINS`.
- **Auth:** a bearer token is required on every route except `/health` and
  `/ready`. Each token is compared in constant time (a minor side-channel on
  token length/count is not fully eliminated, which is immaterial for the
  high-entropy tokens this uses behind a tunnel). Tokens are never placed in
  URLs and are never logged. The primary token file is created `0600` and is
  git-ignored. The `0600` mode applies on POSIX systems; on Windows (NTFS) it has no effect, so rely on the folder
  permissions of your user profile.
- **Scoped tokens:** besides the primary (admin) token, you can define extra
  `read` / `write` / `admin` tokens via `MONOMEM_TOKENS` (a JSON array)
  or a `~/.monomem/tokens.json` file, so a leaked read-only token can't write, delete
  or dump the store. Scopes are enforced identically on the REST API and the
  MCP tools; `/export` (a full-store dump), `/import` and all deletes require
  `admin`. If you use `~/.monomem/tokens.json`, it is re-`chmod`ed `600` on every start (POSIX) — it holds credentials
  and the app reads but does not set its permissions.
- **Rate limiting:** per-client fixed-window limiter (defaults configurable via
  `MONOMEM_RATE_MAX` / `MONOMEM_RATE_WINDOW_MS`) so a leaked token
  can't be brute-forced or hammered. Over-limit requests get `429`.
- **Input validation:** per-note size caps (title/body/tags), a 1MB request
  body cap, and all values are bound as parameters; SQL text is
  built only from internal identifiers.
- **Secret guard:** writes are scanned for high-confidence credentials (AWS
  keys, private-key blocks, provider API tokens, etc.) and **rejected** by
  default (`MONOMEM_LINT`), since a memory store is where secrets get pasted
  by accident.
- **Audit log:** an append-only log records every mutation (op, id, namespace,
  byte count) — **no note content and no secrets** are logged. Archive, restore and the expiry and decay sweeps are
  logged from inside the store, so every path (MCP, REST, CLI, background sweep) writes a line. Each line carries
  `prev`, the sha256 of the line before it (carried across rotation), and `monomem audit verify` walks the chain and
  counts every break. Several apps append to one log, so two can race and one line then names an earlier line as its
  `prev`; verify counts that as a concurrent fork, not a break, and keeps going. This is **tamper-evident, not
  tamper-proof**: it detects lines edited or removed *inside* the chain. The hashes are not keyed, so any program
  running as you with a shell or file access (including an agent with a shell tool) can rewrite the whole chain or cut
  off its newest lines, and deleting rotated files is not detected. `audit verify` prints the head hash: note it
  somewhere else to catch a later rewrite. Lines written before this was added have no `prev` and are counted as
  unchained. Archive through MCP `state_delete` currently writes two lines (one from the store, one
  from the tool, which names the caller).
- **Supply chain:** committed lockfile + `npm ci`, Dependabot, `npm audit` in
  CI, and MIT-licensed with only two production dependencies.

## Threat model (short)

- **Assets:** note bodies, and the bearer tokens.
- **Attackers considered:** someone who obtained a token (leak, shared
  device); malicious text inside a note (stored prompt injection); a person
  who steals a disk image or backup.
- **Trusted:** the CLI and the stdio MCP transport run with full local trust
  and use no token. Anyone with shell access to the machine and its data
  directory owns the store. Since 1.1.0 the *agent* on the stdio connection
  does not inherit all of that: its `state_delete` archives instead of
  erasing, and the operator-only tools (`memory_quarantine`, `trust_policy`,
  `memory_history_purge`, `memory_consolidate`, `task_approve`), the
  `include_distrusted` flag and `task_put` with `approve: true` are off for
  it unless the operator sets `MONOMEM_STDIO_ADMIN_TOOLS=1`.
- **Not covered:** a live attacker holding a valid admin token; an attacker
  who can read both the database and the key file; prompt injection is
  mitigated, not eliminated (OWASP GenAI #1); there is no OAuth, only static
  bearer tokens.

## Writer trust (1.4.0, hardened in 1.4.1)

A note's `written_by` is stamped by the server from the authenticated token; an admin can put a writer on a
per-namespace distrust list that every read path honours (through one gate, with a guard test), and a JSON export
made with `--attest` / `?attest=1` carries Ed25519 attestations so a server you chose to trust can vouch for a
note's original author. Read [docs/trust.md](./docs/trust.md) for exactly what this proves and does not.

- A distrusted writer's content **stays hidden** after anyone else edits it (the taint set only grows); only the
  admin lifting the rule shows it again. `include_distrusted` is admin-only on every surface.
- A trusted key is **pinned to one `server_id`** (an unpinned key needs an explicit `--any-server`), can carry a
  `not_after`, and is rotated with `monomem trust rotate`. Version-2 attestations also sign `created_at`,
  `source`, `expires_at`, `archived_at`, `rev` and the export time.
- **Replay:** an old export stays validly signed. Replaying it into a server that trusts the key restores the old
  content (with its old provenance); `not_after` retires a whole key, but there is no per-note freshness.
  Import only files you hold, and treat `exported_at` as the signer's claim of when it exported.
- `.attest-key` is the identity: protect it like the encryption key and **do not keep the data directory in a
  synced folder** (Dropbox, iCloud, OneDrive copy it to every device). It is re-tightened to 0600 at every start and
  left out of `monomem backup` unless you pass `--include-attest-key`.
- It is a policy on labels, not protection against the operator; a trusted server can still export a hostile
  note; and a writer who obtains a new token under a new label is not on the list.
- Heartbeats from runners older than 1.3.4 are no longer believed by default (`MONOMEM_RUNNER_ACCEPT_LEGACY=1`
  restores the old behaviour). A heartbeat counts only if the runner process wrote it and its own `alive_at` agrees
  with the server's clock within two minutes, so a tag-only touch of an old heartbeat does not make it fresh.
- **Replacing a note (1.6.0)** is two steps: a preview that changes nothing, then a confirm that needs the preview's one-time
  code. The code is signed with a key kept in the database, expires (default 10 minutes), works once, is bound to the caller
  (writer, scope, tenant), to the exact notes and revisions previewed and to the exact replacement text, and a wrong code gets
  one generic message. A distrusted writer, or a replacement that claims lower confidence, needs an administrator and an explicit
  `acknowledge_risk`. Nothing is deleted and undo is recorded. **Limit:** over MCP and REST an agent stands between you and the
  warning; the tool descriptions tell it to show the full warning and wait for you, and the code makes it impossible to confirm
  without a preview, but a careless or manipulated agent could still confirm on its own. The command line asks you at your own
  keyboard and is the strongest gate.
- **Version history (1.6.0)** keeps the text an edit replaces, so it can hold text someone removed on purpose. It is administrators-only,
  bounded per note, encrypted at rest when encryption is on (plaintext otherwise, like note bodies), included in `export` unless
  `?history=0` / `--no-history`, and removable with `history purge`. Treat an export that carries history like the database.
- Pre-upgrade copies (`<db>.pre-v16-backup`) are plaintext snapshots: remove them
  (`monomem backup --prune-premigration`) once the upgrade is checked, especially before enabling encryption.

## Encryption at rest (shipped in 1.2.0)

`monomem encrypt enable` encrypts note **bodies** with AES-256-GCM. The
limits, stated plainly:

- **Titles, tags, timestamps and the writer (`written_by` / `created_by`,
  the token label that wrote a note) stay plaintext.** Search and namespace
  isolation need them. Keyword search covers title + tags only while
  encryption is on.
- **Embeddings bypass encryption.** If you enable semantic search, the
  decrypted body is sent to your `MONOMEM_EMBED_URL` endpoint, and the
  resulting vectors are stored unencrypted (vectors can leak information
  about the text). Leave embeddings off if that matters.
- **The key sits beside the database** (`~/.monomem/.key`, mode `0600`, or
  `MONOMEM_KEY_FILE`). A backup of the whole data directory contains both,
  so encryption protects against a stolen database file or a backup of the
  database alone, not against someone who gets the whole directory. There is
  no re-key command.
- **Binding of ciphertext to its row (AAD):** 1.2.0 did not bind a body's
  ciphertext to its note id and namespace, so someone who could write to the
  SQLite file could copy ciphertext between rows. 1.2.1 addresses this (see
  the CHANGELOG; confirm for the version you run).
- Quarantined (linter-held) writes are sealed too in 1.2.1; in 1.2.0 they
  were stored in plaintext.
- `GET /export` returns decrypted bodies, so treat exports as sensitive.
- Details: [docs/encryption-retention.md](./docs/encryption-retention.md).

## Namespaces and tokens

- Besides the primary admin token you can define `read` / `write` / `admin`
  tokens. A token can also be **pinned to one namespace**; a pinned token
  (even an admin one) cannot read or write another namespace. See
  [docs/token-namespaces.md](./docs/token-namespaces.md).
- Rotate by setting a new `MONOMEM_TOKEN` or deleting
  `~/.monomem/.token`; a leaked token works until you do.

## Memory safety

A note store whose contents are read back by autonomous agents is a **stored
prompt-injection / "memory poisoning"** channel. Layers:

- **Write-time linter:** secrets (API keys, private keys, JWTs,
  high-entropy tokens) are blocked; prompt-injection phrasing is
  **quarantined**, invisible to search and recall until an admin approves it
  (`monomem quarantine`). It is a pattern linter: it will miss novel
  phrasing and can flag harmless text. It matches patterns, so a reworded attack passes (bench scenario E16 is a
  designed miss). Text written in invisible Unicode tag characters is decoded and scanned, and any such character
  is flagged, as is a run of four or more variation selectors (the England, Scotland and Wales flag emoji are
  exempt). The `source` field is not scanned; tag characters are removed from it when it is stored. See
  [docs/memory-linter.md](./docs/memory-linter.md).
- **Untrusted-data banner on every MCP read** (and `monomem recall`).
  REST responses do not carry it; REST callers must apply the same rule.
- **SKILL.md** tells agents to treat note content as data, never as
  instructions. If you integrate the tools yourself, enforce the same rule.

## Write controls and their limits

These protect memory from agents that reach it through MCP or REST. **An agent with a shell tool can run the `monomem`
CLI itself, so none of them stops an agent that can run commands.**

- **Approve-first namespaces** (`monomem approve-first`): writes that do not come from the local CLI are held in the
  quarantine queue until approved. An admin REST token is treated like any other REST caller, so it is held too.
- **Pinned notes** (`monomem pin`): only the CLI can edit, forget, restore, replace or delete them. An admin token can
  unpin a note over REST and then change it.
- **Flood guard**: a writer label that makes too many writes in an hour is paused until `monomem resume`. The label is
  self-declared, so this stops runaway loops, not a hostile app that changes its label.
- **Rollback by writer** (`monomem rollback`): undoes what one writer label created or changed; it does not undo tag
  edits, archives, replacements or deletes, and it relies on the same self-declared label.
- **Read access log** (`monomem access`): records which writer read what (query preview, counts, no note text), kept
  30 days by default.

## Limitations (stated honestly)

- Single-user, single-node SQLite. No clustering, no multi-tenant isolation
  beyond namespaces on one process.
- Note history is bounded, not unlimited: `MONOMEM_HISTORY_VERSIONS` earlier
  versions per note (default 20, at most 500; **`0` keeps none at all, the
  original included**) and `MONOMEM_HISTORY_MAX_BYTES` of earlier text per
  note (default 2,000,000; 10,000 to 50,000,000). While history is on,
  pruning never drops the oldest kept version. Older versions beyond those
  limits are gone and cannot be restored, and an explicit purge
  (`monomem history purge`, `memory_history_purge`,
  `DELETE /notes/:id/history`) deletes **every** kept version, original
  included.
- The similarity-edge graph rebuild is O(n^2); large imports defer it.
- Keyword extraction for recall is English-oriented.
- Requires Node.js 22.16+ (built-in `node:sqlite`; added in 22.5.0 but behind `--experimental-sqlite` until 22.16.0).
- **Restore into an empty store.** `POST /import` does not de-duplicate:
  importing a backup into a store that already holds those notes creates
  duplicates.
- Rate limiting is per client address and runs before authentication;
  behind a shared tunnel, clients share a bucket.
- The audit log records operations, never note content.
- Encryption limits are listed above.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or email the
maintainer. Do not file public issues for security reports.
