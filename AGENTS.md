# Notes for agents

- Check with `bun run typecheck`. Start the app with `bun run start` (port 5180, or `PORT`). The server does not hot-reload; restart it after changing `server/`. The frontend hot-reloads.
- yt-dlp is pinned in `server/youtube.ts` and runs through `uvx` because a stale yt-dlp gets HTTP 403 from YouTube. When downloads start failing, bump the pin first.
- Demucs 4.1 runs on Python 3.11 through `uv run --with demucs==4.1.0` and uses the `mps` device on Apple Silicon.
- Bun's CSS bundler dropped a `.library { grid-row: 2 / 4 }` rule that also had a later same-selector rule and a media-query override. Keep grid placement inside the element's main rule (`grid-area`).
- Timing model: clips sit on the master grid in master beats. `srcStart` is in seconds of the original song. A lane plays the server render stretched by `laneRate()`, so a source time `t` is at `t / rate` in the buffer. `laneRate()` rounds to 5 decimals so the fetched buffer and the scheduler use the same rate.
- Track data in `data/<id>/`: `source.wav`, `analysis.json`, `stems/*.wav`, `stems.json` (per-bar stem dBFS), `render/` (stretch cache). `data/` is not in git.
- The pipeline is driven by the files on disk (`processTrack`). At startup, and when an audio request finds its file missing, `repairIfMissing` redoes only the missing steps: download, analysis, separation, stem levels. To re-run the analysis, delete `analysis.json` and `stems.json` and restart. Clients only request audio for tracks where `isPlayable()` holds.
