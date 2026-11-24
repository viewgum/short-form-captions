// Reads word timings from the JSON shapes speech-to-text tools write, into [{ text, start, end, sep }] in seconds.
// sep is what goes between a word and the one before it: " ", or "" for closing punctuation and inside Chinese or Japanese text.

// whisper.cpp's [_BEG_], [_TT_30], [_LANG_en], [_extra_token_3] and Whisper's <|en|>.
const SPECIAL = /^(\[_[^\]]*\]|<\|[^|]*\|>)$/;
const CLOSING = /^[.,!?;:%)\]}"'’”»…、。，．！？：；）」』】]+$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;
const cjkEdge = (a, b) => CJK.test([...a].pop() ?? "") && CJK.test([...b][0] ?? "");

function num(v) {
  return typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
}

function fromItem(item, scale, where) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${where}: not an object`);
  const raw = String(item.word ?? item.text ?? item.punctuated_word ?? "");
  if (item.offsets && item.start === undefined) {
    return { raw, start: num(item.offsets.from) / 1000, end: num(item.offsets.to) / 1000, where };
  }
  const s = item.start ?? item.start_time ?? item.startTime, e = item.end ?? item.end_time ?? item.endTime;
  // WhisperX writes a word it could not align (often a number) with no times at all.
  if (s == null && e == null) return { raw, untimed: true, where };
  return { raw, start: num(s) * scale, end: num(e) * scale, where };
}

function check(w) {
  if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) throw new Error(`${w.where}: start and end must be numbers`);
  if (w.start < 0) throw new Error(`${w.where}: starts before zero`);
  if (w.end < w.start) throw new Error(`${w.where}: ends before it starts`);
  return w;
}

// whisper.cpp's full JSON splits words into tokens: a token that starts with a space, or follows a space-only token, starts a
// new word, and each Chinese or Japanese character run starts one too.
function mergeTokens(tokens, where) {
  const words = [];
  let space = false;
  tokens.forEach((t, i) => {
    const raw = String(t.text ?? "");
    if (SPECIAL.test(raw.trim())) return;
    if (!raw.trim()) { space = true; return; }
    const w = check(fromItem(t, 0.001, `${where}.tokens[${i}]`));
    const last = words[words.length - 1];
    if (!last || space || /^\s/.test(raw) || cjkEdge(last.raw, raw.trim())) words.push({ ...w, raw: space ? ` ${raw}` : raw });
    else { last.raw += raw; last.end = Math.max(last.end, w.end); }
    space = false;
  });
  return words;
}

// An untimed word joins the timed word before it in the same segment, or the first timed word after it.
function attachUntimed(items) {
  const out = [];
  let lead = "";
  for (const w of items) {
    if (!w.untimed) { if (lead) { w.raw = `${lead} ${w.raw.trimStart()}`; lead = ""; } out.push(w); }
    else if (out.length) out[out.length - 1].raw += ` ${w.raw.trim()}`;
    else lead = lead ? `${lead} ${w.raw.trim()}` : w.raw.trim();
  }
  if (lead && !out.length) return { words: [], orphan: lead };
  return { words: out, orphan: "" };
}

function segmentWords(s, i, scale) {
  if (!s || typeof s !== "object") throw new Error(`segments[${i}]: not an object`);
  if (!Array.isArray(s.words)) throw new Error(`segments[${i}] has no words array: turn word timestamps on in the transcriber`);
  const items = s.words.map((w, j) => fromItem(w, scale, `segments[${i}].words[${j}]`)).filter((w) => w.raw.trim() !== "");
  const { words, orphan } = attachUntimed(items);
  if (!words.length && (orphan || String(s.text ?? "").trim())) {
    throw new Error(`segments[${i}] has words but none with times ("${(orphan || s.text).trim().slice(0, 40)}"): the transcriber could not align it`);
  }
  return words;
}

function transcriptionWords(s, i) {
  if (Array.isArray(s.tokens)) return mergeTokens(s.tokens, `transcription[${i}]`);
  const w = fromItem(s, 0.001, `transcription[${i}]`);
  if (/\S\s+\S/.test(w.raw.trim())) {
    throw new Error(`transcription[${i}] is a whole segment, not a word: run whisper.cpp with -ojf (full JSON) or -ml 1`);
  }
  return [w];
}

/** Word timings from parsed JSON: an array of words, { words }, { word_segments } (WhisperX), { segments: [{ words }] }, an
 *  array of such segments, or whisper.cpp's { transcription } (full JSON with tokens, or one word per segment with -ml 1).
 *  Times are seconds unless ms is true (whisper.cpp offsets are always milliseconds). */
export function wordsFrom(json, { ms = false } = {}) {
  const scale = ms ? 0.001 : 1;
  const isSegments = (a) => a.length > 0 && a.every((s) => s && typeof s === "object" && Array.isArray(s.words));
  let raw;
  if (Array.isArray(json) && isSegments(json)) raw = json.flatMap((s, i) => segmentWords(s, i, scale));
  else if (Array.isArray(json)) raw = attachUntimed(json.map((w, i) => fromItem(w, scale, `[${i}]`)).filter((w) => w.raw.trim() !== "")).words;
  else if (json && Array.isArray(json.segments)) raw = json.segments.flatMap((s, i) => segmentWords(s, i, scale));
  else if (json && Array.isArray(json.words)) raw = attachUntimed(json.words.map((w, i) => fromItem(w, scale, `words[${i}]`)).filter((w) => w.raw.trim() !== "")).words;
  else if (json && Array.isArray(json.word_segments)) raw = attachUntimed(json.word_segments.map((w, i) => fromItem(w, scale, `word_segments[${i}]`)).filter((w) => w.raw.trim() !== "")).words;
  else if (json && Array.isArray(json.transcription)) raw = json.transcription.flatMap((s, i) => transcriptionWords(s, i));
  else throw new Error("no word timings found: expected an array of words, or a words, word_segments, segments or transcription array");
  if (!raw.length) throw new Error("no word has times");
  // Sources that keep spacing (Whisper's " word") decide the separators; otherwise spaces go between words, except before
  // closing punctuation and between Chinese or Japanese characters.
  const spaced = raw.some((w, i) => i > 0 && /^\s/.test(w.raw));
  let last = -Infinity;
  return raw.map((w, i) => {
    check(w);
    if (w.start < last) throw new Error(`${w.where}: starts before the word before it`);
    last = w.start;
    const text = w.raw.trim();
    const prev = i ? raw[i - 1].raw.trim() : "";
    const sep = i === 0 ? "" : CLOSING.test(text) || cjkEdge(prev, text) ? "" : spaced ? (/^\s/.test(w.raw) ? " " : "") : " ";
    return { text, start: w.start, end: w.end, sep };
  });
}
