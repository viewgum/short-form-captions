---
name: short-form-captions
description: Use when the user wants captions or subtitles for a vertical (9:16) video for TikTok, Instagram Reels, YouTube Shorts or Facebook Reels, such as turning Whisper or other word timestamps into SRT, WebVTT or ASS, word-by-word highlighted captions, captions placed inside the safe zone, converting SRT to ASS, or checking a caption file's reading speed, line length, duration and gaps against Netflix or BBC subtitle guidelines.
---

# Captions for vertical video

The tool is `short-form-captions` (https://github.com/viewgum/short-form-captions). It needs Node 18 or newer and runs with
`npx github:viewgum/short-form-captions <command>`; no install, no account, no network once fetched.

## Workflow

1. Find out what the user has: word timings (JSON from a speech-to-text tool), a caption file (SRT or WebVTT), or only audio.
   With only audio, they need word timestamps first, for example Whisper with word timestamps on
   (`whisper audio.mp3 --word_timestamps True --output_format json`). Do not invent timings.
2. Make captions from word timings:
   - SRT or WebVTT as a caption file: `npx github:viewgum/short-form-captions words words.json --out captions.srt`. YouTube
     Studio takes SRT or WebVTT (https://support.google.com/youtube/answer/2734698) and Facebook takes SRT for a video on a
     profile (https://www.facebook.com/help/www/261764017354370); for the other apps, burn the ASS in (step 3).
   - ASS to burn into the picture, inside the safe zone:
     `npx github:viewgum/short-form-captions words words.json --to ass --style highlight --out captions.ass`
     (`--style phrase` for plain cues, `one-word` for one word at a time; `--position bottom|middle|top`; `--size 1080x1920`
     or the video's own 9:16 size).
3. Burn ASS in with FFmpeg if the user wants it in the picture:
   `ffmpeg -i video.mp4 -vf "ass=captions.ass" -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a copy captioned.mp4`
4. Convert an existing file: `npx github:viewgum/short-form-captions convert captions.srt --to ass --out captions.ass`
   (lines are re-split to fit the safe box).
5. Check a caption file: `npx github:viewgum/short-form-captions check captions.srt --profile netflix` (or `bbc`,
   `bbc-vertical`, `netflix-children`; `--fps` to the video's frame rate; `--json` for rows). Report each fail and warn with the
   rule it cites. Exit 1 means a fail, or with `--strict` a warn too.

## What to tell the user

- Cues follow speech: a fast speaker can break a reading-speed rule however the cues are split, and a line break adds no
  reading time. Suggest editing the text shorter where the user allows it, or letting a cue stay up longer into a pause; the
  tool already joins short sentences in a row. Do not shift timings away from the audio.
- The safe zone used for ASS is where all four apps' published 9:16 ad guidance leaves the frame clear (on 1080 x 1920: 288 px
  from the top, 672 from the bottom, 120 from the left, 192 from the right, and out of the right 300 px below y 840). The apps
  publish no pixel figures for regular posts.
- Netflix and BBC rules are those publishers' own subtitle guidelines, a sourced yardstick, not an app's requirement.
- The input JSON can be an array of words, `{ "words": [...] }`, WhisperX's `{ "word_segments": [...] }`, Whisper's
  `{ "segments": [{ "words": [...] }] }` or whisper.cpp's full JSON (`-ojf`); times in seconds unless `--ms`. A file with times
  out of order, or a segment with text but no word timings, is refused (exit 2): fix the input instead of forcing it.
- `convert` keeps the text and times; tags, styles and positions in the input are dropped. Only ASS output is placed in the
  safe zone; SRT and WebVTT are caption files for YouTube Studio (SRT or WebVTT) and Facebook (SRT).
- A position holds a limited number of lines at a font size (at 72 px: 11 at the bottom, 6 in the middle or at the top); a
  larger `--max-lines` or `--font-size` is refused with exit 2 instead of leaving the safe zone.
