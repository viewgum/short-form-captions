// Checks caption cues against a guideline profile from data/guidelines.json.
import { readFileSync } from "node:fs";
import { plainLines } from "./formats.mjs";

export const guidelines = JSON.parse(readFileSync(new URL("../data/guidelines.json", import.meta.url), "utf8"));

/** A profile's rules, with the rules of the profile it extends (a rule with the same id replaces the inherited one). */
export function profileRules(id) {
  const p = guidelines.profiles[id];
  if (!p) throw new Error(`unknown profile "${id}"; profiles: ${Object.keys(guidelines.profiles).join(", ")}`);
  const base = p.extends ? profileRules(p.extends) : [];
  const own = new Map(p.rules.map((r) => [r.id, r]));
  return [...base.filter((r) => !own.has(r.id)), ...p.rules].map((r) => ({ ...r, source: guidelines.sources[r.source] ? { key: r.source, ...guidelines.sources[r.source] } : r.source }));
}

// Times in SRT and WebVTT files are whole milliseconds, so a limit counts as met within half a millisecond.
const EPS = 0.0005;
const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0);
// A word has a letter or a digit; a lone dash before a speaker's line is not one.
const wordCount = (text) => text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
const is24 = (fps) => Math.abs(fps - 24) < 0.1 || Math.abs(fps - 24000 / 1001) < 0.01;

/** Rows for every rule a cue breaks, plus structural problems (empty, ends before it starts, overlaps, out of order). */
export function checkCues(cues, { profile = "netflix", fps = 30 } = {}) {
  if (!(Number.isFinite(fps) && fps > 0)) throw new Error("fps must be a positive number");
  const rules = profileRules(profile);
  const rows = [];
  const add = (i, rule, level, value, limit, extra = {}) =>
    rows.push({ cue: i + 1, start: cues[i].start, end: cues[i].end, rule, level, value, limit, ...extra });
  cues.forEach((c, i) => {
    const lines = plainLines(c.lines, c.format).filter((l) => l !== "");
    const text = lines.join(" ");
    const dur = c.end - c.start;
    const words = wordCount(text);
    if (![c.start, c.end].every((t) => Number.isFinite(t) && t >= 0)) { add(i, "bad-time", "fail", null, null, { note: "a time that is not a number of seconds from zero" }); return; }
    if (!lines.length) add(i, "empty", "fail", 0, null, { note: "a cue with no text" });
    if (dur <= 0) { add(i, "ends-before-start", "fail", r2(dur), null, { note: "the end time is not after the start time" }); return; }
    if (i > 0 && c.start < cues[i - 1].start) add(i, "out-of-order", "fail", c.start, null, { note: "starts before the cue before it" });
    const next = cues[i + 1];
    const gap = next ? next.start - c.end : null;
    if (gap !== null && gap < -EPS) add(i, "overlap", "fail", r2(gap), 0, { note: "still on screen when the next cue starts" });
    for (const rule of rules) {
      const meta = { source: rule.source, section: rule.section, quote: rule.quote, ...(rule.min !== undefined ? { min: rule.min } : {}) };
      const v = (() => {
        switch (rule.id) {
          case "max-chars-per-line": { const m = maxOf(lines.map((l) => [...l].length)); return m > rule.limit ? m : null; }
          case "max-lines": return lines.length > rule.limit ? lines.length : null;
          // Spaces and punctuation count; a line break counts as the space it stands for.
          case "max-cps": { const cps = [...text].length / dur; return cps > rule.limit + EPS ? r2(cps) : null; }
          case "max-wpm": { const wpm = (words / dur) * 60; return wpm > rule.limit + EPS ? r1(wpm) : null; }
          case "min-seconds-per-word": { const spw = words ? dur / words : Infinity; return spw < rule.limit - EPS ? r2(spw) : null; }
          case "min-duration": return dur < rule.limit - EPS ? r2(dur) : null;
          case "max-duration": return dur > rule.limit + EPS ? r2(dur) : null;
          case "min-gap-frames": { if (gap === null || gap < -EPS) return null; const f = gap * fps; return f < rule.limit - fps * EPS ? r2(f) : null; }
          case "close-gaps-24fps": {
            if (gap === null || !is24(fps)) return null;
            const f = gap * fps;
            return f >= rule.min - fps * EPS && f < rule.limit + 1 - fps * EPS ? r2(f) : null;
          }
          case "close-gaps-under": {
            if (gap === null || (is24(fps) && rules.some((x) => x.id === "close-gaps-24fps"))) return null;
            const min = (rules.find((x) => x.id === "min-gap-frames")?.limit ?? 2) / fps;
            return gap > min + 0.5 / fps && gap < rule.limit - EPS ? r2(gap) : null;
          }
          default: throw new Error(`no check for rule ${rule.id}`);
        }
      })();
      if (v !== null) add(i, rule.id, rule.level, v, rule.limit, meta);
    }
  });
  const counts = { fail: rows.filter((r) => r.level === "fail").length, warn: rows.filter((r) => r.level === "warn").length };
  return { profile, fps, cues: cues.length, ok: counts.fail === 0, counts, rows };
}

const WHAT = {
  "max-chars-per-line": (r) => `a line of ${r.value} characters (limit ${r.limit})`,
  "max-lines": (r) => `${r.value} lines (limit ${r.limit})`,
  "max-cps": (r) => `${r.value} characters a second (limit ${r.limit})`,
  "max-wpm": (r) => `${r.value} words a minute (recommended up to ${r.limit})`,
  "close-gaps-24fps": (r) => `a gap of ${r.value} frames before the next cue (at 24 fps, gaps of ${r.min} to ${r.limit} frames must be closed to 2)`,
  "min-seconds-per-word": (r) => `${r.value} s a word (aim for at least ${r.limit})`,
  "min-duration": (r) => `on screen ${r.value} s (minimum ${r.limit === 0.8333 ? "5/6" : r.limit} s)`,
  "max-duration": (r) => `on screen ${r.value} s (maximum ${r.limit} s)`,
  "min-gap-frames": (r) => `${r.value} frames before the next cue (minimum ${r.limit})`,
  "close-gaps-under": (r) => `a gap of ${r.value} s before the next cue (close it to 2 frames or make it ${r.limit} s or more)`,
};

/** The report as text, one line a problem, with each source once at the end. */
export function formatReport(result, { srtTime }) {
  const out = [];
  for (const r of result.rows) {
    const what = WHAT[r.rule] ? WHAT[r.rule](r) : r.note;
    out.push(`${r.level.padEnd(4)}  cue ${r.cue} (${srtTime(r.start)})  ${what}${r.source?.key ? `  [${r.source.key} ${r.section}]` : ""}`);
  }
  const used = [...new Map(result.rows.filter((r) => r.source?.key).map((r) => [r.source.key, r.source])).values()];
  if (used.length) {
    out.push("", "Sources:");
    for (const s of used) out.push(`  [${s.key}] ${s.publisher}: ${s.title}, read ${s.checked}: ${s.url}`);
  }
  out.push("", `${result.cues} cues, profile ${result.profile} at ${result.fps} fps: ${result.counts.fail} fail, ${result.counts.warn} warn`);
  return out.join("\n");
}
