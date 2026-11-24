#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import { wordsFrom } from "../lib/words.mjs";
import { cuesFromWords, oneWordCues, SUBTITLE_DEFAULTS } from "../lib/cues.mjs";
import { parseCaptions, toSrt, toVtt, toAss, rewrap, assLayout, assMeasure, srtTime, isPosition, POSITIONS, ASS_DEFAULTS } from "../lib/formats.mjs";
import { checkCues, formatReport, guidelines } from "../lib/check.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `short-form-captions ${VERSION}
Captions for vertical video: word timings to SRT, WebVTT or ASS (ASS placed inside the TikTok, Reels and Shorts safe zone), and a
checker for SRT and WebVTT files.

  short-form-captions words <words.json> [--to srt|vtt|ass] [--out <file>] [options]
      Word timings (an array of words, or a words, word_segments, segments or transcription array; seconds, or --ms) to captions.
  short-form-captions convert <captions.srt|captions.vtt> --to srt|vtt|ass [--out <file>] [ASS options]
      SRT or WebVTT to another format, keeping the text and times; to ASS the lines are re-split to fit the safe box.
  short-form-captions check <captions.srt|captions.vtt> [--profile netflix] [--fps 30] [--json] [--strict]
      Reading speed, line length, lines, duration and gaps against a published guideline.
  short-form-captions profiles
      The check profiles and their sources.

  Cue options:  --max-chars <n> --max-lines <n> --max-words <n> --max-seconds <s> --fps <n> --ms --style phrase|one-word
  ASS options:  --style phrase|highlight|one-word  --position bottom|middle|top  --size 1080x1920
                --font <name> --font-size <px> --color RRGGBB --highlight-color RRGGBB

Exit codes: 0 done (check: no fail), 1 check found a fail (or a warn with --strict), 2 bad input.
Profiles: ${Object.keys(guidelines.profiles).join(", ")}. Sources: data/guidelines.json.`;

// s: text, i: whole number from 1, n: positive number, b: switch.
const FLAGS = {
  "--to": "s", "--out": "s", "--max-chars": "i", "--max-lines": "i", "--max-words": "i", "--max-seconds": "n", "--fps": "n",
  "--style": "s", "--position": "s", "--size": "s", "--font": "s", "--font-size": "n", "--color": "s", "--highlight-color": "s",
  "--profile": "s", "--ms": "b", "--json": "b", "--strict": "b", "--help": "b", "--version": "b",
};
const ALLOWED = {
  words: ["to", "out", "max-chars", "max-lines", "max-words", "max-seconds", "fps", "style", "position", "size", "font", "font-size", "color", "highlight-color", "ms"],
  convert: ["to", "out", "max-chars", "max-lines", "style", "position", "size", "font", "font-size", "color", "highlight-color"],
  check: ["profile", "fps", "json", "strict"],
  profiles: [],
};
const ASS_ONLY = ["position", "size", "font", "font-size", "color", "highlight-color"];

class Usage extends Error {}

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const [k, inline] = a.split(/=(.*)/s, 2);
    const kind = FLAGS[k];
    if (!kind) throw new Usage(`unknown option ${k}`);
    if (kind === "b") { if (inline !== undefined) throw new Usage(`${k} takes no value`); o[k.slice(2)] = true; continue; }
    const v = inline ?? argv[++i];
    if (v === undefined || v === "" || (inline === undefined && v.startsWith("--"))) throw new Usage(`${k} needs a value`);
    if (kind === "i") { if (!/^[1-9]\d*$/.test(v)) throw new Usage(`${k} must be a whole number from 1, not "${v}"`); o[k.slice(2)] = Number(v); }
    else if (kind === "n") { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Usage(`${k} must be a positive number, not "${v}"`); o[k.slice(2)] = n; }
    else o[k.slice(2)] = v;
  }
  return o;
}

// Reads UTF-8 (with or without a byte order mark) or UTF-16 with its byte order mark; refuses bytes that are not valid text.
function read(file) {
  let buf;
  try { buf = readFileSync(file); } catch (e) { throw new Usage(`cannot read ${file}: ${e.code || e.message}`); }
  const enc = buf[0] === 0xff && buf[1] === 0xfe ? "utf-16le" : buf[0] === 0xfe && buf[1] === 0xff ? "utf-16be" : "utf-8";
  try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { throw new Usage(`${file} is not valid ${enc.toUpperCase()} text`); }
}

function sizeOf(s) {
  const m = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(s ?? `${ASS_DEFAULTS.width}x${ASS_DEFAULTS.height}`);
  if (!m) throw new Usage(`--size must look like 1080x1920, not "${s}"`);
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (Math.abs(w / h - 9 / 16) > 0.01) throw new Usage("--size must be 9:16 (the safe zones are for vertical video)");
  return { width: w, height: h };
}

function targetOf(o) {
  const to = o.to ?? (o.out ? extname(o.out).slice(1).toLowerCase() : "srt");
  if (!["srt", "vtt", "ass"].includes(to)) throw new Usage(`--to must be srt, vtt or ass, not "${to}"`);
  return to;
}

function assOpts(o) {
  if (o.position !== undefined && !isPosition(o.position)) throw new Usage(`--position must be ${Object.keys(POSITIONS).join(", ")}`);
  for (const k of ["color", "highlight-color"]) if (o[k] !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(o[k])) throw new Usage(`--${k} must be six hex digits like FFD400`);
  if (o.font !== undefined && /[,\r\n]/.test(o.font)) throw new Usage("--font cannot contain a comma or a line break");
  const size = sizeOf(o.size);
  return {
    ...size,
    position: o.position ?? ASS_DEFAULTS.position,
    font: o.font ?? ASS_DEFAULTS.font,
    fontSize: o["font-size"] ?? Math.round((ASS_DEFAULTS.fontSize * size.height) / 1920),
    color: o.color ?? ASS_DEFAULTS.color,
    highlightColor: o["highlight-color"] ?? ASS_DEFAULTS.highlightColor,
    highlight: o.style === "highlight",
  };
}

// The lines a cue may have in ASS: what the user asked, refused when the position's box cannot hold that many at the font size.
function assLines(o, ass, fallback) {
  const { linesFit } = assLayout(ass);
  if (linesFit < 1) throw new Usage(`--font-size ${ass.fontSize} is too large for --position ${ass.position}: not one line fits inside the safe zone`);
  if (o["max-lines"] > linesFit) throw new Usage(`--position ${ass.position} holds at most ${linesFit} lines at --font-size ${ass.fontSize} inside the safe zone`);
  return o["max-lines"] ?? Math.min(fallback, linesFit);
}

function cueOpts(o, to, ass) {
  const c = {};
  if (to === "ass") {
    const { measure, maxWidth } = assMeasure(ass);
    c.measure = measure;
    c.maxChars = o["max-chars"] ? Math.min(maxWidth, o["max-chars"] * measure("n")) : maxWidth;
    c.maxWords = o["max-words"] ?? 6;
    c.maxLines = assLines(o, ass, SUBTITLE_DEFAULTS.maxLines);
  } else {
    if (o["max-chars"]) c.maxChars = o["max-chars"];
    if (o["max-words"]) c.maxWords = o["max-words"];
    if (o["max-lines"]) c.maxLines = o["max-lines"];
  }
  if (o["max-seconds"]) {
    if (o["max-seconds"] < SUBTITLE_DEFAULTS.minDuration) throw new Usage(`--max-seconds must be at least the minimum duration, ${SUBTITLE_DEFAULTS.minDuration.toFixed(3)} s`);
    c.maxSeconds = o["max-seconds"];
  }
  if (o.fps) c.fps = o.fps;
  return c;
}

function emit(cues, to, ass, o, io) {
  const text = to === "srt" ? toSrt(cues) : to === "vtt" ? toVtt(cues) : toAss(cues, ass);
  if (o.out) {
    try { writeFileSync(o.out, text); } catch (e) { throw new Usage(`cannot write ${o.out}: ${e.code || e.message}`); }
  } else io.out(text);
  return 0;
}

function captionsFrom(file) {
  let cues;
  try { cues = parseCaptions(read(file)); } catch (e) { if (e instanceof Usage) throw e; throw new Usage(`${file}: ${e.message}`); }
  if (!cues.length) throw new Usage(`${file} has no cues`);
  return cues;
}

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const o = parse(argv);
    if (o.version) { io.out(`${VERSION}\n`); return 0; }
    const [cmd, file, ...extra] = o._;
    if (o.help || !cmd) { io.out(`${HELP}\n`); return cmd || o.help ? 0 : 2; }
    if (!ALLOWED[cmd]) throw new Usage(`unknown command ${cmd}`);
    if (extra.length) throw new Usage(`unexpected ${extra.join(" ")}`);
    for (const k of Object.keys(o)) if (k !== "_" && !ALLOWED[cmd].includes(k)) throw new Usage(`--${k} is not an option of ${cmd}`);
    if (cmd === "profiles") {
      for (const [id, p] of Object.entries(guidelines.profiles)) io.out(`${id}: ${p.name}${p.extends ? ` (extends ${p.extends})` : ""}\n`);
      for (const [k, s] of Object.entries(guidelines.sources)) io.out(`  [${k}] ${s.publisher}: ${s.title}, read ${s.checked}: ${s.url}\n`);
      return 0;
    }
    if (!file) throw new Usage(`${cmd} needs a file`);
    if (cmd === "check") {
      const cues = captionsFrom(file);
      let result;
      try { result = checkCues(cues, { profile: o.profile ?? "netflix", fps: o.fps ?? 30 }); } catch (e) { throw new Usage(e.message); }
      if (o.strict) { result.strict = true; result.ok = result.counts.fail === 0 && result.counts.warn === 0; }
      io.out(o.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatReport(result, { srtTime })}\n`);
      return result.ok ? 0 : 1;
    }
    const to = targetOf(o);
    if (o.style !== undefined && !["phrase", "highlight", "one-word"].includes(o.style)) throw new Usage("--style must be phrase, highlight or one-word");
    if (to !== "ass") {
      const used = [...ASS_ONLY, ...(cmd === "convert" ? ["max-chars", "max-lines"] : [])].filter((k) => o[k] !== undefined);
      if (used.length || o.style === "highlight") throw new Usage(`${used.length ? `--${used[0]}` : "--style highlight"} is for ASS output: add --to ass`);
    }
    const ass = assOpts(o);
    if (cmd === "words") {
      let json;
      try { json = JSON.parse(read(file).replace(/^﻿/, "")); } catch (e) { if (e instanceof Usage) throw e; throw new Usage(`${file} is not JSON: ${e.message}`); }
      let words;
      try { words = wordsFrom(json, { ms: !!o.ms }); } catch (e) { throw new Usage(`${file}: ${e.message}`); }
      const opts = cueOpts(o, to, ass);
      let cues;
      try { cues = o.style === "one-word" ? oneWordCues(words, opts) : cuesFromWords(words, opts); } catch (e) { throw new Usage(e.message); }
      return emit(cues, to, ass, o, io);
    }
    if (o.style === "highlight" || o.style === "one-word") throw new Usage(`--style ${o.style} needs word timings: use the words command`);
    let cues = captionsFrom(file);
    if (to === "ass") {
      const { measure, maxWidth } = assMeasure(ass);
      cues = rewrap(cues, o["max-chars"] ? Math.min(maxWidth, o["max-chars"] * measure("n")) : maxWidth, assLines(o, ass, ASS_DEFAULTS.maxLines), measure);
    }
    return emit(cues, to, ass, o, io);
  } catch (e) {
    if (e instanceof Usage) { io.err(`short-form-captions: ${e.message}\nRun short-form-captions --help for usage.\n`); return 2; }
    throw e;
  }
}

const self = realpathSync(fileURLToPath(import.meta.url));
let invoked = "";
try { invoked = realpathSync(process.argv[1] ?? ""); } catch {}
if (invoked === self) process.exitCode = main(process.argv.slice(2));
