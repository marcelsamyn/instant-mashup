import type { Server } from "bun";
import type { GridOverrides } from "../shared/types";
import index from "../web/index.html";
import { accessRequired, hasAccess, login } from "./access";
import { config } from "./config";
import { clientIp, limits, tooMany } from "./limits";
import {
  addTrack,
  audioFileExists,
  getLibraryVersion,
  getTrack,
  isAudioSource,
  listTracks,
  loadTracks,
  needsRender,
  queuedCount,
  renderAudio,
  repairIfMissing,
  isProcessing,
  retuneTrack,
  touchTrack,
} from "./tracks";
import { parseVideoId, searchVideos } from "./youtube";

const badRequest = (message: string): Response => Response.json({ error: message }, { status: 400 });
const notFound = (): Response => Response.json({ error: "Not found" }, { status: 404 });

/** Pages on other sites must not be able to make this server download and process videos. */
function isCrossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true; // "null" and other opaque origins
  }
}

/** Validates a tuner submission against the song's length. */
function parseOverrides(body: unknown, duration: number): GridOverrides | string {
  if (typeof body !== "object" || body === null) return "Expected { bpm, downbeat, key }";
  const { bpm, downbeat, key } = body as Record<string, unknown>;
  if (typeof bpm !== "number" || !(bpm >= 40 && bpm <= 250)) return "bpm must be a number between 40 and 250";
  if (typeof downbeat !== "number" || !(downbeat >= -10 && downbeat <= duration)) return "downbeat must be a time inside the song";
  if (key === null || key === undefined) return { bpm, downbeat, key: null };
  if (typeof key !== "object") return "key must be { tonic, minor } or null";
  const { tonic, minor } = key as Record<string, unknown>;
  if (typeof tonic !== "number" || !Number.isInteger(tonic) || tonic < 0 || tonic > 11 || typeof minor !== "boolean") {
    return "key must be { tonic: 0..11, minor: boolean }";
  }
  return { bpm, downbeat, key: { tonic, minor } };
}

type Handler<R extends Request> = (req: R, server: Server<unknown>) => Response | Promise<Response>;

/** API routes need the access cookie when a password is set. */
function guarded<R extends Request>(handler: Handler<R>): Handler<R> {
  return (req, server) => (hasAccess(req) ? handler(req, server) : accessRequired());
}

/** Re-analysis costs about as much as analysing a new song, so it shares the add limits. */
async function retune(req: Request, server: Server<unknown>, track: Parameters<typeof retuneTrack>[0], overrides: GridOverrides | null): Promise<Response> {
  // Checked before the rate limit, so a refused change does not cost a token.
  if (isProcessing(track.id)) return Response.json({ error: "This song is still processing. Try again when it is ready." }, { status: 409 });
  if (config.maxQueuedSongs > 0 && queuedCount() >= config.maxQueuedSongs) {
    return Response.json({ error: "Busy processing other songs. Try again in a few minutes." }, { status: 503, headers: { "Retry-After": "120" } });
  }
  const wait = limits.addsPerIp.take(clientIp(req, server));
  if (wait) return tooMany(wait, `Too many changes. Try again in ${Math.ceil(wait / 60)} minutes.`);
  retuneTrack(track, overrides);
  return Response.json(track);
}

await loadTracks();

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Every request body here is a small JSON object.
  maxRequestBodySize: 64 * 1024,
  development: Bun.env.NODE_ENV !== "production" && { hmr: true, console: true },
  routes: {
    "/": index,

    "/api/health": { GET: () => Response.json({ ok: true, queued: queuedCount() }) },

    "/api/session": {
      GET: (req) => Response.json({ access: hasAccess(req), passwordRequired: config.accessPassword !== null }),
      async POST(req, server) {
        if (isCrossSite(req)) return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
        const wait = limits.loginsPerIp.take(clientIp(req, server));
        if (wait) return tooMany(wait, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.`);
        const body: unknown = await req.json().catch(() => null);
        const password = typeof body === "object" && body !== null && "password" in body && typeof body.password === "string" ? body.password : "";
        const cookie = login(req, password);
        if (!cookie) return Response.json({ error: "That password is not right" }, { status: 401 });
        return Response.json({ access: true }, { headers: { "Set-Cookie": cookie } });
      },
    },

    "/api/search": {
      GET: guarded(async (req, server) => {
        const query = new URL(req.url).searchParams.get("q")?.trim() ?? "";
        if (!query) return badRequest("Missing search query");
        // A link always means "add this video". A bare id only when it cannot be a word:
        // "Springsteen" is 11 letters, like an id, but should be searched.
        const id = parseVideoId(query);
        if (id && (id !== query || /[\d_-]/.test(id))) return Response.json({ results: [], videoId: id });
        const wait = limits.searchesPerIp.take(clientIp(req, server));
        if (wait) return tooMany(wait, `Searching too fast. Try again in ${wait} seconds.`);
        return Response.json({ results: await searchVideos(query), videoId: null });
      }),
    },

    "/api/tracks": {
      GET: guarded((req) => {
        // The list carries every waveform; clients poll it, so answer "unchanged" without a body.
        const etag = `W/"library-${getLibraryVersion()}"`;
        if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
        return Response.json(listTracks(), { headers: { ETag: etag, "Cache-Control": "no-cache" } });
      }),
      POST: guarded(async (req, server) => {
        if (isCrossSite(req)) return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
        const body: unknown = await req.json().catch(() => null);
        if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
          return badRequest("Expected { url: string }");
        }
        const id = parseVideoId(body.url);
        if (!id) return badRequest("Not a YouTube video URL or id");
        const existing = getTrack(id);
        if (!existing || existing.status === "error") {
          if (config.maxQueuedSongs > 0 && queuedCount() >= config.maxQueuedSongs) {
            return Response.json({ error: "Busy processing other songs. Try again in a few minutes." }, { status: 503, headers: { "Retry-After": "120" } });
          }
          const perIp = limits.addsPerIp.take(clientIp(req, server));
          if (perIp) return tooMany(perIp, `You added a lot of songs. Try again in ${Math.ceil(perIp / 60)} minutes.`);
          const global = limits.addsGlobal.take("all");
          if (global) return tooMany(global, "The daily song limit is reached. Try again tomorrow.");
        }
        const hint = "title" in body && typeof body.title === "string" ? { title: body.title.slice(0, 200) } : undefined;
        return Response.json(await addTrack(id, hint));
      }),
    },

    "/api/tracks/:id": {
      GET: guarded((req) => {
        const track = getTrack(req.params.id);
        return track ? Response.json(track) : notFound();
      }),
    },

    "/api/tracks/:id/grid": {
      // Hand-made tempo, downbeat and key corrections; the analysis re-runs with them.
      PUT: guarded(async (req, server) => {
        if (isCrossSite(req)) return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
        const track = getTrack(req.params.id);
        if (!track?.analysis) return notFound();
        const overrides = parseOverrides(await req.json().catch(() => null), track.analysis.duration);
        if (typeof overrides === "string") return badRequest(overrides);
        return retune(req, server, track, overrides);
      }),
      DELETE: guarded(async (req, server) => {
        if (isCrossSite(req)) return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
        const track = getTrack(req.params.id);
        if (!track?.analysis) return notFound();
        return retune(req, server, track, null);
      }),
    },

    "/api/tracks/:id/audio/:source": {
      GET: guarded(async (req, server) => {
        const track = getTrack(req.params.id);
        const { source } = req.params;
        if (!track || !isAudioSource(source)) return notFound();
        if (source !== "mix" && !track.stemLevels) return badRequest("Stems are not ready yet");
        const params = new URL(req.url).searchParams;
        const rate = Number(params.get("rate") ?? "1");
        const semitones = Number(params.get("semitones") ?? "0");
        if (!(rate >= 0.4 && rate <= 2.5)) return badRequest("rate must be between 0.4 and 2.5");
        if (!Number.isInteger(semitones) || Math.abs(semitones) > 6) return badRequest("semitones must be an integer in -6..6");
        if (!(await audioFileExists(track.id, source))) {
          // Only finished songs get repaired here; a failed song is retried by adding it again,
          // which goes through the add limits and the queue cap.
          if (track.status !== "ready") return Response.json({ error: "This song's audio is not ready" }, { status: 409 });
          await repairIfMissing(track);
          return Response.json({ error: "This song's audio is missing; it is being restored" }, { status: 409 });
        }
        if (await needsRender(track.id, source, rate, semitones)) {
          const wait = limits.rendersPerIp.take(clientIp(req, server));
          if (wait) return tooMany(wait, `Too many tempo or pitch changes. Try again in ${Math.ceil(wait / 60)} minutes.`);
        }
        const file = await renderAudio(track.id, source, rate, semitones);
        await touchTrack(track.id);
        return new Response(Bun.file(file), {
          headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=31536000, immutable" },
        });
      }),
    },
  },
  error(err) {
    // Details (tool output, paths) go to the log, not to the browser.
    console.error(JSON.stringify({ event: "request_failed", message: err.message, stack: err.stack }));
    return Response.json({ error: "Something went wrong on the server. Try again." }, { status: 500 });
  },
});

console.log(`Instant Mashup running at ${server.url}`);
