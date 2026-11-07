# Search, recall and memory hygiene

## Semantic search (optional)

Keyword (FTS5) search is the default and needs nothing extra. Turn on
meaning-based search and the bridge will also embed each note so a query like
*"canine companion"* finds a note about your dog that shares no words with it:

```bash
export MONOMEM_EMBEDDINGS=on
export MONOMEM_EMBED_URL=http://localhost:11434/v1/embeddings  # Ollama default
export MONOMEM_EMBED_MODEL=nomic-embed-text
node dist/src/cli.js reindex   # backfill embeddings for existing notes
```

Embeddings come from **your own** OpenAI-compatible endpoint (local Ollama,
or any OpenAI-shaped `/v1/embeddings` API) — still zero native modules, still
nothing sent to a third party you didn't configure. `state_search` /
`GET /search` then accept `mode=keyword | semantic | hybrid` (hybrid fuses
both with Reciprocal Rank Fusion). If the endpoint is unavailable, search and
writes silently fall back to keyword — an optional embedder can never fail a
write or a query.

## How keyword search ranks

`state_search` (and `GET /search`, `memory_index`) first looks for notes containing
**every** word of the query, as typed. If that leaves room under the limit and the query has
two or more keywords (or one that a suffix trim widens), it adds notes matching **some** of
them, ranked by BM25 (rarer words count more), always below the full matches. So a short
exact query behaves as it always did, and a whole question ("what port is my staging
server on?") still finds the note. With several namespaces, the full matches of all of
them come before any partial match.

Each query word is a prefix match (`deploy` also finds `deployment`). Since 1.2.0, in the
some-of-the-words step, a plain English word of 5+ letters also loses a common suffix
(`recommendations` searches as `recommend*`, `deployed` as `deploy*`, `boxes` as `box*`).
`-er`, `-ly` and `-ment` are never trimmed, and words such as `evening` and `species`
keep their ending. Words with digits, punctuation, `#tags`, short words and non-ASCII
words are searched as typed.

A query is cut to its first 4,096 characters and 64 words; the API and MCP refuse a
longer one with an error. Scores on LongMemEval-S and LoCoMo: [BENCHMARK.md](./BENCHMARK.md#retrieval-longmemeval-s-and-locomo).

## Query repair

Keyword search matches words as typed (by prefix), which misses four common ways of searching. Since 1.3.0, when a short
query (4 words or fewer) leaves room under the limit, Monomem looks at the words the index actually holds (SQLite's `fts5vocab`
view; no second index, no migration, nothing added to the database file) and adds the closest matches:

| You type | The note says | What happens |
|---|---|---|
| `postgress` | `Postgres` | a word that matches nothing is replaced by an indexed word one edit away (two for words of 9+ letters, same first letter) |
| `ratelimit` | `rate-limit` | split into two indexed words |
| `rate limit` | `RateLimiter` | two words that an indexed word spells together |
| `connection reset` | `ECONNRESET` | (only when nothing else matched) an indexed word holding the start of each |
| `东京` | `我们决定去东京旅行` | the tokenizer keeps a run of Chinese, Japanese or Korean text as one word, so a CJK query word is matched inside the indexed runs that contain it; two-character CJK words are now kept as keywords |

The repaired search runs in addition to the normal one and its hits are merged in; a word that already matches something is never
replaced, and a longer question (more than 4 words) is not repaired except for CJK words, because one word missing from the
index is normal in a question and repairing it lowered LoCoMo recall. `MONOMEM_REPAIR=off` turns it off. The vocabulary is the
whole index, but the repaired query is filtered by the same namespace, trust and time rules as any search, so it can only
return what the caller may read. Numbers: [BENCHMARK.md](./BENCHMARK.md#coding-agent-recall-and-passages-130).

**On a big store (1.4.0).** Repair reads the index's vocabulary, which costs time in proportion to the index: about 50 ms for a missed
query at 5,000 notes and 350 ms at 100,000. Above 2,000 notes (`MONOMEM_REPAIR_FULL_MAX_NOTES`) it narrows: a misspelt word must keep its
first two letters (it was one), the abbreviation step (`connection reset` finds `ECONNRESET`) is skipped, and CJK words get 4
vocabulary scans per query instead of 12. A missed query then costs about a millisecond more than with repair off (20,000 notes:
1.4 ms against 1.1 ms; 113 ms with the full scan).

## Passages: the paragraph, not the whole note

`state_search` returns whole notes, and a long note costs its full length in the agent's context even when one paragraph answers
the question. With `passages: true` (MCP) or `?passages=1` (REST), and `monomem search --passages`, each result comes back
without its body and with the best-matching passages instead, within a token budget (`max_tokens`, default 1,500, about 4
characters a token; `?max_tokens=` on REST):

```
state_search { query: "what pool mode does pgbouncer use", passages: true, max_tokens: 300 }
-> results: [{ id: 12, title: "Database: Postgres connection pooling", body_omitted: true, body_chars: 1010,
               passages: [{ start: 188, end: 420, text: "## Decision\nPgBouncer runs in transaction mode ...", score: 3.1 }] }],
   passage_tokens: 112
```

A chat-style body ("user: ...", "assistant: ...") splits at each turn; anything else at blank lines; a block over 900 characters is cut
at a line or sentence break. Passages are scored with BM25 over the passages of the returned notes (prefix match, so `deploy`
finds `deployment`; typos and compounds that query repair fixed count too), the best one also brings its next passage when
there is room, and a note whose passages match nothing still shows its opening. `start`/`end` are character offsets in the
note body, and the note keeps its `id`, so `state_read` fetches the whole thing. Passages are chosen from the notes the search
already returned, so permissions, trust and staleness rules are unchanged. It only helps on long notes: on one-line notes there is
nothing to cut. On REST, `explain=1` returns whole bodies (passages apply to the plain response). It adds about 120 tokens to the tool schema the model reads every turn.

## Time-aware search

`state_search` takes an optional `when` parameter (and `GET /search` takes
`?when=`) with a natural-language time phrase. It scopes results to notes
**created** in that window; keywords still rank within it. An unrecognized
phrase is ignored — the query runs unscoped rather than erroring.

```
state_search({ query: "budget", when: "yesterday evening" })
state_search({ query: "",      when: "last week" })   # time-only: newest-first list of the range
GET /search?q=invoice&when=Oct+14
```

Supported phrases (case-insensitive, found anywhere in the string, so
`"yesterday about the budget"` works — the time part scopes, the rest ranks):

- `today`, `yesterday`, `3 days ago`, `a day ago`
- `last week` / `this week` (weeks start **Monday**), `last month` / `this month`
- `in july`, `in july 2025` (bare month = most recent such month, never future)
- Dayparts: `this morning`, `yesterday evening`, `tonight`, `last night`
  (morning 05–12, afternoon 12–17, evening 17–22, night 22–05 next day;
  `tonight` = 17:00 → 05:00 next day)
- Clock times: `around 3pm`, `at 14:30`, `3pm yesterday` (±30 min window)
- Absolute: `2026-10-14`, `Oct 14`, `October 14 2025`, `10/14/2026`
  (numeric dates are **MM/DD**; a missing year means the most recent past occurrence)

Day boundaries are computed in your timezone: set `MONOMEM_TIMEZONE`
(e.g. `America/Winnipeg`, default: the host's system timezone). Invalid names fall back to UTC.

## Relevant-memory search

Don't know the exact wording? `state_relevant` takes a natural conversational
message, extracts keywords from it (lowercase, stop-words removed, hashtags
like `#status` kept as-is), and returns notes matching **any** of them —
a deliberately permissive OR search. Results are ranked by one BM25 query
over those keywords (since 1.2.0), so a note matching more of the rarer
keywords ranks higher than a passing mention of a common one. The extracted keywords
are returned alongside the results so you can see what was searched.

```
state_relevant({ message: "what did we decide about the acme launch?" })
# -> { keywords: ["decide", "acme", "launch"], results: [...] }
```

Same over HTTP: `POST /relevant` with `{ message, limit?, namespace? }`
(read-scoped), and on the CLI: `monomem relevant "some message" [--limit 5]`.

## Staleness detection

Facts go stale. `state_read` and `state_search` (and `GET /notes/:id`,
`GET /search`) annotate every note with `stale: boolean` and
`ageDays: number` (whole days since `updated_at` — the most recent write
wins). When a note is stale, a `staleWarning` string is included, e.g.:

> "This note is 45 days old (tagged #status, expires after 30 days).
> Verify against current state before acting on it."

Stale notes are never hidden or deleted — they stay findable, but search
ranks them slightly lower (their score is multiplied by 0.9), so a fresh
note with comparable relevance wins. Agents should verify a stale note
against current state before acting on it.

**A stale note stays behind its newer twin (1.6.0).** The 0.9 factor is mild, so a 200-day-old note that matches the words better could still
come first. Now, when a stale note has a newer, fresh note that is *about the same thing* (the two are linked as similar notes), the stale one is
placed right behind the lowest-ranked of its fresh newer twins. It is still returned and still flagged, and `explain` says "Kept behind the newer note #N on the same topic."
A stale note that people keep reading (a clearly active read signal) keeps the place its reads earned. Notes that are not similar to anything are
untouched. To remove an out-of-date note from search entirely, replace it ([replacing-memories.md](./replacing-memories.md)).

Thresholds (env vars, read live — no restart needed to retune):

| Variable | Default | Meaning |
|---|---|---|
| `MONOMEM_STALE_DAYS` | `90` | Notes older than this (by `updated_at`) are stale |
| `MONOMEM_STALE_TAGS` | `#status` | Comma-separated tags that expire faster (matched with or without `#`) |
| `MONOMEM_STALE_TAG_DAYS` | `30` | Expiry for notes carrying a stale tag |
| `MONOMEM_ACCESS_BOOST` | on | Set to `0` to turn off the access-count boost and staleness penalty in search ranking (results then follow native relevance only, as in 1.0.0); access counts are still recorded |

Invalid values fall back to the defaults. Staleness is per-note and
namespace-agnostic — it never crosses (or needs to know about) namespace
isolation boundaries.

## Consolidation (dedup)

Agents re-storing the same fact ("our API base URL is …" saved three times
in slightly different words) bloats the store and muddies search results.
Consolidation finds near-duplicates by **cosine similarity over
term-frequency vectors** (title + body, lowercase, stopwords removed;
Jaccard available as a secondary metric — zero new dependencies) and merges
them: longest title wins, bodies are deduplicated and joined with `---`,
tags are unioned.

**Candidate detection never crosses namespaces** — namespaces are an
isolation boundary, so a pair is only ever suggested when both notes live in
the same one. Detection is O(n²) and capped: beyond 2,000 notes (or ~2 MB
of title + body text) only the most recently created notes are scanned.

MCP tools:

| Tool | Scope | What it does |
|---|---|---|
| `memory_consolidation_candidates` | **admin** | Lists near-duplicate pairs (score ≥ threshold, default 0.95) with both titles so the model can judge. Admin because the scan is O(n²) CPU; one scan runs at a time, under a 15 s budget, and stops if the client disconnects |
| `memory_consolidate` | **admin** | Merges 2+ ids into one note. `dry_run: true` previews the merge without writing; `keep_sources: true` skips deleting the originals. Gated at admin because it deletes, like `state_delete`. |

CLI (safe by default — reports only, unless you opt in):

```bash
node dist/src/cli.js consolidate                          # list candidates
node dist/src/cli.js consolidate --dry-run                # preview each merge
node dist/src/cli.js consolidate --yes                    # actually merge
node dist/src/cli.js consolidate --threshold 0.98 --namespace acme
```

**Scheduled auto-consolidation** (opt-in):

```bash
export MONOMEM_AUTO_CONSOLIDATE_INTERVAL=24h   # or "30m", "90s", "3600" (seconds)
```

When set, `monomem start` runs a background pass on that interval that
**logs** every candidate pair ≥ 0.95 for review — and only auto-merges pairs
scoring **≥ 0.99** (near-identical notes, e.g. the same fact saved twice
verbatim). Weaker duplicates are never merged blindly; review them with
`memory_consolidation_candidates` or the CLI. The scheduler never throws: a
background janitor must not take down the server.
