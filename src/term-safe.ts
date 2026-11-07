// Terminal-safe output. Note titles, bodies and tags are written by other agents (and by web pages they read), so
// anything the CLI prints can carry an ANSI escape that rewrites the screen, a carriage return that overwrites a line,
// a right-to-left override that flips what a line says, or zero-width characters that hide text. The CLI escapes all of
// these as visible \uXXXX sequences before they reach the terminal.
//
// The escape is the JSON escape (astral characters as surrogate pairs), so `--json` output stays valid JSON and decodes
// to the original text; in plain output the reader sees the escape instead of the effect. Tab and newline are kept.

// C0 controls except \t \n, DEL and C1, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// directional marks/overrides/isolates (U+200B-200F, U+202A-202E, U+2060-206F), line/paragraph separators, BOM,
// interlinear annotation, and the Unicode tag / variation-selector blocks that can smuggle invisible text.
// Built from code point ranges (no raw invisible characters in this source file).
const RANGES: Array<[number, number]> = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
  // invisible fillers and format characters that render as nothing
  [0x34f, 0x34f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x2800, 0x2800], [0x3164, 0x3164], [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0], [0xfffc, 0xfffc], [0x1d173, 0x1d17a],
];
const cls = (n: number): string => (n <= 0xffff ? "\\u" + n.toString(16).padStart(4, "0") : "\\u{" + n.toString(16) + "}");
const UNSAFE = new RegExp("[" + RANGES.map(([a, b]) => (a === b ? cls(a) : cls(a) + "-" + cls(b))).join("") + "]", "gu");

const hex4 = (n: number): string => "\\u" + n.toString(16).padStart(4, "0");

const LETTERISH = /[\p{L}\p{M}\p{Extended_Pictographic}\u{FE0F}]/u;
const lastCp = (s: string, end: number): string => {
  const a = s.slice(Math.max(0, end - 2), end);
  return [...a].pop() ?? "";
};
const firstCp = (s: string, start: number): string => [...s.slice(start, start + 2)][0] ?? "";

/**
 * Escape terminal control, bidi and zero-width characters; leave everything else untouched. One exception: a single
 * zero-width (non-)joiner between two letters or emoji is kept, because Persian, Indic scripts and emoji sequences
 * need it. Two or more in a row, or one at the edge of a word, are escaped (that is how text gets hidden).
 */
export function safeText(s: string): string {
  if (!s) return s;
  return s
    .replace(/\r\n/g, "\n")
    .replace(UNSAFE, (c, off: number, whole: string) => {
      const cp = c.codePointAt(0)!;
      // One emoji-presentation selector right after an emoji keeps the emoji an emoji.
      if ((cp === 0xfe0f || cp === 0xfe0e) && /\p{Extended_Pictographic}|[0-9#*]/u.test(lastCp(whole, off))) return c;
      if ((cp === 0x200c || cp === 0x200d) && LETTERISH.test(lastCp(whole, off)) && LETTERISH.test(firstCp(whole, off + 1))) return c;
      if (cp <= 0xffff) return hex4(cp);
      const v = cp - 0x10000;
      return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
    });
}

/** True when `safeText` would change `s`. */
export const hasUnsafe = (s: string): boolean => safeText(s) !== s;

import { format } from "node:util";

let installed = false;
/**
 * Route every console.* call and every process.stdout.write through safeText for the life of the process. Not for the
 * stdio MCP server, whose stdout is a protocol channel. Safe to call twice.
 */
export function installTerminalGuard(): void {
  if (installed) return;
  installed = true;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]): void => orig(safeText(format(...args)));
  }
  const write = process.stdout.write.bind(process.stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean =>
    write(typeof chunk === "string" ? safeText(chunk) : chunk, ...rest)) as typeof process.stdout.write;
  // stderr too. Progress lines our own code writes start with one carriage return ("\rRebuilding edges: ..."); that
  // one leading return is kept, everything after it is escaped.
  const ewrite = process.stderr.write.bind(process.stderr) as (chunk: unknown, ...rest: unknown[]) => boolean;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk !== "string") return ewrite(chunk, ...rest);
    const lead = chunk.startsWith("\r") && !chunk.startsWith("\r\n") ? "\r" : "";
    return ewrite(lead + safeText(chunk.slice(lead.length)), ...rest);
  }) as typeof process.stderr.write;
}
