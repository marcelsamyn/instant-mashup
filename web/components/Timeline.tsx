import { type DragEvent, type PointerEvent, memo, useEffect, useRef, useState } from "react";
import { STEMS, type Analysis, type Stem, type Track } from "../../shared/types";
import type { Engine } from "../engine";
import { type Clip, type Lane, type Project, beatsPerSourceBar, projectEndBeat, shiftedKeyLabel, srcSecPerBeat } from "../project";
import { Grime, WipeButton } from "./Grime";
import { SECTION_DRAG_TYPE, STEM_UI, type SectionDrag, energyColor, parseSectionDrag, shortTitle } from "../ui";

export const HEADER_W = 196;
const EDGE_PX = 7;

type DragMode = "move" | "slip" | "trim-start" | "trim-end";

interface DragState {
  mode: DragMode;
  x0: number;
  orig: Clip;
  preview: Clip;
  moved: boolean;
}

interface TimelineProps {
  project: Project;
  tracks: Map<string, Track>;
  ppb: number;
  engine: Engine;
  playing: boolean;
  selectedClipId: string | null;
  selectedLaneId: string | null;
  onSelectClip: (id: string | null) => void;
  onSelectLane: (id: string) => void;
  onCommitClip: (clip: Clip) => void;
  onSeek: (beat: number) => void;
  onPatchLane: (id: string, patch: Partial<Lane>) => void;
  onRemoveLane: (id: string) => void;
  onDropSection: (drag: SectionDrag, laneId: string | null, beat: number) => void;
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const { project, tracks, ppb } = props;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const totalBeats = Math.max(256, Math.ceil(projectEndBeat(project) / 16) * 16 + 64);
  const width = HEADER_W + totalBeats * ppb;
  const barPx = 4 * ppb;
  const labelEvery = [1, 2, 4, 8, 16].find((n) => n * barPx >= 34) ?? 32;

  const laneById = new Map(project.lanes.map((l) => [l.id, l]));

  function beginDrag(e: PointerEvent<HTMLDivElement>, clip: Clip): void {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const mode: DragMode = x < EDGE_PX ? "trim-start" : x > rect.width - EDGE_PX ? "trim-end" : e.altKey ? "slip" : "move";
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ mode, x0: e.clientX, orig: clip, preview: clip, moved: false });
    props.onSelectClip(clip.id);
  }

  function updateDrag(e: PointerEvent<HTMLDivElement>): void {
    if (!drag) return;
    const lane = laneById.get(drag.orig.laneId);
    const analysis = lane && tracks.get(lane.trackId)?.analysis;
    if (!lane || !analysis) return;
    const unit = e.shiftKey ? 1 : 4;
    const snap = (b: number): number => Math.round(b / unit) * unit;
    const d = (e.clientX - drag.x0) / ppb;
    const o = drag.orig;
    const secPerBeat = srcSecPerBeat(lane, analysis);
    let next: Clip = o;
    if (drag.mode === "move") {
      next = { ...o, start: Math.max(0, snap(o.start + d)) };
    } else if (drag.mode === "slip") {
      const step = e.shiftKey ? 1 : beatsPerSourceBar(lane);
      next = { ...o, srcStart: o.srcStart - Math.round(d / step) * step * secPerBeat };
    } else if (drag.mode === "trim-start") {
      const start = Math.min(o.start + o.length - unit, Math.max(0, snap(o.start + d)));
      const delta = start - o.start;
      next = { ...o, start, length: o.length - delta, srcStart: o.srcStart + delta * secPerBeat };
    } else {
      next = { ...o, length: Math.max(unit, snap(o.start + o.length + d) - o.start) };
    }
    next = { ...next, fadeIn: Math.min(next.fadeIn, next.length), fadeOut: Math.min(next.fadeOut, next.length) };
    setDrag({ ...drag, preview: next, moved: drag.moved || Math.abs(e.clientX - drag.x0) > 2 });
  }

  function endDrag(): void {
    if (drag?.moved) props.onCommitClip(drag.preview);
    setDrag(null);
  }

  function seekFromRuler(e: PointerEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    props.onSeek(Math.max(0, Math.round((e.clientX - rect.left) / ppb)));
  }

  function dropProps(laneId: string | null, key: string) {
    return {
      onDragOver(e: DragEvent<HTMLDivElement>) {
        if (!e.dataTransfer.types.includes(SECTION_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropTarget(key);
      },
      onDragLeave() {
        setDropTarget((t) => (t === key ? null : t));
      },
      onDrop(e: DragEvent<HTMLDivElement>) {
        setDropTarget(null);
        const section = parseSectionDrag(e.dataTransfer.getData(SECTION_DRAG_TYPE));
        if (!section) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const beat = Math.max(0, Math.round((e.clientX - rect.left) / ppb / 4) * 4);
        props.onDropSection(section, laneId, beat);
      },
    };
  }

  const gridStyle = {
    "--beat-px": `${ppb}px`,
    "--bar-px": `${barPx}px`,
    "--phrase-px": `${barPx * 8}px`,
  } as React.CSSProperties;

  return (
    <div className="screen-bezel" data-grime="screen">
    <div className="screen" ref={scroller}>
      <div className="timeline" style={{ width, ...gridStyle }}>
        <div className="ruler-row">
          <div className="corner">
            <span className="eyebrow">Bars</span>
          </div>
          <div className="ruler" onPointerDown={seekFromRuler} title="Click to move the play position">
            {Array.from({ length: Math.ceil(totalBeats / 4 / labelEvery) }, (_, i) => (
              <span key={i} className="ruler-mark" style={{ left: i * labelEvery * barPx }}>
                {i * labelEvery + 1}
              </span>
            ))}
          </div>
        </div>

        {project.lanes.map((lane) => {
          const track = tracks.get(lane.trackId);
          const clips = project.clips.filter((c) => c.laneId === lane.id);
          return (
            <div key={lane.id} className={`lane-row${lane.id === props.selectedLaneId ? " is-selected" : ""}`}>
              <LaneHeader
                lane={lane}
                track={track}
                masterBpm={project.masterBpm}
                onSelect={() => props.onSelectLane(lane.id)}
                onPatch={(patch) => props.onPatchLane(lane.id, patch)}
                onRemove={() => props.onRemoveLane(lane.id)}
              />
              <div
                className={`lane-body${dropTarget === lane.id ? " is-drop-target" : ""}`}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) props.onSelectClip(null);
                }}
                {...dropProps(lane.id, lane.id)}
              >
                {track?.analysis &&
                  clips.map((clip) => {
                    const shown = drag?.orig.id === clip.id ? drag.preview : clip;
                    return (
                      <ClipView
                        key={clip.id}
                        clip={shown}
                        lane={lane}
                        analysis={track.analysis!}
                        hasStems={track.stemLevels !== null}
                        ppb={ppb}
                        selected={clip.id === props.selectedClipId}
                        dragging={drag?.orig.id === clip.id ? drag.mode : null}
                        onPointerDown={(e) => beginDrag(e, clip)}
                        onPointerMove={updateDrag}
                        onPointerUp={endDrag}
                        onToggleStem={(stem) => props.onCommitClip({ ...clip, stems: { ...clip.stems, [stem]: !clip.stems[stem] } })}
                      />
                    );
                  })}
              </div>
            </div>
          );
        })}

        <div className={`lane-row lane-new${dropTarget === "new" ? " is-drop-target" : ""}`} {...dropProps(null, "new")}>
          <div className="lane-header lane-header-empty">
            <span className="eyebrow">New lane</span>
          </div>
          <div className="lane-body lane-body-empty">
            {project.lanes.length === 0
              ? "Pick two songs on the left and press Make mashup, or drag a song part here."
              : "Drag a song part here to put it on its own lane."}
          </div>
        </div>

        <Playhead engine={props.engine} playing={props.playing} ppb={ppb} scroller={scroller} />
      </div>
    </div>
    <div className="screen-glare" aria-hidden />
    <Grime surface="screen" />
    <WipeButton />
    </div>
  );
}

function LaneHeader({
  lane,
  track,
  masterBpm,
  onSelect,
  onPatch,
  onRemove,
}: {
  lane: Lane;
  track: Track | undefined;
  masterBpm: number;
  onSelect: () => void;
  onPatch: (patch: Partial<Lane>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const a = track?.analysis;
  const stretch = a ? (masterBpm / (a.bpm * lane.bpmFactor) - 1) * 100 : 0;
  return (
    <div className="lane-header" onPointerDown={onSelect}>
      <div className="tape" title={track?.title}>
        {track ? shortTitle(track) : "Missing song"}
      </div>
      {a && (
        <div className="lane-meta mono">
          <span title="Original tempo and how much it is stretched">
            {a.bpm.toFixed(1)}
            {lane.bpmFactor !== 1 ? ` ×${lane.bpmFactor}` : ""} {stretch >= 0 ? "+" : ""}
            {stretch.toFixed(1)}%
          </span>
          <span title="Key (Camelot), after pitch shift">{shiftedKeyLabel(a.key, lane.semitones)}</span>
        </div>
      )}
      <div className="lane-buttons">
        <button type="button" className={`chip-btn${lane.mute ? " is-on is-mute" : ""}`} onClick={() => onPatch({ mute: !lane.mute })} aria-pressed={lane.mute} title="Mute">
          M
        </button>
        <button type="button" className={`chip-btn${lane.solo ? " is-on is-solo" : ""}`} onClick={() => onPatch({ solo: !lane.solo })} aria-pressed={lane.solo} title="Solo">
          S
        </button>
        <button type="button" className="chip-btn ghost" onClick={onRemove} title="Remove lane and its clips" aria-label="Remove lane">
          ✕
        </button>
      </div>
    </div>
  );
}

interface ClipViewProps {
  clip: Clip;
  lane: Lane;
  analysis: Analysis;
  hasStems: boolean;
  ppb: number;
  selected: boolean;
  dragging: DragMode | null;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onToggleStem: (stem: Stem) => void;
}

const ClipView = memo(function ClipView(props: ClipViewProps): React.JSX.Element {
  const { clip, lane, analysis, ppb } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = Math.max(4, clip.length * ppb);
  const secPerBeat = srcSecPerBeat(lane, analysis);
  const src0 = clip.srcStart + lane.nudge;

  useEffect(() => {
    if (canvas.current) drawWaveform(canvas.current, analysis, src0, secPerBeat, ppb, width);
  }, [analysis, src0, secPerBeat, ppb, width]);

  const sections = analysis.sections
    .map((s) => ({ s, x0: ((s.start - src0) / secPerBeat) * ppb, x1: ((s.end - src0) / secPerBeat) * ppb }))
    // A section that only grazes the clip (a clip starting exactly on a boundary leaves the
    // previous section a rounding error wide) would stack its label on the real one.
    .filter(({ x0, x1 }) => Math.min(width, x1) - Math.max(0, x0) >= 2);
  const fadeInPx = clip.fadeIn * ppb;
  const fadeOutPx = clip.fadeOut * ppb;
  const playsVocalsOnly = props.hasStems && STEMS.filter((s) => clip.stems[s]).length === 1;

  return (
    <div
      className={`clip${props.selected ? " is-selected" : ""}${props.dragging ? ` is-${props.dragging}` : ""}`}
      style={{ left: clip.start * ppb, width }}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerUp}
    >
      <div className="clip-sections">
        {sections.map(({ s, x0, x1 }) => (
          <div
            key={s.startBar}
            className="clip-section"
            style={{ left: Math.max(0, x0), width: Math.min(width, x1) - Math.max(0, x0), borderTopColor: energyColor(s.energy) }}
            title={`${s.label} ${s.group} · ${s.bars} bars · energy ${Math.round(s.energy * 100)}`}
          >
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      <canvas ref={canvas} className={`clip-wave${playsVocalsOnly ? " is-thin" : ""}`} />
      <svg className="clip-fades" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden>
        {fadeInPx > 0 && <polygon points={`0,0 ${fadeInPx},0 0,100`} className={`fade fade-${clip.inStyle}`} />}
        {fadeOutPx > 0 && <polygon points={`${width},0 ${width - fadeOutPx},0 ${width},100`} className={`fade fade-${clip.outStyle}`} />}
        {clip.bassIn > 0 && <line x1={clip.bassIn * ppb} x2={clip.bassIn * ppb} y1="0" y2="100" className="bass-swap" />}
        {clip.bassOut !== null && <line x1={clip.bassOut * ppb} x2={clip.bassOut * ppb} y1="0" y2="100" className="bass-swap" />}
      </svg>
      {props.hasStems && (
        <div className="clip-stems" onPointerDown={(e) => e.stopPropagation()}>
          {STEMS.map((stem) => (
            <button
              key={stem}
              type="button"
              className={`stem-pill${clip.stems[stem] ? " is-on" : ""}`}
              style={{ "--stem": STEM_UI[stem].color } as React.CSSProperties}
              onClick={() => props.onToggleStem(stem)}
              aria-pressed={clip.stems[stem]}
              title={`${clip.stems[stem] ? "Mute" : "Play"} ${STEM_UI[stem].label.toLowerCase()} in this clip`}
            >
              {STEM_UI[stem].short}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

function drawWaveform(canvas: HTMLCanvasElement, analysis: Analysis, src0: number, secPerBeat: number, ppb: number, widthPx: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = Math.min(widthPx, 30000 / dpr);
  const cssH = canvas.clientHeight || 60;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  const { rate, low, mid, high } = analysis.waveform;
  const n = low.length;
  const half = cssH / 2;
  const layers: [number[], string, number][] = [
    [low, "#4f74ff", 0.98],
    [mid, "#f2a93b", 0.72],
    [high, "#f4f2ea", 0.42],
  ];
  const secPerPx = secPerBeat / ppb;
  for (const [band, color, scale] of layers) {
    g.fillStyle = color;
    for (let x = 0; x < cssW; x++) {
      const i0 = Math.floor((src0 + x * secPerPx) * rate);
      const i1 = Math.max(i0 + 1, Math.floor((src0 + (x + 1) * secPerPx) * rate));
      if (i1 <= 0 || i0 >= n) continue;
      let peak = 0;
      for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) peak = Math.max(peak, band[i] ?? 0);
      const h = (peak / 255) * half * scale;
      if (h > 0.3) g.fillRect(x, half - h, 1, h * 2);
    }
  }
}

function Playhead({
  engine,
  playing,
  ppb,
  scroller,
}: {
  engine: Engine;
  playing: boolean;
  ppb: number;
  scroller: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    let lastX = -1;
    const tick = (): void => {
      const x = HEADER_W + engine.position() * ppb;
      if (line.current) line.current.style.transform = `translateX(${x}px)`;
      const view = scroller.current;
      // Follow while playing; after a jump (seek, new arrangement) bring the playhead into view once.
      const moved = playing || Math.abs(x - lastX) > 1;
      if (moved && view && (x > view.scrollLeft + view.clientWidth - 60 || x < view.scrollLeft + HEADER_W)) {
        view.scrollLeft = x - HEADER_W - 80;
      }
      lastX = x;
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [engine, playing, ppb, scroller]);
  return <div ref={line} className={`playhead${playing ? " is-playing" : ""}`} aria-hidden />;
}
