import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { musicalKey } from "../../shared/keys";
import type { Analysis, Track } from "../../shared/types";
import { retune } from "../api";
import { formatTime } from "../project";
import { shortTitle } from "../ui";

interface TuneDialogProps {
  track: Track & { analysis: Analysis };
  ctx: AudioContext;
  onClose: () => void;
  onSaved: (track: Track) => void;
}

const KEYS = [false, true].flatMap((minor) => Array.from({ length: 12 }, (_, tonic) => musicalKey(tonic, minor)));
const keyId = (tonic: number, minor: boolean): string => `${tonic}${minor ? "m" : ""}`;
const VIEW_BARS = [2, 4, 8] as const;
const PREVIEW_LOOPS = 4;

/** First bar start at or after 0 for a grid anchored at `anchor`. */
const firstBar = (anchor: number, barSec: number): number => anchor - Math.floor(anchor / barSec) * barSec;

/** A short sine blip: high for bar starts, lower for beats. */
function clickBuffer(ctx: AudioContext, hz: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.035);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / ctx.sampleRate) * (1 - i / length) ** 3;
  return buffer;
}

/**
 * Beat-grid tuner. Shows a few bars of waveform with the grid on top; drag the grid or click to
 * put the nearest bar line on a beat, adjust the tempo until later bars line up too, and check by
 * ear with a click track. Saving re-runs the analysis with the corrected grid.
 */
export function TuneDialog({ track, ctx, onClose, onSaved }: TuneDialogProps): React.JSX.Element {
  const a = track.analysis;
  const [bpm, setBpm] = useState(a.bpm);
  const [bpmText, setBpmText] = useState(String(Number(a.bpm.toFixed(3))));
  useEffect(() => setBpmText(String(Number(bpm.toFixed(3)))), [bpm]);
  function commitBpm(): void {
    const v = Number(bpmText.replace(",", "."));
    if (v >= 40 && v <= 250) setBpm(v);
    else setBpmText(String(Number(bpm.toFixed(3))));
  }
  const [anchor, setAnchor] = useState(a.downbeat);
  const [keyChoice, setKeyChoice] = useState(keyId(a.key.tonic, a.key.minor));
  const [viewBars, setViewBars] = useState<(typeof VIEW_BARS)[number]>(4);
  const strongest = a.sections.find((s) => s.energy > 0.6) ?? a.sections[0];
  const [viewStart, setViewStart] = useState(Math.max(0, strongest?.start ?? 0));
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const beatSec = 60 / bpm;
  const barSec = 4 * beatSec;
  const viewSec = viewBars * barSec;
  const keyChanged = keyChoice !== keyId(a.key.tonic, a.key.minor);
  const changed = Math.abs(bpm - a.bpm) > 1e-6 || Math.abs(anchor - a.downbeat) > 1e-4 || keyChanged;

  const zoom = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const audio = useRef<{ buffer: AudioBuffer | null; nodes: AudioScheduledSourceNode[]; startedAt: number }>({
    buffer: null,
    nodes: [],
    startedAt: 0,
  });

  // Zoomed view: waveform plus the grid being edited.
  useEffect(() => {
    const canvas = zoom.current;
    if (!canvas) return;
    const g = setupCanvas(canvas);
    if (!g) return;
    const { width, height } = canvas.getBoundingClientRect();
    drawWave(g, a, viewStart, viewSec, width, height);
    const bar0 = firstBar(anchor, barSec);
    const firstBeat = Math.ceil((viewStart - bar0) / beatSec);
    for (let k = firstBeat; ; k++) {
      const t = bar0 + k * beatSec;
      if (t > viewStart + viewSec) break;
      const x = ((t - viewStart) / viewSec) * width;
      const isBar = ((k % 4) + 4) % 4 === 0;
      g.fillStyle = isBar ? "rgb(255 90 31 / 0.95)" : "rgb(255 255 255 / 0.28)";
      g.fillRect(Math.round(x), 0, isBar ? 2 : 1, height);
      if (isBar) {
        g.fillStyle = "rgb(255 140 90)";
        g.font = "600 10px 'JetBrains Mono', monospace";
        // Bars count from the first bar that starts at or before 0 s, as the analysis numbers them.
        const barZero = anchor - Math.ceil(anchor / barSec) * barSec;
        g.fillText(String(Math.round((t - barZero) / barSec) + 1), x + 4, 12);
      }
    }
  }, [a, anchor, beatSec, barSec, viewStart, viewSec]);

  // Overview of the whole song with the visible window highlighted.
  useEffect(() => {
    const canvas = overview.current;
    if (!canvas) return;
    const g = setupCanvas(canvas);
    if (!g) return;
    const { width, height } = canvas.getBoundingClientRect();
    drawWave(g, a, 0, a.duration, width, height);
    g.fillStyle = "rgb(255 90 31 / 0.22)";
    g.fillRect((viewStart / a.duration) * width, 0, Math.max(2, (viewSec / a.duration) * width), height);
  }, [a, viewStart, viewSec]);

  /** Latest grid and view. Playback reads it after loading, so an edit made meanwhile is not lost. */
  const grid = useRef({ anchor, barSec, beatSec, viewStart, viewSec });
  grid.current = { anchor, barSec, beatSec, viewStart, viewSec };
  /** Bumped by every play and stop. A play that sees a newer number after loading gives up. */
  const generation = useRef(0);
  const [loading, setLoading] = useState(false);

  const stop = useCallback(() => {
    generation.current++;
    for (const n of audio.current.nodes) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        // Already ended.
      }
    }
    audio.current.nodes = [];
    setPlaying(false);
    setLoading(false);
  }, []);

  /** Loops the visible bars with a click on every beat of the edited grid. */
  const play = useCallback(async () => {
    stop();
    const gen = generation.current;
    setError(null);
    try {
      await ctx.resume();
      if (!audio.current.buffer) {
        setLoading(true);
        const res = await fetch(`/api/tracks/${track.id}/audio/mix?rate=1.00000&semitones=0`);
        if (!res.ok) throw new Error(`Could not load the song (${res.status})`);
        audio.current.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      }
      if (gen !== generation.current) return;
      setLoading(false);
      const buffer = audio.current.buffer;
      const { anchor, barSec, beatSec, viewStart, viewSec } = grid.current;
      const out = new GainNode(ctx, { gain: 0.8 });
      out.connect(ctx.destination);
      const barClick = clickBuffer(ctx, 1600);
      const beatClick = clickBuffer(ctx, 1000);
      const t0 = ctx.currentTime + 0.08;
      const bar0 = firstBar(anchor, barSec);
      const nodes: AudioScheduledSourceNode[] = [];
      for (let loop = 0; loop < PREVIEW_LOOPS; loop++) {
        const when = t0 + loop * viewSec;
        const song = new AudioBufferSourceNode(ctx, { buffer });
        song.connect(out);
        song.start(when, Math.max(0, viewStart), viewSec);
        nodes.push(song);
        for (let k = Math.ceil((viewStart - bar0) / beatSec); bar0 + k * beatSec < viewStart + viewSec; k++) {
          const click = new AudioBufferSourceNode(ctx, { buffer: ((k % 4) + 4) % 4 === 0 ? barClick : beatClick });
          click.connect(out);
          click.start(when + (bar0 + k * beatSec - viewStart));
          nodes.push(click);
        }
      }
      const last = nodes.at(-1);
      if (last) {
        last.onended = () => {
          if (gen === generation.current) setPlaying(false);
        };
      }
      audio.current.nodes = nodes;
      audio.current.startedAt = t0;
      setPlaying(true);
    } catch (err) {
      if (gen !== generation.current) return;
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ctx, track.id, stop]);

  // Hear changes right away: restart the loop when the grid or view changes while playing.
  const playingRef = useRef(false);
  playingRef.current = playing;
  useEffect(() => {
    if (!playingRef.current) return;
    const timer = setTimeout(() => void play(), 150);
    return () => clearTimeout(timer);
  }, [anchor, barSec, viewStart, viewSec, play]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = (): void => {
      const pos = (((ctx.currentTime - audio.current.startedAt) % viewSec) + viewSec) % viewSec;
      if (playhead.current) playhead.current.style.left = `${(pos / viewSec) * 100}%`;
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [playing, ctx, viewSec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Drag slides the whole grid; a click without dragging puts the nearest bar line there.
  const drag = useRef<{ x: number; anchor: number; moved: boolean } | null>(null);
  function timeAt(e: PointerEvent<HTMLCanvasElement>): number {
    const rect = e.currentTarget.getBoundingClientRect();
    return viewStart + ((e.clientX - rect.left) / rect.width) * viewSec;
  }
  function onPointerDown(e: PointerEvent<HTMLCanvasElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, anchor, moved: false };
  }
  function onPointerMove(e: PointerEvent<HTMLCanvasElement>): void {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) < 3 && !d.moved) return;
    d.moved = true;
    const secPerPx = viewSec / e.currentTarget.getBoundingClientRect().width;
    setAnchor(d.anchor + dx * secPerPx);
  }
  function onPointerUp(e: PointerEvent<HTMLCanvasElement>): void {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const t = timeAt(e);
    setAnchor(t - Math.round((t - anchor) / barSec) * barSec);
  }

  function jump(fraction: number): void {
    setViewStart(Math.max(0, Math.min(a.duration - viewSec, fraction * a.duration)));
  }

  async function save(reset: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const [tonic, minor] = [Number.parseInt(keyChoice, 10), keyChoice.endsWith("m")];
      // An earlier hand-set key is resent so it survives a grid change.
      const key = keyChanged || a.tuned ? { tonic, minor } : null;
      const updated = await retune(track.id, reset ? null : { bpm, downbeat: firstBar(anchor, barSec), key });
      stop();
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="gate-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="tuner" role="dialog" aria-modal="true" aria-labelledby="tuner-title">
        <header className="tuner-head">
          <span className="engraved" id="tuner-title">
            Tune grid
          </span>
          <span className="tape tape-small">{shortTitle(track)}</span>
          <button type="button" className="chip-btn ghost tuner-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <p className="hint">
          Drag the grid, or click a beat to put the nearest orange bar line on it. Then change the tempo until bars later in the song line up too. Play
          to hear a click on every beat.
        </p>

        <div className="tuner-screen">
          <canvas
            ref={zoom}
            className="tuner-zoom"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            aria-label="Waveform with beat grid. Drag to move the grid."
          />
          {playing && <div ref={playhead} className="tuner-playhead" aria-hidden />}
        </div>
        <canvas
          ref={overview}
          className="tuner-overview"
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            jump((e.clientX - rect.left) / rect.width - viewSec / a.duration / 2);
          }}
          aria-label="Whole song. Click to look at another part."
        />

        <div className="tuner-controls">
          <div className="control-group">
            <span className="engraved">View · {formatTime(viewStart)}</span>
            <div className="segmented">
              <button type="button" className="hw-btn" onClick={() => jump(0)}>
                Start
              </button>
              <button type="button" className="hw-btn" onClick={() => jump(0.5)}>
                Middle
              </button>
              <button type="button" className="hw-btn" onClick={() => jump(1)}>
                End
              </button>
              {VIEW_BARS.map((n) => (
                <button key={n} type="button" className={`hw-btn${viewBars === n ? " is-lit" : ""}`} onClick={() => setViewBars(n)}>
                  {n} bars
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <span className="engraved">Tempo · detected {a.tuned ? "or set " : ""}{a.bpm.toFixed(2)}</span>
            <div className="segmented">
              <button type="button" className="hw-btn" onClick={() => setBpm((b) => b / 2)} title="Half time">
                ½
              </button>
              <button type="button" className="hw-btn" onClick={() => setBpm((b) => Math.round((b - 0.1) * 1000) / 1000)}>
                −0.1
              </button>
              <input
                className="lcd mono tuner-bpm"
                inputMode="decimal"
                value={bpmText}
                onChange={(e) => setBpmText(e.target.value)}
                onBlur={commitBpm}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitBpm();
                }}
                aria-label="Tempo in BPM"
              />
              <button type="button" className="hw-btn" onClick={() => setBpm((b) => Math.round((b + 0.1) * 1000) / 1000)}>
                +0.1
              </button>
              <button type="button" className="hw-btn" onClick={() => setBpm((b) => b * 2)} title="Double time">
                ×2
              </button>
            </div>
          </div>

          <div className="control-group">
            <span className="engraved">Downbeat</span>
            <div className="segmented">
              <button type="button" className="hw-btn" onClick={() => setAnchor((t) => t - beatSec)} title="Bar starts one beat earlier">
                ◂ beat
              </button>
              <button type="button" className="hw-btn" onClick={() => setAnchor((t) => t - 0.01)}>
                −10ms
              </button>
              <button type="button" className="hw-btn" onClick={() => setAnchor((t) => t + 0.01)}>
                +10ms
              </button>
              <button type="button" className="hw-btn" onClick={() => setAnchor((t) => t + beatSec)} title="Bar starts one beat later">
                beat ▸
              </button>
            </div>
          </div>

          <label className="control-group">
            <span className="engraved">Key</span>
            <select className="hw-select" value={keyChoice} onChange={(e) => setKeyChoice(e.target.value)}>
              {KEYS.map((k) => (
                <option key={keyId(k.tonic, k.minor)} value={keyId(k.tonic, k.minor)}>
                  {k.camelot} · {k.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <footer className="tuner-actions">
          <button type="button" className={`hw-btn big${playing || loading ? " is-lit" : ""}`} onClick={() => (playing || loading ? stop() : void play())}>
            {loading ? "Loading song… (stop)" : playing ? "Stop" : "Play with clicks"}
          </button>
          <span className="tuner-spacer" />
          {a.tuned && (
            <button type="button" className="hw-btn" disabled={saving} onClick={() => void save(true)} title="Forget the hand-made changes and detect again">
              Reset to detected
            </button>
          )}
          <button type="button" className="hw-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="hw-btn is-primary big" disabled={!changed || saving} onClick={() => void save(false)}>
            {saving ? "Saving…" : "Save and re-analyse"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const g = canvas.getContext("2d");
  g?.scale(dpr, dpr);
  return g;
}

/** Three-band waveform of [start, start + span) seconds across the canvas. */
function drawWave(g: CanvasRenderingContext2D, a: Analysis, start: number, span: number, width: number, height: number): void {
  const { rate, low, mid, high } = a.waveform;
  const half = height / 2;
  const layers: [number[], string, number][] = [
    [low, "#4f74ff", 0.98],
    [mid, "#f2a93b", 0.72],
    [high, "#f4f2ea", 0.42],
  ];
  for (const [band, color, scale] of layers) {
    g.fillStyle = color;
    for (let x = 0; x < width; x++) {
      const i0 = Math.floor((start + (x / width) * span) * rate);
      const i1 = Math.max(i0 + 1, Math.floor((start + ((x + 1) / width) * span) * rate));
      let peak = 0;
      for (let i = Math.max(0, i0); i < Math.min(band.length, i1); i++) peak = Math.max(peak, band[i] ?? 0);
      const h = (peak / 255) * half * scale;
      if (h > 0.3) g.fillRect(x, half - h, 1, h * 2);
    }
  }
}
