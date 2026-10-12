import type { SearchResult, Track } from "../shared/types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body: unknown = await res.json();
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : res.statusText;
    throw new Error(message);
  }
  return body as T;
}

export const fetchTracks = (): Promise<Track[]> => request("/api/tracks");

export const searchVideos = (q: string): Promise<{ results: SearchResult[]; videoId: string | null }> =>
  request(`/api/search?q=${encodeURIComponent(q)}`);

export const addTrack = (url: string, title?: string): Promise<Track> =>
  request("/api/tracks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, title }) });
