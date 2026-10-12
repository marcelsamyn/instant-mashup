import type { Analysis, Section, Track } from "../shared/types";
import {
  type Clip,
  type Lane,
  type Project,
  allStems,
  barTime,
  beatsPerSourceBar,
  bestBpmFactor,
  bestKeyShift,
  newClip,
  newLane,
  splitClip,
  srcSecPerBeat,
} from "./project";

export type TransitionStyle = "blend" | "filter" | "echo";

export const TRANSITION_STYLES: { value: TransitionStyle; label: string; hint: string }[] = [
  { value: "blend", label: "EQ blend", hint: "Long overlap, fades, and a bass swap halfway" },
  { value: "filter", label: "Filter sweep", hint: "Outgoing song sweeps up a high-pass, incoming opens a low-pass" },
  { value: "echo", label: "Echo out", hint: "Outgoing song throws into a beat-synced echo, next one drops in" },
];

/** Analysed track; auto-mixing only works with these. */
export type AnalysedTrack = Track & { analysis: Analysis };

export const isAnalysed = (t: Track): t is AnalysedTrack => t.analysis !== null;

const VOCAL_FLOOR_DB = -42;
const VOCAL_RANGE_DB = 18;

/** 0..1 share of bars in a range where the vocal stem is clearly audible. 0.5 when stems are unknown. */
export function vocalPresence(track: Track, startBar: number, bars: number): number {
  const levels = track.stemLevels?.vocals;
  if (!levels) return 0.5;
  const slice = levels.slice(Math.max(0, startBar), Math.max(0, startBar + bars));
  if (!slice.length) return 0;
  const sum = slice.reduce((acc, db) => acc + Math.min(1, Math.max(0, (db - VOCAL_FLOOR_DB) / VOCAL_RANGE_DB)), 0);
  return sum / slice.length;
}

function sectionAt(analysis: Analysis, bar: number): Section {
  const found = analysis.sections.findLast((s) => s.startBar <= bar);
  return found ?? analysis.sections[0]!;
}

function energyOver(analysis: Analysis, startBar: number, bars: number): number {
  const slice = analysis.barEnergy.slice(Math.max(0, startBar), startBar + bars);
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
}

/** Master beats of source audio left after `srcStart` on a lane. */
function beatsLeft(track: AnalysedTrack, lane: Lane, srcStart: number): number {
  return (track.analysis.duration - srcStart) / srcSecPerBeat(lane, track.analysis);
}

/**
 * Mashup: the first song supplies the beat (drums, bass, instruments), every other song supplies
 * vocals. For each section of the beat, pick the donor vocal section whose energy fits best,
 * preferring matching roles (chorus over chorus) and spreading picks so one hook does not repeat.
 */
export function autoBlend(tracks: AnalysedTrack[]): Project {
  const [base, ...donors] = tracks;
  if (!base || donors.length === 0) throw new Error("Pick at least two songs: one beat and one or more vocals");
  const masterBpm = base.analysis.bpm;
  const baseLane = newLane(base.id);
  const donorLanes = donors.map((d) => {
    const lane = newLane(d.id, bestBpmFactor(d.analysis.bpm, masterBpm), bestKeyShift(base.analysis.key, d.analysis.key, 3));
    lane.volume = 0.95;
    return lane;
  });

  const candidates = donors.flatMap((donor, i) =>
    donor.analysis.sections
      .filter((s) => s.label !== "Intro" && s.label !== "Outro")
      .map((section) => ({ donor, lane: donorLanes[i]!, section, vocals: vocalPresence(donor, section.startBar, section.bars) }))
      .filter((c) => c.vocals >= 0.35),
  );
  if (candidates.length === 0) throw new Error("No sung sections found in the vocal songs");

  const uses = new Map<(typeof candidates)[number], number>();
  let previous: (typeof candidates)[number] | null = null;
  const clips: Clip[] = [];
  for (const section of base.analysis.sections) {
    const start = section.startBar * 4;
    const length = section.bars * 4;
    clips.push(
      newClip({
        laneId: baseLane.id,
        start,
        length,
        srcStart: barTime(base.analysis, section.startBar),
        stems: { ...allStems(true), vocals: false },
      }),
    );
    if (section.label === "Intro" || section.label === "Outro") continue;

    const score = (c: (typeof candidates)[number]): number =>
      Math.abs(section.energy - c.section.energy) +
      0.3 * (uses.get(c) ?? 0) +
      (c === previous ? 0.4 : 0) +
      (c.section.label === section.label ? -0.15 : 0) +
      (1 - c.vocals) * 0.4;
    // A long beat section takes several donor sections back to back. A remainder shorter than
    // 4 bars stays in the last pick, which just runs on a little.
    let cursor = start;
    while (start + length - cursor >= 16) {
      const pick = candidates.reduce((best, c) => (score(c) < score(best) ? c : best));
      uses.set(pick, (uses.get(pick) ?? 0) + 1);
      previous = pick;
      const srcStart = barTime(pick.donor.analysis, pick.section.startBar);
      const remaining = start + length - cursor;
      const sectionBeats = pick.section.bars * beatsPerSourceBar(pick.lane);
      const take = remaining - sectionBeats < 16 ? remaining : sectionBeats;
      clips.push(
        newClip({
          laneId: pick.lane.id,
          start: cursor,
          length: Math.min(take, Math.floor(beatsLeft(pick.donor, pick.lane, srcStart))),
          srcStart,
          fadeOut: 2,
          stems: { ...allStems(false), vocals: true },
        }),
      );
      cursor += take;
    }
  }
  return { masterBpm, lanes: [baseLane, ...donorLanes], clips };
}

interface TransitionPlan {
  /** Bar in the outgoing song where the incoming song starts. */
  exitBar: number;
  /** Bar in the incoming song where it starts playing. */
  entryBar: number;
  /** Overlap in master bars. */
  overlapBars: number;
}

/**
 * Choose where to leave song A and where to enter song B. Candidates are section starts: late in A,
 * early in B. Score keeps most of each song, avoids overlapping a near-silent fade-out (nothing to
 * blend with), avoids two vocals at once, and prefers similar-energy material while both play.
 * With stems, B's vocals stay muted during the overlap, so vocal clashes do not count.
 */
function planTransition(a: AnalysedTrack, laneA: Lane, aEntryBar: number, b: AnalysedTrack, style: TransitionStyle): TransitionPlan {
  const A = a.analysis;
  const B = b.analysis;
  const minExit = Math.max(aEntryBar + 32, Math.floor(A.barCount * 0.45));
  const exits = A.sections.map((s) => s.startBar).filter((bar) => bar >= minExit && bar < A.barCount - 4);
  if (exits.length === 0) exits.push(Math.max(aEntryBar + 8, A.barCount - 16));
  const entries = B.sections.map((s) => s.startBar).filter((bar) => bar <= B.barCount * 0.4);

  let best: TransitionPlan & { score: number } = { exitBar: exits[0]!, entryBar: 0, overlapBars: 0, score: Infinity };
  for (const exitBar of exits) {
    for (const entryBar of entries) {
      const sourceBarsLeft = A.barCount - exitBar;
      const overlapSource = style === "echo" ? 0 : Math.min(sourceBarsLeft, Math.max(8, Math.min(16, Math.floor(sectionAt(A, exitBar).bars / 4) * 4)));
      const overlapBars = Math.round((overlapSource * beatsPerSourceBar(laneA)) / 4);
      const exitFrac = exitBar / A.barCount;
      const entryFrac = entryBar / B.barCount;
      const outEnergy = energyOver(A, exitBar, Math.max(overlapSource, 4));
      const inEnergy = energyOver(B, entryBar, Math.max(overlapSource, 4));
      let score = 1.5 * (1 - exitFrac) + 1.5 * entryFrac;
      if (style === "echo") {
        // A hard handover: keep the momentum of the section that just ended.
        score += Math.abs(energyOver(A, exitBar - 8, 8) - inEnergy);
      } else {
        const clash = b.stemLevels ? 0 : vocalPresence(a, exitBar, overlapSource) * vocalPresence(b, entryBar, overlapSource);
        const deadAir = Math.max(0, 0.25 - outEnergy) * 4;
        score += 2 * clash + 1.5 * deadAir + Math.abs(outEnergy - inEnergy) + 0.2 * (outEnergy + inEnergy);
      }
      if (score < best.score) best = { exitBar, entryBar, overlapBars, score };
    }
  }
  return best;
}

function transitionClips(style: TransitionStyle, overlapBeats: number): { out: Partial<Clip>; in: Partial<Clip> } {
  if (style === "echo") return { out: { fadeOut: 4, outStyle: "echo" }, in: {} };
  const half = overlapBeats / 2;
  if (style === "filter") {
    return { out: { fadeOut: overlapBeats, outStyle: "filter" }, in: { fadeIn: overlapBeats, inStyle: "filter", bassIn: half } };
  }
  return { out: { fadeOut: half, outStyle: "fade" }, in: { fadeIn: half, inStyle: "fade", bassIn: half } };
}

/**
 * DJ mix: songs play one after another, each handover planned by planTransition(). When the
 * incoming song has stems, its first clip (the overlap) plays without vocals.
 */
export function autoMix(tracks: AnalysedTrack[], style: TransitionStyle): Project {
  const first = tracks[0];
  if (!first) throw new Error("Pick at least one song");
  const masterBpm = first.analysis.bpm;
  const lanes = tracks.map((t, i) => newLane(t.id, i === 0 ? 1 : bestBpmFactor(t.analysis.bpm, masterBpm)));
  const clips: Clip[] = [];
  let cursor = 0;
  let entryBar = 0;
  let incoming: Partial<Clip> = {};
  let instrumentalIntro = 0;

  tracks.forEach((track, i) => {
    const lane = lanes[i]!;
    const next = tracks[i + 1];
    const srcStart = barTime(track.analysis, entryBar);
    const perBar = beatsPerSourceBar(lane);
    const available = Math.floor(beatsLeft(track, lane, srcStart));
    let clip: Clip;
    let overlapBeats = 0;
    if (next) {
      const plan = planTransition(track, lane, entryBar, next, style);
      overlapBeats = plan.overlapBars * 4;
      const body = (plan.exitBar - entryBar) * perBar;
      const { out, in: nextIn } = transitionClips(style, overlapBeats);
      const bassOut = style === "echo" ? null : body + overlapBeats / 2;
      clip = newClip({ laneId: lane.id, start: cursor, length: Math.min(body + overlapBeats, available), srcStart, ...incoming, ...out, bassOut });
      cursor += body;
      entryBar = plan.entryBar;
      incoming = nextIn;
    } else {
      clip = newClip({ laneId: lane.id, start: cursor, length: available, srcStart, ...incoming });
    }
    if (instrumentalIntro > 0 && instrumentalIntro < clip.length) {
      const [intro, rest] = splitClip(clip, lane, track.analysis, instrumentalIntro);
      clips.push({ ...intro, stems: { ...intro.stems, vocals: false } }, rest);
    } else {
      clips.push(clip);
    }
    instrumentalIntro = next?.stemLevels && style !== "echo" ? overlapBeats : 0;
  });
  return { masterBpm, lanes, clips };
}
