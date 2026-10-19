import type { Analysis, AudioSource, MusicalKey, Stem, Track } from "../shared/types";
import { camelot } from "../shared/keys";
import { STEMS } from "../shared/types";

export type InStyle = "fade" | "filter";
export type OutStyle = "fade" | "filter" | "echo";
export type BpmFactor = 0.5 | 1 | 2;

/** One mixer channel. A song can sit on several lanes, for example its beat on one and its vocals on another. */
export interface Lane {
  id: string;
  trackId: string;
  volume: number;
  mute: boolean;
  solo: boolean;
  /** dB per band; -40 is a kill. */
  eq: { low: number; mid: number; high: number };
  /** -1 closes the low-pass, 0 is open, 1 closes the high-pass. */
  filter: number;
  stemGain: Record<Stem, number>;
  echo: number;
  reverb: number;
  /** Plays the song as if its tempo were bpm × factor, so 70 BPM can lock to 140 BPM. */
  bpmFactor: BpmFactor;
  semitones: number;
  /**
   * Seconds added to every source position on this lane, to fix a beat grid that is a bit off.
   * Positive reads later audio at the same moment, so the lane sounds earlier.
   */
  nudge: number;
}

export interface Clip {
  id: string;
  laneId: string;
  /** Position on the master timeline, in master beats. */
  start: number;
  length: number;
  /** Where the clip starts in the original song, in seconds. */
  srcStart: number;
  fadeIn: number;
  fadeOut: number;
  inStyle: InStyle;
  outStyle: OutStyle;
  /** Beats from clip start before the low end comes in (bass swap). 0 = from the start. */
  bassIn: number;
  /** Beats from clip start after which the low end is cut. null = never. */
  bassOut: number | null;
  stems: Record<Stem, boolean>;
}

export interface Project {
  masterBpm: number;
  lanes: Lane[];
  clips: Clip[];
}

export const EMPTY_PROJECT: Project = { masterBpm: 124, lanes: [], clips: [] };
export const EQ_KILL_DB = -40;

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export const allStems = (on: boolean): Record<Stem, boolean> =>
  Object.fromEntries(STEMS.map((s) => [s, on])) as Record<Stem, boolean>;

export function newLane(trackId: string, bpmFactor: BpmFactor = 1, semitones = 0): Lane {
  return {
    id: uid(),
    trackId,
    volume: 0.85,
    mute: false,
    solo: false,
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    stemGain: { vocals: 1, drums: 1, bass: 1, other: 1 },
    echo: 0,
    reverb: 0,
    bpmFactor,
    semitones,
    nudge: 0,
  };
}

export function newClip(fields: Pick<Clip, "laneId" | "start" | "length" | "srcStart"> & Partial<Clip>): Clip {
  return {
    id: uid(),
    fadeIn: 0,
    fadeOut: 0,
    inStyle: "fade",
    outStyle: "fade",
    bassIn: 0,
    bassOut: null,
    stems: allStems(true),
    ...fields,
  };
}

/** Time-stretch factor that makes the lane's song run at the master tempo. Rounded so renders cache well. */
export function laneRate(masterBpm: number, lane: Lane, analysis: Analysis): number {
  return Math.round((masterBpm / (analysis.bpm * lane.bpmFactor)) * 1e5) / 1e5;
}

/** Seconds of original audio that one master beat covers on this lane. */
export function srcSecPerBeat(lane: Lane, analysis: Analysis): number {
  return 60 / (analysis.bpm * lane.bpmFactor);
}

/** Master beats that one bar of the original song takes. */
export function beatsPerSourceBar(lane: Lane): number {
  return 4 * lane.bpmFactor;
}

export function barTime(analysis: Analysis, bar: number): number {
  return analysis.downbeat + bar * 4 * analysis.beatSec;
}

/**
 * Audio exists on the server: finished, past download and splitting stems (the mix plays
 * meanwhile), or a finished song being re-analysed after a tune, or whose re-analysis failed
 * (its audio and stems are untouched either way).
 */
export function isPlayable(track: Track): boolean {
  if (track.analysis === null) return false;
  if (track.status === "ready" || track.status === "separating") return true;
  return (track.status === "analyzing" || track.status === "error") && track.stemLevels !== null;
}

/** Sources a lane needs: the stems its clips use, or the full mix while stems are still being made. */
export function laneSources(track: Track, clips: Clip[]): AudioSource[] {
  if (!track.stemLevels) return clips.length ? ["mix"] : [];
  return STEMS.filter((s) => clips.some((c) => c.stems[s]));
}

/** Tempo factor that keeps the stretch smallest: 70 BPM next to 140 BPM plays at double time. */
export function bestBpmFactor(bpm: number, masterBpm: number): BpmFactor {
  const factors: BpmFactor[] = [0.5, 1, 2];
  return factors.reduce((best, f) =>
    Math.abs(Math.log(masterBpm / (bpm * f))) < Math.abs(Math.log(masterBpm / (bpm * best))) ? f : best,
  );
}

/** 0 = same key, 1 = relative or neighbour on the wheel (mixes well), higher clashes more. */
export function keyDistance(a: MusicalKey, b: MusicalKey, shiftB = 0): number {
  const ca = camelot(a.tonic, a.minor);
  const cb = camelot(b.tonic + shiftB, b.minor);
  const step = Math.min((ca.number - cb.number + 12) % 12, (cb.number - ca.number + 12) % 12);
  return step + (ca.letter === cb.letter ? 0 : 1);
}

export function shiftedKeyLabel(key: MusicalKey, semitones: number): string {
  const c = camelot(key.tonic + semitones, key.minor);
  return `${c.number}${c.letter}`;
}

/** Smallest pitch shift (within ±maxShift) that makes `b` harmonically compatible with `a`. */
export function bestKeyShift(a: MusicalKey, b: MusicalKey, maxShift: number): number {
  let best = 0;
  let bestScore = keyDistance(a, b);
  for (let s = -maxShift; s <= maxShift; s++) {
    const score = keyDistance(a, b, s) + Math.abs(s) * 0.35;
    if (score < bestScore - 1e-9) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

export function formatBarBeat(beat: number): string {
  const b = Math.max(0, beat);
  return `${Math.floor(b / 4) + 1}.${Math.floor(b % 4) + 1}`;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
}

/** Cuts a clip `at` beats after its start. Fades and bass swaps stay with the half they belong to. */
export function splitClip(clip: Clip, lane: Lane, analysis: Analysis, at: number): [Clip, Clip] {
  const left: Clip = { ...clip, length: at, fadeOut: 0, bassOut: clip.bassOut !== null && clip.bassOut < at ? clip.bassOut : null };
  const right: Clip = {
    ...clip,
    id: uid(),
    start: clip.start + at,
    length: clip.length - at,
    srcStart: clip.srcStart + at * srcSecPerBeat(lane, analysis),
    fadeIn: 0,
    bassIn: Math.max(0, clip.bassIn - at),
    bassOut: clip.bassOut === null ? null : Math.max(0, clip.bassOut - at),
  };
  return [left, right];
}

export function projectEndBeat(project: Project): number {
  return project.clips.reduce((end, c) => Math.max(end, c.start + c.length), 0);
}
