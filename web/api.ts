import type { GridOverrides, SearchResult, Track } from "../shared/types";

/** A failed API call. `status` 401 means the server wants the access password. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : res.statusText;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const fetchTracks = (): Promise<Track[]> => request("/api/tracks");

export const searchVideos = (q: string): Promise<{ results: SearchResult[]; videoId: string | null }> =>
  request(`/api/search?q=${encodeURIComponent(q)}`);

export const addTrack = (url: string, title?: string): Promise<Track> => request("/api/tracks", json({ url, title }));

/** Saves hand-made grid and key corrections, or resets to the detected ones with null. */
export const retune = (id: string, overrides: GridOverrides | null): Promise<Track> =>
  request(`/api/tracks/${id}/grid`, overrides ? { ...json(overrides), method: "PUT" } : { method: "DELETE" });

export const unlock = (password: string): Promise<{ access: boolean }> => request("/api/session", json({ password }));
