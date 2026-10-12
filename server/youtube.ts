import { type SearchResult, thumbnailUrl } from "../shared/types";
import { run } from "./run";

// The Homebrew yt-dlp goes stale quickly and YouTube then answers 403; run a pinned recent release.
const YT_DLP = ["uvx", "--from", "yt-dlp[default]==2026.08.19", "yt-dlp", "--no-update", "--js-runtimes", "node"];
const MAX_DURATION_SEC = 15 * 60;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Accepts a bare video id or any common YouTube URL form. Returns null when it is neither. */
export function parseVideoId(input: string): string | null {
  const text = input.trim();
  if (VIDEO_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const candidate =
    host === "youtu.be"
      ? url.pathname.slice(1)
      : host === "youtube.com"
        ? (url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ?? "")
        : "";
  return VIDEO_ID.test(candidate) ? candidate : null;
}

interface FlatEntry {
  id?: unknown;
  title?: unknown;
  channel?: unknown;
  uploader?: unknown;
  duration?: unknown;
}

export async function searchVideos(query: string): Promise<SearchResult[]> {
  const out = await run([...YT_DLP, `ytsearch12:${query}`, "--flat-playlist", "-J"]);
  const entries: FlatEntry[] = JSON.parse(out).entries ?? [];
  return entries.flatMap((e) => {
    if (typeof e.id !== "string" || !VIDEO_ID.test(e.id)) return [];
    const duration = typeof e.duration === "number" ? e.duration : 0;
    if (duration === 0 || duration > MAX_DURATION_SEC) return [];
    return [
      {
        id: e.id,
        title: typeof e.title === "string" ? e.title : e.id,
        channel: typeof e.channel === "string" ? e.channel : typeof e.uploader === "string" ? e.uploader : "",
        duration,
        thumbnail: thumbnailUrl(e.id),
      },
    ];
  });
}

export interface VideoInfo {
  title: string;
  channel: string;
  duration: number;
}

/** Downloads the audio as 44.1 kHz stereo WAV to `<dir>/source.wav`. */
export async function downloadAudio(id: string, dir: string): Promise<VideoInfo> {
  await run([
    ...YT_DLP,
    "--no-playlist",
    "--match-filter",
    `duration <= ${MAX_DURATION_SEC}`,
    "-f",
    "bestaudio/best",
    "-x",
    "--audio-format",
    "wav",
    "--postprocessor-args",
    "ExtractAudio:-ar 44100 -ac 2",
    "--write-info-json",
    "-o",
    `${dir}/source.%(ext)s`,
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  if (!(await Bun.file(`${dir}/source.wav`).exists())) {
    throw new Error(`No audio downloaded. The video may be longer than ${MAX_DURATION_SEC / 60} minutes or unavailable.`);
  }
  const info: FlatEntry = await Bun.file(`${dir}/source.info.json`).json();
  return {
    title: typeof info.title === "string" ? info.title : id,
    channel: typeof info.channel === "string" ? info.channel : typeof info.uploader === "string" ? info.uploader : "",
    duration: typeof info.duration === "number" ? info.duration : 0,
  };
}
