# Round 3 (1.4.0): five expert reviews and the ideas considered

Every number below was measured on this repository with the scripts and benchmarks named; nothing here was taken from a
competitor's own claims. "Not measured" means we did not run it.

## What each reviewer did and found

| Reviewer | Hands-on tests | Findings (before 1.4.0) |
|---|---|---|
| **Coding-agent power user** (50+ sessions a week) | Session start and first write on a 100,000-note store; `remember`, `search`, `recall` from a cold process | `monomem remember` took 8.6 s, all of it building an in-memory word index of the whole namespace (one blocked event loop for a long-lived server). `recall` took 1.6 s against its own 0.8 s budget, because "newest notes" sorted the namespace on every call (260 ms a call). |
| **Distributed systems / concurrency** | 8 processes x 150 writers on one file; `kill -9` six times mid-write; truncated, zeroed and header-damaged files; 100,000 notes | Concurrency and crash recovery held: 1,200 of 1,200 writes, no `SQLITE_BUSY` escaped, integrity ok after six kills, no orphan links, no notes missing from the index. Weak spots: a write got slower with every note (4.5 ms at 500 notes, 17 ms at 5,000, linear), a damaged file gave only "database disk image is malformed" and no way forward, and a missed search cost 350 ms at 100,000 notes (query repair, added in 1.3.0, scanned the vocabulary). |
| **Red team** | 26 cross-namespace probes with a namespace-pinned token (search, passages, index, timeline, get, export, changes, tasks, stats, FTS operators, writes by id); 12 injection evasions; `npm pack` contents and install hooks | 0 leaks, 0 foreign writes. `npm pack` holds no tests, keys or maps; no install scripts; 2 direct dependencies. The linter missed one cheap evasion: `&#105;gnore ...` (character references) and `ignore` escapes. Known and still open: role hijack ("you are now DAN"), tool-call coercion without override words. |
| **Product / DX lead** | First run from an empty home: `remember`, `search`, wrong usage, a held write | Time to first memory about 0.13 s after install; usage and quarantine messages are clear. Gaps: no hint when a note restates an existing one, no `doctor` depth check, nothing to try after "malformed", no import from the most-installed memory server (official MCP memory). |
| **Evaluation scientist** | Re-read how 1.3.0's passage settings were chosen | The passage settings were tuned and reported on the same 470 questions. A fixed dev/test split existed in the code (`splitOf`) but was never used for a claim. Built `--passages --sweep`: tuned on dev only, judged on test, bootstrap interval. The 1.3.0 settings were not the optimum: held-out evidence coverage at 500 tokens rose from 80.2 % to 85.5 % (95 % interval for the gain +2.5 to +8.3 points). |

## Ideas considered (28), scored 1 to 5

Value = what a user feels; Gap = how far it widens the distance to other memory tools on something checkable; Cost = effort (5 = cheap);
Safety = risk of breaking behaviour or trust (5 = safe). Score = Value + Gap + Cost + Safety.

| # | Idea | Value | Gap | Cost | Safety | Score | Decision |
|---|---|---|---|---|---|---|---|
| 1 | Edges through the full-text index above a size limit (bounded write cost, no per-note memory) | 5 | 5 | 3 | 4 | 17 | **Built** |
| 2 | Index in sort order for "newest notes" (list, session start) | 5 | 3 | 5 | 5 | 18 | **Built** |
| 3 | Bound query repair on big stores | 5 | 3 | 4 | 4 | 16 | **Built** |
| 4 | Repeat-write hint (name the notes a new note restates) | 4 | 4 | 4 | 5 | 17 | **Built** |
| 5 | `monomem recover` (salvage a damaged file) | 4 | 5 | 3 | 5 | 17 | **Built** |
| 6 | Held-out sweep of passage settings; adopt what generalises | 4 | 4 | 4 | 4 | 16 | **Built** |
| 7 | `bench --scale` (committed scale benchmark) | 4 | 5 | 4 | 5 | 18 | **Built** |
| 8 | Import from the official MCP memory server | 3 | 3 | 5 | 5 | 16 | **Built** |
| 9 | Decode character references and escapes before the injection scan | 3 | 2 | 5 | 5 | 15 | **Built** |
| 10 | `doctor --deep` (file structure, search index, orphan links) | 3 | 3 | 5 | 5 | 16 | **Built** |
| 11 | Session briefing pack | 3 | 2 | 2 | 4 | 11 | Not built: `recall` already ranks and budgets the start-of-session pack |
| 12 | Digest old observations into summaries, token saving measured | 4 | 4 | 1 | 3 | 12 | Not built: honest summaries need a model; the free distiller exists |
| 13 | Refuse exact duplicate writes (idempotent by content hash) | 3 | 2 | 4 | 2 | 11 | Not built: changes who is recorded as the writer; the hint is the safe version |
| 14 | Detect contradicting numbers and propose a replace | 4 | 4 | 2 | 3 | 13 | Partly: the hint finds the candidate; confirming stays with a person |
| 15 | Export to mem0 / MCP-memory formats (no lock-in both ways) | 3 | 3 | 4 | 5 | 15 | Not built |
| 16 | Approximate nearest-neighbour index for semantic search past 50,000 notes | 3 | 4 | 1 | 3 | 11 | Not built, not measured (brute-force cosine is what exists) |
| 17 | Hash-chained write log (tamper evidence) | 3 | 4 | 2 | 4 | 13 | Not built |
| 18 | Query result cache for repeated lookups | 2 | 1 | 4 | 4 | 11 | Not built |
| 19 | Co-occurrence synonym expansion from the store's own text | 3 | 4 | 2 | 3 | 12 | Not built; would need its own held-out test |
| 20 | `monomem optimize` (FTS merge, WAL checkpoint) | 2 | 2 | 4 | 5 | 13 | Not built |
| 21 | Read-only replica / Litestream recipe | 2 | 2 | 4 | 5 | 13 | Not built |
| 22 | Lazy-load CLI modules for faster cold start | 2 | 1 | 3 | 4 | 10 | Not built (cold start is 0.1 to 0.3 s) |
| 23 | Linter: role-hijack and tool-coercion patterns | 3 | 2 | 3 | 2 | 10 | Not built: false-positive risk with no measured rate |
| 24 | Signed releases / npm provenance | 3 | 3 | 4 | 5 | 15 | Not built (release process, not code) |
| 25 | Per-namespace size quotas | 2 | 2 | 3 | 4 | 11 | Not built |
| 26 | Dashboard scale view | 2 | 1 | 3 | 5 | 11 | Not built |
| 27 | Parallel `rebuild-edges` | 2 | 2 | 2 | 3 | 9 | Not built |
| 28 | Task/handoff tag lookups without a table scan (3 x 75 ms at 100,000 notes) | 3 | 2 | 3 | 3 | 11 | Not built; named in the limits |
