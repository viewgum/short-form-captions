// SRT and WebVTT in and out, and ASS out, for cues of the shape { start, end, lines: [string], words?: [{ text, start, end, sep }] }.
import { splitLineGroups, joinWords } from "./cues.mjs";

const pad = (n, w = 2) => String(n).padStart(w, "0");
function clock(s, sep, digits = 3) {
  if (!Number.isFinite(s) || s < 0) throw new Error(`cannot write the time ${s}`);
  const unit = 10 ** digits;
  let t = Math.round(s * unit);
  const frac = t % unit; t = (t - frac) / unit;
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}${sep}${pad(frac, digits)}`;
}
export const srtTime = (s) => clock(s, ",");
export const vttTime = (s) => clock(s, ".");
/** ASS time from centiseconds. */
function assClock(cs) {
  const c = clock(cs / 100, ".", 2);
  return c.startsWith("0") ? c.slice(1) : c;
}
export const assTime = (s) => assClock(Math.round(s * 100));

const TIME = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})$/;
function parseTime(t, where) {
  const m = TIME.exec(t.trim());
  if (!m) throw new Error(`${where}: cannot read the time "${t.trim()}"`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}
const CLOCK = "(?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3}";
const TIMING = new RegExp(`^\\s*${CLOCK}\\s+-->\\s+${CLOCK}`);

function blocks(text) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map((b) => b.split("\n"))
    .map((b) => { while (b.length && !b[b.length - 1].trim()) b.pop(); while (b.length && !b[0].trim()) b.shift(); return b; })
    .filter((b) => b.length);
}

function cueText(lines, n) {
  const i = lines.findIndex((l) => TIMING.test(l));
  if (i >= 0) throw new Error(`cue ${n}: a second timing line inside the text (is a blank line missing before it?)`);
  return lines;
}

export function parseSrt(text) {
  return blocks(text).map((b, i) => {
    const t = b.findIndex((l) => l.includes("-->"));
    if (t < 0 || t > 1) throw new Error(`cue ${i + 1}: no "start --> end" line`);
    const [a, z, ...rest] = b[t].split("-->");
    if (rest.length) throw new Error(`cue ${i + 1}: cannot read the timing line`);
    // SRT end times may be followed by old position hints (X1:... Y2:...); only the time is read.
    return { start: parseTime(a, `cue ${i + 1}`), end: parseTime(z.trim().split(/\s+/)[0], `cue ${i + 1}`), lines: cueText(b.slice(t + 1), i + 1), format: "srt" };
  });
}

export function parseVtt(text) {
  const bs = blocks(text);
  if (!bs.length || !/^WEBVTT([ \t]|$)/.test(bs[0][0])) throw new Error('not a WebVTT file: the first line must be "WEBVTT"');
  const cues = [];
  bs.slice(1).forEach((b, i) => {
    const t = b.findIndex((l) => l.includes("-->"));
    // A block with a timing line in its first two lines is a cue, even if its identifier starts with STYLE or NOTE.
    if (t < 0 || t > 1) {
      if (/^(NOTE|STYLE|REGION)([ \t]|$)/.test(b[0])) return;
      throw new Error(`block ${i + 2}: no "start --> end" line`);
    }
    const n = cues.length + 1;
    const [a, rest] = b[t].split(/-->(.*)/s);
    const [end, ...settings] = rest.trim().split(/[ \t]+/);
    cues.push({ id: t === 1 ? b[0] : undefined, start: parseTime(a, `cue ${n}`), end: parseTime(end, `cue ${n}`), settings: settings.join(" "), lines: cueText(b.slice(t + 1), n), format: "vtt" });
  });
  return cues;
}

/** Reads SRT or WebVTT, by the WEBVTT header. */
export function parseCaptions(text) {
  return /^﻿?WEBVTT/.test(text) ? parseVtt(text) : parseSrt(text);
}

const ENTITY = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "‎", rlm: "‏", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e.toLowerCase()] ?? m);

/** The text a viewer reads. WebVTT: tags removed and entities decoded once. SRT: HTML-style tags and ASS override blocks
 *  ({\an8}) removed; other braces are text. */
export function plainLines(lines, format = "srt") {
  return lines.map((l) => (format === "vtt" ? decode(l.replace(/<[^>]*>/g, "")) : l.replace(/<\/?[a-z][^>]*>/gi, "").replace(/\{\\[^}]*\}/g, "")).trim());
}

const textOf = (c) => (c.format ? plainLines(c.lines, c.format) : c.lines);

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${textOf(c).join("\n")}\n`).join("\n");
}

// WebVTT text may not hold "-->"; escaping ">" covers it.
const vttEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function toVtt(cues) {
  return `WEBVTT\n\n${cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${textOf(c).map(vttEscape).join("\n")}\n`).join("\n")}`;
}

// All four apps' published 9:16 safe zones at once, on 1080 x 1920 (short-form-video-specs, data/safe-zones.json): clear at least
// 288 px from the top, 672 from the bottom, 120 from the left, 192 from the right, and the right 300 px below y 840.
export const SAFE = Object.freeze({ width: 1080, height: 1920, top: 288, bottom: 672, left: 120, right: 192, columnFromY: 840, column: 300 });

// Where each position puts the text on 1080 x 1920: ASS alignment, margins, and the box the lines must fit. height is how tall the
// text may grow from its anchor and stay clear: bottom up to y 288, middle up to y 288, top down to y 840 (below it the lines,
// which reach x 888, would enter the right-hand column).
export const POSITIONS = Object.freeze({
  bottom: Object.freeze({ alignment: 2, marginV: 700, marginL: 300, marginR: 300, height: 932, note: "bottom centre, lowest line ending about y 1220, lines between x 300 and 780" }),
  middle: Object.freeze({ alignment: 2, marginV: 1108, marginL: 192, marginR: 192, height: 524, note: "lowest line ending about y 812, above the right-hand column, lines between x 192 and 888" }),
  top: Object.freeze({ alignment: 8, marginV: 300, marginL: 192, marginR: 192, height: 540, note: "top centre, from y 300 down to y 840, lines between x 192 and 888" }),
});
// Arial Bold's line height (ascent plus descent, 2288 of 2048 units), as libass spaces lines.
const LINE_HEIGHT = 2288 / 2048;
export const isPosition = (p) => typeof p === "string" && Object.prototype.hasOwnProperty.call(POSITIONS, p);

export const ASS_DEFAULTS = Object.freeze({ width: 1080, height: 1920, position: "bottom", font: "Arial", fontSize: 72, bold: true, outline: 4, color: "FFFFFF", outlineColor: "000000", highlightColor: "FFD400", maxLines: 3 });

// Advance widths of Arial Bold (and Liberation Sans Bold, which shares them) in thousandths of the font size, for U+0020 to
// U+007E and U+00A0 to U+00FF. Other characters count as 1000 (Chinese, Japanese, Korean) or 750.
const ASCII = "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584".split(",").map(Number);
const LATIN1 = "278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,552,400,549,333,333,333,576,556,333,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,549,611,611,611,611,611,556,611,556".split(",").map(Number);
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
function advance(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x20 && c <= 0x7e) return ASCII[c - 0x20];
  if (c >= 0xa0 && c <= 0xff) return LATIN1[c - 0xa0];
  return WIDE.test(ch) ? 1000 : 750;
}
/** Width in pixels of a line of text at a font size, with its outline on both sides. */
export function textWidth(s, fontSize, outline = 0) {
  let w = 0;
  for (const ch of s) w += advance(ch);
  return (w * fontSize) / 1000 + 2 * outline;
}

function assColour(hex) {
  const h = String(hex).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`colour must be six hex digits like FFD400, not "${hex}"`);
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
// ASS reads { } as the start and end of an override block and \ as the start of a code; the text keeps their look with ( ) and /.
const assText = (s) => s.replace(/\{/g, "(").replace(/\}/g, ")").replace(/\\/g, "/");

/** The box and margins a position gets on a 9:16 frame, scaled from 1080 x 1920. */
export function assLayout(opts = {}) {
  const o = { ...ASS_DEFAULTS, ...opts };
  if (!isPosition(o.position)) throw new Error(`position must be one of ${Object.keys(POSITIONS).join(", ")}`);
  for (const k of ["width", "height", "fontSize"]) if (!(Number.isFinite(o[k]) && o[k] > 0)) throw new Error(`${k} must be a positive number`);
  if (/[,\r\n]/.test(String(o.font))) throw new Error("the font name cannot contain a comma or a line break");
  const p = POSITIONS[o.position];
  const sx = o.width / SAFE.width, sy = o.height / SAFE.height;
  const marginL = Math.round(p.marginL * sx), marginR = Math.round(p.marginR * sx), marginV = Math.round(p.marginV * sy);
  const fontSize = Math.round(o.fontSize), boxHeight = Math.floor(p.height * sy);
  const linesFit = Math.floor((boxHeight - 2 * o.outline) / (fontSize * LINE_HEIGHT));
  return { ...o, alignment: p.alignment, marginL, marginR, marginV, fontSize, boxWidth: o.width - marginL - marginR, boxHeight, linesFit };
}

/** A line-width function for a layout, in pixels, for splitting cues into lines that fit its box. */
export function assMeasure(opts = {}) {
  const l = assLayout(opts);
  return { measure: (s) => textWidth(s, l.fontSize, l.outline), maxWidth: l.boxWidth };
}

/** About how many characters of ordinary text fit a line of a layout's box (for messages and defaults). */
export function lineCharsFor(opts = {}) {
  const l = assLayout(opts);
  return Math.max(4, Math.floor(l.boxWidth / textWidth("n", l.fontSize)));
}

/** An ASS script for a 9:16 frame, captions inside every app's safe zone. highlight: each word lights up from its start until
 *  the next word starts. A line too wide for the box (one long word) is drawn smaller so it fits. */
export function toAss(cues, opts = {}) {
  const l = assLayout(opts);
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${l.width}`,
    `PlayResY: ${l.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${l.font},${l.fontSize},${assColour(l.color)},${assColour(l.color)},${assColour(l.outlineColor)},&H00000000,${l.bold ? -1 : 0},0,0,0,100,100,0,0,1,${l.outline},0,${l.alignment},${l.marginL},${l.marginR},${l.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const base = assColour(l.color), hi = assColour(l.highlightColor);
  const events = [];
  // Times on the centisecond grid: starts rounded up and ends down, so a gap is never narrower than the cues' own.
  const cs = cues.map((c) => {
    const s = Math.ceil(c.start * 100 - 1e-6);
    return { s, e: Math.max(s + 1, Math.floor(c.end * 100 + 1e-6)) };
  });
  cues.forEach((c, k) => {
    const words = c.words && c.lineWords && c.lineWords.reduce((a, b) => a + b, 0) === c.words.length ? c.words : null;
    const lines = words ? splitByCounts(words, c.lineWords) : textOf(c).map((t) => [{ text: t, sep: "" }]);
    // Too wide (one long word) or too many lines for the box: the cue is drawn smaller so it fits both ways.
    const widest = Math.max(...lines.map((ws) => textWidth(joinWords(ws), l.fontSize, l.outline)));
    const byWidth = widest > l.boxWidth ? Math.floor((l.fontSize * (l.boxWidth - 2 * l.outline)) / (widest - 2 * l.outline)) : l.fontSize;
    const byHeight = lines.length > l.linesFit ? Math.floor((l.boxHeight - 2 * l.outline) / (lines.length * LINE_HEIGHT)) : l.fontSize;
    const size = Math.max(1, Math.min(byWidth, byHeight));
    const fit = size < l.fontSize ? `{\\fs${size}}` : "";
    const { s, e } = cs[k];
    const render = (lit) => fit + lines.map((ws) => ws.map((w, i) => (i ? w.sep ?? " " : "") + (w === lit ? `{\\c${hi}&}${assText(w.text)}{\\c${base}&}` : assText(w.text))).join("")).join("\\N");
    if (!l.highlight || !words) { events.push(`Dialogue: 0,${assClock(s)},${assClock(e)},Default,,0,0,0,,${render(null)}`); return; }
    // Word boundaries inside the cue, each word at least one centisecond.
    const n = words.length;
    if (e - s < n) { events.push(`Dialogue: 0,${assClock(s)},${assClock(e)},Default,,0,0,0,,${render(null)}`); return; }
    const b = [s, ...words.slice(1).map((w) => Math.round(w.start * 100)), e];
    for (let i = 1; i < n; i++) b[i] = Math.max(b[i], b[i - 1] + 1);
    for (let i = n - 1; i >= 1; i--) b[i] = Math.min(b[i], b[i + 1] - 1);
    words.forEach((w, i) => events.push(`Dialogue: 0,${assClock(b[i])},${assClock(b[i + 1])},Default,,0,0,0,,${render(w)}`));
  });
  return `${head.join("\n")}\n${events.join("\n")}\n`;
}

function splitByCounts(words, counts) {
  const out = [];
  let k = 0;
  for (const n of counts) { out.push(words.slice(k, k + n)); k += n; }
  return out;
}

/** Re-splits parsed cues' text to fit a width (pixels with assMeasure, characters by default). A cue that needs more than
 *  maxLines lines becomes several cues in a row, its time shared by the length of each. */
export function rewrap(cues, maxWidth, maxLines = 3, measure = (s) => [...s].length) {
  return cues.flatMap((c) => {
    const words = textOf(c).join(" ").split(/\s+/).filter(Boolean).map((t) => ({ text: t, sep: " " }));
    if (!words.length) return [{ ...c, lines: [], format: undefined }];
    const groups = splitLineGroups(words, maxWidth, maxLines, measure);
    const parts = [];
    for (let i = 0; i < groups.length; i += maxLines) parts.push(groups.slice(i, i + maxLines));
    if (parts.length === 1) return [{ start: c.start, end: c.end, lines: groups.map(joinWords) }];
    const sizes = parts.map((p) => p.reduce((n, g) => n + [...joinWords(g)].length, 0));
    const total = sizes.reduce((a, b) => a + b, 0);
    let t = c.start;
    return parts.map((p, i) => {
      const end = i === parts.length - 1 ? c.end : Math.round((t + ((c.end - c.start) * sizes[i]) / total) * 1000) / 1000;
      const cue = { start: t, end, lines: p.map(joinWords) };
      t = end;
      return cue;
    });
  });
}
