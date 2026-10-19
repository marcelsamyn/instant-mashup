import type { MusicalKey } from "./types";

export const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;

// Camelot number for each major tonic (pitch class); minor keys use their relative major's number.
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1] as const;

export function camelot(tonic: number, minor: boolean): { number: number; letter: "A" | "B" } {
  const majorTonic = (((minor ? tonic + 3 : tonic) % 12) + 12) % 12;
  return { number: CAMELOT_MAJOR[majorTonic] ?? 8, letter: minor ? "A" : "B" };
}

/** A key set by hand, in the same shape the analysis produces. */
export function musicalKey(tonic: number, minor: boolean): MusicalKey {
  const c = camelot(tonic, minor);
  return { name: `${NOTE_NAMES[tonic] ?? "C"}${minor ? "m" : ""}`, camelot: `${c.number}${c.letter}`, tonic, minor, confidence: 1 };
}
