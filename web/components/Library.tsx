import { type FormEvent, useMemo, useState } from "react";
import type { SearchResult, Track, TrackStatus } from "../../shared/types";
import { searchVideos } from "../api";
import { CRATE_SORTS, type CrateSort, arrangeCrate } from "../crate";
import { type Match, formatTempoMatch } from "../match";
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
  onTune: (track: Track) => void;
}

export function Library({ tracks, queue, onAdd, onToggleQueue, onMakeMashup, onMakeMix, onTune }: LibraryProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<TransitionStyle>("blend");
  const [sort, setSort] = useState<CrateSort>("added");
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [goodMatchesOnly, setGoodMatchesOnly] = useState(false);
  const ids = new Set(tracks.map((t) => t.id));
  const reference = tracks.find((t) => t.id === referenceId && t.analysis) ?? null;
  const crate = useMemo(
    () => arrangeCrate(tracks, { query, sort, referenceId: reference?.id ?? null, goodMatchesOnly }),
    [tracks, query, sort, reference, goodMatchesOnly],
  );

  function matchAgainst(id: string | null): void {
    setReferenceId(id);
    if (id) setSort("match");
    else if (sort === "match") setSort("added");
  }

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
            placeholder="Filter your songs, or search YouTube"
            aria-label="Filter your songs, or search YouTube and paste links"
            title="Typing filters your songs. Go searches YouTube."
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
        <span className="engraved">
          Your songs · {crate.length === tracks.length ? tracks.length : `${crate.length} of ${tracks.length}`}
        </span>
        {tracks.length > 1 && (
          <div className="crate-tools">
            <select className="hw-select" value={sort} onChange={(e) => setSort(e.target.value as CrateSort)} aria-label="Sort songs">
              {CRATE_SORTS.filter((o) => o.value !== "match" || reference).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="hw-select"
              value={reference?.id ?? ""}
              onChange={(e) => matchAgainst(e.target.value || null)}
              aria-label="Match songs against"
              title="Shows how every song fits in tempo and key next to this one"
            >
              <option value="">Match against…</option>
              {tracks
                .filter((t) => t.analysis)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {shortTitle(t)}
                  </option>
                ))}
            </select>
            {reference && (
              <label className="toggle" title="Tempo within 6% and a compatible key, with at most 2 semitones of pitch shift">
                <input type="checkbox" checked={goodMatchesOnly} onChange={(e) => setGoodMatchesOnly(e.target.checked)} />
                <span>Good fits only</span>
              </label>
            )}
          </div>
        )}
        {tracks.length === 0 && <p className="hint">Search for a song above. Each one is downloaded, analysed and split into stems, which takes about a minute.</p>}
        {tracks.length > 0 && crate.length === 0 && (
          <p className="hint">
            {query.trim() ? "None of your songs match. Press Go to search YouTube." : "No song fits this one well yet. Turn off “Good fits only” to see them all."}
          </p>
        )}
        <ul>
          {crate.map(({ track: t, match }) => (
            <TrackCard
              key={t.id}
              track={t}
              order={queue.indexOf(t.id)}
              match={match}
              isReference={t.id === reference?.id}
              onToggle={() => onToggleQueue(t.id)}
              onRetry={() => void onAdd(t.id)}
              onMatch={() => matchAgainst(t.id === reference?.id ? null : t.id)}
              onTune={() => onTune(t)}
            />
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

function tempoTone(m: Match): string {
  const pct = Math.abs(m.tempoPct);
  return pct <= 3 ? "good" : pct <= 6 ? "ok" : "bad";
}

function keyTone(m: Match): string {
  return m.keyDistance <= 1 ? "good" : m.shift !== 0 || m.keyDistance === 2 ? "ok" : "bad";
}

interface TrackCardProps {
  track: Track;
  order: number;
  match: Match | null;
  isReference: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onMatch: () => void;
  onTune: () => void;
}

function TrackCard({ track, order, match, isReference, onToggle, onRetry, onMatch, onTune }: TrackCardProps): React.JSX.Element {
  const a = track.analysis;
  const busy = track.status !== "ready" && track.status !== "error";
  return (
    <li className={`track-card${order >= 0 ? " is-queued" : ""}${isReference ? " is-reference" : ""}`}>
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
            {a.tuned && (
              <span className="tuned-chip" title="Tempo, downbeat or key set by hand">
                tuned
              </span>
            )}
          </div>
          {(match || isReference) && (
            <div className="match-row">
              {isReference ? (
                <span className="match-badge tone-ref">Matching against this song</span>
              ) : (
                match && (
                  <>
                    <span className={`match-badge tone-${tempoTone(match)}`} title="Tempo stretch needed to play at the reference tempo">
                      {formatTempoMatch(match)}
                    </span>
                    <span className={`match-badge tone-${keyTone(match)}`} title="Key fit with the reference, on the Camelot wheel">
                      {match.keyLabel}
                    </span>
                  </>
                )
              )}
            </div>
          )}
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
          <div className="card-actions">
            <button type="button" className="text-btn" onClick={onMatch} aria-pressed={isReference}>
              {isReference ? "Stop matching" : "Find matches"}
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={onTune}
              disabled={track.status !== "ready" && !(track.status === "error" && track.stemLevels)}
              title="Fix the tempo, beat grid or key by hand"
            >
              Tune grid
            </button>
          </div>
        </>
      )}
    </li>
  );
}
