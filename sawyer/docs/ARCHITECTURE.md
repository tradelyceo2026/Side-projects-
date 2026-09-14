# Sawyer architecture

## Data model (`src/model.js`)

A project is plain JSON: settings, a media dictionary, tracks with clips, markers, in/out.
A clip references media by id and stores `start` and `duration` in sequence seconds, `inPoint` in source
seconds, `speed`, `props` (motion, colour, audio, text, crop), `keyframes` (`prop -> [{t, v}]`, clip-local
time), transitions on either side, and a `linkId` that ties a video clip to its audio.

All edits are pure functions on that JSON, which is why they are unit-tested in Node and why undo is a stack
of JSON snapshots. Placement uses overwrite semantics: dropping a clip on top of another trims or splits the
one underneath, the way Premiere's default overwrite edit works.

## Media (`src/media.js`)

`importFile` creates an object URL, reads metadata through a `<video>`/`<audio>`/`<img>` element, decodes
the audio with `decodeAudioData` into an `AudioBuffer` (kept in memory for playback, export, waveforms and
silence detection), renders 8 thumbnails, and stores the original `File` in IndexedDB so the project survives a
reload without re-importing.

## Engine (`src/engine.js`)

`renderFrame` composites video tracks from V1 upward at a given time. For each visible clip it computes
opacity (keyframes × fades × transitions), builds a CSS-filter string for colour, applies wipe/slide/zoom
clipping and transforms, and draws the source. The source for a video clip is an `HTMLVideoElement` whose
`currentTime` the caller has positioned.

`scheduleAudio` builds the whole audio graph for a time range: one `AudioBufferSourceNode` and `GainNode`
per audible clip with the gain curve sampled at 20 Hz. The same function drives the live `AudioContext` during
playback and the `OfflineAudioContext` during export, so what you hear is what you get.

`Player` runs a `requestAnimationFrame` loop against a wall-clock master, keeps every active video element
within 120 ms of its target time, and pauses inactive ones.

## Export (`src/export.js`)

1. `pickCodecs` probes `VideoEncoder.isConfigSupported` for H.264 (MP4), then VP9/VP8 (WebM), and
   `AudioEncoder` for AAC or Opus.
2. Audio is rendered offline and encoded first.
3. Video is produced frame by frame: seek each active source element to the exact source time (awaiting
   `seeked`), draw with `renderFrame`, wrap the canvas in a `VideoFrame`, encode with a keyframe every 2 s.
4. `mp4-muxer` / `webm-muxer` receive chunks as they are produced and finalize an in-memory file.
5. Browsers without WebCodecs fall back to `MediaRecorder` on a captured canvas stream at real-time speed.

## AI assistant (`src/ai.js`)

Tools are defined once as `{name, description, inputSchema, execute}` against an editor facade. Two backends
use the same list:

- `sampleBackend` passes them to `claude.use('sample')` inside a claude.ai artifact; the platform runs the tool
  loop and calls `execute` in the page.
- `apiBackend` runs the Messages API tool loop itself over `fetch` with the user's key, replaying `tool_result`
  blocks until `stop_reason` is `end_turn`.

Every tool commits an undo snapshot before mutating, and the assistant's reply lists what changed.
