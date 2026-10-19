import { type FormEvent, useState } from "react";
import { unlock } from "../api";

/** Shown when the server asks for the shared password. */
export function AccessGate({ onUnlock }: { onUnlock: () => void }): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      onUnlock();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate-backdrop">
      <form key={attempt} className={`gate${attempt > 0 ? " is-wrong" : ""}`} onSubmit={submit} aria-labelledby="gate-title">
        <span id="gate-title" className="brand-name">
          Instant Mashup
        </span>
        <p className="gate-text">This console is shared with friends. Enter the password you were given.</p>
        <label className="display-glass gate-display">
          <span className="display-label">Password</span>
          <input
            className="display-input gate-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? "gate-error" : undefined}
          />
        </label>
        {error && (
          <p id="gate-error" className="error-text" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="hw-btn is-primary big" disabled={busy || !password}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
