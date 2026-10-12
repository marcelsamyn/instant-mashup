import { type FormEvent, useState } from "react";
import type { SearchResult, Track, TrackStatus } from "../../shared/types";
import { searchVideos } from "../api";
import { TRANSITION_STYLES, type TransitionStyle } from "../mashup";
import { formatTime } from "../project";
import { SECTION_DRAG_TYPE, type SectionDrag, energyColor, shortTitle } from "../ui";

const STATUS_TEXT: Record<TrackStatus, string> = {
  downloading: "Downloading audio",
  analyzing: "Finding beat, key and sections",
  separating: "Splitting vocals, drums, bass, instruments",
  ready: "Ready",
  error: "Failed",
};

interface LibraryProps {
  tracks: Track[];
  queue: string[];
  onAdd: (url: string, title?: string) => Promise<void>;
  onToggleQueue: (id: string) => void;
  onMakeMashup: () => void;
  onMakeMix: (style: TransitionStyle) => void;
}

export function Library({ tracks, queue, onAdd, onToggleQueue, onMakeMashup, onMakeMix }: LibraryProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<TransitionStyle>("blend");
  const ids = new Set(tracks.map((t) => t.id));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const { results: found, videoId } = await searchVideos(q);
      if (videoId) {
        await onAdd(videoId);
        setQuery("");
        setResults([]);
      } else {
        setResults(found);
        if (found.length === 0) setError("No songs found. Try the artist and title.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  const queued = queue.map((id) => tracks.find((t) => t.id === id)).filter((t): t is Track => Boolean(t));
  const allAnalysed = queued.every((t) => t.analysis);
  const allStems = queued.every((t) => t.stemLevels);

  return (
    <aside className="library">
      <form className="search" onSubmit={submit} role="search">
        <span className="engraved">Find songs</span>
        <div className="search-row">
          <input
            className="lcd-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search YouTube or paste a link"
            aria-label="Search YouTube or paste a link"
          />
          <button type="submit" className="hw-btn is-primary" disabled={searching}>
            {searching ? <span className="spinner" aria-label="Searching" /> : "Go"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </form>

      {results.length > 0 && (
        <div className="results">
          <div className="results-head">
            <span className="engraved">Results</span>
            <button type="button" className="text-btn" onClick={() => setResults([])}>
              Close
            </button>
          </div>
          <ul>
            {results.map((r, i) => (
              <li key={r.id} className="result" style={{ animationDelay: `${i * 30}ms` }}>
                <img src={r.thumbnail} alt="" loading="lazy" />
                <div className="result-text">
                  <span className="result-title">{r.title}</span>
                  <span className="result-meta">
                    {r.channel} · {formatTime(r.duration)}
                  </span>
                </div>
                <button type="button" className="hw-btn" disabled={ids.has(r.id)} onClick={() => void onAdd(r.id, r.title)}>
                  {ids.has(r.id) ? "Added" : "Add"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="crate">
        <span className="engraved">Your songs · {tracks.length}</span>
        {tracks.length === 0 && <p className="hint">Search for a song above. Each one is downloaded, analysed and split into stems, which takes about a minute.</p>}
        <ul>
          {tracks.map((t) => (
            <TrackCard key={t.id} track={t} order={queue.indexOf(t.id)} onToggle={() => onToggleQueue(t.id)} onRetry={() => void onAdd(t.id)} />
          ))}
        </ul>
      </div>

      <div className="builder">
        <span className="engraved">Auto mix · {queued.length ? `${queued.length} picked` : "pick songs with the + buttons"}</span>
        {queued.length > 0 && (
          <ol className="builder-list">
            {queued.map((t, i) => (
              <li key={t.id}>
                <span className="order mono">{i + 1}</span>
                <span className="builder-title">{shortTitle(t)}</span>
                <span className="role" title="Role in a mashup. A DJ mix plays the songs in this order.">
                  {i === 0 ? "beat" : "vocals"}
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="builder-actions">
          <button
            type="button"
            className="hw-btn is-primary big"
            disabled={queued.length < 2 || !allStems}
            onClick={onMakeMashup}
            title="Song 1 gives the beat; the others give vocals, matched section by section"
          >
            Make mashup
          </button>
          {queued.length >= 2 && !allStems && <span className="hint">Waiting for stems to finish…</span>}
          <div className="mix-row">
            <select className="hw-select" value={style} onChange={(e) => setStyle(e.target.value as TransitionStyle)} aria-label="Transition style">
              {TRANSITION_STYLES.map((s) => (
                <option key={s.value} value={s.value} title={s.hint}>
                  {s.label}
                </option>
              ))}
            </select>
            <button type="button" className="hw-btn big" disabled={queued.length < 2 || !allAnalysed} onClick={() => onMakeMix(style)} title="Play the songs in order with planned transitions">
              Make DJ mix
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function TrackCard({ track, order, onToggle, onRetry }: { track: Track; order: number; onToggle: () => void; onRetry: () => void }): React.JSX.Element {
  const a = track.analysis;
  const busy = track.status !== "ready" && track.status !== "error";
  return (
    <li className={`track-card${order >= 0 ? " is-queued" : ""}`}>
      <div className="track-top">
        <img src={track.thumbnail} alt="" className="thumb" loading="lazy" />
        <div className="track-text">
          <span className="track-title" title={track.title}>
            {shortTitle(track)}
          </span>
          <span className="track-status">
            <span className={`status-led status-${track.status}`} aria-hidden />
            {STATUS_TEXT[track.status]}
            {track.status === "separating" && a ? " · usable now" : ""}
          </span>
        </div>
        {a && (
          <button
            type="button"
            className={`queue-btn${order >= 0 ? " is-lit" : ""}`}
            onClick={onToggle}
            aria-pressed={order >= 0}
            title={order >= 0 ? "Remove from auto mix" : "Add to auto mix"}
          >
            {order >= 0 ? order + 1 : "+"}
          </button>
        )}
      </div>

      {track.status === "error" && (
        <div className="track-error">
          <p className="error-text">{track.error}</p>
          <button type="button" className="hw-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {busy && !a && <div className="progress-groove" aria-hidden />}

      {a && (
        <>
          <div className="track-stats mono">
            <span title="Tempo">{a.bpm.toFixed(1)} BPM</span>
            <span title={`Key ${a.key.name}`}>
              {a.key.camelot} · {a.key.name}
            </span>
            <span>{formatTime(a.duration)}</span>
          </div>
          <div className="skyline" aria-label="Song sections. Drag one onto the timeline.">
            {a.sections.map((s) => {
              const payload: SectionDrag = { trackId: track.id, startBar: s.startBar, bars: s.bars };
              return (
                <div
                  key={s.startBar}
                  className="skyline-block"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SECTION_DRAG_TYPE, JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  style={{ flexGrow: s.bars, height: `${18 + s.energy * 82}%`, background: energyColor(s.energy) }}
                  title={`${s.label} ${s.group} · ${s.bars} bars · energy ${Math.round(s.energy * 100)} — drag to the timeline`}
                >
                  <span>{s.label[0]}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </li>
  );
}
