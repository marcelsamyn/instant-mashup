import { useState } from "react";
import { type GrimeSurface, printImage, useHasGrime, useMarks, wipeAll } from "../grime";

/** Fingerprints and smears on a glass surface. Place inside a positioned element marked `data-grime`. */
export function Grime({ surface }: { surface: GrimeSurface }): React.JSX.Element {
  const marks = useMarks(surface);
  return (
    <div className="grime" aria-hidden>
      {marks.map((m, i) =>
        m.kind === "print" ? (
          <span
            key={i}
            className="print"
            style={
              {
                left: `${m.x * 100}%`,
                top: `${m.y * 100}%`,
                transform: `translate(-50%, -50%) rotate(${m.angle}deg) scale(${m.scale})`,
                backgroundImage: `url(${printImage(m.variant)})`,
                "--sweep": m.x,
              } as React.CSSProperties
            }
          />
        ) : (
          <span
            key={i}
            className="smear"
            style={
              {
                left: `${m.x * 100}%`,
                top: `${m.y * 100}%`,
                width: `${m.length * 100}%`,
                transform: `rotate(${m.angle}deg)`,
                "--sweep": m.x,
              } as React.CSSProperties
            }
          />
        ),
      )}
    </div>
  );
}

const WIPE_MS = 1100;

/** A microfiber cloth tag. The sweep animation runs before the marks are cleared. */
export function WipeButton(): React.JSX.Element | null {
  const dirty = useHasGrime();
  const [wiping, setWiping] = useState(false);
  if (!dirty && !wiping) return null;
  return (
    <button
      type="button"
      className="wipe-btn"
      data-no-grime
      disabled={wiping}
      title="Wipe the fingerprints off the glass"
      onClick={() => {
        setWiping(true);
        document.documentElement.classList.add("is-wiping");
        setTimeout(() => {
          wipeAll();
          document.documentElement.classList.remove("is-wiping");
          setWiping(false);
        }, WIPE_MS);
      }}
    >
      {wiping ? "Wiping…" : "Wipe glass"}
    </button>
  );
}
