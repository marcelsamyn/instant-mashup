export const STEMS = ["vocals", "drums", "bass", "other"] as const;
export type Stem = (typeof STEMS)[number];
/** "mix" is the full song; stems exist only after separation finishes. */
export type AudioSource = Stem | "mix";

export type SectionLabel = "Intro" | "Verse" | "Build" | "Chorus" | "Breakdown" | "Outro";

export interface Section {
  startBar: number;
  bars: number;
  /** Seconds in the original audio. The first section can start before 0 (pickup). */
  start: number;
  end: number;
  /** 0..1, relative to the rest of the same song. */
  energy: number;
  label: SectionLabel;
  /** Sections with the same letter sound alike (repeated chorus, verse, ...). */
  group: string;
}

export interface MusicalKey {
  name: string;
  camelot: string;
  tonic: number;
  minor: boolean;
  confidence: number;
}

export interface Analysis {
  duration: number;
  bpm: number;
  beatSec: number;
  /** Start time of bar 0 in seconds; bars are 4 beats on a constant grid from here. */
  downbeat: number;
  barCount: number;
  key: MusicalKey;
  sections: Section[];
  barEnergy: number[];
  waveform: { rate: number; low: number[]; mid: number[]; high: number[] };
}

/** RMS level of each stem per bar, in dBFS. */
export type StemLevels = Record<Stem, number[]>;

export type TrackStatus = "downloading" | "analyzing" | "separating" | "ready" | "error";

export interface Track {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
  status: TrackStatus;
  error: string | null;
  analysis: Analysis | null;
  stemLevels: StemLevels | null;
}

export interface SearchResult {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
}

export function thumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}
