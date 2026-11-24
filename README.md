# short-form-captions

Turns word timestamps from Whisper or any other speech-to-text tool into SRT, WebVTT or ASS captions for vertical video. The ASS
output is placed inside the area TikTok, Instagram Reels, YouTube Shorts and Facebook Reels all leave clear in their published
9:16 ad safe zones, with word-by-word highlighting if you want it; SRT and WebVTT carry the text and times for an app's own
caption upload. It also checks any SRT or WebVTT file for reading speed, line length, line count, duration and gaps against
Netflix's and the BBC's published subtitle guidelines, quoting the guideline behind each finding. A command line tool and a
JavaScript module for Node 18 or newer, with no dependencies.

## Run it

```sh
npx github:viewgum/short-form-captions words words.json > captions.srt
npx github:viewgum/short-form-captions words words.json --to ass --style highlight --out captions.ass
npx github:viewgum/short-form-captions check captions.srt --profile bbc-vertical
```

From [examples/words.json](examples/words.json), the first command writes [examples/captions.srt](examples/captions.srt):

```
1
00:00:00,120 --> 00:00:02,273
Bread rises
because yeast eats sugar

2
00:00:02,340 --> 00:00:03,600
and breathes out gas.

3
00:00:04,200 --> 00:00:05,373
The gluten traps it,

4
00:00:05,440 --> 00:00:07,400
so the dough puffs
up like a balloon.
```

Each cue ends at a sentence end or a pause, holds at most two lines of 25 characters, avoids ending a cue or a line on a word
like "the" or "because", and leaves two frames before the next cue. It stays on screen at least five sixths of a second unless
the next cue starts sooner; short sentences in a row join into one cue when they fit, so fast speech does not flash past. The
second command writes [examples/captions-highlight.ass](examples/captions-highlight.ass), where each word lights up from its
start until the next word starts. Burn it in with FFmpeg:

```sh
ffmpeg -i video.mp4 -vf "ass=captions.ass" -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a copy captioned.mp4
```

## Word timings it reads

| Shape | Where it comes from |
|---|---|
| `{ "segments": [{ "words": [{ "word", "start", "end" }] }] }`, or an array of such segments | Whisper's JSON with word timestamps on (openai-whisper's `--word_timestamps True`, WhisperX, faster-whisper segments saved as JSON) |
| `{ "word_segments": [...] }` | WhisperX's flat word list |
| `{ "words": [{ "word" or "text", "start", "end" }] }` | Speech-to-text APIs that return a flat word list |
| `[{ "word" or "text", "start", "end" }]` | Any array of words |
| `{ "transcription": [{ "tokens": [{ "text", "offsets": { "from", "to" } }] }] }` | whisper.cpp's full JSON (`-ojf`): tokens are joined into words and its special tokens dropped. With `-ml 1`, one word a segment also works |

Times are seconds; add `--ms` for milliseconds (whisper.cpp's offsets are always read as milliseconds). Where the source keeps
spacing (Whisper writes " word"), its spacing is kept; otherwise words get a space between them, except before closing
punctuation and between Chinese or Japanese characters. A word with no times at all (WhisperX leaves numbers it could not align
that way) joins the timed word before it in its segment. A file whose words go backwards in time, start before zero, or have
half a time or a time that is not a number is refused (exit 2) rather than turned into wrong captions, and so is a segment with
text but no word timings: turn word timestamps on in the transcriber.

## Where the captions sit

ASS output is sized for the frame (`--size`, default 1080x1920; any 9:16 size scales) and kept inside the area all four apps
leave clear in their published 9:16 safe zones: at least 288 px from the top, 672 px from the bottom, 120 px from the left and
192 px from the right on 1080 x 1920, and out of the right 300 px below y = 840. These are the presets in each app's 9:16 ad
guidance, the only pixel figures the apps publish; they publish none for regular posts. Figures and sources:
[short-form-video-specs](https://github.com/viewgum/short-form-video-specs).

| `--position` | On 1080 x 1920 |
|---|---|
| `bottom` (default) | bottom centre, the lowest line ending about y 1220, lines between x 300 and 780 |
| `middle` | the lowest line ending about y 812, above the right-hand column, lines between x 192 and 888 |
| `top` | top centre from y 300 down, lines between x 192 and 888 |

For ASS, lines are split to fit the box by the width of each character in Arial Bold, the default font (Liberation Sans, which
Linux systems often use for Arial, has the same widths), at `--font-size` (default 72 on 1080 x 1920), with the outline. A
word too wide for the box on its own is drawn smaller so it fits. A wider font can still overflow: lower `--font-size` with it.
A cue made from word timings holds at most six words. `--style highlight` lights each word in `--highlight-color` (default
FFD400) from its start until the next word starts, with the same line breaks in every frame so the text never jumps;
`--style one-word` shows one word at a time. `--font`, `--color` and the cue options (`--max-chars`, `--max-lines`,
`--max-words`, `--max-seconds`, `--fps`) change the rest. ASS reads braces and backslashes as codes, so text in it shows them as
parentheses and slashes.

This tool writes SRT and WebVTT without positions or styling: the app or player places them. `convert` turns an SRT or WebVTT
file into another format, keeping the text a viewer reads and the times; tags, styles and positions in the input are dropped. To
ASS it re-splits the lines to fit the box, and a cue too long for three lines becomes consecutive cues, its time shared by
length:

```sh
npx github:viewgum/short-form-captions convert captions.srt --to ass --position middle --out captions.ass
```

## Check a caption file

```sh
npx github:viewgum/short-form-captions check examples/too-fast.srt
```

```
fail  cue 1 (00:00:00,000)  a line of 53 characters (limit 42)  [netflix-en I.2 Character Limitation]
fail  cue 1 (00:00:00,000)  44.17 characters a second (limit 20)  [netflix-en I.14 Reading Speed Limits]
fail  cue 1 (00:00:00,000)  0.3 frames before the next cue (minimum 2)  [netflix-timing 5: Gaps between subtitles]
fail  cue 2 (00:00:01,210)  51.72 characters a second (limit 20)  [netflix-en I.14 Reading Speed Limits]
fail  cue 2 (00:00:01,210)  on screen 0.29 s (minimum 5/6 s)  [netflix-general 1 Duration]
```

The report ends with each source's page and the date it was read; `--json` gives every row with the guideline's own words.
Exit code 0 means no fail (and, with `--strict`, no warn), 1 a fail, 2 bad input. Characters a second count spaces and
punctuation, with a line break counted as the space it stands for; a word is a run with a letter or a digit, so a speaker's
dash is not one. Times in SRT and WebVTT are whole milliseconds, so a limit counts as met within half a millisecond. Besides
the guidelines, this tool fails a cue that is empty, ends before it starts, starts before the cue before it, or overlaps the
next one (two cues at once suit positioned WebVTT, not captions burned into a short).

| `--profile` | Rules | Source |
|---|---|---|
| `netflix` (default) | 42 characters a line, 2 lines, 20 characters a second, 5/6 s to 7 s on screen, 2 frames between cues; at 24 fps (`--fps 24`) a gap of 3 to 11 frames fails, at other rates a gap between 2 frames and half a second is a warn | Netflix English (USA) Timed Text Style Guide, its section for same-language captions (SDH), and its general and timing pages |
| `netflix-children` | the same with 17 characters a second | the same |
| `bbc` | 37 characters a line (the broadcast Teletext limit; online the BBC limits a line by width, so this is a guide), 2 lines, 180 words a minute, 0.3 s a word, all as warns | BBC Subtitle Guidelines 1.2.5 |
| `bbc-vertical` | the BBC rules with 25 characters a line and 3 lines, its guide for 9:16 video | the same |

Each rule, with its section and the guideline's words, is in [data/guidelines.json](data/guidelines.json).
`short-form-captions profiles` lists them with their pages. Netflix's style guides are written for its own deliveries and the
BBC's for its programmes; on short vertical video they are a sourced yardstick, not an app's requirement.

## In JavaScript

```js
import { wordsFrom, cuesFromWords, toSrt, toAss, parseCaptions, checkCues } from "short-form-captions";

const cues = cuesFromWords(wordsFrom(JSON.parse(text)), { maxChars: 25, maxLines: 2 });
const srt = toSrt(cues);
const ass = toAss(cues, { position: "bottom", highlight: true });
const report = checkCues(parseCaptions(srt), { profile: "bbc-vertical", fps: 30 });
```

Install from GitHub with `npm install github:viewgum/short-form-captions`. The guideline data is also exported as
`short-form-captions/guidelines.json`.

## Use it from an AI agent

The commands are an agent skill, so Claude Code, Codex, Gemini CLI and other agents that read skills can make and check
captions with it:

```sh
npx skills add viewgum/short-form-captions
```

Any chat assistant: paste [skills/short-form-captions/SKILL.md](skills/short-form-captions/SKILL.md) into the chat.

## How it is tested

[test.mjs](test.mjs) covers each word-timing shape (spacing, untimed words, whisper.cpp tokens), the cue and line rules, the
times (minimum, maximum, gaps, overlaps, the ASS centisecond grid), the highlight events, SRT and WebVTT parsing of real-world
files and bad times, each check at its limit and just past it, the command line's outputs, input encodings and exit codes, and
that the files in [examples](examples) and the examples in this README match what the tool makes. It then burns the ASS output
into 9:16 video with FFmpeg (libass), at 1080 x 1920 and 720 x 1280, in each position and style and through `convert`,
including a cue of wide capital letters and single words too wide for the box, and checks that every pixel of text in a frame
of every event lands inside the safe zone. CI runs it on every push with Node 18 and 22 on Ubuntu 24.04, with Liberation Sans
standing in for Arial.

```sh
node test.mjs
```

## Related

- [ffmpeg-vertical-video](https://github.com/viewgum/ffmpeg-vertical-video): tested FFmpeg commands for 9:16 video, including
  burning captions inside the safe zone
- [short-form-video-specs](https://github.com/viewgum/short-form-video-specs): safe zones in pixels, length and caption limits,
  with sources
- [shortform-preflight](https://github.com/viewgum/shortform-preflight): checks a video file against each app's upload limits

## License

Code: MIT ([LICENSE](LICENSE)). Data ([data/guidelines.json](data/guidelines.json)): CC BY 4.0 ([LICENSE-DATA](LICENSE-DATA)),
except the quoted guideline text, which belongs to its publishers. [NOTICE](NOTICE) says which covers what.

Maintained by [ViewGum](https://viewgum.com), which makes finished vertical shorts with [captions timed to the
voice](https://viewgum.com/auto-captions-for-shorts) if you would rather not edit them yourself.
