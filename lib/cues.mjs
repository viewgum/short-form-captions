// Groups words into caption cues, splits each cue into lines and sets its times. A word is { text, start, end, sep }.

const SENTENCE_END = /[.?!…。！？]["'’”)\]]*$/u;
const CLAUSE_END = /[,;:、，]["'’”)\]]*$/u;

export const SUBTITLE_DEFAULTS = Object.freeze({
  maxChars: 25,
  maxLines: 2,
  maxWords: 0,
  maxSeconds: 7,
  minDuration: 5 / 6,
  pause: 0.4,
  closeGapsUnder: 0.5,
  gapFrames: 2,
  fps: 30,
});

/** Characters as a reader counts them (code points, so an emoji is one). */
export const chars = (s) => [...s].length;

/** The text of some words, with each word's own separator. */
export const joinWords = (ws) => ws.map((w, i) => (i ? w.sep ?? " " : "") + w.text).join("");

// Words given as plain strings get a space before each.
const asWords = (xs) => xs.map((x) => (typeof x === "string" ? { text: x, sep: " " } : x));

function options(opts) {
  const o = { ...SUBTITLE_DEFAULTS, ...opts };
  for (const k of ["maxChars", "maxLines", "maxSeconds", "fps", "minDuration"]) {
    if (!(Number.isFinite(o[k]) && o[k] > 0)) throw new Error(`${k} must be a positive number`);
  }
  if (o.maxSeconds < o.minDuration) throw new Error(`maxSeconds (${o.maxSeconds}) is shorter than the minimum duration (${o.minDuration.toFixed(3)} s)`);
  o.measure ??= chars;
  return o;
}

function greedyGroups(ws, maxWidth, measure) {
  const groups = [];
  for (const w of ws) {
    const cur = groups[groups.length - 1];
    if (cur && measure(joinWords([...cur, w])) <= maxWidth) cur.push(w);
    else groups.push([w]);
  }
  return groups;
}

/** The words of each line for one cue: one line if it fits; two lines balanced, the lower one no shorter; more lines filled
 *  greedily. measure gives a line's width (characters by default); a word wider than maxWidth gets a line of its own. */
export function splitLineGroups(words, maxWidth, maxLines = 2, measure = chars) {
  const ws = asWords(words);
  if (measure(joinWords(ws)) <= maxWidth) return [ws.slice()];
  const greedy = greedyGroups(ws, maxWidth, measure);
  if (greedy.length !== 2 || maxLines < 2) return greedy;
  let best = null;
  for (let k = 1; k < ws.length; k++) {
    const a = ws.slice(0, k), b = ws.slice(k);
    const la = measure(joinWords(a)), lb = measure(joinWords(b));
    if (la > maxWidth || lb > maxWidth) continue;
    const unit = measure("n") || 1;
    const score = Math.abs(la - lb) / unit + (la > lb ? 0.5 : 0) + 2 * breakCost(a[a.length - 1].text, b[0].text);
    if (!best || score < best.score) best = { score, groups: [a, b] };
  }
  return best ? best.groups : greedy;
}

export const splitLines = (words, maxWidth, maxLines = 2, measure = chars) => splitLineGroups(words, maxWidth, maxLines, measure).map(joinWords);

// English words a line or cue should not end on, and words it may start on.
const WEAK_END = new Set("a an the of to in on at for with from by and or but nor so if as my your his her our their its this these those that".split(" "));
const GOOD_START = new Set("and but so because or which that when while if then until unless".split(" "));
const bare = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
/** Cost of ending a line or cue after word a with word b next: lower is a better place to break. */
export function breakCost(a, b) {
  let c = 0;
  if (CLAUSE_END.test(a)) c -= 4;
  if (WEAK_END.has(bare(a)) || GOOD_START.has(bare(a))) c += 8;
  if (b !== undefined && GOOD_START.has(bare(b))) c -= 2;
  return c;
}

const fitsCue = (ws, o) =>
  ws.length === 1 ||
  (greedyGroups(ws, o.maxChars, o.measure).length <= o.maxLines &&
    (!o.maxWords || ws.length <= o.maxWords) &&
    ws[ws.length - 1].end - ws[0].start <= o.maxSeconds);

/** Groups words into cues. Cues end at a sentence end or a pause; a longer stretch is split into the fewest cues that fit
 *  maxChars x maxLines, maxWords and maxSeconds, balanced in length and broken at the most natural places. */
export function groupWords(words, opts = {}) {
  const o = options(opts);
  const runs = [];
  let cur = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (SENTENCE_END.test(prev.text) || w.start - prev.end >= o.pause - 1e-9)) { runs.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) runs.push(cur);
  return runs.flatMap((run) => splitRun(run, o));
}

function splitRun(ws, o) {
  const n = ws.length;
  // best[j]: the cheapest split of ws[0..j); the cue count dominates, then balance, then the break places.
  const best = new Array(n + 1).fill(null);
  best[0] = { cost: 0, cut: -1 };
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (!fitsCue(ws.slice(i, j), o)) break;
      if (!best[i]) continue;
      const width = o.measure(joinWords(ws.slice(i, j))) / (o.measure("n") || 1);
      // A weak break costs more than one more cue, so cues never end on "the" or "because" just to save one.
      const brk = j < n ? breakCost(ws[j - 1].text, ws[j].text) * 1500 : 0;
      const cost = best[i].cost + 10000 + width * width + brk;
      if (!best[j] || cost < best[j].cost) best[j] = { cost, cut: i };
    }
  }
  const groups = [];
  for (let j = n; j > 0; j = best[j].cut) groups.unshift(ws.slice(best[j].cut, j));
  return groups;
}

// A cue that the next one would cut short of the minimum joins it when the two still fit one cue (borrowing time, as subtitle
// guidelines suggest), so fast speech does not flash past.
function mergeShort(groups, o) {
  const gap = o.gapFrames / o.fps;
  const out = [];
  for (const g of groups) {
    const prev = out[out.length - 1];
    if (prev && g[0].start - prev[0].start < o.minDuration + gap && fitsCue([...prev, ...g], o)) out[out.length - 1] = [...prev, ...g];
    else out.push(g);
  }
  return out;
}

const floorMs = (s) => Math.floor(s * 1000 + 1e-6) / 1000;
const ceilMs = (s) => Math.ceil(s * 1000 - 1e-6) / 1000;

/** Sets cue times on the millisecond grid: from the first word's start to the last word's end, at least minDuration and at most
 *  maxSeconds, gaps under closeGapsUnder closed to gapFrames, never closer than gapFrames to the next cue, and never overlapping
 *  it (when the next cue starts sooner than that allows, this cue ends as it starts). */
export function timeCues(cues, opts = {}) {
  const o = options(opts);
  const gap = o.gapFrames / o.fps;
  const out = cues.map((c) => ({ ...c, start: ceilMs(c.start) }));
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    // The maximum outranks closing a gap: a cue is never held past it to meet the next one.
    const cap = floorMs(c.start + Math.max(o.maxSeconds, c.end - c.start));
    let end = Math.min(ceilMs(Math.max(c.end, c.start + o.minDuration)), cap);
    const next = out[i + 1];
    if (next) {
      if (next.start <= c.start) next.start = ceilMs(c.start + 0.001);
      const latest = floorMs(next.start - gap);
      if (o.closeGapsUnder && next.start - end < o.closeGapsUnder) end = Math.min(latest, cap);
      if (end > latest) end = latest;
      if (end <= c.start) end = next.start;
    }
    c.end = end;
  }
  return out;
}

/** Words to timed cues with lines. Each cue keeps its words (for highlighting) and the words of each line. */
export function cuesFromWords(words, opts = {}) {
  const o = options(opts);
  const cues = mergeShort(groupWords(words, o), o).map((ws) => {
    const groups = splitLineGroups(ws, o.maxChars, o.maxLines, o.measure);
    return { start: ws[0].start, end: ws[ws.length - 1].end, lines: groups.map(joinWords), lineWords: groups.map((g) => g.length), words: ws };
  });
  return timeCues(cues, o);
}

/** One cue per word, each shown until the next word starts (words that start together share a cue). */
export function oneWordCues(words, opts = {}) {
  const o = options({ minDuration: 1 / (opts.fps ?? SUBTITLE_DEFAULTS.fps), ...opts });
  const gap = o.gapFrames / o.fps;
  const groups = [];
  for (const w of words) {
    const prev = groups[groups.length - 1];
    if (prev && w.start - prev[0].start < gap + 1 / o.fps) prev.push(w);
    else groups.push([w]);
  }
  return timeCues(groups.map((g) => ({ start: g[0].start, end: g[g.length - 1].end, lines: [joinWords(g)], lineWords: [g.length], words: g })), o);
}
