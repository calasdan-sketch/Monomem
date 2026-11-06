# Provenance benchmark: Monomem vs. two other memory systems

**Internal draft — not for publication until the owner approves.**

Date: 2026-11-04. Seed: 1. Scenarios: the 127 in `bench/scenarios/` (suites A–E). Same engine, same scenario
files, same seed for every system. Raw reports: `bench/results/<system>-2026-11-04.md` and `.json`.

## Who wrote this benchmark

The benchmark, its scenarios and its reading of "provenance" were written by the Monomem project, around the
behaviour Monomem was built to have. The other two systems do not claim most of these behaviours. A large
"unsupported" count below is therefore expected and is not a defect in those systems; it means the scenario tests a
concept the system does not have. Read the fail column, and read why each fail failed (listed below).

## How a scenario is counted

- **pass**: every check held.
- **fail**: at least one check the system could be judged on did not hold.
- **unsupported**: the scenario needs an operation the system does not offer (a capability it does not declare),
  or every check it could be judged on passed but some checks were on a concept the system lacks (for example a
  server-stamped writer, a read-only credential, a confidence field). Such checks are never counted as passed.
  The engine change that makes this possible is in `src/bench/engine.ts` (`unsupportedIf`) and is covered by
  `test/bench-competitors.test.ts`.

## Results per suite

| Suite | Monomem 1.1.1 (pass / fail / unsupported) | Official MCP memory server 2.0.1 | Mem0 2.2.1, infer=False | Mem0 2.2.1, infer=True (default) |
|---|---|---|---|---|
| A Stale memory (32) | 32 / 0 / 0 | 8 / 0 / 24 | 4 / 4 / 24 | not run (see below) |
| B Contradiction recovery (31) | 31 / 0 / 0 | 0 / 0 / 31 | 0 / 0 / 31 | not run |
| C Permission isolation (27) | 27 / 0 / 0 | 0 / 0 / 27 | 0 / 0 / 27 | not run |
| D Provenance retention (19) | 19 / 0 / 0 | 0 / 0 / 19 | 0 / 0 / 19 | not run |
| E Memory poisoning (18) | 18 / 0 / 0 | 1 / 8 / 9 | 1 / 8 / 9 | not run |
| **Total (127)** | **127 / 0 / 0** | **9 / 8 / 110** | **5 / 12 / 110** | not run |

Of the "unsupported" scenarios, 11 per competitor were run and every judged check passed, but other checks were on
concepts the system lacks (A07, A19, B01, B02, B07, B10, B17, D07, D16, D17, E08). The rest were not run because they
need an operation the system does not offer (tenants, trust/distrust, replace, history, merge, archive/expiry,
export/import, attestation, capture, recall, change feed, SessionStart injection, placing notes in the past).

## Every failure, with the reason

**Official MCP memory server** (8, all in suite E):

- E01, E02, E03, E11, E15: an injection / forged system-prompt / zero-width-obfuscated / markdown-exfiltration /
  booking-override note is stored and returned by search. The server has no write-time content filter.
- E07: a note containing a secret is stored and returned. No secret check on write.
- E17, E18: a sleeper-trigger note and a curl-pipe-to-shell note are stored without a warning. No warnings exist.

**Mem0, infer=False** (12):

- The same 8 suite-E failures as above, for the same reason: no write-time filter, no secret check, no warnings.
- A01, A08, A09, A14: a search for the *old* value must return 0 results; Mem0 returns 1. In each case the one hit
  is the updated note itself (these scenarios hold a single note, and the stale-hit counters are 0/6), so no old
  value was served. The failure comes from vector search returning the nearest note above Mem0's default similarity
  threshold (0.1) for any query, while the scenario assumes keyword search where an unknown word finds nothing.
  This is a mismatch between the scenario's assumption and vector search, not stale data.

**Monomem**: no failures. There is **no scenario where Monomem fails and a competitor passes.**

Poisoning headline (`poison-reach-count`, over the defended probes each system was judged on): Monomem 0 of 34;
official server 13 of 14; Mem0 infer=False 13 of 14. Stale memory: no stale value was served in the top 5 by any
system on the queries each could be judged on (Monomem 15 queries, the others 6).

A note on suite E: the task brief asked that quarantine be reported as "unsupported". The write itself is an
operation both systems support, and the poisoned note then reaches an ordinary search, which is the thing suite E
measures, so these are counted as fails with the reason stated. Reclassifying them as unsupported would be a
one-line policy change; the owner should decide which reading to publish.

## Mem0 with its default infer=True: not run, and why

Mem0's default `add()` sends the text to an LLM, which extracts facts and stores those (reworded). This is what Mem0
users get by default, so it is the variant that matters most. It was set up (Ollama `qwen2.5:7b`, temperature 0,
`nomic-embed-text` embeddings) and works: a test add of "Deploy region for bakomu42 / Deploys to fasoli17." was stored
as the memory "User deploys bakomu42 to fasoli17". But on this machine during this run Ollama was serving every model
on the CPU (`/api/ps` showed `size_vram: 0`, GPU at 5% use) and was also holding `gpt-oss:20b` for other local
programs. One Mem0 add took 552 s, and a bare "Say hi" to `qwen2.5:7b` took 7 min 33 s. The 127 scenarios need
several hundred adds (A18 alone writes 20 distractor notes), which would take days. It was not run rather than run on
a cherry-picked subset. To run it once Ollama uses the GPU: `npm run build && node bench/run-competitors.mjs mem0`.

Expected differences when it is run (not measured, do not quote): the reworded text will fail checks that compare a
body exactly, a note may become zero or several memories, and LLM output can vary between runs even at temperature 0.

## How each system was driven (summary; full mapping in each adapter's header comment)

- **Monomem**: its own reference adapter (`src/bench/monomem-adapter.ts`), REST over loopback plus one MCP tool.
- **Official MCP memory server** (`@modelcontextprotocol/server-memory@2.0.1`, run with `npx` as a stdio MCP server,
  fresh process and fresh `MEMORY_FILE_PATH` per scenario; adapter `src/bench/competitors/official-memory-adapter.ts`).
  One note = one entity (name = title + unique suffix, because the server skips a duplicate name), body/tags/source
  as observations. The server's `search_nodes` matches the whole query as one substring; the adapter charitably
  sends one `search_nodes` per query word and ranks by words matched. Version 2.1.0 was published on the day of the
  run; its diff was reviewed and the search logic is unchanged apart from an optional limit.
- **Mem0** (`mem0ai` 2.2.1 from PyPI, `qdrant-client` 1.20.0 local on-disk mode, no server; Python 3.12.10 bridge
  `bench/mem0_bridge.py` speaking JSON lines; adapter `src/bench/competitors/mem0-adapter.ts`). Telemetry off
  (`MEM0_TELEMETRY=False`), `MEM0_DIR` inside the repo's ignored `.venv-bench`, no cloud key. A note is written as
  "title\nbody" with metadata {title, tags, source}; all actors share one `user_id` scope. Plain `pip install mem0ai`
  has no spaCy/fastembed, so Mem0 disables its BM25 keyword search and search is vector-only; that default install
  is what was measured.
- Neither competitor has credentials, so a read-only actor's write is reported as unsupported rather than executed.

## Limits

- One run per system, one seed, one machine (Windows 11 Home, Node 24.18.0). Monomem and the official server are
  deterministic here; Mem0 infer=False depends only on the embedding model (`nomic-embed-text`, local).
- The scenarios use made-up unique words and tiny stores; they say nothing about retrieval quality, speed or scale.
- Adapter mapping choices affect results. They are documented in each adapter and are meant to be charitable; a
  maintainer of either system may map differently.
- Monomem's version string is the `package.json` version on branch `release/next` (base commit 27d13fe).
