import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { musicalKey } from "../shared/keys";
import { type Analysis, type AudioSource, type GridOverrides, STEMS, type StemLevels, type Track, thumbnailUrl } from "../shared/types";
import { config } from "./config";
import { concurrency } from "./limits";
import { run } from "./run";
import { downloadAudio } from "./youtube";

const tracks = new Map<string, Track>();
const trackDir = (id: string): string => path.join(config.dataDir, id);
const sourcePath = (id: string): string => path.join(trackDir(id), "source.wav");
const stemPath = (id: string, stem: string): string => path.join(trackDir(id), "stems", `${stem}.wav`);
const overridesPath = (id: string): string => path.join(trackDir(id), "overrides.json");

const downloadSlot = concurrency(config.parallelDownloads);
const analysisSlot = concurrency(config.parallelAnalyses);
/** Demucs saturates the GPU or every CPU core it gets; separate one song at a time. */
const separationSlot = concurrency(1);
const renderSlot = concurrency(config.parallelRenders);

/** Bumped on every library change; clients poll with it as an ETag and usually get a cheap 304. */
let libraryVersion = 0;
export const getLibraryVersion = (): number => libraryVersion;

/** Saved metadata only; analysis and stem levels live in their own files. */
type TrackMeta = Omit<Track, "analysis" | "stemLevels">;

async function readJson<T>(file: string): Promise<T | null> {
  const f = Bun.file(file);
  return (await f.exists()) ? ((await f.json()) as T) : null;
}

/** Write-then-rename, so a crash mid-write never leaves a half-written file behind. */
async function writeAtomic(file: string, data: string): Promise<void> {
  await Bun.write(`${file}.tmp`, data);
  await rename(`${file}.tmp`, file);
}

async function save(track: Track): Promise<void> {
  const { analysis: _a, stemLevels: _s, ...meta } = track;
  await writeAtomic(path.join(trackDir(track.id), "track.json"), JSON.stringify(meta satisfies TrackMeta, null, 2));
}

function update(track: Track, patch: Partial<Track>): Promise<void> {
  Object.assign(track, patch);
  libraryVersion++;
  return save(track);
}

async function separate(id: string): Promise<void> {
  const dir = trackDir(id);
  const tmp = path.join(dir, "stems.tmp");
  await rm(tmp, { recursive: true, force: true });
  await run([...config.tools.demucs, "-o", tmp, "--filename", "{stem}.{ext}", sourcePath(id)]);
  await rm(path.join(dir, "stems"), { recursive: true, force: true });
  await rename(path.join(tmp, "htdemucs"), path.join(dir, "stems"));
  await rm(tmp, { recursive: true, force: true });
}

async function stemsOnDisk(id: string): Promise<boolean> {
  const found = await Promise.all(STEMS.map((s) => Bun.file(stemPath(id, s)).exists()));
  return found.every(Boolean);
}

/** Tracks with a pipeline run in flight, so a repair never starts a second one. */
const active = new Set<string>();

const analysisPath = (id: string): string => path.join(trackDir(id), "analysis.json");
const levelsPath = (id: string): string => path.join(trackDir(id), "stems.json");
const mtime = (file: string): Promise<number> => stat(file).then((s) => s.mtimeMs, () => 0);

/**
 * The analysis no longer matches the hand-made corrections on disk: they were added or changed
 * after it was written, or removed while it still carries them. Judged from files, so a re-tune
 * interrupted by a restart still completes.
 */
async function analysisOutdated(track: Track): Promise<boolean> {
  if (!track.analysis) return true;
  const overridesAt = await mtime(overridesPath(track.id));
  if (overridesAt === 0) return track.analysis.tuned === true;
  return overridesAt > (await mtime(analysisPath(track.id)));
}

/** Runs the analysis, applying any hand-made grid and key corrections. */
async function analyse(id: string): Promise<Analysis> {
  const overrides = await readJson<GridOverrides>(overridesPath(id));
  const grid = overrides ? ["--bpm", String(overrides.bpm), "--downbeat", String(overrides.downbeat)] : [];
  const out = await analysisSlot(() => run([...config.tools.analyze, "track", sourcePath(id), ...grid]));
  const analysis = JSON.parse(out) as Analysis;
  if (overrides?.key) analysis.key = musicalKey(overrides.key.tonic, overrides.key.minor);
  analysis.tuned = overrides !== null;
  return analysis;
}

/**
 * Runs whatever pipeline steps a track is missing, judged by the files on disk: download,
 * analysis, stem separation, stem levels. Also how a track heals when its audio was deleted or
 * not copied along with the rest of its folder.
 */
async function processTrack(track: Track, prepare?: () => Promise<void>): Promise<void> {
  // Claimed before the first await, so concurrent callers see the song as busy.
  if (active.has(track.id)) return;
  active.add(track.id);
  const dir = trackDir(track.id);
  try {
    await prepare?.();
    if (!(await Bun.file(sourcePath(track.id)).exists())) {
      await update(track, { status: "downloading", error: null });
      const info = await downloadSlot(() => downloadAudio(track.id, dir));
      await update(track, info);
    }
    if (await analysisOutdated(track)) {
      // A re-tune keeps the old analysis on screen until the new one is ready.
      await update(track, { status: "analyzing", error: null });
      const analysis = await analyse(track.id);
      await writeAtomic(analysisPath(track.id), JSON.stringify(analysis));
      track.analysis = analysis;
    }
    if (!(await stemsOnDisk(track.id))) {
      // Stem levels describe stems that are gone; drop them so clients play the full mix meanwhile.
      track.stemLevels = null;
    }
    // Stem levels are measured per bar, so a new grid needs them measured again. The old levels
    // stay in use meanwhile, so the song keeps playing from its stems.
    const levelsOutdated = (await mtime(levelsPath(track.id))) < (await mtime(analysisPath(track.id)));
    if (!track.stemLevels || levelsOutdated) {
      if (!track.stemLevels) await update(track, { status: "separating", error: null });
      if (!(await stemsOnDisk(track.id))) await separationSlot(() => separate(track.id));
      const out = await run([...config.tools.analyze, "stems", path.join(dir, "analysis.json"), path.join(dir, "stems")]);
      await writeAtomic(path.join(dir, "stems.json"), out);
      track.stemLevels = JSON.parse(out) as StemLevels;
    }
    await update(track, { status: "ready", error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "track_failed", id: track.id, status: track.status, message }));
    await update(track, { status: "error", error: message });
  } finally {
    active.delete(track.id);
  }
  await enforceDiskBudget(track.id);
}

/** Starts a repair when any of a track's files are missing. Returns true when it did. */
export async function repairIfMissing(track: Track): Promise<boolean> {
  if (active.has(track.id)) return true;
  const complete =
    track.analysis !== null &&
    track.stemLevels !== null &&
    (await Bun.file(sourcePath(track.id)).exists()) &&
    (await stemsOnDisk(track.id));
  if (complete) return false;
  console.info(JSON.stringify({ event: "track_repair", id: track.id }));
  void processTrack(track);
  return true;
}

export async function loadTracks(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  for (const id of await readdir(config.dataDir)) {
    try {
      const meta = await readJson<TrackMeta>(path.join(trackDir(id), "track.json"));
      if (!meta) continue;
      const track: Track = {
        ...meta,
        addedAt: meta.addedAt ?? (await stat(trackDir(id))).birthtimeMs,
        analysis: await readJson<Analysis>(path.join(trackDir(id), "analysis.json")),
        stemLevels: await readJson<StemLevels>(path.join(trackDir(id), "stems.json")),
      };
      tracks.set(id, track);
      if (track.status !== "ready" && track.status !== "error") void processTrack(track);
      else if (track.status === "ready") await repairIfMissing(track);
    } catch (err) {
      // One damaged track must not keep the server from starting; skip it and say which.
      console.error(JSON.stringify({ event: "track_load_failed", id, message: err instanceof Error ? err.message : String(err) }));
    }
  }
}

export function listTracks(): Track[] {
  return [...tracks.values()];
}

export function getTrack(id: string): Track | undefined {
  return tracks.get(id);
}

/** Songs still downloading, analysing or splitting. */
export function queuedCount(): number {
  return active.size;
}

/** Adds a video to the library and starts processing. Retries a track that failed before. */
export async function addTrack(id: string, hint?: { title?: string; channel?: string }): Promise<Track> {
  const existing = tracks.get(id);
  if (existing && existing.status !== "error") return existing;
  const track: Track = existing ?? {
    id,
    title: hint?.title ?? id,
    channel: hint?.channel ?? "",
    duration: 0,
    thumbnail: thumbnailUrl(id),
    status: "downloading",
    error: null,
    addedAt: Date.now(),
    analysis: null,
    stemLevels: null,
  };
  tracks.set(id, track);
  await mkdir(trackDir(id), { recursive: true });
  await update(track, { status: "downloading", error: null });
  void processTrack(track);
  return track;
}

export class TrackBusyError extends Error {}

/**
 * Saves hand-made grid and key corrections (null resets to the detected values) and re-runs the
 * analysis and stem levels. Download and stem separation are not repeated.
 */
export function retuneTrack(track: Track, overrides: GridOverrides | null): void {
  if (isProcessing(track.id)) throw new TrackBusyError("This song is still processing. Try again when it is ready.");
  void processTrack(track, () =>
    overrides ? writeAtomic(overridesPath(track.id), JSON.stringify(overrides, null, 2)) : rm(overridesPath(track.id), { force: true }),
  );
}

export const isProcessing = (id: string): boolean => active.has(id);

const lastTouched = new Map<string, number>();

/**
 * Marks a song as used. The folder's modification time is the "last used" clock for the disk
 * budget; it is touched at most once a minute per song.
 */
export async function touchTrack(id: string): Promise<void> {
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) < 60_000) return;
  lastTouched.set(id, now);
  const t = new Date(now);
  await utimes(trackDir(id), t, t);
}

async function folderBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const sizes = await Promise.all(
    entries.filter((e) => e.isFile()).map((e) => stat(path.join(e.parentPath, e.name)).then((s) => s.size, () => 0)),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

/**
 * Keeps the library under MAX_LIBRARY_GB by deleting the least recently used finished songs.
 * Songs in progress and the song that just finished are never deleted.
 */
async function enforceDiskBudget(keepId: string): Promise<void> {
  if (config.maxLibraryGb === 0) return;
  const budget = config.maxLibraryGb * 1024 ** 3;
  const usage = await Promise.all(
    [...tracks.keys()].map(async (id) => ({
      id,
      bytes: await folderBytes(trackDir(id)).catch(() => 0),
      usedAt: await stat(trackDir(id)).then((s) => s.mtimeMs, () => 0),
    })),
  );
  let total = usage.reduce((a, u) => a + u.bytes, 0);
  const candidates = usage.filter((u) => u.id !== keepId && !active.has(u.id)).sort((a, b) => a.usedAt - b.usedAt);
  for (const victim of candidates) {
    if (total <= budget) break;
    tracks.delete(victim.id);
    lastTouched.delete(victim.id);
    await rm(trackDir(victim.id), { recursive: true, force: true });
    total -= victim.bytes;
    libraryVersion++;
    console.info(JSON.stringify({ event: "track_evicted", id: victim.id, freedMb: Math.round(victim.bytes / 1024 ** 2) }));
  }
}

export function audioFileExists(id: string, source: AudioSource): Promise<boolean> {
  return Bun.file(source === "mix" ? sourcePath(id) : stemPath(id, source)).exists();
}

const renderPath = (id: string, source: AudioSource, rate: number, semitones: number): string =>
  path.join(trackDir(id), "render", `${source}_r${rate.toFixed(5)}_s${semitones}.wav`);

/** True when serving this audio means running ffmpeg (not the original file or a cached render). */
export async function needsRender(id: string, source: AudioSource, rate: number, semitones: number): Promise<boolean> {
  if (rate === 1 && semitones === 0) return false;
  return !renders.has(renderPath(id, source, rate, semitones)) && !(await Bun.file(renderPath(id, source, rate, semitones)).exists());
}

const renders = new Map<string, Promise<string>>();

/**
 * Path to a WAV of `source` played `rate` times faster and shifted by `semitones`, keeping pitch
 * independent from tempo. Renders are cached on disk.
 */
export function renderAudio(id: string, source: AudioSource, rate: number, semitones: number): Promise<string> {
  const input = source === "mix" ? sourcePath(id) : stemPath(id, source);
  if (rate === 1 && semitones === 0) return Promise.resolve(input);
  const output = renderPath(id, source, rate, semitones);
  const pending = renders.get(output);
  if (pending) return pending;
  const job = (async () => {
    if (await Bun.file(output).exists()) return output;
    await mkdir(path.dirname(output), { recursive: true });
    // asetrate shifts pitch and tempo together; atempo then corrects the tempo to the target rate.
    const pitch = 2 ** (semitones / 12);
    const tempo = atempoChain(rate / pitch);
    const filter = semitones === 0 ? tempo : `asetrate=${44100 * pitch},aresample=44100,${tempo}`;
    const tmp = `${output}.tmp.wav`;
    await renderSlot(() => run(["ffmpeg", "-v", "error", "-y", "-i", input, "-af", filter, "-c:a", "pcm_s16le", tmp]));
    await rename(tmp, output);
    await pruneRenders(id, output);
    await enforceDiskBudget(id);
    return output;
  })().finally(() => renders.delete(output));
  renders.set(output, job);
  return job;
}

/** Renders kept per song. An arrangement needs at most 5 per lane (4 stems and the mix). */
const MAX_RENDERS_PER_TRACK = 12;

/** Deletes a song's oldest renders beyond MAX_RENDERS_PER_TRACK, never the one just written. */
async function pruneRenders(id: string, keep: string): Promise<void> {
  const dir = path.join(trackDir(id), "render");
  const files = await Promise.all(
    (await readdir(dir)).filter((f) => f.endsWith(".wav") && !f.endsWith(".tmp.wav")).map(async (f) => {
      const file = path.join(dir, f);
      return { file, usedAt: await stat(file).then((s) => s.mtimeMs, () => 0) };
    }),
  );
  const old = files.filter((f) => f.file !== keep && !renders.has(f.file)).sort((a, b) => b.usedAt - a.usedAt);
  for (const f of old.slice(MAX_RENDERS_PER_TRACK - 1)) await rm(f.file, { force: true });
}

/** ffmpeg's atempo takes 0.5..100 per stage; chain stages for bigger slow-downs. */
function atempoChain(factor: number): string {
  const stages: number[] = [];
  let rest = factor;
  while (rest < 0.5) {
    stages.push(0.5);
    rest /= 0.5;
  }
  stages.push(rest);
  return stages.map((f) => `atempo=${f}`).join(",");
}

export function isAudioSource(value: string): value is AudioSource {
  return value === "mix" || (STEMS as readonly string[]).includes(value);
}
