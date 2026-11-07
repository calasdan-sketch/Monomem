// Passage retrieval: hand an agent the few paragraphs/turns that answer the query, not the five whole notes.
//
// state_search normally returns whole notes. A long note costs its full length in the agent's context even when one
// paragraph is the answer. With `passages` on, the notes the search already ranked are split into passages (a chat
// turn, or a paragraph; an over-long block is cut at line/sentence breaks), the passages are scored against the query
// with BM25 over the candidate set, and the best ones are returned in a token budget. Nothing is stored or indexed
// differently: this runs on the notes a search returned, so permissions, trust and staleness rules are unchanged.

import { extractKeywords } from "./keywords.js";
import { queryStem, type Store } from "./store.js";
import { planRepair, repairEnabled } from "./repair.js";

export interface Passage {
  /** Character offset of the passage in the note body. */
  start: number;
  end: number;
  text: string;
}

export interface ScoredPassage extends Passage {
  noteId: number;
  score: number;
}

/** About four characters a token, the same estimate the meter uses. */
export const estTokens = (chars: number): number => (chars > 0 ? Math.ceil(chars / 4) : 0);

export const MAX_PASSAGE_CHARS = 900;
const MIN_PASSAGE_CHARS = 40;
export const DEFAULT_PASSAGE_TOKENS = 1500;
export const MAX_PASSAGE_TOKENS = 20_000;
const MAX_PER_NOTE = 8;
const MAX_BODY_SCAN = 120_000; // characters of one note body examined
/** Only this many notes are searched for passages; later ones contribute their opening only (bounded work at limit=200). */
const MAX_PASSAGE_NOTES = 25;

const TURN_RE = /^(?:user|assistant|human|ai|system|tool|agent|claude)[ \t]*:[ \t]/i;

/** Cut a block that is longer than the limit at a line break, then a sentence end, then a space, then anywhere. */
function cutLong(text: string, start: number, out: Passage[]): void {
  let from = 0;
  while (from < text.length) {
    if (text.length - from <= MAX_PASSAGE_CHARS) {
      out.push({ start: start + from, end: start + text.length, text: text.slice(from) });
      return;
    }
    const window = text.slice(from, from + MAX_PASSAGE_CHARS);
    let cut = window.lastIndexOf("\n");
    if (cut < MAX_PASSAGE_CHARS * 0.4) {
      const m = [...window.matchAll(/[.!?。！？][)"'\]]?\s/g)].pop();
      cut = m && m.index !== undefined ? m.index + m[0].length : -1;
    }
    if (cut < MAX_PASSAGE_CHARS * 0.4) cut = window.lastIndexOf(" ");
    if (cut < MAX_PASSAGE_CHARS * 0.4) cut = MAX_PASSAGE_CHARS;
    const piece = text.slice(from, from + cut);
    if (piece.trim()) out.push({ start: start + from, end: start + from + cut, text: piece });
    from += cut;
  }
}

/**
 * Split a note body into passages. A chat-style body ("user: ...", "assistant: ...") splits at each turn; anything
 * else splits at blank lines. Very short pieces (a heading line) are joined to the piece after them.
 */
export function splitPassages(body: string): Passage[] {
  const text = body.length > MAX_BODY_SCAN ? body.slice(0, MAX_BODY_SCAN) : body;
  if (!text.trim()) return [];
  const bounds: number[] = [0];
  const lines = text.split("\n");
  const turnStarts: number[] = [];
  let off = 0;
  for (const line of lines) {
    if (TURN_RE.test(line)) turnStarts.push(off);
    off += line.length + 1;
  }
  if (turnStarts.length >= 2) {
    for (const t of turnStarts) if (t > 0) bounds.push(t);
  } else {
    for (const m of text.matchAll(/\n[ \t]*\n+/g)) bounds.push((m.index ?? 0) + m[0].length);
  }
  bounds.push(text.length);
  const raw: Passage[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    let b = bounds[i + 1];
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a && text.slice(a, b).trim()) raw.push({ start: a, end: b, text: text.slice(a, b) });
  }
  // Join tiny pieces (headings, one-word lines) to the piece after them.
  const merged: Passage[] = [];
  for (let i = 0; i < raw.length; i++) {
    let cur = raw[i];
    while (cur.text.trim().length < MIN_PASSAGE_CHARS && i + 1 < raw.length) {
      const nxt = raw[++i];
      cur = { start: cur.start, end: nxt.end, text: text.slice(cur.start, nxt.end) };
    }
    merged.push(cur);
  }
  const out: Passage[] = [];
  for (const p of merged) {
    if (p.text.length <= MAX_PASSAGE_CHARS) out.push(p);
    else cutLong(p.text, p.start, out);
  }
  return out;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/u;

function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const w = m[0];
    if (CJK_RE.test(w)) {
      // CJK runs have no spaces: index overlapping two-character pieces so "东京" matches inside a long run.
      const cs = [...w];
      if (cs.length === 1) out.push(w);
      for (let i = 0; i + 1 < cs.length; i++) out.push(cs[i] + cs[i + 1]);
    } else out.push(w);
  }
  return out;
}

/** The terms a query is scored on: its keywords (stop-words dropped), suffix-trimmed, CJK as two-character pieces. */
export function queryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const k of extractKeywords(query)) {
    const bare = k.startsWith("#") ? k.slice(1) : k;
    if (CJK_RE.test(bare)) for (const w of words(bare)) out.add(w);
    else out.add(queryStem(bare).toLowerCase());
  }
  return [...out];
}

export interface PassageNote {
  id: number;
  title: string;
  body: string;
}

export interface PassageOpts {
  maxTokens?: number;
  /** Extra weight for passages of higher-ranked notes: note i gets (1 + prior / (1 + i)). Default 0.25. */
  rankPrior?: number;
  maxPerNote?: number;
  /** Extra words that count as query terms (the indexed spellings query repair found: "postgres" for "postgress"). */
  extraTerms?: string[];
  /**
   * How many of the best passages also bring their next passage along (when it fits the budget). The sentence that
   * answers is often the one after the one that matches ("Symptom: ECONNRESET ..." then "Fix: ..."). Default 1.
   */
  context?: number;
  /** BM25 saturation and length normalisation. */
  k1?: number;
  b?: number;
}

export interface PassageResult {
  /** The picked passages, grouped by note in the order the notes were given, in reading order within a note. */
  picked: ScoredPassage[];
  /** Estimated tokens of the picked passages. */
  tokens: number;
}

/**
 * Choose the best passages of `notes` (already ranked by the search, best first) for `query`, within `maxTokens`.
 * A passage scores BM25 over the candidate passages (a query term matches a passage word that starts with it); a note
 * whose passages match nothing still contributes its opening passage, last, so a title/tag-only hit is not lost.
 */
export function selectPassages(notes: PassageNote[], query: string, opts: PassageOpts = {}): PassageResult {
  const budget = Math.min(Math.max(Math.floor(opts.maxTokens ?? DEFAULT_PASSAGE_TOKENS), 20), MAX_PASSAGE_TOKENS);
  const prior = opts.rankPrior ?? 0.25;
  const perNote = Math.max(1, opts.maxPerNote ?? MAX_PER_NOTE);
  const terms = [...new Set([...queryTerms(query), ...(opts.extraTerms ?? []).map((t) => t.toLowerCase())])];

  interface Cand extends ScoredPassage {
    rank: number;
    ws: string[];
    first: boolean;
    idx: number;
  }
  const cands: Cand[] = [];
  notes.forEach((n, rank) => {
    splitPassages(rank < MAX_PASSAGE_NOTES ? n.body : n.body.slice(0, MAX_PASSAGE_CHARS)).forEach((p, i) => cands.push({ ...p, noteId: n.id, score: 0, rank, ws: words(p.text), first: i === 0, idx: i }));
  });
  // Titles carry meaning ("Rate limits"): the first passage of a note also counts the title's words.
  notes.forEach((n, rank) => {
    const c = cands.find((x) => x.rank === rank && x.first);
    if (c) c.ws = c.ws.concat(words(n.title));
  });

  if (terms.length && cands.length) {
    const N = cands.length;
    const df = new Map<string, number>();
    const tfs = cands.map((c) => {
      const tf = new Map<string, number>();
      for (const t of terms) {
        let n = 0;
        for (const w of c.ws) if (w.startsWith(t)) n++;
        if (n) {
          tf.set(t, n);
          df.set(t, (df.get(t) ?? 0) + 1);
        }
      }
      return tf;
    });
    const avg = cands.reduce((a, c) => a + c.ws.length, 0) / N || 1;
    const k1 = opts.k1 ?? 1.2;
    const b = opts.b ?? 1;
    cands.forEach((c, i) => {
      let s = 0;
      for (const [t, f] of tfs[i]) {
        const d = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
        s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * c.ws.length) / avg));
      }
      c.score = s * (1 + prior / (1 + c.rank));
    });
  }

  const order = cands
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.start - b.start);
  // Title/tag-only hits: the opening passage of any note that has no scored passage, best-ranked note first.
  const scoredNotes = new Set(order.map((c) => c.noteId));
  for (const c of cands) if (c.first && !scoredNotes.has(c.noteId)) order.push(c);

  const picked: Cand[] = [];
  const used = new Map<number, number>();
  let tokens = 0;
  for (const c of order) {
    if ((used.get(c.noteId) ?? 0) >= perNote) continue;
    const t = estTokens(c.text.length);
    if (tokens + t > budget) {
      // Nothing picked yet and the best passage is bigger than the budget: cut it to fit rather than return nothing.
      if (picked.length === 0) {
        const room = budget * 4;
        picked.push({ ...c, end: c.start + room, text: c.text.slice(0, room) });
        used.set(c.noteId, 1);
        tokens = budget;
      }
      continue;
    }
    picked.push(c);
    used.set(c.noteId, (used.get(c.noteId) ?? 0) + 1);
    tokens += t;
  }
  // Context: the next passage of the best picks (the previous one when it is the last of its note).
  const ctx = Math.max(0, Math.floor(opts.context ?? 1));
  const bestFirst = [...picked];
  for (const c of bestFirst.slice(0, ctx)) {
    if (c.score <= 0) continue;
    const sibs = cands.filter((x) => x.noteId === c.noteId);
    const neighbor = sibs.find((x) => x.idx === c.idx + 1) ?? sibs.find((x) => x.idx === c.idx - 1);
    if (!neighbor || picked.includes(neighbor)) continue;
    const t = estTokens(neighbor.text.length);
    if (tokens + t > budget) continue;
    picked.push(neighbor);
    tokens += t;
  }
  // Reading order: notes by their search rank, passages by position.
  picked.sort((a, b) => a.rank - b.rank || a.start - b.start);
  return {
    picked: picked.map(({ noteId, start, end, text, score }) => ({ noteId, start, end, text, score: Math.round(score * 1000) / 1000 })),
    tokens,
  };
}

/** Shape one search result for the wire: the note without its body, plus the passages picked from it. */
export function withPassages<T extends { id: number; body?: string }>(
  note: T,
  picked: ScoredPassage[]
): Omit<T, "body"> & { body_omitted: true; body_chars: number; passages: Array<{ start: number; end: number; text: string; score: number }> } {
  const { body, ...rest } = note;
  return {
    ...rest,
    body_omitted: true,
    body_chars: (body ?? "").length,
    passages: picked.filter((p) => p.noteId === note.id).map((p) => ({ start: p.start, end: p.end, text: p.text, score: p.score })),
  };
}

/**
 * Apply passage retrieval to search results already shaped for the wire (annotated notes): drop each body, add the
 * picked passages. `store` supplies the indexed spellings query repair found, so a typo'd query picks the right
 * paragraph too. Returns the shaped results and the estimated tokens of all passages.
 */
export function shapeWithPassages<T extends { id: number; title: string; body?: string }>(
  store: Store,
  query: string,
  results: T[],
  maxTokens?: number
): { results: Array<ReturnType<typeof withPassages<T>>>; passage_tokens: number; max_tokens: number } {
  const budget = Math.min(Math.max(Math.floor(maxTokens ?? DEFAULT_PASSAGE_TOKENS), 20), MAX_PASSAGE_TOKENS);
  const extraTerms = repairEnabled() ? (planRepair(store, extractKeywords(query), { abbreviations: true })?.terms ?? []) : [];
  const sel = selectPassages(
    results.map((n) => ({ id: n.id, title: n.title, body: n.body ?? "" })),
    query,
    { maxTokens: budget, extraTerms }
  );
  return { results: results.map((n) => withPassages(n, sel.picked)), passage_tokens: sel.tokens, max_tokens: budget };
}
