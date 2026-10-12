import type { Stem, Track } from "../shared/types";

export const STEM_UI: Record<Stem, { short: string; label: string; color: string }> = {
  vocals: { short: "V", label: "Vocals", color: "var(--stem-vocals)" },
  drums: { short: "D", label: "Drums", color: "var(--stem-drums)" },
  bass: { short: "B", label: "Bass", color: "var(--stem-bass)" },
  other: { short: "I", label: "Instruments", color: "var(--stem-other)" },
};

/** Cool blue for calm sections through amber to hot red for the loudest. */
export function energyColor(energy: number, alpha = 1): string {
  const hue = 225 - 215 * Math.min(1, Math.max(0, energy));
  return `hsl(${hue} 80% 58% / ${alpha})`;
}

/** Strips the "(Official Video)" and "| Lyrics" noise YouTube titles carry. */
export function shortTitle(track: Pick<Track, "title">): string {
  return track.title
    .replace(/\s*[([](official|lyrics?|audio|video|hd|hq|music video|visuali[sz]er)[^)\]]*[)\]]/gi, "")
    .replace(/\s*\|.*$/, "")
    .trim();
}

export const SECTION_DRAG_TYPE = "application/x-mashup-section";

export interface SectionDrag {
  trackId: string;
  startBar: number;
  bars: number;
}

export function parseSectionDrag(data: string): SectionDrag | null {
  try {
    const value: unknown = JSON.parse(data);
    if (
      typeof value === "object" &&
      value !== null &&
      "trackId" in value &&
      typeof value.trackId === "string" &&
      "startBar" in value &&
      typeof value.startBar === "number" &&
      "bars" in value &&
      typeof value.bars === "number"
    ) {
      return { trackId: value.trackId, startBar: value.startBar, bars: value.bars };
    }
  } catch {
    // Not our payload; ignore the drop.
  }
  return null;
}
