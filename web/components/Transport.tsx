import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine";
import { formatBarBeat, formatTime } from "../project";
import { Grime } from "./Grime";

interface TransportProps {
  engine: Engine;
  playing: boolean;
  masterBpm: number;
  endBeat: number;
  loading: { done: number; total: number } | null;
  exporting: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canExport: boolean;
  ppb: number;
  onTogglePlay: () => void;
  onRewind: () => void;
  onEnd: () => void;
  onBpm: (bpm: number) => void;
  onZoom: (ppb: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
}

const MIN_BPM = 60;
const MAX_BPM = 200;

export function Transport(props: TransportProps): React.JSX.Element {
  const { engine, playing, masterBpm, endBeat, onEnd } = props;
  const barBeat = useRef<HTMLSpanElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const beatLed = useRef<HTMLSpanElement>(null);
  const [bpmText, setBpmText] = useState(masterBpm.toFixed(2));

  useEffect(() => setBpmText(masterBpm.toFixed(2)), [masterBpm]);

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const pos = engine.position();
      if (barBeat.current) barBeat.current.textContent = formatBarBeat(pos);
      if (clock.current) clock.current.textContent = formatTime(pos * (60 / masterBpm));
      if (beatLed.current) beatLed.current.classList.toggle("is-on", playing && pos % 1 < 0.18);
      if (playing && endBeat > 0 && pos > endBeat + 8) onEnd();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [engine, playing, masterBpm, endBeat, onEnd]);

  const commitBpm = (value: number): void => {
    if (!Number.isFinite(value)) return setBpmText(masterBpm.toFixed(2));
    const bpm = Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, value)) * 100) / 100;
    setBpmText(bpm.toFixed(2));
    if (bpm !== masterBpm) props.onBpm(bpm);
  };

  const status = props.exporting
    ? "Rendering mix…"
    : props.loading
      ? `Preparing audio ${props.loading.done}/${props.loading.total}`
      : playing
        ? "Playing"
        : "Ready";

  return (
    <header className="transport">
      <div className="brand">
        <span className="brand-name">Instant Mashup</span>
        <span className="brand-plate mono">IM-1</span>
      </div>

      <div className="transport-keys">
        <button type="button" className="round-btn" onClick={props.onRewind} aria-label="Back to start" title="Back to start (Home)">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 5h2v14H6zM20 5v14L9 12z" />
          </svg>
        </button>
        <button
          type="button"
          className={`round-btn play-btn${playing ? " is-lit" : ""}`}
          onClick={props.onTogglePlay}
          aria-label={playing ? "Pause" : "Play"}
          title="Play or pause (Space)"
        >
          {playing ? (
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
      </div>

      <div className="display">
        <div className="display-glass" data-grime="display">
          <div className="display-cell">
            <span className="display-label">Bar</span>
            <span ref={barBeat} className="display-big mono">
              1.1
            </span>
          </div>
          <div className="display-cell">
            <span className="display-label">Time</span>
            <span ref={clock} className="display-mid mono">
              0:00
            </span>
          </div>
          <div className="display-cell display-bpm">
            <span className="display-label">
              Master BPM <span ref={beatLed} className="beat-led" />
            </span>
            <input
              className="display-input mono"
              value={bpmText}
              inputMode="decimal"
              aria-label="Master tempo in BPM"
              onChange={(e) => setBpmText(e.target.value)}
              onBlur={() => commitBpm(Number(bpmText))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitBpm(Number(bpmText));
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  commitBpm(masterBpm + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 0.1 : 1));
                }
              }}
            />
          </div>
          <div className={`display-status${props.loading || props.exporting ? " is-busy" : ""}`}>{status}</div>
          <Grime surface="display" />
        </div>
      </div>

      <div className="transport-tools">
        <label className="zoom" title="Zoom (+ and − keys)">
          <span className="engraved">Zoom</span>
          <input type="range" min={1.5} max={32} step={0.5} value={props.ppb} onChange={(e) => props.onZoom(Number(e.target.value))} />
        </label>
        <div className="segmented">
          <button type="button" className="hw-btn" onClick={props.onUndo} disabled={!props.canUndo} title="Undo (⌘Z)">
            Undo
          </button>
          <button type="button" className="hw-btn" onClick={props.onRedo} disabled={!props.canRedo} title="Redo (⌘⇧Z)">
            Redo
          </button>
        </div>
        <button type="button" className="hw-btn is-primary" onClick={props.onExport} disabled={!props.canExport || props.exporting}>
          {props.exporting ? "Rendering…" : "Export WAV"}
        </button>
      </div>
    </header>
  );
}
