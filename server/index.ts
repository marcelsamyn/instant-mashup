import index from "../web/index.html";
import { addTrack, audioFileExists, getTrack, isAudioSource, listTracks, loadTracks, renderAudio, repairIfMissing } from "./tracks";
import { parseVideoId, searchVideos } from "./youtube";

const badRequest = (message: string): Response => Response.json({ error: message }, { status: 400 });
const notFound = (): Response => Response.json({ error: "Not found" }, { status: 404 });

await loadTracks();

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

const server = Bun.serve({
  // Local tool: listen on loopback only unless HOST says otherwise.
  hostname: Bun.env.HOST ?? "127.0.0.1",
  port: Number(Bun.env.PORT ?? 5180),
  development: Bun.env.NODE_ENV !== "production" && { hmr: true, console: true },
  routes: {
    "/": index,

    "/api/search": {
      async GET(req) {
        const query = new URL(req.url).searchParams.get("q")?.trim() ?? "";
        if (!query) return badRequest("Missing search query");
        // A link always means "add this video". A bare id only when it cannot be a word:
        // "Springsteen" is 11 letters, like an id, but should be searched.
        const id = parseVideoId(query);
        if (id && (id !== query || /[\d_-]/.test(id))) return Response.json({ results: [], videoId: id });
        return Response.json({ results: await searchVideos(query), videoId: null });
      },
    },

    "/api/tracks": {
      GET: () => Response.json(listTracks()),
      async POST(req) {
        if (isCrossSite(req)) return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
        const body: unknown = await req.json();
        if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
          return badRequest("Expected { url: string }");
        }
        const id = parseVideoId(body.url);
        if (!id) return badRequest("Not a YouTube video URL or id");
        const hint = "title" in body && typeof body.title === "string" ? { title: body.title } : undefined;
        return Response.json(await addTrack(id, hint));
      },
    },

    "/api/tracks/:id": {
      GET: (req) => {
        const track = getTrack(req.params.id);
        return track ? Response.json(track) : notFound();
      },
    },

    "/api/tracks/:id/audio/:source": {
      async GET(req) {
        const track = getTrack(req.params.id);
        const { source } = req.params;
        if (!track || !isAudioSource(source)) return notFound();
        if (source !== "mix" && !track.stemLevels) return badRequest("Stems are not ready yet");
        const params = new URL(req.url).searchParams;
        const rate = Number(params.get("rate") ?? "1");
        const semitones = Number(params.get("semitones") ?? "0");
        if (!(rate >= 0.25 && rate <= 4)) return badRequest("rate must be between 0.25 and 4");
        if (!Number.isInteger(semitones) || Math.abs(semitones) > 6) return badRequest("semitones must be an integer in -6..6");
        if (!(await audioFileExists(track.id, source))) {
          await repairIfMissing(track);
          return Response.json({ error: "This song's audio is missing; it is being restored" }, { status: 409 });
        }
        const file = await renderAudio(track.id, source, rate, semitones);
        return new Response(Bun.file(file), {
          headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=31536000, immutable" },
        });
      },
    },
  },
  error(err) {
    console.error(JSON.stringify({ event: "request_failed", message: err.message }));
    return Response.json({ error: err.message }, { status: 500 });
  },
});

console.log(`Instant Mashup running at ${server.url}`);
