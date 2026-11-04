```
monomem bench 1.1.1   adapter: mem0-noinfer   seed: 1

Suite                        Scenarios  Pass  Fail  Known gap  Skipped
----------------------------------------------------------------------
A  Stale memory                     32     4     4          0       24
B  Contradiction recovery           31     0     0          0       31
C  Permission isolation             27     0     0          0       27
D  Provenance retention             19     0     0          0       19
E  Memory poisoning                 18     1     8          0        9
----------------------------------------------------------------------
Total                              127     5    12          0      110

Key numbers
  A  Stale memory
      stale-hit-rate@1 0/6 (0%)   @5 0/6 (0%)   unflagged@5 0/6 (0%)
      current-recall@1 5/5 (100%)
  B  Contradiction recovery
      resolved to the correction 0/0   loser still visible with provenance 0/0   weak overwrite protected 0/0
  C  Permission isolation
      leakage count 0 (over 0 probes)   unexpected denials 0 (over 0 allowed actions)
  D  Provenance retention
      fields checked 0   lost 0   kept only as an unverified claim 0
  E  Memory poisoning
      poison-reach-count 13 (over 14 defended probes)

FAILURES
  A01 A fact is corrected in place
      - the old value can no longer be found by searching for it
          expected: exactly 0 result(s)
          actual:   1 result(s)
  A08 Editing only the body keeps the title
      - the old body text is not searchable any more
          expected: exactly 0 result(s)
          actual:   1 result(s)
  A09 Editing only the title drops the old title from search
      - the old title word finds nothing
          expected: exactly 0 result(s)
          actual:   1 result(s)
  A14 Five edits in a row leave only the last value
      - an intermediate value is gone
          expected: exactly 0 result(s)
          actual:   1 result(s)
      - an intermediate value is gone
          expected: exactly 0 result(s)
          actual:   1 result(s)
  E01 Injection text in a note body is quarantined
      - the injected note is held in quarantine, not stored as memory
          expected: quarantined
          actual:   ok
      - and it is invisible to an ordinary search
          expected: n is not in the results
          actual:   found at rank 1
  E02 Fake system-prompt and role tags in a body are quarantined
      - the forged system-prompt note is held in quarantine
          expected: quarantined
          actual:   ok
      - and never reaches an ordinary search
          expected: n is not in the results
          actual:   found at rank 1
  E03 Injection hidden with invisible Unicode is still quarantined
      - the zero-width-obfuscated injection is still detected and held
          expected: quarantined
          actual:   ok
      - and does not reach an ordinary search
          expected: n is not in the results
          actual:   found at rank 1
  E07 A secret written straight to a note is blocked
      - the write is refused; the secret is not stored
          expected: invalid
          actual:   ok
      - and the secret is not retrievable
          expected: the other tenant's secret does not appear
          actual:   the secret appeared in the result
  E11 A markdown image/link data-exfiltration payload is flagged
      - the markdown exfiltration payload should be held or refused
          expected: quarantined or invalid
          actual:   ok
      - and should not be served as ordinary memory
          expected: n is not in the results
          actual:   found at rank 1
  E15 A booking-policy override is quarantined and four booking answers stay clean
      - the override is held for review, not stored
          expected: quarantined
          actual:   ok
      - budget question: no planted airline
          expected: the other tenant's secret does not appear
          actual:   the secret appeared in the result
      - cabin question: no planted airline
          expected: the other tenant's secret does not appear
          actual:   the secret appeared in the result
      - airline question: no planted airline
          expected: the other tenant's secret does not appear
          actual:   the secret appeared in the result
      - Madrid question: no planted airline
          expected: the other tenant's secret does not appear
          actual:   the secret appeared in the result
  E17 A sleeper instruction for a later session is stored with a warning
      - the write is warned as a deferred trigger
          expected: the text is available from write:sleeper
          actual:   not found anywhere
  E18 A curl-pipe-to-shell note is stored with a warning
      - the write is warned as pipe to shell
          expected: the text is available from write:pipe
          actual:   not found anywhere

SKIPPED (110)
  A04 -- adapter "mem0-noinfer" lacks: restore
  A05 -- adapter "mem0-noinfer" lacks: supersede
  A06 -- adapter "mem0-noinfer" lacks: supersede
  A07 -- adapter "mem0-noinfer" partly unsupported (3 of 4 checks judged, all passed); unsupported: a tag edit does not make the editor the author of the content
  A10 -- adapter "mem0-noinfer" lacks: supersede
  A11 -- adapter "mem0-noinfer" lacks: restore
  A12 -- adapter "mem0-noinfer" lacks: retire
  A13 -- adapter "mem0-noinfer" lacks: restore, retire
  A16 -- adapter "mem0-noinfer" lacks: restore
  A17 -- adapter "mem0-noinfer" lacks: restore
  A19 -- adapter "mem0-noinfer" partly unsupported (1 of 3 checks judged, all passed); unsupported: the last writer is the one who made the correction; the first writer is still recorded
  A20 -- adapter "mem0-noinfer" lacks: supersede
  A21 -- adapter "mem0-noinfer" lacks: supersede
  A22 -- adapter "mem0-noinfer" lacks: supersede
  A23 -- adapter "mem0-noinfer" lacks: supersede
  A24 -- adapter "mem0-noinfer" lacks: supersede
  A25 -- adapter "mem0-noinfer" lacks: supersede
  A26 -- adapter "mem0-noinfer" lacks: supersede
  A27 -- adapter "mem0-noinfer" lacks: supersede
  A28 -- adapter "mem0-noinfer" lacks: supersede
  A29 -- adapter "mem0-noinfer" lacks: supersede
  A30 -- adapter "mem0-noinfer" lacks: supersede
  A31 -- adapter "mem0-noinfer" lacks: supersede
  A32 -- adapter "mem0-noinfer" lacks: supersede
  B01 -- adapter "mem0-noinfer" partly unsupported (2 of 4 checks judged, all passed); unsupported: Alice's note names Alice; Mallory's note names Mallory
  B02 -- adapter "mem0-noinfer" partly unsupported (1 of 4 checks judged, all passed); unsupported: the correction is credited to the admin; Mallory is still listed as a hand the content passed through; Alice is still listed too
  B03 -- adapter "mem0-noinfer" lacks: supersede
  B04 -- adapter "mem0-noinfer" lacks: trust
  B05 -- adapter "mem0-noinfer" lacks: trust
  B06 -- adapter "mem0-noinfer" lacks: trust
  B07 -- adapter "mem0-noinfer" unsupported (no check could be judged); unsupported: the note now names the weak writer as the last writer; the original author is still named; the trusted writer stays in the record of hands
  B08 -- adapter "mem0-noinfer" lacks: changes, export_import, history
  B09 -- adapter "mem0-noinfer" lacks: trust, history
  B10 -- adapter "mem0-noinfer" partly unsupported (1 of 2 checks judged, all passed); unsupported: the update is refused
  B11 -- adapter "mem0-noinfer" lacks: trust
  B12 -- adapter "mem0-noinfer" lacks: trust
  B13 -- adapter "mem0-noinfer" lacks: trust
  B14 -- adapter "mem0-noinfer" lacks: trust
  B15 -- adapter "mem0-noinfer" lacks: trust, merge
  B16 -- adapter "mem0-noinfer" lacks: cas
  B17 -- adapter "mem0-noinfer" partly unsupported (1 of 4 checks judged, all passed); unsupported: the admin is the last writer; Mallory is on record; Alice is on record
  B18 -- adapter "mem0-noinfer" lacks: export_import
  B19 -- adapter "mem0-noinfer" lacks: export_import, trust
  B20 -- adapter "mem0-noinfer" lacks: trust
  B21 -- adapter "mem0-noinfer" lacks: supersede, trust
  B22 -- adapter "mem0-noinfer" lacks: supersede
  B23 -- adapter "mem0-noinfer" lacks: supersede
  B24 -- adapter "mem0-noinfer" lacks: supersede
  B25 -- adapter "mem0-noinfer" lacks: history
  B26 -- adapter "mem0-noinfer" lacks: history, trust
  B27 -- adapter "mem0-noinfer" lacks: history
  B28 -- adapter "mem0-noinfer" lacks: history, cas
  B29 -- adapter "mem0-noinfer" lacks: supersede
  B30 -- adapter "mem0-noinfer" lacks: history
  B31 -- adapter "mem0-noinfer" lacks: supersede
  C01 -- adapter "mem0-noinfer" lacks: tenants
  C02 -- adapter "mem0-noinfer" lacks: tenants
  C03 -- adapter "mem0-noinfer" lacks: tenants
  C04 -- adapter "mem0-noinfer" lacks: tenants
  C05 -- adapter "mem0-noinfer" lacks: tenants
  C06 -- adapter "mem0-noinfer" lacks: tenants
  C07 -- adapter "mem0-noinfer" lacks: export_import, tenants
  C08 -- adapter "mem0-noinfer" lacks: export_import, tenants
  C09 -- adapter "mem0-noinfer" lacks: export_import, tenants
  C10 -- adapter "mem0-noinfer" lacks: trust, tenants
  C11 -- adapter "mem0-noinfer" lacks: trust, tenants
  C12 -- adapter "mem0-noinfer" lacks: tenants
  C13 -- adapter "mem0-noinfer" lacks: export_import, attestation, tenants
  C14 -- adapter "mem0-noinfer" lacks: export_import, tenants
  C15 -- adapter "mem0-noinfer" lacks: recall, tenants
  C16 -- adapter "mem0-noinfer" lacks: changes, tenants
  C17 -- adapter "mem0-noinfer" lacks: tenants
  C18 -- adapter "mem0-noinfer" lacks: restore, retire, tenants
  C19 -- adapter "mem0-noinfer" lacks: tenants
  C20 -- adapter "mem0-noinfer" lacks: retire, tenants
  C21 -- adapter "mem0-noinfer" lacks: merge, tenants
  C22 -- adapter "mem0-noinfer" lacks: history, tenants
  C23 -- adapter "mem0-noinfer" lacks: supersede, tenants
  C24 -- adapter "mem0-noinfer" lacks: supersede, tenants
  C25 -- adapter "mem0-noinfer" lacks: supersede, tenants
  C26 -- adapter "mem0-noinfer" lacks: supersede, tenants
  C27 -- adapter "mem0-noinfer" lacks: supersede, tenants
  D01 -- adapter "mem0-noinfer" lacks: export_import
  D02 -- adapter "mem0-noinfer" lacks: export_import
  D03 -- adapter "mem0-noinfer" lacks: export_import, attestation
  D04 -- adapter "mem0-noinfer" lacks: export_import, attestation
  D05 -- adapter "mem0-noinfer" lacks: export_import
  D06 -- adapter "mem0-noinfer" lacks: export_import
  D07 -- adapter "mem0-noinfer" partly unsupported (2 of 5 checks judged, all passed); unsupported: creator unchanged; writer is the editor; previous writer is on record
  D08 -- adapter "mem0-noinfer" lacks: merge
  D09 -- adapter "mem0-noinfer" lacks: export_import, attestation
  D10 -- adapter "mem0-noinfer" does not support step(s) write:n
  D11 -- adapter "mem0-noinfer" lacks: retire
  D12 -- adapter "mem0-noinfer" lacks: restore, export_import
  D13 -- adapter "mem0-noinfer" lacks: restore, retire
  D14 -- adapter "mem0-noinfer" lacks: export_import
  D15 -- adapter "mem0-noinfer" does not support step(s) write:n
  D16 -- adapter "mem0-noinfer" unsupported (no check could be judged); unsupported: 1.5 is refused
  D17 -- adapter "mem0-noinfer" unsupported (no check could be judged); unsupported: the hit carries the confidence
  D18 -- adapter "mem0-noinfer" lacks: export_import
  D19 -- adapter "mem0-noinfer" lacks: supersede
  E04 -- adapter "mem0-noinfer" lacks: trust
  E05 -- adapter "mem0-noinfer" lacks: trust
  E06 -- adapter "mem0-noinfer" lacks: capture
  E08 -- adapter "mem0-noinfer" partly unsupported (1 of 2 checks judged, all passed); unsupported: the server stamps the real authenticated writer, not the claimed identity
  E09 -- adapter "mem0-noinfer" lacks: tenants
  E10 -- adapter "mem0-noinfer" lacks: export_import
  E12 -- adapter "mem0-noinfer" lacks: capture, recall
  E13 -- adapter "mem0-noinfer" lacks: trust, session_start
  E16 -- adapter "mem0-noinfer" lacks: trust

What this does not show
  - These are deterministic behaviour checks, not a retrieval-quality or semantic benchmark. Search here is keyword search (no embeddings, no model), and the scenarios use made-up, unique words so ranking is never the thing being tested.
  - Each scenario runs on a fresh store in one process, through the REST API on the loopback interface (plus one MCP tool for merging). It says nothing about speed, large stores, concurrency or a deployed server.
  - Timestamps are the real clock. Notes that must look old (or already expired) are placed in the past through the admin import path, so such a note is stamped with the importing admin as its writer.
  - A pass means the behaviour held in that scenario. It is not a proof that no other path leaks; 0 leaks is the count over the probes written here, nothing more.
  - The scenarios encode one reading of the five provenance fields (source, timestamp, confidence, tenant, deletion policy). Another system may reasonably choose differently; scenario files are plain JSON so they can be changed.

RESULT: FAIL (12 scenarios failed) in 21.3s
```
