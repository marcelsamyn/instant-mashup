import { useEffect, useSyncExternalStore } from "react";

/**
 * Fingerprints and smears on the glass surfaces. Pure decoration: it is saved per browser so the
 * console slowly gets dirtier between sessions, and nothing breaks when storage is unavailable.
 */

export type GrimeSurface = "screen" | "display";

export interface Mark {
  kind: "print" | "smear";
  /** Position as a 0..1 fraction of the surface, so marks survive resizes. */
  x: number;
  y: number;
  angle: number;
  scale: number;
  /** Smear length as a fraction of the surface width. */
  length: number;
  variant: number;
}

type GrimeState = Record<GrimeSurface, Mark[]>;

const STORAGE_KEY = "instant-mashup:grime";
const MAX_MARKS = 70;
/** Not every touch leaves a visible print. */
const PRINT_CHANCE = 0.55;
const SMEAR_MIN_PX = 40;

function load(): GrimeState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof raw === "object" && raw !== null && "screen" in raw && "display" in raw && Array.isArray(raw.screen) && Array.isArray(raw.display)) {
      return { screen: raw.screen as Mark[], display: raw.display as Mark[] };
    }
  } catch {
    // Storage blocked or corrupt: start with clean glass.
  }
  return { screen: [], display: [] };
}

let state: GrimeState = load();
const listeners = new Set<() => void>();

function setState(next: GrimeState): void {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not saved; the marks still show this session.
  }
  for (const l of listeners) l();
}

function addMark(surface: GrimeSurface, mark: Mark): void {
  setState({ ...state, [surface]: [...state[surface], mark].slice(-MAX_MARKS) });
}

export function wipeAll(): void {
  setState({ screen: [], display: [] });
}

export function useMarks(surface: GrimeSurface): Mark[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state[surface],
  );
}

export function useHasGrime(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state.screen.length + state.display.length > 0,
  );
}

/** Watches presses on `[data-grime]` surfaces: a tap may leave a print, a drag leaves a smear. */
export function useGrimeTracker(): void {
  useEffect(() => {
    let press: { surface: GrimeSurface; el: Element; x: number; y: number } | null = null;
    const down = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest("[data-grime]");
      const surface = el?.getAttribute("data-grime");
      if (!el || target?.closest("[data-no-grime]") || (surface !== "screen" && surface !== "display")) return;
      press = { surface, el, x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent): void => {
      if (!press) return;
      const { surface, el, x, y } = press;
      press = null;
      const rect = el.getBoundingClientRect();
      const dx = e.clientX - x;
      const dy = e.clientY - y;
      const distance = Math.hypot(dx, dy);
      const base = { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, variant: Math.floor(Math.random() * PRINT_VARIANTS) };
      if (distance >= SMEAR_MIN_PX) {
        addMark(surface, { ...base, kind: "smear", angle: (Math.atan2(dy, dx) * 180) / Math.PI, scale: 1, length: distance / rect.width });
      } else if (Math.random() < PRINT_CHANCE) {
        addMark(surface, { ...base, kind: "print", angle: Math.random() * 70 - 35, scale: 0.8 + Math.random() * 0.4, length: 0 });
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
    };
  }, []);
}

const PRINT_VARIANTS = 4;
let printImages: string[] | null = null;

/** Small seeded PRNG so each print variant looks the same every load. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws fingerprint ridges: a wobbly whorl of broken loops that fades out at the edge of the fingertip. */
function drawPrint(seed: number): string {
  const rand = mulberry32(seed * 7919 + 13);
  const w = 120;
  const h = 150;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return "";
  const cx = w / 2 + (rand() - 0.5) * 14;
  const cy = h * 0.46 + (rand() - 0.5) * 14;
  const wobble = [rand() * 2, rand() * 2, rand() * 2];
  // Outer ridges drift sideways and down, which turns a bullseye into a loop pattern.
  const drift = (rand() - 0.5) * 0.35;
  g.strokeStyle = "rgb(255 255 255)";
  g.lineWidth = 1.7;
  g.lineCap = "round";
  for (let r = 3; r < 80; r += 3.6) {
    const squash = 1.28 + rand() * 0.1;
    let angle = rand() * Math.PI * 2;
    const end = angle + Math.PI * 2;
    while (angle < end) {
      // Ridges break up, like real prints.
      const run = 0.4 + rand() * 1.6;
      g.beginPath();
      for (let a = angle; a < Math.min(end, angle + run); a += 0.05) {
        const jitter = 1 + 0.05 * Math.sin(a * 3 + wobble[0]!) + 0.03 * Math.sin(a * 7 + wobble[1]!) + 0.04 * Math.sin(r * 0.15 + wobble[2]!);
        const px = cx + r * drift + Math.cos(a) * r * jitter;
        const py = cy + r * 0.22 + Math.sin(a) * r * squash * jitter;
        if (a === angle) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
      angle += run + rand() * 0.35;
    }
  }
  // Fingertip shape: soft oval, one side pressed harder than the other.
  g.globalCompositeOperation = "destination-in";
  const mask = g.createRadialGradient(cx + (rand() - 0.5) * 20, cy + (rand() - 0.5) * 20, 6, cx, cy, 62);
  mask.addColorStop(0, "rgb(0 0 0 / 1)");
  mask.addColorStop(0.55, "rgb(0 0 0 / 0.7)");
  mask.addColorStop(1, "rgb(0 0 0 / 0)");
  g.fillStyle = mask;
  g.fillRect(0, 0, w, h);
  return canvas.toDataURL("image/png");
}

export function printImage(variant: number): string {
  printImages ??= Array.from({ length: PRINT_VARIANTS }, (_, i) => drawPrint(i + 1));
  return printImages[variant % PRINT_VARIANTS] ?? "";
}
