import type { Analysis } from "../shared/types";
import { type BpmFactor, bestBpmFactor, bestKeyShift, keyDistance } from "./project";

/** How well a song fits next to a reference song. */
export interface Match {
  /** Half or double time that brings the tempos closest. */
  factor: BpmFactor;
  /** Stretch needed to reach the reference tempo, in percent (signed). */
  tempoPct: number;
  /** 0 same key, 1 relative or neighbour on the Camelot wheel, higher clashes. */
  keyDistance: number;
  /** Pitch shift (at most 2 semitones) that improves the key fit; 0 when none helps. */
  shift: number;
  keyLabel: string;
  /** Lower is better. */
  score: number;
  /** Stretch within 6% and keys compatible, by pitch shift if needed. */
  good: boolean;
}

const MAX_SHIFT = 2;

export function matchSongs(ref: Analysis, other: Analysis): Match {
  const factor = bestBpmFactor(other.bpm, ref.bpm);
  const tempoPct = (ref.bpm / (other.bpm * factor) - 1) * 100;
  const distance = keyDistance(ref.key, other.key);
  const shift = bestKeyShift(ref.key, other.key, MAX_SHIFT);
  const shiftedDistance = keyDistance(ref.key, other.key, shift);
  // A pitch shift costs a little sound quality, so it ranks below a natural fit.
  const keyCost = Math.min(distance, shiftedDistance + 0.4 * Math.abs(shift));
  return {
    factor,
    tempoPct,
    keyDistance: distance,
    shift: shiftedDistance < distance ? shift : 0,
    keyLabel: keyLabel(ref, other, distance, shiftedDistance < distance ? shift : 0),
    score: Math.abs(tempoPct) / 3 + 1.2 * keyCost + (factor === 1 ? 0 : 0.5),
    good: Math.abs(tempoPct) <= 6 && Math.min(distance, shiftedDistance) <= 1,
  };
}

function keyLabel(ref: Analysis, other: Analysis, distance: number, shift: number): string {
  if (distance === 0) return "same key";
  if (distance === 1) return ref.key.camelot.slice(0, -1) === other.key.camelot.slice(0, -1) ? "relative key" : "next on wheel";
  if (shift !== 0) return `fits at ${shift > 0 ? "+" : ""}${shift} semitone${Math.abs(shift) === 1 ? "" : "s"}`;
  // Two steps (for example 9A next to 10B) can work for a short blend; more clashes.
  return distance === 2 ? "loose fit" : "key clash";
}

export function formatTempoMatch(m: Match): string {
  const sign = m.tempoPct >= 0 ? "+" : "−";
  const half = m.factor === 1 ? "" : m.factor === 2 ? "2× " : "½× ";
  return `${half}${sign}${Math.abs(m.tempoPct).toFixed(1)}%`;
}
