# Poisoning corpus

`poisoning-corpus.json` holds the memory-poisoning attacks that `monomem drill` replays: the suite-E scenarios from
`bench/scenarios/` plus one self-poisoning case. MIT licensed. Regenerate it with `npm run build && node scripts/export-poison-corpus.mjs`.

## Format

```
{ "format": "poisoning-corpus/1", "license": "MIT", "attacks": [ ... ] }
```

Each attack:

- `id`, `title`, `what`: which attack and why it matters.
- `actors`: who takes part, with a `scope` (`read`, `write`, `admin`) and optionally a `writer` label or `namespace`.
- `needs`: capabilities the memory system must have (for example `trust`); skip the attack when it lacks one.
- `steps`: operations in order (`write`, `search`, `distrust`, `capture`, ...). `as` names the actor, `ref` and `id`
  name results for later steps.
- `expect`: what a defended system should show. A check with `"metric": "poison_reach"` is a defence check: failing it
  means poison reached the agent. Checks without `metric` are context checks (for example "the write was accepted").
- `designed_miss`: present when Monomem is expected NOT to stop this attack (E16, self-poisoning).

Placeholders `{{proj}}`, `{{tok}}`, `{{good}}`, `{{bad}}` stand for made-up words; use a different fresh word per attack
and per run, the same word in every place inside one attack. The step and check semantics are defined in
`src/bench/types.ts` and `docs/BENCHMARK.md`.

To run it against another memory system, map `steps` onto its write, search and admin calls and evaluate `expect`.
This folder makes no claim about how any other system performs.

## Prior work

This corpus builds on public research into memory poisoning, and we credit it here without claiming to match or extend it: sleeper
triggers (an instruction stored now that fires in a later session), MINJA (memory injection through ordinary queries), Trojan Hippo,
and the OWASP framing of this risk as ASI06, memory and context poisoning. Search for those names to find the original papers and write-ups.
