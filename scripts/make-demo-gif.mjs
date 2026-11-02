#!/usr/bin/env node
// Builds docs/monomem-demo.gif from docs/brand/demo-transcript.txt.
//
// Why this script exists: the previous demo GIF was an orphan binary with no
// generator, which is indefensible in a repo whose pitch is provenance. Every
// string rendered below is transcribed from the transcript file, and the
// read-latency beat is held for the real measured duration (255 ms) rather
// than being shortened to look faster.
//
// Needs only ffmpeg (no ImageMagick, no headless browser). Run: npm run demo-gif

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = "docs/monomem-demo.gif";
const BUILD = "build/gif";
const W = 850, H = 336, FPS = 12;

// --- palette (Calas brand) -------------------------------------------------
const C = {
  page: "0x071E2E",   // one step darker than brand navy
  pane: "0x0B2E45",   // brand navy exactly
  text: "0xE6EDF3",
  dim: "0x8CA6B8",
  gold: "0xF0C171",   // Claude Code accent + brand mark
  sky: "0x5FB3DD",    // Gemini CLI accent
  tick: "0x6FD08C",
  caption: "0xC8D6E0",
};

// --- geometry --------------------------------------------------------------
const PANE_Y = 58, PANE_H = 176;
const L = { x: 16, w: 404 }, R = { x: 430, w: 404 };
const PAD = 14;
const CAP_Y = 262;

// --- fonts (copied locally so ffmpeg needs no Windows path escaping) -------
// Copied into build/ so the ffmpeg filter needs no Windows drive-letter escaping.
// Candidates are tried in order so `npm run demo-gif` works off this one machine.
mkdirSync(BUILD, { recursive: true });
function font(name, candidates) {
  // Forward slashes only: ffmpeg's drawtext parser treats "\" as an escape.
  const dst = join(BUILD, name).replace(/\\/g, "/");
  if (existsSync(dst)) return dst;
  const src = candidates.find((p) => existsSync(p));
  if (!src) {
    console.error(`Cannot find a ${name} font. Tried:\n  ${candidates.join("\n  ")}`);
    console.error("Install one of those, or edit the candidate list in scripts/make-demo-gif.mjs.");
    process.exit(1);
  }
  copyFileSync(src, dst);
  return dst;
}
const MONO = font("mono.ttf", [
  "C:/Windows/Fonts/CascadiaMono.ttf",
  "C:/Windows/Fonts/consola.ttf",              // always present on Windows
  "/System/Library/Fonts/Menlo.ttc",           // macOS
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", // Debian/Ubuntu
  "/usr/share/fonts/TTF/DejaVuSansMono.ttf",   // Arch
]);
const UI = font("ui.ttf", [
  "C:/Windows/Fonts/segoeuib.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]);

// --- timeline (seconds). Derived from the transcript, not invented. --------
const T = {
  open: 0.0,
  leftType: 0.8,          // "> remember: ..." types word by word
  leftTool: 3.4,          // the state_write tool line + tick
  bridge: 4.2,            // the note is now in the shared store
  handoff: 5.0,
  rightType: 5.4,         // "> where do we deploy?"
  rightTool: 7.8,
  rightLatency: 7.8,      // real measured 255 ms gap, held in full, no dead air
  answer: 8.1,
  payoff: 9.8,
  cta: 12.0,
  end: 16.0,              // the CTA holds for 4s as the resting frame
};

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");

/** One drawtext layer, visible only between `from` and `to`. */
function text(s, { x, y, size = 15, color = C.text, font = MONO, from = 0, to = T.end, alpha = 1 }) {
  const parts = [
    `fontfile=${font}`,
    `text='${esc(s)}'`,
    `fontsize=${size}`,
    `fontcolor=${color}${alpha < 1 ? `@${alpha}` : ""}`,
    `x=${x}`,
    `y=${y}`,
    `enable='between(t,${from},${to})'`,
  ];
  return `drawtext=${parts.join(":")}`;
}

/** Reveal a line word by word between `from` and `until`, then hold to `to`. */
function typed(words, opts) {
  const { from, until, to = T.end } = opts;
  const step = (until - from) / words.length;
  const layers = [];
  for (let i = 0; i < words.length; i++) {
    const shown = words.slice(0, i + 1).join(" ");
    const start = from + i * step;
    const stop = i === words.length - 1 ? to : from + (i + 1) * step;
    layers.push(text(shown, { ...opts, from: start, to: stop }));
  }
  return layers;
}

const layers = [];

// --- pane titles (on screen for the whole run, never animated away) --------
// These name the two authenticated WRITERS, which is what the captured run
// actually produced. They deliberately do not claim two live vendor clients
// were recorded, and no vendor company names appear: see demo-transcript.txt.
layers.push(text("Writer A - token \"claude-code\"", { x: L.x + PAD, y: 30, size: 14, color: C.gold, font: UI }));
layers.push(text("Writer B - token \"gemini-cli\"", { x: R.x + PAD, y: 30, size: 14, color: C.sky, font: UI }));

// --- left pane: the write -------------------------------------------------
const LY = PANE_Y + PAD;
layers.push(...typed(
  ["> remember:", "we", "deploy", "on", "Fly.io,", "not", "Render"],
  { x: L.x + PAD, y: LY, size: 15, color: C.text, from: T.leftType, until: T.leftTool }
));
layers.push(text("monomem - state_write", { x: L.x + PAD, y: LY + 34, size: 13, color: C.dim, from: T.leftTool }));
layers.push(text("stored - id 1 - rev 1", { x: L.x + PAD, y: LY + 54, size: 13, color: C.tick, from: T.leftTool + 0.5 }));
layers.push(text("written_by: claude-code", { x: L.x + PAD, y: LY + 74, size: 13, color: C.dim, from: T.leftTool + 0.8 }));

// (No centre line: it collided with the caption 20px below and said the same thing.)

// --- right pane: the read -------------------------------------------------
const RY = PANE_Y + PAD;
layers.push(...typed(
  ["> where", "do", "we", "deploy?"],
  { x: R.x + PAD, y: RY, size: 15, color: C.text, from: T.rightType, until: T.rightTool }
));
layers.push(text("monomem - state_relevant", { x: R.x + PAD, y: RY + 34, size: 13, color: C.dim, from: T.rightTool }));
// the real measured gap: 255 ms, held in full, not shortened
layers.push(text("...", { x: R.x + PAD, y: RY + 54, size: 13, color: C.dim, from: T.rightLatency, to: T.answer }));
layers.push(text("Fly.io - not Render.", { x: R.x + PAD, y: RY + 54, size: 16, color: C.text, from: T.answer }));
// The provenance line is the product thesis, so it is set larger and in gold,
// not demoted to a footnote beneath the (commodity) answer above it.
layers.push(text("written_by: claude-code - rev 1", { x: R.x + PAD, y: RY + 82, size: 15, color: C.gold, from: T.answer + 0.4 }));
layers.push(text("255 ms, measured", { x: R.x + PAD, y: RY + 104, size: 12, color: C.dim, from: T.answer + 0.7 }));

// --- captions -------------------------------------------------------------
const cap = (s, from, to, color = C.caption, size = 17) =>
  layers.push(text(s, { x: "(w-tw)/2", y: CAP_Y, size, color, font: UI, from, to }));

cap("Two assistants. One memory.", T.open, T.bridge);
cap("Written once, to a file on your own machine.", T.bridge, T.payoff);
cap("The second writer never saw the first. Same note - and it shows who wrote it.", T.payoff, T.cta, C.caption, 16);
cap("npx monomem setup", T.cta, T.end, C.gold, 19);

// --- render ---------------------------------------------------------------
// The Calas mark, gold on transparent, in the closing frame only. It is
// input 0, so the colour sources below are generated inside the filter graph.
const MARK = "docs/brand/mark-gold-48.png";
layers.push(text("Calas Automations", { x: "w-tw-56", y: H - 36, size: 12, color: C.dim, font: UI, from: T.cta }));

const panes =
  `color=c=${C.page}:s=${W}x${H}:d=${T.end}:r=${FPS}[bg];` +
  `color=c=${C.pane}:s=${L.w}x${PANE_H}:d=${T.end}:r=${FPS}[lp];` +
  `color=c=${C.pane}:s=${R.w}x${PANE_H}:d=${T.end}:r=${FPS}[rp];` +
  `[bg][lp]overlay=${L.x}:${PANE_Y}[b1];` +
  `[b1][rp]overlay=${R.x}:${PANE_Y}[b2];` +
  `[0:v]scale=-1:26[mk];` +
  `[b2][mk]overlay=W-w-24:H-h-30:enable='between(t,${T.cta},${T.end})'[b3];` +
  `[b3]${layers.join(",")}[v]`;

console.log(`rendering ${layers.length} text layers, ${T.end}s @ ${FPS}fps ...`);
execFileSync("ffmpeg", ["-y", "-i", MARK, "-filter_complex", panes, "-map", "[v]", "-frames:v", String(Math.round(T.end * FPS)), `${BUILD}/frames.mp4`], { stdio: ["ignore", "ignore", "inherit"] });

console.log("building shared palette ...");
execFileSync("ffmpeg", ["-y", "-i", `${BUILD}/frames.mp4`, "-vf", "palettegen=max_colors=64:stats_mode=diff", `${BUILD}/palette.png`], { stdio: ["ignore", "ignore", "inherit"] });

console.log("assembling gif ...");
execFileSync("ffmpeg", ["-y", "-i", `${BUILD}/frames.mp4`, "-i", `${BUILD}/palette.png`,
  // -loop 2, not 0: an endlessly repeating 16s typing animation beside prose is
  // a WCAG 2.2.2 (Pause, Stop, Hide) failure and disrupts reading. Two passes,
  // then it rests on the CTA frame.
  "-lavfi", "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", "-loop", "2", OUT],
  { stdio: ["ignore", "ignore", "inherit"] });

const bytes = statSync(OUT).size;
console.log(`${OUT}  ${(bytes / 1e6).toFixed(2)} MB`);
if (bytes > 3_000_000) {
  console.error(`FAIL: over the 3 MB budget. Drop max_colors to 32 or fps to 10.`);
  process.exit(1);
}
