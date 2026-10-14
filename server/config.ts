import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

/** Non-negative number from the environment. Fails startup loudly on a typo instead of running unprotected. */
function num(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return value;
}

/** Python tools. A container ships them preinstalled in one venv; local development lets uv fetch them. */
function tools(): { analyze: string[]; demucs: string[]; ytDlp: string[] } {
  const analyzeScript = path.join(ROOT, "analysis", "analyze.py");
  const venv = Bun.env.PYTHON_VENV;
  if (venv) {
    const python = path.join(venv, "bin", "python");
    return {
      analyze: [python, analyzeScript],
      demucs: [python, "-m", "demucs", "-n", "htdemucs", "-d", "cpu"],
      ytDlp: [path.join(venv, "bin", "yt-dlp"), "--no-update"],
    };
  }
  return {
    analyze: ["uv", "run", "--script", analyzeScript],
    demucs: [
      "uv", "run", "--python", "3.11", "--with", "demucs==4.1.0", "--with", "soundfile",
      "python", "-m", "demucs", "-n", "htdemucs",
      "-d", process.platform === "darwin" && process.arch === "arm64" ? "mps" : "cpu",
    ],
    // The Homebrew yt-dlp goes stale quickly and YouTube then answers 403; run a pinned recent release.
    ytDlp: ["uvx", "--from", "yt-dlp[default]==2026.08.19", "yt-dlp", "--no-update"],
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Every setting comes from the environment; 0 turns a limit off. */
export const config = {
  host: Bun.env.HOST ?? "127.0.0.1",
  port: num("PORT", 5180),
  dataDir: Bun.env.DATA_DIR ?? path.join(ROOT, "data"),
  tools: tools(),

  /** Shared password for friends. Unset = open (fine on localhost, not on the internet). */
  accessPassword: Bun.env.ACCESS_PASSWORD || null,
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy in front of the app. */
  trustProxy: Bun.env.TRUST_PROXY === "1",

  maxSongMinutes: num("MAX_SONG_MINUTES", 10),
  /** Disk budget for downloaded songs, stems and renders. Least recently used songs are deleted past it. */
  maxLibraryGb: num("MAX_LIBRARY_GB", 20),
  /** Songs waiting to download, analyse or split; adds beyond it are refused until the queue drains. */
  maxQueuedSongs: num("MAX_QUEUED_SONGS", 6),

  addsPerHourPerIp: num("ADDS_PER_HOUR_PER_IP", 10),
  addsPerDay: num("ADDS_PER_DAY", 100),
  searchesPerMinutePerIp: num("SEARCHES_PER_MINUTE_PER_IP", 20),
  rendersPerHourPerIp: num("RENDERS_PER_HOUR_PER_IP", 60),
  loginAttemptsPer15MinPerIp: num("LOGIN_ATTEMPTS_PER_15_MIN_PER_IP", 10),

  /** Heavy jobs that may run at the same time. Stem separation always runs one at a time. */
  parallelDownloads: Math.max(1, num("PARALLEL_DOWNLOADS", 2)),
  parallelAnalyses: Math.max(1, num("PARALLEL_ANALYSES", 1)),
  parallelRenders: Math.max(1, num("PARALLEL_RENDERS", 2)),
  parallelSearches: Math.max(1, num("PARALLEL_SEARCHES", 2)),
} as const;

// An open server on a public interface is never what anyone wants; ALLOW_OPEN=1 is the explicit opt-out.
if (!config.accessPassword && !LOOPBACK.has(config.host) && Bun.env.ALLOW_OPEN !== "1") {
  throw new Error(`Refusing to listen on ${config.host} without ACCESS_PASSWORD. Set a password, or ALLOW_OPEN=1 to run open.`);
}
