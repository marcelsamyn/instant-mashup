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

## Deploy with Docker Swarm

GitHub Actions builds the image on every push to `main` and publishes it to `ghcr.io/marcelsamyn/instant-mashup` (private, linux/amd64). The image includes everything: Python 3.11, librosa, Demucs with its model, yt-dlp, ffmpeg and Deno. A new container downloads nothing except songs.

`deploy/stack.yml` runs it behind Traefik at `https://mashup.samyn.co`. Traefik must already run on the external `traefik-public` network with a `https` entrypoint and a default Let's Encrypt resolver. Set `MASHUP_HOST` to use another hostname.

On the swarm node:

1. Create the data folder. The container runs as uid 1000:
   ```bash
   mkdir -p /var/services/mashup/data && chown 1000:1000 /var/services/mashup/data
   ```
2. The node needs pull access to the private image. If other `ghcr.io/marcelsamyn/*` images already deploy, nothing is needed. Otherwise, log in once with a GitHub token that has the `read:packages` scope:
   ```bash
   echo "$GHCR_TOKEN" | docker login ghcr.io -u marcelsamyn --password-stdin
   ```
3. Deploy the stack. The password is required, and the deploy stops without it.
   - **Portainer:** Stacks → Add stack, paste `deploy/stack.yml`, add `ACCESS_PASSWORD` under environment variables, and deploy.
   - **Shell:**
     ```bash
     ACCESS_PASSWORD='something-you-share-with-friends' docker stack deploy --with-registry-auth -c deploy/stack.yml mashup
     ```
4. Open `https://mashup.samyn.co` and enter the password.

The server refuses to start on a public interface without `ACCESS_PASSWORD` (set `ALLOW_OPEN=1` to override). To run without Traefik, remove the `networks` and `labels` blocks, publish port 5180 with `mode: host`, and set `TRUST_PROXY=0`.

**Client addresses behind swarm ingress.** When Traefik's ports are published in swarm ingress mode (the default), Docker rewrites source addresses. Every visitor then arrives from the same internal IP, so the "per IP" limits below are shared by everyone. The stack sizes them for that. To make them per person, publish Traefik's ports 80 and 443 with `mode: host` in its own stack.

### Protection against heavy use

Limits work at two levels. The container cannot take over the server, and the app refuses work before it piles up.

| Setting | Default | What it protects |
| --- | --- | --- |
| `ACCESS_PASSWORD` | required | Only people with the password can use the API. Changing it signs everyone out. |
| `CPU_LIMIT` / `MEMORY_LIMIT` | 3 / 4G | Hard ceiling for the container, including stem separation. Use a whole number for `CPU_LIMIT`. |
| `MAX_SONG_MINUTES` | 10 | Longer videos are refused, so nobody splits a 2-hour mix. |
| `MAX_LIBRARY_GB` | 20 | Disk budget. Past it, the songs used least recently are deleted. A song takes about 250 MB. |
| `MAX_QUEUED_SONGS` | 6 | New songs are refused (try again later) while this many are still processing. |
| `ADDS_PER_HOUR_PER_IP` / `ADDS_PER_DAY` | 30 / 100 | New songs per person per hour, and for everyone per day. |
| `SEARCHES_PER_MINUTE_PER_IP` | 60 | YouTube searches per person. |
| `RENDERS_PER_HOUR_PER_IP` | 240 | Tempo and pitch renders per person. Cached renders do not count. Each song keeps its 12 newest renders, and renders count toward the disk budget. |
| `PARALLEL_DOWNLOADS` / `PARALLEL_ANALYSES` / `PARALLEL_RENDERS` | 2 / 1 / 2 | Heavy jobs at the same time. Stem separation always runs one at a time. |

Set any of these as environment variables before `docker stack deploy`. `0` turns a limit off. The pids limit (256) and the log rotation (3 × 10 MB) are fixed in the stack file. The stack defaults above differ from the app's own defaults (10 / 20 / 60 per IP), because of the shared-address issue described above.

On CPU, splitting stems takes about as long as the song plays, depending on the server. Songs wait in a queue, and the library shows their progress.

## How it works

- `server/` is a Bun server. It searches and downloads with a pinned yt-dlp through `uvx`, runs the analysis and Demucs, and renders time-stretched audio on request with ffmpeg (`atempo`, plus `asetrate` for pitch). Everything is cached under `data/<video id>/`.
- `analysis/analyze.py` is a self-contained uv script built on librosa. It fits a constant beat grid, refines the tempo by folding a fine onset envelope over candidate beat lengths, picks the downbeat from kick and chord-change strength, and finds sections with a checkerboard novelty curve on a bar-level self-similarity matrix, snapped to 4-bar phrases. Energy mixes loudness, onset density and low end.
- `web/` is a React app. `engine.ts` is the Web Audio mixer, and the same graph renders the export. `mashup.ts` has the auto-mashup and DJ-mix planners.

## Limits

- Each lane decodes its stems in full, about 100 MB per 5-minute stem. A DJ mix of four long songs can use close to 2 GB of browser memory.
- Stretched and pitched renders are cached in `data/<id>/render/` and never cleaned up. Delete that folder to free disk space.
- If a song's files go missing (for example, `data/` was copied without its audio), the server notices at startup and restores them: it downloads and splits that song again.
- Analysis assumes a steady tempo. For a live recording or a song with tempo changes, fix small drift with Nudge.
- Locally the server listens on 127.0.0.1 only. Set `HOST` to change that. The Docker image listens on all interfaces.
- The song library is shared: everyone with the password sees every song. Arrangements stay in each person's browser.
