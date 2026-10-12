import { type KeyboardEvent, type PointerEvent, useRef } from "react";

interface RangeProps {
  value: number;
  min: number;
  max: number;
  /** Knob rest point. Values left of it fill one way, right of it the other (EQ, filter). */
  center?: number;
  defaultValue: number;
  onChange: (value: number) => void;
  label: string;
  format?: (value: number) => string;
  disabled?: boolean;
}

/** Position 0..1 along the control. With a center, the center sits at 0.5 even when the range is lopsided. */
function toPos(v: number, min: number, max: number, center: number): number {
  if (center <= min) return (v - min) / (max - min);
  return v < center ? (0.5 * (v - min)) / (center - min) : 0.5 + (0.5 * (v - center)) / (max - center);
}

function fromPos(p: number, min: number, max: number, center: number): number {
  const q = Math.min(1, Math.max(0, p));
  if (center <= min) return min + q * (max - min);
  return q < 0.5 ? min + (q / 0.5) * (center - min) : center + ((q - 0.5) / 0.5) * (max - center);
}

/** Vertical drag, wheel and arrow keys; shift for fine control; double-click resets. */
function useRangeInput({ value, min, max, center = min, defaultValue, onChange, disabled }: RangeProps, travel: number) {
  const drag = useRef<{ y: number; pos: number } | null>(null);
  const pos = toPos(value, min, max, center);
  const set = (p: number): void => {
    // Snap to the rest point near the middle so "flat" is easy to hit.
    const snapped = center > min && Math.abs(p - 0.5) < 0.012 ? 0.5 : p;
    onChange(fromPos(snapped, min, max, center));
  };
  return {
    pos,
    handlers: {
      onPointerDown(e: PointerEvent<HTMLElement>) {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, pos };
      },
      onPointerMove(e: PointerEvent<HTMLElement>) {
        if (!drag.current) return;
        set(drag.current.pos + (drag.current.y - e.clientY) / (e.shiftKey ? travel * 4 : travel));
      },
      onPointerUp() {
        drag.current = null;
      },
      onDoubleClick() {
        if (!disabled) onChange(defaultValue);
      },
      onKeyDown(e: KeyboardEvent<HTMLElement>) {
        if (disabled) return;
        const step = e.shiftKey ? 0.005 : 0.03;
        if (e.key === "ArrowUp" || e.key === "ArrowRight") set(pos + step);
        else if (e.key === "ArrowDown" || e.key === "ArrowLeft") set(pos - step);
        else if (e.key === "Home" || e.key === "Delete") onChange(defaultValue);
        else return;
        e.preventDefault();
      },
    },
  };
}

const SWEEP = 270;
const polar = (r: number, deg: number): [number, number] => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [20 + r * Math.cos(rad), 20 + r * Math.sin(rad)];
};
const arc = (r: number, from: number, to: number): string => {
  const [x1, y1] = polar(r, Math.min(from, to));
  const [x2, y2] = polar(r, Math.max(from, to));
  return `M ${x1} ${y1} A ${r} ${r} 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${x2} ${y2}`;
};

export function Knob(props: RangeProps & { color?: string; size?: number }): React.JSX.Element {
  const { label, format, disabled, value, color = "var(--ink)", size = 38, min, center = min } = props;
  const { pos, handlers } = useRangeInput(props, 140);
  const start = -SWEEP / 2;
  const angle = start + pos * SWEEP;
  const restAngle = start + toPos(center, min, props.max, center) * SWEEP;
  const [ix, iy] = polar(10, angle);
  const [ox, oy] = polar(15, angle);
  return (
    <div className={`knob${disabled ? " is-disabled" : ""}`} title={disabled ? undefined : "Drag up or down. Double-click to reset."}>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={value}
        aria-valuetext={format?.(value)}
        aria-disabled={disabled}
        className="knob-dial"
        style={{ width: size, height: size, "--angle": `${angle}deg` } as React.CSSProperties}
        {...handlers}
      >
        <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden>
          <path d={arc(18.5, start, start + SWEEP)} className="knob-track" />
          {Math.abs(angle - restAngle) > 0.5 && <path d={arc(18.5, restAngle, angle)} className="knob-value" style={{ stroke: color }} />}
          <circle cx="20" cy="20" r="14" className="knob-cap-ring" style={{ stroke: color }} />
          <line x1={ix} y1={iy} x2={ox} y2={oy} className="knob-pointer" />
        </svg>
      </div>
      <span className="knob-label">{label}</span>
      <span className="knob-readout">{format ? format(value) : value.toFixed(2)}</span>
    </div>
  );
}

export function Fader(props: RangeProps): React.JSX.Element {
  const { label, value, format, disabled } = props;
  const { pos, handlers } = useRangeInput(props, 120);
  return (
    <div className="fader">
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={value}
        aria-valuetext={format?.(value)}
        className="fader-track"
        {...handlers}
      >
        <div className="fader-fill" style={{ height: `${pos * 100}%` }} />
        <div className="fader-cap" style={{ bottom: `calc(${pos * 100}% - 9px)` }} />
      </div>
      <span className="knob-readout">{format ? format(value) : value.toFixed(2)}</span>
    </div>
  );
}

export const formatDb = (db: number): string => (db <= -39.5 ? "kill" : `${db > 0 ? "+" : ""}${db.toFixed(1)}`);
export const formatPercent = (v: number): string => `${Math.round(v * 100)}`;
export const formatFilter = (v: number): string => (Math.abs(v) < 0.02 ? "open" : `${v < 0 ? "LP" : "HP"} ${Math.round(Math.abs(v) * 100)}`);
export const formatGainDb = (v: number): string => (v < 0.001 ? "-∞" : `${(20 * Math.log10(v)).toFixed(1)}`);
