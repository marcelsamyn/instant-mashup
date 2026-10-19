import type { Track } from "../shared/types";
import { type Match, matchSongs } from "./match";
import { shortTitle } from "./ui";

export type CrateSort = "added" | "title" | "tempo" | "key" | "length" | "match";

export const CRATE_SORTS: { value: CrateSort; label: string }[] = [
  { value: "added", label: "Recently added" },
  { value: "title", label: "Title" },
  { value: "tempo", label: "Tempo" },
  { value: "key", label: "Key (Camelot)" },
  { value: "length", label: "Length" },
  { value: "match", label: "Best match" },
];

export interface CrateView {
  /** Filter text; every word must appear in the title or channel. */
  query: string;
  sort: CrateSort;
  /** Song the others are matched against, or null. */
  referenceId: string | null;
  goodMatchesOnly: boolean;
}

export interface CrateEntry {
  track: Track;
  /** Fit against the reference song; null without a reference, for the reference itself, or before analysis. */
  match: Match | null;
}

const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function camelotOrder(track: Track): number {
  const key = track.analysis?.key;
  if (!key) return Number.POSITIVE_INFINITY;
  const number = Number.parseInt(key.camelot, 10);
  return number * 2 + (key.camelot.endsWith("B") ? 1 : 0);
}

const missingLast = (value: number | undefined): number => value ?? Number.POSITIVE_INFINITY;

const COMPARE: Record<CrateSort, (a: CrateEntry, b: CrateEntry) => number> = {
  added: (a, b) => b.track.addedAt - a.track.addedAt,
  title: (a, b) => shortTitle(a.track).localeCompare(shortTitle(b.track)),
  tempo: (a, b) => missingLast(a.track.analysis?.bpm) - missingLast(b.track.analysis?.bpm),
  key: (a, b) => camelotOrder(a.track) - camelotOrder(b.track),
  length: (a, b) => missingLast(a.track.analysis?.duration) - missingLast(b.track.analysis?.duration),
  match: (a, b) => missingLast(a.match?.score) - missingLast(b.match?.score),
};

/** The library as the crate shows it: filtered, matched against the reference, sorted. */
export function arrangeCrate(tracks: Track[], view: CrateView): CrateEntry[] {
  const words = fold(view.query).split(/\s+/).filter(Boolean);
  const reference = tracks.find((t) => t.id === view.referenceId)?.analysis ?? null;
  const entries = tracks
    .filter((t) => {
      const haystack = fold(`${t.title} ${t.channel}`);
      return words.every((w) => haystack.includes(w));
    })
    .map((track) => ({
      track,
      match: reference && track.analysis && track.id !== view.referenceId ? matchSongs(reference, track.analysis) : null,
    }))
    .filter((e) => !reference || !view.goodMatchesOnly || e.track.id === view.referenceId || e.match?.good);
  const sorted = [...entries].sort((a, b) => COMPARE[view.sort](a, b) || b.track.addedAt - a.track.addedAt);
  // The reference stays on top so the list reads "this song, then what fits it".
  if (!reference) return sorted;
  return [...sorted.filter((e) => e.track.id === view.referenceId), ...sorted.filter((e) => e.track.id !== view.referenceId)];
}
