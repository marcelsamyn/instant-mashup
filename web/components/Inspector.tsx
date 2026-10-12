import { STEMS, type Track } from "../../shared/types";
import { type Clip, type InStyle, type Lane, type OutStyle, barTime, formatBarBeat } from "../project";
import { STEM_UI, energyColor, shortTitle } from "../ui";

interface InspectorProps {
  clip: Clip | null;
  lane: Lane | undefined;
  track: Track | undefined;
  onChange: (clip: Clip) => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const IN_STYLES: { value: InStyle; label: string }[] = [
  { value: "fade", label: "Fade" },
  { value: "filter", label: "Low-pass open" },
];
const OUT_STYLES: { value: OutStyle; label: string }[] = [
  { value: "fade", label: "Fade" },
  { value: "filter", label: "High-pass sweep" },
  { value: "echo", label: "Echo out" },
];

function BeatInput({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }): React.JSX.Element {
  return (
    <label className="field">
      <span className="engraved">{label}</span>
      <span className="beat-input">
        <input
          type="number"
          className="lcd mono"
          min={0}
          max={max}
          step={4}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(Math.min(max, Math.max(0, v)));
          }}
        />
        <span className="unit">beats</span>
      </span>
    </label>
  );
}

export function Inspector({ clip, lane, track, onChange, onSplit, onDuplicate, onDelete }: InspectorProps): React.JSX.Element {
  if (!clip || !lane || !track?.analysis) {
    return (
      <aside className="inspector inspector-empty">
        <span className="engraved">Clip</span>
        <p>Select a clip to shape its fades, stems and bass swap.</p>
        <p className="hint">
          Drag a clip to move it. Drag its edges to trim. Hold <kbd>⌥</kbd> and drag to slide the audio inside it. Hold <kbd>⇧</kbd> to snap to beats
          instead of bars.
        </p>
      </aside>
    );
  }
  const a = track.analysis;
  const set = (patch: Partial<Clip>): void => onChange({ ...clip, ...patch });
  const currentSection = a.sections.findLast((s) => s.start <= clip.srcStart + 0.05) ?? a.sections[0];

  return (
    <aside className="inspector" key={clip.id}>
      <header className="inspector-head">
        <span className="engraved">Clip</span>
        <span className="tape tape-small">{shortTitle(track)}</span>
        <span className="lcd mono" title="Start position on the timeline (bar.beat) and length">
          {formatBarBeat(clip.start)} · {clip.length / 4} bars
        </span>
      </header>

      <label className="field">
        <span className="engraved">Song part</span>
        <select
          className="hw-select"
          value={currentSection?.startBar ?? 0}
          onChange={(e) => set({ srcStart: barTime(a, Number(e.target.value)) })}
          style={{ borderLeftColor: currentSection ? energyColor(currentSection.energy) : undefined }}
        >
          {a.sections.map((s) => (
            <option key={s.startBar} value={s.startBar}>
              {s.label} {s.group} — bar {s.startBar + 1}, {s.bars} bars
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span className="engraved">Stems in this clip</span>
        <div className="stem-toggles">
          {STEMS.map((stem) => (
            <button
              key={stem}
              type="button"
              className={`hw-btn stem-toggle${clip.stems[stem] ? " is-lit" : ""}`}
              style={{ "--stem": STEM_UI[stem].color } as React.CSSProperties}
              aria-pressed={clip.stems[stem]}
              disabled={!track.stemLevels}
              onClick={() => set({ stems: { ...clip.stems, [stem]: !clip.stems[stem] } })}
            >
              {STEM_UI[stem].label}
            </button>
          ))}
        </div>
        {!track.stemLevels && <span className="hint">Separating stems… the full song plays until then.</span>}
      </div>

      <div className="field-grid">
        <BeatInput label="Fade in" value={clip.fadeIn} max={clip.length} onChange={(v) => set({ fadeIn: v })} />
        <label className="field">
          <span className="engraved">In style</span>
          <select className="hw-select" value={clip.inStyle} onChange={(e) => set({ inStyle: e.target.value as InStyle })}>
            {IN_STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <BeatInput label="Fade out" value={clip.fadeOut} max={clip.length} onChange={(v) => set({ fadeOut: v })} />
        <label className="field">
          <span className="engraved">Out style</span>
          <select className="hw-select" value={clip.outStyle} onChange={(e) => set({ outStyle: e.target.value as OutStyle })}>
            {OUT_STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <BeatInput label="Bass enters at" value={clip.bassIn} max={clip.length} onChange={(v) => set({ bassIn: v })} />
        <label className="field">
          <span className="engraved">Bass leaves at</span>
          <span className="beat-input">
            <input
              type="number"
              className="lcd mono"
              min={0}
              max={clip.length}
              step={4}
              placeholder="never"
              value={clip.bassOut ?? ""}
              onChange={(e) => set({ bassOut: e.target.value === "" ? null : Math.min(clip.length, Math.max(0, Number(e.target.value))) })}
            />
            <span className="unit">beats</span>
          </span>
        </label>
      </div>

      <div className="inspector-actions">
        <button type="button" className="hw-btn" onClick={onSplit} title="Split at the play position (S)">
          Split
        </button>
        <button type="button" className="hw-btn" onClick={onDuplicate} title="Copy right after this clip (⌘D)">
          Duplicate
        </button>
        <button type="button" className="hw-btn danger" onClick={onDelete} title="Delete (⌫)">
          Delete
        </button>
      </div>
    </aside>
  );
}
