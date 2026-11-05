# Upgrading from 1.3.x

> **Moving to monomem 1.2.0 from 1.1.x?** The first start migrates the database from schema v16 to **v18** (the read access log, flood-guard
> counts, pinned notes and per-writer history for rollback). No note text is rewritten. A verified copy is made first at
> `<database>.pre-v18-backup`, and the upgrade does not run if that copy cannot be made. An older monomem cannot open a v18 database. To go back:
> stop everything, put that copy back as the database (delete the `-wal` and `-shm` files beside it), install the older version. The first start
> also rebuilds the search index once for prefix search (about half a second per 50,000 notes). What is new: [CHANGELOG.md](../CHANGELOG.md).

> **Moving to 1.6.0 from 1.4.x or 1.5.0?** The first start migrates the database from schema v14 to **v15** (confidence and replace columns,
> and tables for history, one-time codes and the replace log). Nothing is rewritten: no note text is touched. A verified copy is made first at
> `<database>.pre-v18-backup`, and the upgrade does not run if that copy cannot be made. To go back: stop everything, put that copy back as the
> database, install the older version. What is new: [replacing-memories.md](./replacing-memories.md). The rest of this page was written for 1.3.x to
> 1.4.x; the backup there is now named `pre-v15` as well, because the file is named after the schema it upgrades to.

This page is for an existing 1.3.x install moving to 1.4.x (1.4.2 is the last 1.4.x; 1.5.0 only adds the benchmark and needs no migration). Nothing here is
needed for a fresh install.

**EXPERIMENTAL in 1.4.x:** signed attestations, cross-server writer ids, `trust rotate`,
`trust attester-revoke` and the `--any-server` flag. They may change in a minor release. The local
distrust list and writer labels are the stable part. See [trust.md](./trust.md).

## What happens when you start 1.4.x

1. **The schema upgrade is one-way.** The first start on a database at schema v1 to v13 migrates it to v14
   (new columns, three small tables, an index over note writers). No note text is touched. An older
   version cannot open a v14 database.
2. **A backup is made first.** Before migrating, Monomem writes a verified copy to
   `<database>.pre-v18-backup` (it is built as `.partial`, then checked: it must hold the same number of notes
   as the database, have the old schema version and pass an integrity check; only then is it renamed). If a
   valid copy from an earlier attempt exists it is kept under a dated name and a fresh one is made; a copy
   that cannot be read (permissions) is never deleted, only moved aside. **The upgrade does not run when the
   copy cannot be made** (for example the disk has no room: free about the size of the database plus its
   WAL). It stops with an error and the database is untouched. To upgrade anyway, take your own
   `monomem backup` and set `MONOMEM_SKIP_PREMIGRATION_BACKUP=1` for that start; there is then no way
   back to the older version.
3. **Expect a delay on the first start** of a large database: building the index takes a few seconds per
   hundred thousand notes. In Docker or a service manager, give the health check a start period
   (the image uses `--start-period=60s`; use a longer one for a very large database) so the container is not reported
   unhealthy (and restarted by an orchestrator) mid-migration.
4. **The data directory must be writable** (the migration, the backup copy and the signing key all write
   there). On a read-only mount Monomem stops with a readable message naming the directory (for new and existing databases alike).
5. **Stored writer labels are cleaned once.** Labels are compared after Unicode normalisation (NFKC) and with
   invisible format characters (zero-width joiner, bidi marks) removed. The first start of 1.4.2 re-writes
   the stored labels of older notes (and any distrust rule) that this changes, so a rule keeps matching them.
   It is automatic, runs once and touches only rows that change.

Run `monomem doctor` afterwards: it lists the pre-migration copies with size and age, and warns about
leftover `.partial` files.

## Rolling back

To roll back:

Stop every Monomem process (server, MCP clients, runners, the CLI). **Move** `<database>.pre-v18-backup`
over the database (a copy would leave the original; remove the `-wal` and `-shm` files next to it),
reinstall 1.3.x and start it. Anything written after the upgrade is not in the backup. Once you are happy
with 1.4.x, `monomem backup --prune-premigration` deletes the copies (they are plaintext even if you
later enable at-rest encryption). Stale `-journal` sidecars and old partial copies are swept
automatically.

## What behaves differently

- **Old notes have no writer.** Rows from before schema v13 have `written_by` of `""`. A distrust rule
  affects what is written from now on; it cannot say who wrote the older notes.
- **Runners older than 1.3.4** write a heartbeat with no writer marker, which 1.4.x no longer believes.
  Update the runner ([RUNNER.md](https://github.com/calasdan-sketch/monomem/blob/main/docs/RUNNER.md)), or set `MONOMEM_RUNNER_ACCEPT_LEGACY=1` as a stopgap.
- **The default export keeps its shape**: `{"notes": [...]}` with no header and no signatures. The notes in
  it carry extra fields (`merged_from_writers`, `written_by`, ...). `?attest=1` / `--attest` adds the
  signed envelope; `import` accepts the plain object, the envelope and a bare array.
- **Import streams.** `monomem import --file` reads the file in batches instead of loading it whole.
  For a file with several batches the similarity edges are not rebuilt per batch: run
  `monomem rebuild-edges` afterwards (the command prints that hint).
- **Notes imported without a verified attestation** are marked `imported_unverified: true` and the agent
  banner says so. The default still accepts them. To refuse them, use `--require-attestation`,
  `require_attestation` over the API, or `MONOMEM_IMPORT_REQUIRE_ATTESTATION=1`.
- **`include_distrusted`** is admin-only, and for a namespace-pinned admin with read grants it applies to
  that token's own namespace only. The primary `MONOMEM_TOKEN` is always an admin.
- **New variables** (all optional, documented in [configuration.md](./configuration.md)):
  `MONOMEM_ATTEST_MIN_VERSION`, `MONOMEM_IMPORT_REQUIRE_ATTESTATION`, `MONOMEM_TRUSTED_ATTESTERS`,
  `MONOMEM_ATTEST_KEY_FILE`.

## A short checklist

1. `monomem backup --out <dir>` yourself as well; the automatic copy is only the pre-upgrade state.
2. Check free disk space (database size, plus the same again for the copy).
3. Upgrade, start, wait for the migration, run `monomem doctor`.
4. If you use several servers: read [trust.md](./trust.md), decide whether you want attestations at all
   (they are EXPERIMENTAL), and back up the signing key (`trust export-key --out <file>`,
   `backup --include-attest-key`).
5. Update runners older than 1.3.4.
