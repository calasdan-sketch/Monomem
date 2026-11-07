// Query repair from the index's own vocabulary.
//
// Keyword search matches words exactly (by prefix). That misses the four ways people really type a query:
//   - a typo:                 "postgress"           vs a note that says "postgres"
//   - a split/joined compound: "ratelimit"           vs "rate-limit"   (and "rate limit" vs "ratelimiter")
//   - an abbreviation/constant: "connection reset"    vs "ECONNRESET"
//   - CJK text:               "东京"                 vs "我们决定去东京旅行" (the tokenizer keeps a CJK run as ONE word)
// The fix needs no model and no second index. SQLite's fts5vocab view lists every term the index holds, so a query
// word that matches nothing is replaced by the closest indexed words, and a pair of words by an indexed term they
// spell together. The repaired search runs IN ADDITION to the normal one: its hits are merged in, never substituted.
//
// Guardrails: a word that already matches something is never "repaired" into another word; typo candidates must share
// the first letter and be one edit away (two for words of nine letters or more); candidate lists are capped; every
// term that reaches the FTS5 expression is quoted. Namespaces: the vocabulary is the whole index, but the repaired
// query is filtered by the same namespace/trust SQL as any search, so it can only ever return what the caller may read.

import { buildMatchQuery, type Store } from "./store.js";

/** Kana, CJK ideographs (incl. extension A) and Hangul: scripts whose words are not separated by spaces. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/u;
export const hasCjk = (s: string): boolean => CJK_RE.test(s);

/** Query repair (typos, compounds, CJK, abbreviations) is on unless MONOMEM_REPAIR=off. */
export function repairEnabled(): boolean {
  return (process.env.MONOMEM_REPAIR ?? "").trim().toLowerCase() !== "off";
}

const quote = (t: string): string => `"${t.replace(/"/g, '""')}"`;
const quotePrefix = (t: string): string => `${quote(t)}*`;
/** The index folds case and strips accents; so does the check against its vocabulary. */
const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Above this many notes (highest id, so a deleted-heavy store counts as big), the vocabulary scans are narrowed: a typo
 * must keep its first TWO letters, and the abbreviation scan is skipped. Reading the vocabulary costs time in proportion
 * to the index (about 350 ms for three misspelt words at 100,000 notes, 50 ms at 5,000); this keeps a miss at a few milliseconds there.
 * MONOMEM_REPAIR_FULL_MAX_NOTES (default 2,000).
 */
export function repairFullMaxNotes(): number {
  const v = process.env.MONOMEM_REPAIR_FULL_MAX_NOTES;
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2_000;
}

const MAX_TYPO_CANDIDATES = 2;
const MAX_CJK_TERMS_PER_GRAM = 8;
const MAX_CJK_TERMS = 40;
const MAX_CJK_GRAMS = 16;
const MAX_JOIN_PAIRS = 8;
const MAX_REPAIR_WORD = 40;
/** Vocabulary scans for CJK words, in total for one query. */
const MAX_CJK_SCANS = 12;
const MAX_CJK_SCANS_BIG = 4;

/** Optimal-string-alignment distance (insert, delete, substitute, adjacent swap), giving up above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

export interface RepairPlan {
  /** All-terms expression with each repaired word swapped for its alternatives; null when nothing was repaired. */
  strictExpr: string | null;
  /** Extra alternatives to OR into the any-keyword query. */
  looseExtra: string[];
  /** Human-readable repairs, for tests and debugging. */
  notes: string[];
  /** The plain (non-CJK) indexed words the repairs use, so passage scoring can match them too. */
  terms: string[];
}

/** One query word, resolved against the index. */
interface Unit {
  /** FTS5 expression that stands for this word (the word itself when it needed no repair). */
  expr: string;
  repaired: boolean;
  kw: string;
  /** Alternatives to add to a looser (OR) query. */
  alts: string[];
  words?: string[];
}

function cjkUnit(store: Store, kw: string, notes: string[], budget: { scans: number }): Unit {
  const own = quotePrefix(kw);
  const terms = new Map<string, number>();
  const take = (gram: string, cap: number): void => {
    if (budget.scans <= 0) return; // each scan walks the whole vocabulary: bounded per query, not per word
    budget.scans--;
    for (const t of store.vocabTerms({ like: `%${likeEscape(gram)}%`, limit: cap })) {
      if (terms.size >= MAX_CJK_TERMS) return;
      terms.set(t.term, t.doc);
    }
  };
  const chars = [...kw];
  if (chars.length <= 2) take(kw, MAX_CJK_TERMS);
  else {
    if (chars.length <= MAX_REPAIR_WORD) take(kw, MAX_CJK_TERMS); // the whole run, if some indexed word contains it
    // The indexed word may be a longer run holding only part of the question: look for its two-character pieces.
    for (let i = 0; i + 1 < chars.length && i < MAX_CJK_GRAMS; i++) take(chars[i] + chars[i + 1], MAX_CJK_TERMS_PER_GRAM);
  }
  const found = [...terms.keys()].filter((t) => t !== kw);
  if (!found.length) return { expr: own, repaired: false, kw, alts: [] };
  notes.push(`${kw} -> ${found.length} indexed CJK word(s)`);
  const alts = found.map(quote);
  return { expr: `(${[own, ...alts].join(" OR ")})`, repaired: true, kw, alts };
}

/** Closest indexed words to a word that matches nothing: split into two indexed words, or a near-typo. */
function wordUnit(store: Store, kw: string, notes: string[]): Unit {
  const own = quotePrefix(kw);
  const plain: Unit = { expr: own, repaired: false, kw, alts: [] };
  if (kw.startsWith("#") || !/^[\p{L}\p{N}]+$/u.test(kw)) return plain;
  const f = fold(kw);
  // A long token is an identifier or a flood, not a typo: the split search below is quadratic in its length.
  if (f.length < 4 || f.length > MAX_REPAIR_WORD || store.vocabHasTerm(f)) return plain;
  const prefixHit = store.vocabHasPrefix(f);
  const alts: string[] = [];
  const words: string[] = [];
  // Compound split: "ratelimit" -> rate + limit (the note says "rate-limit", indexed as two words).
  let bestSplit: { a: string; b: string; score: number } | null = null;
  // Tried even when the word is the start of a longer indexed word ("ratelimit" -> "ratelimiter"), because the note
  // that spells it with a hyphen is a different match.
  for (let k = 3; f.length >= 6 && k <= f.length - 3; k++) {
    const a = f.slice(0, k);
    const b = f.slice(k);
    if (!store.vocabHasTerm(a) || !store.vocabHasPrefix(b)) continue;
    const score = Math.min(a.length, b.length);
    if (!bestSplit || score > bestSplit.score) bestSplit = { a, b, score };
  }
  if (bestSplit) {
    alts.push(`(${quote(bestSplit.a)} AND ${quotePrefix(bestSplit.b)})`);
    words.push(bestSplit.a, bestSplit.b);
    notes.push(`${kw} -> ${bestSplit.a} + ${bestSplit.b}`);
  }
  // Typo: same first letter, one edit away (two for long words).
  const maxD = f.length >= 9 ? 2 : f.length >= 5 ? 1 : 0;
  if (maxD > 0 && !prefixHit) {
    const big = store.approxNotes() > repairFullMaxNotes();
    const cands = store
      .vocabTerms({ startsWith: big ? f.slice(0, 2) : f[0], minLen: f.length - maxD, maxLen: f.length + maxD, limit: 3000 })
      .map((c) => ({ ...c, d: editDistance(f, c.term, maxD) }))
      .filter((c) => c.d <= maxD && c.term !== f)
      .sort((x, y) => x.d - y.d || y.doc - x.doc)
      .slice(0, MAX_TYPO_CANDIDATES);
    for (const c of cands) {
      alts.push(quotePrefix(c.term));
      words.push(c.term);
      notes.push(`${kw} -> ${c.term}`);
    }
  }
  if (!alts.length) return plain;
  return { expr: `(${[own, ...alts].join(" OR ")})`, repaired: true, kw, alts, words };
}

/**
 * Plan the repaired queries for a list of query keywords (already lower-cased, stop-words removed).
 * `abbreviations` additionally tries to read two short words as an abbreviation/constant ("connection reset" ->
 * ECONNRESET); it scans the vocabulary, so callers turn it on only when the normal search found nothing.
 * Returns null when there is nothing to add, so the common case costs one prefix lookup per word.
 */
export function planRepair(store: Store, keywords: string[], o: { abbreviations?: boolean } = {}): RepairPlan | null {
  if (!keywords.length || typeof store.vocabHasTerm !== "function") return null; // not a real Store (a test double)
  try {
    return planRepairInner(store, keywords, o);
  } catch {
    return null; // repair is a bonus: whatever goes wrong, the ordinary search stands
  }
}

/**
 * Typo, compound and abbreviation repair is for SHORT lookups (this many words or fewer). In a whole question one word
 * missing from the index is normal, not a typo, and repairing it added noise on LoCoMo (R@5 down 0.6) with no gain.
 * CJK words are always repaired: their only alternative is not matching at all.
 */
export const MAX_REPAIR_QUERY_WORDS = 4;

function planRepairInner(store: Store, keywords: string[], o: { abbreviations?: boolean }): RepairPlan | null {
  const short = keywords.length <= MAX_REPAIR_QUERY_WORDS;
  const cjkBudget = { scans: store.approxNotes() > repairFullMaxNotes() ? MAX_CJK_SCANS_BIG : MAX_CJK_SCANS };
  const notes: string[] = [];
  const units: Unit[] = keywords.map((kw) =>
    hasCjk(kw) ? cjkUnit(store, kw, notes, cjkBudget) : short ? wordUnit(store, kw, notes) : { expr: quotePrefix(kw), repaired: false, kw, alts: [] }
  );

  // Adjacent words that an indexed term spells together: "rate limit" -> ratelimit* (note says "rateLimiter"),
  // "connection reset" -> econnreset. Each word joins at most one pair.
  const out: string[] = [];
  const looseExtra: string[] = [];
  let changed = units.some((u) => u.repaired);
  for (const u of units) looseExtra.push(...u.alts);
  const pairable = (u: Unit): boolean => !u.kw.startsWith("#") && u.kw.length <= MAX_REPAIR_WORD && /^[a-z0-9]{3,}$/.test(fold(u.kw));
  const terms = new Set<string>();
  for (const u of units) for (const w of u.words ?? []) terms.add(w);
  let pairs = 0;
  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    const b = units[i + 1];
    if (short && b && pairs < MAX_JOIN_PAIRS && pairable(a) && pairable(b)) {
      pairs++;
      const fa = fold(a.kw);
      const fb = fold(b.kw);
      const alts: string[] = [];
      const joined = fa + fb;
      if (joined.length <= MAX_REPAIR_WORD && store.vocabHasPrefix(joined)) {
        alts.push(quotePrefix(joined));
        terms.add(joined);
        notes.push(`${a.kw} ${b.kw} -> ${joined}`);
      } else if (o.abbreviations && keywords.length <= 4 && store.approxNotes() <= repairFullMaxNotes()) {
        // "connection reset" -> "econnreset": an indexed term holding the start of the first word, then of the second.
        const like = `%${likeEscape(fa.slice(0, 4))}%${likeEscape(fb.slice(0, Math.min(5, fb.length)))}%`;
        for (const t of store.vocabTerms({ like, minLen: 6, maxLen: 24, limit: 2 })) {
          alts.push(quotePrefix(t.term));
          terms.add(t.term);
          notes.push(`${a.kw} ${b.kw} -> ${t.term}`);
        }
      }
      if (alts.length) {
        changed = true;
        out.push(`((${a.expr} AND ${b.expr}) OR ${alts.join(" OR ")})`);
        looseExtra.push(...alts);
        i++;
        continue;
      }
    }
    out.push(a.expr);
  }
  if (!changed) return null;
  return { strictExpr: out.join(" AND "), looseExtra, notes, terms: [...terms] };
}

/** The any-keyword (OR) expression for `keywords`, with the repaired alternatives added. */
export function looseExpression(keywords: string[], plan: RepairPlan | null): string {
  const base = buildMatchQuery(keywords.join(" "), true);
  if (!plan || !plan.looseExtra.length) return base;
  return [base, ...plan.looseExtra].filter(Boolean).join(" OR ");
}

// The plan a search made is remembered (per store, last query only) so passage selection can reuse its spellings
// instead of planning again. No entry means the search needed no repair.
const lastPlans = new WeakMap<Store, { key: string; terms: string[] }>();
export function rememberPlan(store: Store, keywords: string[], plan: RepairPlan | null): void {
  lastPlans.set(store, { key: keywords.join(" "), terms: plan?.terms ?? [] });
}
/** The repaired spellings the last search for `keywords` used, or [] (never plans anew). */
export function rememberedTerms(store: Store, keywords: string[]): string[] {
  const e = lastPlans.get(store);
  return e && e.key === keywords.join(" ") ? e.terms : [];
}
