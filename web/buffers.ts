import type { AudioSource, Track } from "../shared/types";
import { type Project, isPlayable, laneRate, laneSources } from "./project";

export interface BufferNeed {
  trackId: string;
  source: AudioSource;
  rate: number;
  semitones: number;
}

/** Buffers a caller loaded for one arrangement. Holding it keeps them alive even if the cache drops them. */
export type BufferLookup = (need: BufferNeed) => AudioBuffer | undefined;

const keyOf = (n: BufferNeed): string => `${n.trackId}|${n.source}|${n.rate.toFixed(5)}|${n.semitones}`;

/** Every decoded buffer the current arrangement plays. */
export function bufferNeeds(project: Project, tracks: Map<string, Track>): BufferNeed[] {
  return project.lanes.flatMap((lane) => {
    const track = tracks.get(lane.trackId);
    if (!track?.analysis || !isPlayable(track)) return [];
    const rate = laneRate(project.masterBpm, lane, track.analysis);
    const clips = project.clips.filter((c) => c.laneId === lane.id);
    return laneSources(track, clips).map((source) => ({ trackId: track.id, source, rate, semitones: lane.semitones }));
  });
}

/**
 * Decoded, time-stretched audio keyed by track, source, rate and pitch. The server does the
 * stretching so pitch stays put; buffers that the arrangement no longer needs are dropped to
 * keep memory in check (a decoded 5-minute stem is about 100 MB).
 */
export class BufferStore {
  private readonly entries = new Map<string, Promise<AudioBuffer>>();

  constructor(private readonly ctx: BaseAudioContext) {}

  /** Loads what `needs` lists and drops cached buffers it does not list. */
  async ensure(needs: BufferNeed[], onProgress?: (done: number, total: number) => void): Promise<BufferLookup> {
    const wanted = new Set(needs.map(keyOf));
    for (const key of this.entries.keys()) {
      if (!wanted.has(key)) this.entries.delete(key);
    }
    let done = 0;
    const loaded = await Promise.all(
      needs.map(async (need) => {
        const buffer = await this.load(need);
        onProgress?.(++done, needs.length);
        return [keyOf(need), buffer] as const;
      }),
    );
    const byKey = new Map(loaded);
    return (need) => byKey.get(keyOf(need));
  }

  private load(need: BufferNeed): Promise<AudioBuffer> {
    const key = keyOf(need);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const url = `/api/tracks/${need.trackId}/audio/${need.source}?rate=${need.rate.toFixed(5)}&semitones=${need.semitones}`;
    const promise = fetch(url).then(async (res) => {
      if (!res.ok) {
        // The server explains limits and repairs in an { error } body; show that to the user.
        const body: unknown = await res.json().catch(() => null);
        const reason = typeof body === "object" && body !== null && "error" in body ? String(body.error) : `status ${res.status}`;
        throw new Error(`Could not load ${need.source} audio: ${reason}`);
      }
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    });
    promise.catch(() => {
      if (this.entries.get(key) === promise) this.entries.delete(key);
    });
    this.entries.set(key, promise);
    return promise;
  }
}
