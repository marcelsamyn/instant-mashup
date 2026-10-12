import { useEffect, useRef } from "react";
import { STEMS, type Track } from "../../shared/types";
import type { Engine } from "../engine";
import { type BpmFactor, EQ_KILL_DB, type Lane, shiftedKeyLabel } from "../project";
import { STEM_UI, shortTitle } from "../ui";
import { Fader, Knob, formatDb, formatFilter, formatGainDb, formatPercent } from "./controls";

interface MixerProps {
  lanes: Lane[];
  tracks: Map<string, Track>;
  engine: Engine;
  selectedLaneId: string | null;
  onSelectLane: (id: string) => void;
  onPatchLane: (id: string, patch: Partial<Lane>) => void;
}

export function Mixer({ lanes, tracks, engine, selectedLaneId, onSelectLane, onPatchLane }: MixerProps): React.JSX.Element {
  if (lanes.length === 0) {
    return (
      <div className="mixer mixer-empty">
        <span className="engraved">Channel strips appear here once a song is on the timeline</span>
      </div>
    );
  }
  return (
    <div className="mixer">
      {lanes.map((lane, i) => (
        <Strip
          key={lane.id}
          index={i + 1}
          lane={lane}
          track={tracks.get(lane.trackId)}
          engine={engine}
          selected={lane.id === selectedLaneId}
          onSelect={() => onSelectLane(lane.id)}
          onPatch={(patch) => onPatchLane(lane.id, patch)}
        />
      ))}
      <MasterStrip engine={engine} />
    </div>
  );
}

function Strip({
  index,
  lane,
  track,
  engine,
  selected,
  onSelect,
  onPatch,
}: {
  index: number;
  lane: Lane;
  track: Track | undefined;
  engine: Engine;
  selected: boolean;
  onSelect: () => void;
  onPatch: (patch: Partial<Lane>) => void;
}): React.JSX.Element {
  const hasStems = Boolean(track?.stemLevels);
  const key = track?.analysis?.key;
  return (
    <section className={`strip${selected ? " is-selected" : ""}`} onPointerDownCapture={onSelect} aria-label={`Channel ${index}`}>
      <header className="strip-head">
        <span className="channel-no mono">{String(index).padStart(2, "0")}</span>
        <span className="tape tape-small" title={track?.title}>
          {track ? shortTitle(track) : "—"}
        </span>
      </header>

      <div className="strip-body">
        <div className="strip-controls">
          <div className="control-group" title={hasStems ? undefined : "Stems are still being separated"}>
            <span className="engraved">Stems</span>
            <div className="knob-row">
              {STEMS.map((stem) => (
                <Knob
                  key={stem}
                  label={STEM_UI[stem].short === "I" ? "Inst" : STEM_UI[stem].label.slice(0, 5)}
                  value={lane.stemGain[stem]}
                  min={0}
                  max={1}
                  defaultValue={1}
                  color={STEM_UI[stem].color}
                  size={34}
                  disabled={!hasStems}
                  format={formatPercent}
                  onChange={(v) => onPatch({ stemGain: { ...lane.stemGain, [stem]: v } })}
                />
              ))}
            </div>
          </div>

          <div className="control-group">
            <span className="engraved">Equalizer</span>
            <div className="knob-row">
              {(["high", "mid", "low"] as const).map((band) => (
                <Knob
                  key={band}
                  label={band === "high" ? "Hi" : band === "mid" ? "Mid" : "Low"}
                  value={lane.eq[band]}
                  min={EQ_KILL_DB}
                  max={6}
                  center={0}
                  defaultValue={0}
                  size={34}
                  format={formatDb}
                  onChange={(v) => onPatch({ eq: { ...lane.eq, [band]: v } })}
                />
              ))}
              <Knob
                label="Filter"
                value={lane.filter}
                min={-1}
                max={1}
                center={0}
                defaultValue={0}
                size={34}
                color="var(--signal)"
                format={formatFilter}
                onChange={(v) => onPatch({ filter: v })}
              />
            </div>
          </div>

          <div className="control-row">
            <div className="control-group">
              <span className="engraved">Send</span>
              <div className="knob-row">
                <Knob label="Echo" value={lane.echo} min={0} max={1} defaultValue={0} size={30} color="var(--fx)" format={formatPercent} onChange={(v) => onPatch({ echo: v })} />
                <Knob label="Verb" value={lane.reverb} min={0} max={1} defaultValue={0} size={30} color="var(--fx)" format={formatPercent} onChange={(v) => onPatch({ reverb: v })} />
              </div>
            </div>
            <div className="control-lines">
              <div className="control-line">
                <span className="engraved">Pitch</span>
                <button type="button" className="hw-btn" onClick={() => onPatch({ semitones: Math.max(-6, lane.semitones - 1) })} aria-label="Pitch down a semitone">
                  −
                </button>
                <span className="lcd mono" title="Semitones and the resulting key (Camelot)">
                  {lane.semitones > 0 ? `+${lane.semitones}` : lane.semitones}
                  {key ? ` ${shiftedKeyLabel(key, lane.semitones)}` : ""}
                </span>
                <button type="button" className="hw-btn" onClick={() => onPatch({ semitones: Math.min(6, lane.semitones + 1) })} aria-label="Pitch up a semitone">
                  +
                </button>
              </div>
              <div className="control-line" role="radiogroup" aria-label="Tempo factor">
                <span className="engraved">Tempo</span>
                {([0.5, 1, 2] as BpmFactor[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={lane.bpmFactor === f}
                    className={`hw-btn${lane.bpmFactor === f ? " is-lit" : ""}`}
                    onClick={() => onPatch({ bpmFactor: f })}
                    title={f === 1 ? "Original tempo" : f === 2 ? "Double time" : "Half time"}
                  >
                    {f === 0.5 ? "½" : `×${f}`}
                  </button>
                ))}
              </div>
              <div className="control-line">
                <span className="engraved">Nudge</span>
                <button type="button" className="hw-btn" onClick={() => onPatch({ nudge: lane.nudge + 0.01 })} aria-label="Play this lane 10 ms earlier">
                  ◂
                </button>
                <span className="lcd mono" title="How far this lane is shifted (negative = earlier). Double-click to reset." onDoubleClick={() => onPatch({ nudge: 0 })}>
                  {Math.round(-lane.nudge * 1000)}ms
                </span>
                <button type="button" className="hw-btn" onClick={() => onPatch({ nudge: lane.nudge - 0.01 })} aria-label="Play this lane 10 ms later">
                  ▸
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="strip-fader">
          <Meter getAnalyser={() => engine.graph.lanes.get(lane.id)?.meter} />
          <Fader label="Volume" value={lane.volume} min={0} max={1.2} defaultValue={0.85} format={formatGainDb} onChange={(v) => onPatch({ volume: v })} />
          <div className="mute-solo">
            <button type="button" className={`hw-btn led-btn${lane.mute ? " is-lit lit-red" : ""}`} onClick={() => onPatch({ mute: !lane.mute })} aria-pressed={lane.mute}>
              M
            </button>
            <button type="button" className={`hw-btn led-btn${lane.solo ? " is-lit lit-amber" : ""}`} onClick={() => onPatch({ solo: !lane.solo })} aria-pressed={lane.solo}>
              S
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function MasterStrip({ engine }: { engine: Engine }): React.JSX.Element {
  return (
    <section className="strip strip-master" aria-label="Master">
      <header className="strip-head">
        <span className="tape tape-small tape-master">Master</span>
      </header>
      <div className="strip-master-body">
        <Meter getAnalyser={() => engine.graph.analyser} tall />
      </div>
    </section>
  );
}

const SEGMENTS = 14;

/**
 * LED ladder driven straight from an AnalyserNode, outside React's render loop. The analyser is
 * looked up in the effect because lane nodes are created after the first render.
 */
function Meter({ getAnalyser, tall = false }: { getAnalyser: () => AnalyserNode | undefined; tall?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const lookup = useRef(getAnalyser);
  lookup.current = getAnalyser;
  useEffect(() => {
    const analyser = lookup.current();
    if (!analyser) return;
    const data = new Float32Array(analyser.fftSize);
    let frame = 0;
    let held = 0;
    const tick = (): void => {
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      const db = 20 * Math.log10(peak + 1e-9);
      const level = Math.max(0, Math.min(1, (db + 42) / 42));
      held = Math.max(level, held - 0.015);
      const lit = Math.round(held * SEGMENTS);
      ref.current?.querySelectorAll<HTMLElement>(".led").forEach((led, i) => {
        led.classList.toggle("is-on", SEGMENTS - i <= lit);
      });
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={ref} className={`meter${tall ? " is-tall" : ""}`} aria-hidden>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span key={i} className={`led ${i < 2 ? "led-red" : i < 5 ? "led-amber" : "led-green"}`} />
      ))}
    </div>
  );
}
