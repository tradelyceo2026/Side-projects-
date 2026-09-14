# Sawyer

An open-source non-linear video editor that runs entirely in your browser. Import real video, cut it on a
multi-track timeline, add titles, transitions, colour and keyframed motion, mix the audio, and export a real
MP4 or WebM. Nothing is uploaded anywhere. There is an optional AI assistant that edits the timeline for you.

**Play with it:** open `dist/sawyer.html` (one file, no install) in Chrome, Edge, or any Chromium browser,
or use the hosted copy: https://claude.ai/code/artifact/7fcf38a8-2458-45d7-8b2c-37d36400e003
Firefox and Safari work for editing and fall back to a real-time recorder for export.

## What works today

| Area | Features |
|---|---|
| Media | Import video, audio and images (drag-drop or picker). Thumbnails, waveforms, duration, audio detection. Media and the project persist in the browser (IndexedDB) so a reload restores everything. |
| Timeline | 3 video + 3 audio tracks, mute/solo/lock, magnetic snapping, zoom, ruler scrubbing. Overwrite-style placement like Premiere. |
| Editing | Select, move (with linked audio), trim handles, ripple trim (Q/W), razor tool, split at playhead (Ctrl+K), delete and ripple delete, close gaps, copy/paste/duplicate, link/unlink, enable/disable, in/out range, markers, undo/redo. |
| Effect Controls | Position, scale, rotation, opacity, crop; brightness, contrast, saturation, hue, blur, grayscale, sepia; speed; text (font, size, weight, colour, background, outline); volume and fades. Every numeric property can be keyframed at the playhead with smooth interpolation. |
| Transitions | Cross dissolve, dip to black, wipe, slide, zoom, applied to both sides of a cut. |
| Playback | Frame-accurate scrubbing, J/K/L shuttle, sample-accurate audio through Web Audio, loop in/out. |
| Export | WebCodecs encode to H.264/AAC MP4 where the browser supports it, otherwise VP9/Opus WebM. Presets from 720p to 4K, vertical and square. Offline audio mix, exact frame stepping. |
| AI assistant | Chat that edits through 15 tools: split, trim, move, delete, properties, keyframes, transitions, titles, placing media, silence removal, closing gaps, in/out, seek, select. Two backends: the built-in Claude sampling capability when the page runs as a claude.ai artifact (no key needed), or the Anthropic Messages API with your own key. |
| Project files | Save and open `.sawyer.json`; media re-links from the browser store by id. |

## Try it in two minutes

1. Open `dist/sawyer.html`. Drop a couple of video files into the Project panel.
2. Double-click a clip to place it at the playhead. Press `C` for the razor, click to cut; `V` to go back to select.
3. Select a clip, open Effect Controls, drag Scale, click the ◇ to set a keyframe, move the playhead, drag again.
4. Effects tab → "Cross dissolve → in" on the second clip.
5. Open AI Assistant and type "remove the silence from clip 1 and add a title card for 3 seconds".
6. Export → Save file.

## Architecture

```
sawyer/
  index.html          layout and styles (dev page; loads src/ as ES modules)
  src/model.js        project data model + pure editing operations (tested in Node)
  src/media.js        import, probing, thumbnails, waveform peaks, IndexedDB persistence
  src/engine.js       compositor (canvas), transitions, keyframes, Web Audio scheduling, Player
  src/export.js       WebCodecs export + mp4-muxer / webm-muxer, MediaRecorder fallback
  src/ai.js           tool definitions and the two AI backends
  src/timeline.js     DOM timeline: lanes, clips, trims, drags, razor, snapping
  src/panels.js       project bin, effect controls, effects list, dialogs, AI panel
  src/app.js          commands, keyboard shortcuts, transport, boot
  vendor/             mp4-muxer and webm-muxer (MIT, by Vanilagy)
  test/               node --test: model operations and the AI tool layer
  scripts/build.mjs   bundles everything into dist/sawyer.html
  docs/ARCHITECTURE.md
```

No framework and no build dependency. `npm test` runs the model and tool-layer tests; `npm run build`
rebuilds the single file.

## How it edits real video

- Decoding uses the browser's own `<video>` element per clip; the compositor draws every visible clip onto a
  canvas each frame with transforms, filters and transitions.
- Audio for every clip is decoded once into an `AudioBuffer`. Playback schedules buffer sources with gain
  automation for fades and keyframes; export renders the same schedule through an `OfflineAudioContext`.
- Export steps the sequence one frame at a time, seeks every source to the exact frame, draws, and hands the
  canvas to a `VideoEncoder`. Encoded chunks go straight into the muxer, so a 1080p export is memory-light.

## Verified

- `npm test`: 12 tests on the model (overwrite placement, split, ripple, trim limits, linked moves, keyframes,
  transitions, silence detection) and the AI tool layer.
- Headless Chromium end-to-end: import two generated WebM clips, place, split, transition, colour, keyframes,
  silence removal, undo/redo, playback, then export 283 frames of 1080p VP9/Opus WebM that ffmpeg reads back
  at 9.42 s, and reload with everything restored from IndexedDB.
- The Anthropic API backend was exercised against a mocked endpoint: tool_use round trip with results.

## Roadmap

1. Nested sequences and adjustment layers.
2. Audio effects (EQ, compressor, noise gate) through Web Audio nodes; audio ducking under speech.
3. Speech-to-text captions in the browser (Whisper via WebGPU) and AI tools that cut by transcript.
4. GPU colour grading (WebGL LUTs, curves, scopes).
5. Proxy workflow for 4K sources and multi-cam sync by audio.
6. Collaborative projects and shared review links.

MIT licensed.
