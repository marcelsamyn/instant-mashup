import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Track } from "../shared/types";
import { addTrack, fetchTracks } from "./api";
import { type BufferLookup, BufferStore, bufferNeeds } from "./buffers";
import { Inspector } from "./components/Inspector";
import { Library } from "./components/Library";
import { Mixer } from "./components/Mixer";
import { Timeline } from "./components/Timeline";
import { Transport } from "./components/Transport";
import { Engine, renderMix } from "./engine";
import { type TransitionStyle, autoBlend, autoMix, isAnalysed } from "./mashup";
import {
  type Clip,
  EMPTY_PROJECT,
  type Lane,
  type Project,
  barTime,
  beatsPerSourceBar,
  bestBpmFactor,
  newClip,
  newLane,
  isPlayable,
  projectEndBeat,
  splitClip,
  uid,
} from "./project";
import { type SectionDrag, shortTitle } from "./ui";
import { useGrimeTracker } from "./grime";
import { encodeWav } from "./wav";

const STORAGE_KEY = "instant-mashup:v1";

interface History {
  past: Project[];
  present: Project;
  future: Project[];
}

function loadSaved(): { project: Project; queue: string[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (
      typeof saved === "object" &&
      saved !== null &&
      "project" in saved &&
      "queue" in saved &&
      Array.isArray(saved.queue) &&
      typeof saved.project === "object" &&
      saved.project !== null &&
      "masterBpm" in saved.project &&
      typeof saved.project.masterBpm === "number" &&
      "lanes" in saved.project &&
      Array.isArray(saved.project.lanes) &&
      "clips" in saved.project &&
      Array.isArray(saved.project.clips)
    ) {
      return { project: saved.project as Project, queue: saved.queue.filter((q): q is string => typeof q === "string") };
    }
  } catch {
    // Storage blocked or corrupt: start fresh.
  }
  return { project: EMPTY_PROJECT, queue: [] };
}

/** Keeps the previous object for tracks that did not change, so polling does not re-render everything. */
function mergeTracks(prev: Track[], next: Track[]): Track[] {
  const byId = new Map(prev.map((t) => [t.id, t]));
  let changed = prev.length !== next.length;
  const merged = next.map((t) => {
    const old = byId.get(t.id);
    const same =
      old &&
      old.status === t.status &&
      old.error === t.error &&
      old.title === t.title &&
      Boolean(old.analysis) === Boolean(t.analysis) &&
      Boolean(old.stemLevels) === Boolean(t.stemLevels);
    if (same) return old;
    changed = true;
    return t;
  });
  return changed ? merged : prev;
}

const isBusy = (t: Track): boolean => t.status !== "ready" && t.status !== "error";

export function App(): React.JSX.Element {
  useGrimeTracker();
  const engine = useMemo(() => new Engine(), []);
  const buffers = useMemo(() => new BufferStore(engine.ctx), [engine]);
  const saved = useMemo(loadSaved, []);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [history, setHistory] = useState<History>({ past: [], present: saved.project, future: [] });
  const [queue, setQueue] = useState<string[]>(saved.queue);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ppb, setPpb] = useState(6);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "info" | "error"; id: number } | null>(null);

  const project = history.present;
  const tracksById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const latest = useRef({ project, tracksById });
  latest.current = { project, tracksById };
  /** Buffers for the arrangement as last loaded; seeks during playback reuse them. */
  const loadedBuffers = useRef<BufferLookup>(() => undefined);

  const notify = useCallback((text: string, tone: "info" | "error" = "info") => setToast({ text, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === "error" ? 7000 : 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // Poll the library quickly while songs are processing, slowly otherwise.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      let delay = 5000;
      try {
        const list = await fetchTracks();
        if (!alive) return;
        setTracks((prev) => mergeTracks(prev, list));
        delay = list.some(isBusy) ? 1500 : 8000;
      } catch (err) {
        console.error("Library refresh failed", err);
      }
      if (alive) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  /** Records an undo step. */
  const commit = useCallback((fn: (p: Project) => Project) => {
    setHistory((h) => {
      const next = fn(h.present);
      return next === h.present ? h : { past: [...h.past.slice(-80), h.present], present: next, future: [] };
    });
  }, []);
  /** Knob tweaks change the sound but do not fill the undo stack. */
  const tweak = useCallback((fn: (p: Project) => Project) => setHistory((h) => ({ ...h, present: fn(h.present) })), []);
  const undo = useCallback(() => setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] } : h)), []);
  const redo = useCallback(() => setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h)), []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ project, queue }));
    } catch {
      // Storage full or blocked; the session still works.
    }
  }, [project, queue]);

  // Knob values go straight to the audio graph.
  useLayoutEffect(() => engine.graph.sync(project), [engine, project]);

  // Anything that changes what plays when: load the audio it needs, then restart playback in place.
  const scheduleKey = JSON.stringify({
    bpm: project.masterBpm,
    clips: project.clips,
    lanes: project.lanes.map((l) => [l.id, l.trackId, l.bpmFactor, l.semitones, l.nudge]),
    ready: project.lanes.map((l) => {
      const t = tracksById.get(l.trackId);
      return [Boolean(t && isPlayable(t)), Boolean(t?.stemLevels)];
    }),
  });
  useEffect(() => {
    let cancelled = false;
    const { project: p, tracksById: t } = latest.current;
    // Snapshot: this effect reruns whenever the arrangement changes, cancelling this run.
    const needs = bufferNeeds(p, t);
    setLoading(needs.length ? { done: 0, total: needs.length } : null);
    buffers
      .ensure(needs, (done, total) => {
        if (!cancelled) setLoading({ done, total });
      })
      .then((lookup) => {
        if (cancelled) return;
        loadedBuffers.current = lookup;
        setLoading(null);
        if (engine.playing) void engine.play(p, t, lookup);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(null);
        notify(err instanceof Error ? err.message : String(err), "error");
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleKey, buffers, engine, notify]);

  const togglePlay = useCallback(async () => {
    if (engine.playing) {
      engine.pause();
      setPlaying(false);
      return;
    }
    if (latest.current.project.clips.length === 0) {
      notify("Nothing to play yet. Make a mashup or drag a song part onto the timeline.");
      return;
    }
    try {
      // Load until the arrangement stops changing underneath, then play exactly what was loaded.
      let p: Project;
      let t: Map<string, Track>;
      let lookup: BufferLookup;
      do {
        ({ project: p, tracksById: t } = latest.current);
        lookup = await buffers.ensure(bufferNeeds(p, t));
      } while (latest.current.project !== p || latest.current.tracksById !== t);
      loadedBuffers.current = lookup;
      await engine.play(p, t, lookup);
      setPlaying(true);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }, [engine, buffers, notify]);

  const seek = useCallback(
    (beat: number) => {
      if (engine.playing) void engine.play(latest.current.project, latest.current.tracksById, loadedBuffers.current, beat);
      else engine.seek(beat);
    },
    [engine, buffers],
  );

  const stopAtEnd = useCallback(() => {
    engine.pause();
    engine.seek(0);
    setPlaying(false);
  }, [engine]);

  const queuedTracks = (): Track[] => queue.map((id) => tracksById.get(id)).filter((t): t is Track => Boolean(t));

  function loadArrangement(next: Project, message: string): void {
    commit(() => next);
    setSelectedClipId(null);
    setSelectedLaneId(next.lanes[0]?.id ?? null);
    seek(0);
    notify(message);
  }

  function makeMashup(): void {
    const picked = queuedTracks().filter(isAnalysed);
    try {
      const next = autoBlend(picked);
      const [beat, ...vocals] = picked;
      loadArrangement(next, `Mashup ready: beat from ${shortTitle(beat!)}, vocals from ${vocals.map(shortTitle).join(" and ")}. Press space to play.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function makeMix(style: TransitionStyle): void {
    try {
      loadArrangement(autoMix(queuedTracks().filter(isAnalysed), style), "DJ mix ready. Press space to play.");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function add(url: string, title?: string): Promise<void> {
    try {
      const track = await addTrack(url, title);
      setTracks((prev) => mergeTracks(prev, [...prev.filter((t) => t.id !== track.id), track]));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function dropSection(drag: SectionDrag, laneId: string | null, beat: number): void {
    const track = tracksById.get(drag.trackId);
    const a = track?.analysis;
    if (!track || !a) return;
    // The first part dropped into an empty project sets the master tempo.
    const masterBpm = project.clips.length === 0 ? a.bpm : project.masterBpm;
    const existing = project.lanes.find((l) => l.id === laneId && l.trackId === track.id);
    const lane = existing ?? newLane(track.id, bestBpmFactor(a.bpm, masterBpm));
    const clip = newClip({ laneId: lane.id, start: beat, length: drag.bars * beatsPerSourceBar(lane), srcStart: barTime(a, drag.startBar) });
    commit((p) => ({ masterBpm, lanes: existing ? p.lanes : [...p.lanes, lane], clips: [...p.clips, clip] }));
    setSelectedClipId(clip.id);
    setSelectedLaneId(lane.id);
  }

  const selectedClip = project.clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedClipLane = selectedClip ? project.lanes.find((l) => l.id === selectedClip.laneId) : undefined;

  const updateClip = useCallback((clip: Clip) => commit((p) => ({ ...p, clips: p.clips.map((c) => (c.id === clip.id ? clip : c)) })), [commit]);
  const patchLane = useCallback(
    (id: string, patch: Partial<Lane>) => tweak((p) => ({ ...p, lanes: p.lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
    [tweak],
  );

  const deleteClip = useCallback(() => {
    if (!selectedClipId) return;
    commit((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== selectedClipId) }));
    setSelectedClipId(null);
  }, [commit, selectedClipId]);

  const duplicateClip = useCallback(() => {
    if (!selectedClip) return;
    const copy = { ...selectedClip, id: uid(), start: selectedClip.start + selectedClip.length };
    commit((p) => ({ ...p, clips: [...p.clips, copy] }));
    setSelectedClipId(copy.id);
  }, [commit, selectedClip]);

  const splitSelected = useCallback(() => {
    const clip = selectedClip;
    const lane = selectedClipLane;
    const a = lane && tracksById.get(lane.trackId)?.analysis;
    if (!clip || !lane || !a) return;
    const cut = Math.round(engine.position());
    const d = cut - clip.start;
    if (d <= 0 || d >= clip.length) {
      notify("Move the play position inside the selected clip to split it.");
      return;
    }
    const [left, right] = splitClip(clip, lane, a, d);
    commit((p) => ({ ...p, clips: p.clips.flatMap((c) => (c.id === clip.id ? [left, right] : [c])) }));
    setSelectedClipId(right.id);
  }, [commit, engine, notify, selectedClip, selectedClipLane, tracksById]);

  const removeLane = useCallback(
    (id: string) => commit((p) => ({ ...p, lanes: p.lanes.filter((l) => l.id !== id), clips: p.clips.filter((c) => c.laneId !== id) })),
    [commit],
  );

  async function exportWav(): Promise<void> {
    setExporting(true);
    // Export exactly the arrangement as it was when the button was pressed.
    const p = project;
    const t = tracksById;
    try {
      const lookup = await buffers.ensure(bufferNeeds(p, t));
      const rendered = await renderMix(p, t, lookup);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(encodeWav(rendered));
      link.download = `mashup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.wav`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      notify("Exported the mix as a WAV file.");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Knobs handle their own arrow keys and mark them handled; text fields keep every key.
      const target = e.target as HTMLElement | null;
      if (e.defaultPrevented || target?.closest("input, select, textarea")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") void togglePlay();
      else if (mod && e.key.toLowerCase() === "z") (e.shiftKey ? redo : undo)();
      else if (mod && e.key.toLowerCase() === "d") duplicateClip();
      else if (e.key === "Backspace" || e.key === "Delete") deleteClip();
      else if (!mod && e.key.toLowerCase() === "s") splitSelected();
      else if (e.key === "Home" || e.key === "Enter") seek(0);
      else if (e.key === "=" || e.key === "+") setPpb((z) => Math.min(32, z * 1.25));
      else if (e.key === "-") setPpb((z) => Math.max(1.5, z / 1.25));
      else if (e.key === "Escape") setSelectedClipId(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, undo, redo, duplicateClip, deleteClip, splitSelected, seek]);

  return (
    <div className="console">
      <Transport
        engine={engine}
        playing={playing}
        masterBpm={project.masterBpm}
        endBeat={projectEndBeat(project)}
        loading={loading}
        exporting={exporting}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        ppb={ppb}
        onTogglePlay={() => void togglePlay()}
        onRewind={() => seek(0)}
        onEnd={stopAtEnd}
        onBpm={(bpm) => commit((p) => ({ ...p, masterBpm: bpm }))}
        onZoom={setPpb}
        onUndo={undo}
        onRedo={redo}
        onExport={() => void exportWav()}
        canExport={project.clips.length > 0}
      />
      <Library
        tracks={tracks}
        queue={queue}
        onAdd={add}
        onToggleQueue={(id) => setQueue((q) => (q.includes(id) ? q.filter((x) => x !== id) : [...q, id]))}
        onMakeMashup={makeMashup}
        onMakeMix={makeMix}
      />
      <Timeline
        project={project}
        tracks={tracksById}
        ppb={ppb}
        engine={engine}
        playing={playing}
        selectedClipId={selectedClipId}
        selectedLaneId={selectedLaneId}
        onSelectClip={setSelectedClipId}
        onSelectLane={setSelectedLaneId}
        onCommitClip={updateClip}
        onSeek={seek}
        onPatchLane={patchLane}
        onRemoveLane={removeLane}
        onDropSection={dropSection}
      />
      <div className="dock">
        <Mixer lanes={project.lanes} tracks={tracksById} engine={engine} selectedLaneId={selectedLaneId} onSelectLane={setSelectedLaneId} onPatchLane={patchLane} />
        <Inspector
          clip={selectedClip}
          lane={selectedClipLane}
          track={selectedClipLane ? tracksById.get(selectedClipLane.trackId) : undefined}
          onChange={updateClip}
          onSplit={splitSelected}
          onDuplicate={duplicateClip}
          onDelete={deleteClip}
        />
      </div>
      {toast && (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
