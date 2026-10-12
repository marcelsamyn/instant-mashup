# Instant Mashup

A local mashup console. Search YouTube or paste a link, and each song is downloaded, analysed (tempo, downbeats, key, sections, energy) and split into vocals, drums, bass and instruments. Then press one button for a beat-matched mashup or a DJ mix, and shape it by hand.

## Run it

Needs [Bun](https://bun.sh), [uv](https://docs.astral.sh/uv/), ffmpeg and Node (yt-dlp uses Node to solve YouTube's JavaScript). Python packages install themselves through `uv` on first use; the first song takes a few minutes extra while librosa and Demucs (PyTorch) download.

```bash
bun install
bun run start
```

Open http://localhost:5180. Set `PORT` to use another port.

## Use it

1. **Find songs.** Type an artist and title, or paste a YouTube link. A song is usable once its tempo and sections are found (about 30 s). Stems take another 20–60 s.
2. **Pick songs** with the round **+** button on each card. The number shows the order.
3. **Make mashup.** Song 1 gives the beat (drums, bass, instruments). The other songs give vocals. Each section of the beat gets the vocal section whose energy fits best, with a chorus preferred over a chorus. Vocal songs are pitch-shifted up to 3 semitones toward a compatible key.
4. **Make DJ mix.** The songs play in order. For each handover the app picks where to leave song A and where to enter song B: late in A, early in B, never over a silent fade-out, with similar energy on both sides. During the overlap the incoming song plays without vocals. Styles: EQ blend (fades and a bass swap halfway), filter sweep, echo out.
5. **Shape it.**
   - Drag clips to move them. Drag an edge to trim. Hold ⌥ and drag to slide the audio inside a clip. Hold ⇧ to snap to beats instead of bars.
   - Drag a coloured block from a song's section strip onto a lane, or onto "New lane". Block height shows energy.
   - The **V D B I** buttons on a clip turn stems on or off for that clip only.
   - The clip panel sets fades, fade style, and where the bass enters or leaves.
   - Each channel strip has stem levels, a 3-band EQ (fully left is a kill), a one-knob filter (left = low-pass, right = high-pass), echo and reverb sends, pitch, tempo factor (½ or ×2 for half or double time) and a grid nudge in 10 ms steps.
6. **Export WAV** renders the arrangement offline, including the echo and reverb tails.

The glass gets dirty with use. Taps on the timeline screen and the display can leave a faint fingerprint, and drags leave smears. They stay between sessions in your browser until you press **Wipe glass**.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Home or Enter | Back to start |
| S | Split the selected clip at the play position |
| ⌘D | Duplicate the selected clip |
| ⌫ | Delete the selected clip |
| ⌘Z / ⌘⇧Z | Undo / redo |
| + / − | Zoom |

## How it works

- `server/` is a Bun server. It searches and downloads with a pinned yt-dlp through `uvx`, runs the analysis and Demucs, and renders time-stretched audio on request with ffmpeg (`atempo`, plus `asetrate` for pitch). Everything is cached under `data/<video id>/`.
- `analysis/analyze.py` is a self-contained uv script built on librosa. It fits a constant beat grid, refines the tempo by folding a fine onset envelope over candidate beat lengths, picks the downbeat from kick and chord-change strength, and finds sections with a checkerboard novelty curve on a bar-level self-similarity matrix, snapped to 4-bar phrases. Energy mixes loudness, onset density and low end.
- `web/` is a React app. `engine.ts` is the Web Audio mixer, and the same graph renders the export. `mashup.ts` has the auto-mashup and DJ-mix planners.

## Limits

- Each lane decodes its stems in full, about 100 MB per 5-minute stem. A DJ mix of four long songs can use close to 2 GB of browser memory.
- Stretched and pitched renders are cached in `data/<id>/render/` and never cleaned up. Delete that folder to free disk space.
- If a song's files go missing (for example, `data/` was copied without its audio), the server notices at startup and restores them: it downloads and splits that song again.
- Analysis assumes a steady tempo. For a live recording or a song with tempo changes, fix small drift with Nudge.
- The server listens on 127.0.0.1 only. Set `HOST` to change that.
