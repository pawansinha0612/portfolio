# Browser video editor

Live at <https://pawansinha.com.au/projects/video-editor/>. A side project linked from the home page's
Projects section, like the Melbourne Deal Finder.

Everything runs in the visitor's browser. Files are never uploaded and nothing is saved, so export before
closing the tab.

## What it does

| Feature | How it works |
|---|---|
| Cut pauses | Decodes the audio (Web Audio API), measures loudness every 20 ms, removes quiet stretches longer than a set length. Settings: threshold, shortest pause, breathing room. |
| Captions | Load an `.srt`/`.vtt` per video. Cues are stored in source time, so they stay in sync after cuts and trims. Burned into the export. |
| Text | Title / boxed / name-banner styles. Drag in the preview to place, drag on the timeline to retime. |
| Look | Colour presets plus brightness, contrast and saturation (canvas filters). |
| Audio | Voice volume, background music that loops, fades out and ducks while you talk (real-time level detection). |
| Suggestions | Checks the video and lists fixes with one-click apply: dark, overexposed, flat or dull picture (8 sampled frames), quiet or clipping voice, silence before the first word, long pauses, missing captions or title, music too loud or not ducked, Shorts length/format and export resolution. Rules in `src/advisor.ts` (unit-tested). |
| Formats | 16:9, 9:16 Shorts, 1:1 square, 4:5 Instagram feed. |
| Music library | Five royalty-free loops (lo-fi, upbeat, corporate, ambient, tech) composed and synthesised in the browser by `src/music.ts`: oscillators, filtered noise and a generated reverb, with no samples or recordings, so nobody else owns the audio. Rendered on first use with `OfflineAudioContext` and folded into seamless WAV loops. |
| Format | 16:9, 9:16 (Shorts) or 1:1; fill (crop, with position) or fit; 720p or 1080p. |
| Timeline | Split (S), delete, reorder, trim by dragging clip edges, undo/redo (Ctrl/Cmd+Z). |
| Export | Plays the timeline once in real time, recording the canvas plus the audio mix with MediaRecorder. MP4 in Chrome/Edge/Safari, WebM in Firefox. |

Best in Chrome or Edge. Safari works but can leave ~0.5 s silent gaps at cuts in the export.

## Files

- `src/engine.ts`: pure logic (timeline maths, silence detection, subtitle parsing, layout). Tested.
- `src/player.ts`: playback, drawing and export. Two video elements per file, so the next clip is
  pre-loaded at every cut.
- `src/App.tsx`, `src/App.css`: the interface.
- `test/engine.test.ts`: unit tests (`npm test`).

## Changing it

- **On GitHub (no computer needed):** edit files under `video-editor/` and commit to `main`. The **Video editor**
  workflow tests, builds and publishes `docs/projects/video-editor/` within a couple of minutes.
- **Locally:** `cd video-editor && npm install && npm run dev`, then `npm test` and `npm run build`
  (the build writes straight into `docs/projects/video-editor/`).
