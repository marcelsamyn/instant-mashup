import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type Analysis, type AudioSource, STEMS, type StemLevels, type Track, thumbnailUrl } from "../shared/types";
import { run } from "./run";
import { downloadAudio } from "./youtube";

const ROOT = path.join(import.meta.dir, "..");
const DATA_DIR = path.join(ROOT, "data");
const ANALYZE = ["uv", "run", "--script", path.join(ROOT, "analysis", "analyze.py")];
const DEMUCS = [
  "uv", "run", "--python", "3.11", "--with", "demucs==4.1.0", "--with", "soundfile",
  "python", "-m", "demucs", "-n", "htdemucs",
  "-d", process.platform === "darwin" && process.arch === "arm64" ? "mps" : "cpu",
];

const tracks = new Map<string, Track>();
const trackDir = (id: string): string => path.join(DATA_DIR, id);

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
  return save(track);
}

/** Demucs saturates the GPU; separate one song at a time. */
let separationQueue: Promise<unknown> = Promise.resolve();
function enqueueSeparation<T>(job: () => Promise<T>): Promise<T> {
  const next = separationQueue.then(job, job);
  separationQueue = next.catch(() => undefined);
  return next;
}

async function separate(id: string): Promise<void> {
  const dir = trackDir(id);
  const tmp = path.join(dir, "stems.tmp");
  await rm(tmp, { recursive: true, force: true });
  await run([...DEMUCS, "-o", tmp, "--filename", "{stem}.{ext}", path.join(dir, "source.wav")]);
  await rm(path.join(dir, "stems"), { recursive: true, force: true });
  await rename(path.join(tmp, "htdemucs"), path.join(dir, "stems"));
  await rm(tmp, { recursive: true, force: true });
}

const sourcePath = (id: string): string => path.join(trackDir(id), "source.wav");
const stemPath = (id: string, stem: string): string => path.join(trackDir(id), "stems", `${stem}.wav`);

async function stemsOnDisk(id: string): Promise<boolean> {
  const found = await Promise.all(STEMS.map((s) => Bun.file(stemPath(id, s)).exists()));
  return found.every(Boolean);
}

/** Tracks with a pipeline run in flight, so a repair never starts a second one. */
const active = new Set<string>();

/**
 * Runs whatever pipeline steps a track is missing, judged by the files on disk: download,
 * analysis, stem separation, stem levels. Also how a track heals when its audio was deleted or
 * not copied along with the rest of its folder.
 */
async function processTrack(track: Track): Promise<void> {
  if (active.has(track.id)) return;
  active.add(track.id);
  const dir = trackDir(track.id);
  try {
    if (!(await Bun.file(sourcePath(track.id)).exists())) {
      await update(track, { status: "downloading", error: null });
      const info = await downloadAudio(track.id, dir);
      await update(track, info);
    }
    if (!track.analysis) {
      await update(track, { status: "analyzing", error: null });
      const out = await run([...ANALYZE, "track", path.join(dir, "source.wav")]);
      await writeAtomic(path.join(dir, "analysis.json"), out);
      track.analysis = JSON.parse(out) as Analysis;
    }
    if (!(await stemsOnDisk(track.id))) {
      // Stem levels describe stems that are gone; drop them so clients play the full mix meanwhile.
      track.stemLevels = null;
    }
    if (!track.stemLevels) {
      await update(track, { status: "separating", error: null });
      if (!(await stemsOnDisk(track.id))) {
        await enqueueSeparation(() => separate(track.id));
      }
      const out = await run([...ANALYZE, "stems", path.join(dir, "analysis.json"), path.join(dir, "stems")]);
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
  await mkdir(DATA_DIR, { recursive: true });
  for (const id of await readdir(DATA_DIR)) {
    try {
      const meta = await readJson<TrackMeta>(path.join(trackDir(id), "track.json"));
      if (!meta) continue;
      const track: Track = {
        ...meta,
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
    analysis: null,
    stemLevels: null,
  };
  tracks.set(id, track);
  await mkdir(trackDir(id), { recursive: true });
  await update(track, { status: "downloading", error: null });
  void processTrack(track);
  return track;
}

const renders = new Map<string, Promise<string>>();

/**
 * Path to a WAV of `source` played `rate` times faster and shifted by `semitones`, keeping pitch
 * independent from tempo. Renders are cached on disk.
 */
export function audioFileExists(id: string, source: AudioSource): Promise<boolean> {
  return Bun.file(source === "mix" ? sourcePath(id) : stemPath(id, source)).exists();
}

export function renderAudio(id: string, source: AudioSource, rate: number, semitones: number): Promise<string> {
  const dir = trackDir(id);
  const input = source === "mix" ? sourcePath(id) : stemPath(id, source);
  if (rate === 1 && semitones === 0) return Promise.resolve(input);
  const output = path.join(dir, "render", `${source}_r${rate.toFixed(5)}_s${semitones}.wav`);
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
    await run(["ffmpeg", "-v", "error", "-y", "-i", input, "-af", filter, "-c:a", "pcm_s16le", tmp]);
    await rename(tmp, output);
    return output;
  })().finally(() => renders.delete(output));
  renders.set(output, job);
  return job;
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
