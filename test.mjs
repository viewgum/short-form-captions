// node test.mjs   (REQUIRE_FFMPEG=1 makes the render checks fail instead of skip when FFmpeg is missing; CI sets it)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  wordsFrom, cuesFromWords, oneWordCues, groupWords, splitLines, timeCues, parseSrt, parseVtt, parseCaptions, toSrt, toVtt,
  toAss, rewrap, assLayout, assMeasure, textWidth, lineCharsFor, srtTime, vttTime, assTime, checkCues, profileRules, guidelines, SAFE,
} from "./index.mjs";
import { main } from "./bin/short-form-captions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, "examples/words.json"), "utf8"));
const W = (text, start, end) => ({ text, start, end });
const words = (s, step = 0.3, gap = 0.02) => s.split(" ").map((t, i) => ({ ...W(t, round(i * step), round(i * step + step - gap)), sep: " " }));
const round = (n) => Math.round(n * 1000) / 1000;
const flat = (ws) => ws.map((w) => [w.text, w.start, w.end, w.sep]);
const cli = (args) => { let out = "", err = ""; const code = main(args, { out: (s) => (out += s), err: (s) => (err += s) }); return { code, out, err }; };
const tmp = mkdtempSync(join(tmpdir(), "sfc-test-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const events = (ass) => ass.split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => {
  const p = l.split(","); const t = (x) => { const [h, m, s] = x.split(":"); return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 100); };
  return { s: t(p[1]), e: t(p[2]), text: p.slice(9).join(",") };
});

test("reads word timings from each JSON shape", () => {
  const want = [["Bread", 0.1, 0.4, ""], ["rises.", 0.4, 0.9, " "]];
  assert.deepEqual(flat(wordsFrom([{ word: "Bread", start: 0.1, end: 0.4 }, { text: "rises.", start: 0.4, end: 0.9 }])), want);
  assert.deepEqual(flat(wordsFrom({ words: [{ word: "Bread", start: 0.1, end: 0.4 }, { word: "rises.", start: 0.4, end: 0.9 }] })), want);
  assert.deepEqual(flat(wordsFrom({ word_segments: [{ word: "Bread", start: 0.1, end: 0.4 }, { word: "rises.", start: 0.4, end: 0.9 }] })), want);
  assert.deepEqual(flat(wordsFrom({ segments: [{ words: [{ word: " Bread", start: 0.1, end: 0.4 }] }, { words: [{ word: " rises.", start: 0.4, end: 0.9 }] }] })), want);
  assert.deepEqual(flat(wordsFrom({ words: [{ text: "Bread", start: 100, end: 400 }, { text: "rises.", start: 400, end: 900 }] }, { ms: true })), want);
  // An array of segments (a faster-whisper dump) is read through each segment's words, not as one word per segment.
  assert.deepEqual(flat(wordsFrom([{ text: " Bread rises.", start: 0.1, end: 0.9, words: [{ word: " Bread", start: 0.1, end: 0.4 }, { word: " rises.", start: 0.4, end: 0.9 }] }])), want);
  // whisper.cpp with -ml 1: one word per segment, offsets in milliseconds.
  assert.deepEqual(flat(wordsFrom({ transcription: [{ text: " Bread", offsets: { from: 100, to: 400 } }, { text: " rises.", offsets: { from: 400, to: 900 } }] })), want);
});

test("keeps the source's spacing: punctuation, Chinese and Japanese", () => {
  // Whisper keeps a space before each word, so a word without one joins the word before it.
  assert.equal(cuesFromWords(wordsFrom({ segments: [{ words: [{ word: " she", start: 0, end: 0.2 }, { word: ",", start: 0.2, end: 0.25 }, { word: " said.", start: 0.3, end: 0.6 }] }] }))[0].lines[0], "she, said.");
  // A word list without spacing gets spaces, except before closing punctuation and between Chinese or Japanese characters.
  assert.equal(cuesFromWords(wordsFrom([W("she", 0, 0.2), W(",", 0.2, 0.25), W("said.", 0.3, 0.6)]))[0].lines[0], "she, said.");
  assert.equal(cuesFromWords(wordsFrom([W("今", 0, 0.2), W("日", 0.2, 0.4), W("は", 0.4, 0.6), W("。", 0.6, 0.7)]))[0].lines[0], "今日は。");
});

test("whisper.cpp tokens join into words", () => {
  const tok = (text, from, to) => ({ text, offsets: { from, to } });
  const tr = (tokens) => flat(wordsFrom({ transcription: [{ text: "", tokens }] }));
  assert.deepEqual(tr([tok("[_BEG_]", 0, 0), tok("[_LANG_en]", 0, 0), tok(" Bre", 100, 250), tok("ad", 250, 400), tok(" rises", 400, 800), tok(".", 800, 900), tok("[_TT_45]", 900, 900), tok("[_extra_token_3]", 900, 900)]),
    [["Bread", 0.1, 0.4, ""], ["rises.", 0.4, 0.9, " "]]);
  assert.deepEqual(tr([tok(" Hello", 0, 300), tok(" ", 300, 300), tok("world", 300, 600)]).map((w) => w[0]), ["Hello", "world"], "a space-only token is a word boundary");
  assert.deepEqual(tr([tok("今", 0, 200), tok("日", 200, 400), tok("は", 400, 600)]).map((w) => w[0]), ["今", "日", "は"], "each character is a word to highlight");
  assert.throws(() => wordsFrom({ transcription: [{ tokens: [tok(" Bre", 100, 250), tok("ad", 400, 300)] }] }), /ends before it starts/);
  assert.throws(() => wordsFrom({ transcription: [{ text: " Bread rises.", offsets: { from: 100, to: 900 } }] }), /whole segment/);
});

test("a word with no times joins the word before it in its own segment", () => {
  const seg = (...ws) => ({ words: ws });
  assert.deepEqual(wordsFrom({ segments: [seg(W("In", 0, 0.2), { word: "1990," }, W("bread", 0.6, 0.9))] }).map((w) => w.text), ["In 1990,", "bread"]);
  // An untimed word that opens a segment joins that segment's first word, not the end of the segment before.
  const two = wordsFrom({ segments: [seg(W("Earlier.", 0, 0.5)), seg({ word: "1990" }, W("was", 15, 15.3))] });
  assert.deepEqual(two.map((w) => [w.text, w.start]), [["Earlier.", 0], ["1990 was", 15]]);
  assert.deepEqual(wordsFrom([{ word: "42" }, W("loaves", 1, 1.4)]).map((w) => w.text), ["42 loaves"]);
  assert.throws(() => wordsFrom([{ word: "42" }]), /no word has times/);
  assert.throws(() => wordsFrom({ segments: [seg(W("a", 0, 1)), { text: "a whole sentence", words: [] }] }), /none with times/);
  assert.throws(() => wordsFrom([{ word: "half", start: 1 }]), /must be numbers/);
});

test("refuses word timings it cannot trust", () => {
  assert.throws(() => wordsFrom({ text: "no words here" }), /no word timings/);
  assert.throws(() => wordsFrom({ segments: [{ text: "x", start: 0, end: 1 }] }), /word timestamps/);
  assert.throws(() => wordsFrom([W("a", 1, 0.5)]), /ends before it starts/);
  assert.throws(() => wordsFrom([W("a", -1, 0.5)]), /before zero/);
  assert.throws(() => wordsFrom([W("a", 1, 1.2), W("b", 0.5, 0.8)]), /starts before/);
  assert.throws(() => wordsFrom([{ word: "a", start: "x", end: 1 }]), /must be numbers/);
  assert.throws(() => wordsFrom([]), /no word has times/);
});

test("cues fit the line limits and break at sentences, pauses and natural places", () => {
  const ws = wordsFrom(example);
  for (const [maxChars, maxLines, maxWords] of [[25, 2, 0], [11, 2, 6], [16, 2, 4], [42, 2, 0]]) {
    const cues = cuesFromWords(ws, { maxChars, maxLines, maxWords });
    assert.deepEqual(cues.flatMap((c) => c.words.map((w) => w.text)), ws.map((w) => w.text), "every word once, in order");
    for (const c of cues) {
      assert.ok(c.lines.length <= maxLines, `${c.lines} has too many lines`);
      for (const l of c.lines) assert.ok([...l].length <= maxChars || !l.includes(" "), `"${l}" is over ${maxChars}`);
      if (maxWords) assert.ok(c.words.length <= maxWords);
      assert.ok(!/^(the|a|an|and|because|so|of|to)$/i.test(c.words[c.words.length - 1].text), `a cue ends on "${c.words[c.words.length - 1].text}"`);
    }
  }
  // A sentence end alone, and a pause alone, each end a cue.
  assert.equal(groupWords([W("One.", 0, 0.3), W("Two", 0.3, 0.6)].map((w) => ({ ...w, sep: " " }))).length, 2);
  assert.equal(groupWords([W("one", 0, 0.3), W("two", 0.7, 1.0)].map((w) => ({ ...w, sep: " " }))).length, 2, "a 0.4 s pause");
  assert.equal(groupWords([W("one", 0, 0.3), W("two", 0.69, 1.0)].map((w) => ({ ...w, sep: " " }))).length, 1, "a 0.39 s pause");
  const timed = groupWords(words("one two three four five six seven eight", 1.2), { maxSeconds: 3, maxChars: 99 });
  for (const g of timed) assert.ok(g[g.length - 1].end - g[0].start <= 3);
});

test("lines split balanced, the lower line no shorter, a long word on its own", () => {
  assert.deepEqual(splitLines(["Bread", "rises"], 25), ["Bread rises"]);
  assert.deepEqual(splitLines("because yeast eats sugar and breathes".split(" "), 25), ["because yeast eats", "sugar and breathes"]);
  assert.deepEqual(splitLines("The gluten traps it, so the dough".split(" "), 25), ["The gluten traps it,", "so the dough"]);
  assert.deepEqual(splitLines(["Supercalifragilistic", "words"], 10), ["Supercalifragilistic", "words"]);
  assert.equal(splitLines(["😀", "😀"], 3).length, 1, "an emoji is one character");
  const { measure, maxWidth } = assMeasure();
  assert.deepEqual(splitLines("MMMM MMMM".split(" "), maxWidth, 2, measure), ["MMMM", "MMMM"], "measured in pixels for ASS");
});

test("times: the minimum duration, two-frame gaps, no overlaps, the maximum", () => {
  const [a, b, c] = timeCues([{ start: 0, end: 0.3, lines: ["a"] }, { start: 1.0, end: 2.0, lines: ["b"] }, { start: 2.7, end: 3.0, lines: ["c"] }], { fps: 30 });
  assert.equal(a.end, Math.floor((1.0 - 2 / 30) * 1000) / 1000, "0.3 s extended past 5/6 s, then a gap under 0.5 s closed to 2 frames");
  assert.equal(b.end, 2.0, "a 0.7 s gap is left as it is");
  assert.ok(c.end - c.start >= 5 / 6, "at least five sixths of a second, rounded up to the millisecond");
  const [x] = timeCues([{ start: 0, end: 1.5, lines: ["x"] }, { start: 1.0, end: 2, lines: ["y"] }], { fps: 24 });
  assert.ok(1.0 - x.end >= 2 / 24 - 1e-9, "overlapping words are pulled back to a 2 frame gap");
  const [m] = timeCues([{ start: 0, end: 7, lines: ["m"] }, { start: 7.45, end: 8, lines: ["n"] }]);
  assert.ok(m.end <= 7, "closing a gap never runs past maxSeconds");
  // Next cue 20 ms later: the two never overlap, whatever the minimum says.
  for (const [s2, e1] of [[0.02, 0.01], [0, 0.3], [0.5, 0.3]]) {
    const t = timeCues([{ start: 0, end: e1, lines: ["one."] }, { start: s2, end: 1, lines: ["two."] }]);
    assert.ok(t[0].end > t[0].start && t[0].end <= t[1].start, JSON.stringify(t));
  }
  for (const fps of [24, 25, 30, 60]) {
    const cues = cuesFromWords(wordsFrom(example), { fps });
    for (let i = 1; i < cues.length; i++) assert.ok((cues[i].start - cues[i - 1].end) * fps >= 2 - 1e-6, `gap under 2 frames at ${fps} fps`);
  }
  assert.throws(() => cuesFromWords(wordsFrom(example), { maxSeconds: 0.5 }), /shorter than the minimum/);
});

test("short sentences in a row join instead of flashing past", () => {
  const ws = [W("Yes.", 0, 0.2), W("No.", 0.25, 0.45), W("Maybe.", 0.5, 0.8)].map((w) => ({ ...w, sep: " " }));
  const cues = cuesFromWords(ws);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].lines.join(" "), "Yes. No. Maybe.");
  assert.ok(cues[0].end - cues[0].start >= 5 / 6);
});

test("one word per cue, shown until the next word; words at the same moment share one", () => {
  const cues = oneWordCues(words("one two three"), { fps: 30 });
  assert.deepEqual(cues.map((c) => c.lines[0]), ["one", "two", "three"]);
  assert.ok(Math.abs(cues[1].start - cues[0].end - 2 / 30) < 0.002);
  const tied = oneWordCues([W("a", 0, 0.2), W("b", 0, 0.2), W("c", 0.5, 0.7)].map((w) => ({ ...w, sep: " " })));
  assert.deepEqual(tied.map((c) => c.lines[0]), ["a b", "c"]);
  for (let i = 1; i < tied.length; i++) assert.ok(tied[i - 1].end <= tied[i].start);
});

test("times print in each format", () => {
  assert.equal(srtTime(3723.0456), "01:02:03,046");
  assert.equal(vttTime(59.9996), "00:01:00.000");
  assert.equal(assTime(3723.456), "1:02:03.46");
  assert.throws(() => srtTime(-1), /cannot write/);
});

test("SRT and WebVTT: round trips, real-world input and bad times", () => {
  const cues = [{ start: 1, end: 2.5, lines: ["Tom & Jerry <live>", "a b"] }, { start: 3, end: 4, lines: ["two"] }];
  assert.deepEqual(parseSrt(toSrt(cues)).map((c) => [c.start, c.end, c.lines]), cues.map((c) => [c.start, c.end, c.lines]));
  const vtt = toVtt(cues);
  assert.match(vtt, /Tom &amp; Jerry &lt;live&gt;/);
  assert.deepEqual(parseVtt(vtt).map((c) => [c.start, c.end]), [[1, 2.5], [3, 4]]);
  // Converting WebVTT keeps what a viewer reads: tags off, entities decoded once, braces kept.
  const v = "WEBVTT - title\n\nNOTE a note\n\nSTYLE\n::cue { color: red }\n\nSTYLE recap\n00:01.000 --> 00:02.000 line:80% align:center\nTom &amp; <i>Jerry</i> {42} &amp;lt;\n\n00:03.000 --> 00:04.000\nnext\n";
  const parsed = parseVtt(v);
  assert.equal(parsed.length, 2, "a cue whose identifier starts with STYLE is still a cue");
  assert.equal(parsed[0].settings, "line:80% align:center");
  assert.match(toVtt(parsed), /\nTom &amp; Jerry \{42\} &amp;lt;\n/);
  assert.match(toSrt(parsed), /\nTom & Jerry \{42\} &lt;\n/);
  assert.match(toSrt(parseSrt("1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Top</i> {note}\n")), /\nTop \{note\}\n/);
  const srt = "﻿1\r\n00:00:01.5 --> 00:00:02,000\r\nhello\r\n\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nno index\r\n";
  assert.deepEqual(parseSrt(srt).map((c) => [c.start, c.end, c.lines]), [[1.5, 2, ["hello"]], [3, 4, ["no index"]]]);
  assert.equal(parseCaptions(v).length, 2);
  assert.throws(() => parseVtt("1\n00:00:01,000 --> 00:00:02,000\nx\n"), /WEBVTT/);
  assert.throws(() => parseSrt("1\n00:00:01,000 00:00:02,000\nx\n"), /no "start --> end"/);
  for (const t of ["-00:00:02,000", "00:00:02,000x", "00:99,000", "00:00:61,000"]) assert.throws(() => parseSrt(`1\n00:00:01,000 --> ${t}\nx\n`), /cannot read the time/, t);
  assert.throws(() => parseSrt("1\n00:00:01,000 --> 00:00:02,000\nx\n2\n00:00:03,000 --> 00:00:04,000\ny\n"), /blank line missing/);
});

test("ASS: frame size, safe margins for each position, escaping, scaled for 720 x 1280", () => {
  const ass = toAss([{ start: 0, end: 1, lines: ["a {b} c\\d"] }], { position: "bottom" });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n/);
  assert.match(ass, /,2,300,300,700,1\n/);
  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,a \(b\) c\/d\n/);
  assert.match(toAss([], { position: "top" }), /,8,192,192,300,1\n/);
  const small = assLayout({ width: 720, height: 1280, position: "bottom", fontSize: 48 });
  assert.deepEqual([small.marginL, small.marginR, small.marginV, small.boxWidth], [200, 200, 467, 320]);
  assert.equal(lineCharsFor({ position: "bottom", fontSize: 72 }), 10);
  assert.equal(Math.round(textWidth("M", 1000)), 833, "Arial Bold widths");
  assert.throws(() => assLayout({ position: "constructor" }), /position/);
  assert.throws(() => assLayout({ font: "Arial,Bold" }), /comma/);
  assert.throws(() => assLayout({ width: 0 }), /positive/);
});

test("ASS: a word too wide for the box is drawn smaller, and gaps survive the centisecond grid", () => {
  const [e] = events(toAss([{ start: 0, end: 1, lines: ["Congratulations"] }]));
  const fs = Number(/\{\\fs(\d+)\}/.exec(e.text)?.[1]);
  assert.ok(fs > 0 && textWidth("Congratulations", fs) <= 480 - 8, `drawn at ${fs}`);
  assert.ok(!/\\fs/.test(events(toAss([{ start: 0, end: 1, lines: ["Bread rises"] }]))[0].text));
  const [a, b] = events(toAss([{ start: 0, end: 0.937, lines: ["a"] }, { start: 1.004, end: 2, lines: ["b"] }]));
  assert.ok(b.s - a.e >= 6.67, `gap ${b.s - a.e} cs`);
});

test("ASS highlight: one event per word inside its cue, every word lit, lines fixed", () => {
  const cues = cuesFromWords(words("one two three four"), { maxChars: 10, maxLines: 2 });
  assert.equal(cues.length, 1);
  const ev = events(toAss(cues, { highlight: true }));
  assert.equal(ev.length, 4);
  assert.equal(new Set(ev.map((x) => x.text.replace(/\{[^}]*\}/g, ""))).size, 1, "the text never changes while the highlight moves");
  ev.forEach((x, i) => assert.ok(x.text.includes(`{\\c&H0000D4FF&}${["one", "two", "three", "four"][i]}{\\c&H00FFFFFF&}`)));
  assert.ok(!ev.some((x) => x.text.includes("{\\r}")));
  // A cue cut short by the next one: the highlight stays inside it and every word gets a turn.
  const short = cuesFromWords([W("one", 0, 0.7), W("two.", 0.97, 1.0), W("Three.", 1.01, 2.0)].map((w) => ({ ...w, sep: " " })), { maxChars: 30 });
  const ev2 = events(toAss(short, { highlight: true }));
  for (const c of short) {
    const s = Math.ceil(c.start * 100 - 1e-6), e = Math.floor(c.end * 100 + 1e-6);
    const mine = ev2.filter((x) => x.s >= s && x.e <= e);
    assert.equal(mine.length, c.words.length, "an event for every word, inside the cue");
  }
  for (let i = 1; i < ev2.length; i++) assert.ok(ev2[i].s >= ev2[i - 1].e);
  const single = events(toAss(cuesFromWords([{ ...W("Alone.", 0, 1), sep: "" }]), { highlight: true }));
  assert.match(single[0].text, /\{\\c&H0000D4FF&\}Alone\./, "a one-word cue is lit too");
});

test("convert to ASS re-splits lines to fit the box and splits a cue that cannot fit", () => {
  const cues = rewrap([{ start: 0, end: 2, lines: ["because the yeast makes gas and the dough rises"] }], 11, 3);
  for (const c of cues) { assert.ok(c.lines.length <= 3); for (const l of c.lines) assert.ok(l.length <= 11); }
  const long = rewrap([{ start: 0, end: 6, lines: ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen"] }], 11, 2);
  assert.ok(long.length > 1);
  assert.equal(long[0].start, 0);
  assert.equal(long[long.length - 1].end, 6);
  for (let i = 1; i < long.length; i++) assert.equal(long[i].start, long[i - 1].end);
  for (const c of long) assert.ok(c.lines.length <= 2);
});

test("each profile's rules have a source, a quote and a check", () => {
  for (const id of Object.keys(guidelines.profiles)) {
    for (const r of profileRules(id)) {
      assert.ok(r.source && r.source.url && r.source.checked, `${id} ${r.id} has no source`);
      assert.ok(r.quote && r.section && ["fail", "warn"].includes(r.level), `${id} ${r.id}`);
    }
    checkCues([{ start: 0, end: 1, lines: ["ok"] }], { profile: id, fps: 24 });
  }
  assert.equal(profileRules("netflix-children").find((r) => r.id === "max-cps").limit, 17);
  assert.equal(profileRules("bbc-vertical").find((r) => r.id === "max-lines").limit, 3);
});

test("the checker flags each rule just past its limit and not at it", () => {
  const ids = (cues, o) => checkCues(cues, o).rows.map((r) => r.rule);
  const c = (start, end, ...lines) => ({ start, end, lines });
  assert.deepEqual(ids([c(0, 3, "x".repeat(42))]), []);
  assert.deepEqual(ids([c(0, 3, "x".repeat(43))]), ["max-chars-per-line"]);
  assert.deepEqual(ids([c(0, 3, "a", "b")]), []);
  assert.deepEqual(ids([c(0, 3, "a", "b", "c")]), ["max-lines"]);
  assert.deepEqual(ids([c(0, 1, "x".repeat(20))]), []);
  assert.deepEqual(ids([c(0, 1, "x".repeat(21))]), ["max-cps"]);
  assert.deepEqual(ids([c(0, 1, "x".repeat(10), "y".repeat(10))]), ["max-cps"], "a line break counts as the space it stands for");
  assert.deepEqual(ids([c(0, 1, "x".repeat(17))], { profile: "netflix-children" }), []);
  assert.deepEqual(ids([c(0, 1, "x".repeat(18))], { profile: "netflix-children" }), ["max-cps"]);
  assert.deepEqual(ids([c(0, 0.833, "hi")]), [], "5/6 s at millisecond precision");
  assert.deepEqual(ids([c(0, 0.832, "hi")]), ["min-duration"]);
  assert.deepEqual(ids([c(0, 7, "hi")]), []);
  assert.deepEqual(ids([c(0, 7.001, "hi")]), ["max-duration"]);
  assert.deepEqual(ids([c(0, 1, "a"), c(1.08, 2, "b")], { fps: 25 }), []);
  assert.deepEqual(ids([c(0, 1, "a"), c(1.078, 2, "b")], { fps: 25 }), ["min-gap-frames"]);
  assert.deepEqual(ids([c(0, 1, "a"), c(1 + 2 / 30, 2, "b")]), []);
  assert.deepEqual(ids([c(0, 1, "a"), c(1.3, 2.3, "b")]), ["close-gaps-under"]);
  // 24 fps: gaps of 3 to 11 frames must be closed (a fail); 2 and 12 frames are fine.
  for (const [f, want] of [[2, []], [3, ["close-gaps-24fps"]], [11, ["close-gaps-24fps"]], [12, []]]) {
    assert.deepEqual(ids([c(0, 1, "a"), c(1 + f / 24, 3, "b")], { fps: 24 }), want, `${f} frames`);
  }
  assert.deepEqual(ids([c(0, 1, "a"), c(0.5, 2, "b")]), ["overlap"]);
  assert.deepEqual(ids([c(0, 1, ""), c(2, 1, "b")]), ["empty", "ends-before-start"]);
  assert.deepEqual(ids([c(NaN, 1, "a")]), ["bad-time"]);
  assert.deepEqual(ids([c(0, 3, "x".repeat(37))], { profile: "bbc" }), []);
  assert.deepEqual(ids([c(0, 3, "x".repeat(38))], { profile: "bbc" }), ["max-chars-per-line"]);
  assert.deepEqual(ids([c(0, 3, "x".repeat(25))], { profile: "bbc-vertical" }), []);
  assert.deepEqual(ids([c(0, 3, "x".repeat(26))], { profile: "bbc-vertical" }), ["max-chars-per-line"]);
  assert.deepEqual(ids([c(0, 1.2, "one two three")], { profile: "bbc" }), [], "150 words a minute");
  assert.deepEqual(ids([c(0, 1, "one two three four")], { profile: "bbc" }), ["max-wpm", "min-seconds-per-word"]);
  assert.deepEqual(ids([c(0, 1.1, "- Say yes now")], { profile: "bbc" }), [], "a speaker dash is not a word");
  assert.deepEqual(ids([c(0, 2, "a b", "c d", "e f")], { profile: "bbc-vertical" }), []);
  assert.deepEqual(ids([{ start: 0, end: 3, lines: ["<i>" + "x".repeat(42) + "</i>"], format: "vtt" }]), [], "tags are not characters");
  assert.deepEqual(ids([c(0, 1, "a"), c(1.07, 2, "b")], { fps: 24 }), ["min-gap-frames"], "2 frames at 24 fps is 0.083 s");
  assert.deepEqual(ids([c(0, 1, "a"), c(1.07, 2, "b")], { fps: 30 }), [], "2 frames at 30 fps is 0.067 s");
  assert.doesNotThrow(() => checkCues([{ start: 0, end: 9, lines: Array(200000).fill("x") }]), "a huge cue does not overflow the stack");
  assert.throws(() => checkCues([c(0, 1, "a")], { fps: NaN }), /fps/);
});

test("captions made from words pass the Netflix profile, at 24, 25 and 30 fps", () => {
  for (const fps of [24, 25, 30]) {
    const r = checkCues(cuesFromWords(wordsFrom(example), { fps }), { profile: "netflix", fps });
    assert.equal(r.counts.fail, 0, JSON.stringify(r.rows));
  }
});

test("the examples and the README show what the tool makes now", () => {
  const ex = join(here, "examples/words.json");
  const files = [["captions.srt", ["words", ex]], ["captions.vtt", ["words", ex, "--to", "vtt"]], ["captions-highlight.ass", ["words", ex, "--to", "ass", "--style", "highlight"]]];
  for (const [f, args] of files) assert.equal(readFileSync(join(here, "examples", f), "utf8"), cli(args).out, `examples/${f} is out of date`);
  const readme = readFileSync(join(here, "README.md"), "utf8");
  assert.ok(readme.includes("```\n" + cli(["words", ex]).out + "```"), "the README's SRT example is out of date");
  const report = cli(["check", join(here, "examples/too-fast.srt")]).out.split("\n\nSources:")[0];
  assert.ok(readme.includes("```\n" + report + "\n```"), "the README's check example is out of date");
});

test("command line: outputs, files, input encodings and exit codes", () => {
  const ex = join(here, "examples/words.json");
  const srt = cli(["words", ex]);
  assert.equal(srt.code, 0);
  assert.equal(parseSrt(srt.out).length, cuesFromWords(wordsFrom(example)).length);
  assert.match(cli(["words", ex, "--to", "vtt"]).out, /^WEBVTT\n/);
  const out = join(tmp, "c.ass");
  assert.equal(cli(["words", ex, "--out", out, "--style", "highlight", "--position", "middle"]).code, 0);
  assert.match(readFileSync(out, "utf8"), /PlayResY: 1920/);
  writeFileSync(join(tmp, "bom.json"), "﻿" + JSON.stringify(example));
  assert.equal(cli(["words", join(tmp, "bom.json")]).out, srt.out, "a JSON file with a byte order mark");
  writeFileSync(join(tmp, "u16.srt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("1\r\n00:00:00,000 --> 00:00:01,000\r\ncafé\r\n", "utf16le")]));
  assert.match(cli(["convert", join(tmp, "u16.srt"), "--to", "vtt"]).out, /café/);
  writeFileSync(join(tmp, "bad-utf8.srt"), Buffer.from([0x31, 0x0a, 0xc3, 0x28]));
  assert.equal(cli(["check", join(tmp, "bad-utf8.srt")]).code, 2);
  writeFileSync(join(tmp, "bad.srt"), "1\n00:00:00,000 --> 00:00:00,300\nway too many characters for one short cue\n");
  const chk = cli(["check", join(tmp, "bad.srt")]);
  assert.equal(chk.code, 1);
  assert.match(chk.out, /fail +cue 1/);
  assert.equal(JSON.parse(cli(["check", join(tmp, "bad.srt"), "--json"]).out).ok, false);
  writeFileSync(join(tmp, "warn.srt"), "1\n00:00:00,000 --> 00:00:01,000\na b c d e f\n");
  assert.equal(cli(["check", join(tmp, "warn.srt"), "--profile", "bbc"]).code, 0);
  assert.equal(cli(["check", join(tmp, "warn.srt"), "--profile", "bbc", "--strict"]).code, 1);
  const strict = JSON.parse(cli(["check", join(tmp, "warn.srt"), "--profile", "bbc", "--strict", "--json"]).out);
  assert.equal(strict.ok, false, "--strict --json reports the same verdict as the exit code");
  for (const bad of [["words"], ["nope", ex], ["words", ex, "--bogus"], ["words", ex, "--to", "doc"], ["words", join(tmp, "missing.json")],
    ["words", join(tmp, "bad.srt")], ["convert", join(tmp, "bad.srt"), "--style", "highlight"], ["check", ex], ["check", join(tmp, "bad.srt"), "--profile", "x"],
    ["words", ex, "--size", "1920x1080"], ["words", ex, "--size", "0x0", "--to", "ass"], ["words", ex, "--max-chars", "0"], ["words", ex, "--max-words", "0.5"],
    ["words", ex, "--to", "ass", "--color", "red"], ["words", ex, "--to", "ass", "--color="], ["words", ex, "--to", "ass", "--position", "constructor"],
    ["words", ex, "--style", "highlight"], ["words", ex, "--position", "top"], ["check", join(tmp, "bad.srt"), "--out", out], ["words", ex, "--max-seconds", "0.5"],
    ["words", ex, "--to", "ass", "--font", "Arial,Bold"]]) {
    const r = cli(bad);
    assert.equal(r.code, 2, bad.join(" "));
    assert.match(r.err, /^short-form-captions: /);
  }
  assert.match(cli(["--version"]).out, /^\d+\.\d+\.\d+\n$/);
  const conv = cli(["convert", join(tmp, "warn.srt"), "--to", "ass"]);
  assert.equal(conv.code, 0);
  assert.match(conv.out, /Dialogue: .*a b c d e f\n/);
});

// Burns the ASS into a flat grey 9:16 video with FFmpeg and checks that every pixel of text lands inside the safe zone.
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
test("rendered captions land inside every app's safe zone", { skip: !ffmpeg && !process.env.REQUIRE_FFMPEG && "FFmpeg not installed" }, () => {
  assert.ok(ffmpeg, "FFmpeg is required (REQUIRE_FFMPEG is set)");
  const caps = JSON.parse(JSON.stringify(example));
  const extra = (s, at) => words(s).map((w) => ({ word: w.text, start: w.start + at, end: w.end + at }));
  caps.words.push(...extra("WOW MAXIMUM WARMTH, MOMENTUM AND WHOLE WHEAT WOMBATS", 8), ...extra("Congratulations", 11), ...extra("MMMMMMMMMMM", 12.5));
  writeFileSync(join(tmp, "words.json"), JSON.stringify(caps));
  writeFileSync(join(tmp, "long.srt"), "1\n00:00:01,000 --> 00:00:05,000\nThis is a long subtitle made for a wide frame that has to be split across several cues to fit\n");
  for (const [w, h] of [[1080, 1920], [720, 1280]]) {
    const video = join(tmp, `grey-${w}.mp4`);
    const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x202020:s=${w}x${h}:r=10:d=14`, "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    assert.equal(made.status, 0, String(made.stderr));
    const s = w / 1080, t = h / 1920;
    const runs = [];
    for (const position of ["bottom", "middle", "top"]) {
      for (const style of ["phrase", "highlight", "one-word"]) runs.push([`${position}-${style}`, ["words", join(tmp, "words.json"), "--position", position, "--style", style]]);
      runs.push([`${position}-convert`, ["convert", join(tmp, "long.srt"), "--position", position]]);
    }
    for (const [name, args] of runs) {
      const ass = join(tmp, `${name}-${w}.ass`);
      assert.equal(cli([...args, "--to", "ass", "--out", ass, "--size", `${w}x${h}`]).code, 0, name);
      // One frame inside each event, on the video's 10 fps grid, all rendered in one pass on the video's own timeline.
      const picks = events(readFileSync(ass, "utf8")).map((ev) => ({ n: Math.ceil(ev.s / 10 - 1e-6), e: ev.e })).filter((p) => p.n * 10 < p.e && p.n < 140)
        .map((p) => p.n).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
      assert.ok(picks.length, `${name}: no events`);
      const select = picks.map((n) => `eq(n\\,${n})`).join("+");
      const f = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `ass=${ass},select='${select}'`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: picks.length * w * h + 1024 });
      assert.equal(f.status, 0, String(f.stderr));
      assert.equal(f.stdout.length, picks.length * w * h, `${name}: ${f.stdout.length / (w * h)} frames for ${picks.length} picks`);
      picks.forEach((n, k) => {
        const b = bbox(f.stdout.subarray(k * w * h, (k + 1) * w * h), w, h);
        const where = `${name} ${w}x${h} at ${(n / 10).toFixed(1)} s: ${JSON.stringify(b)}`;
        assert.ok(b, `nothing drawn, ${where}`);
        assert.ok(b.x0 >= SAFE.left * s && b.x1 < w - SAFE.right * s && b.y0 >= SAFE.top * t && b.y1 < h - SAFE.bottom * t, `outside the box, ${where}`);
        if (b.y1 >= SAFE.columnFromY * t) assert.ok(b.x1 < w - SAFE.column * s, `in the right-hand column, ${where}`);
      });
    }
  }
});

function bbox(buf, w, h, bg = 0x20) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.abs(buf[y * w + x] - bg) > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
