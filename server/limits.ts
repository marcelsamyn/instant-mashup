import type { Server } from "bun";
import { config } from "./config";

/** Runs at most `slots` jobs at once; the rest wait in order. */
export function concurrency(slots: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    if (running >= slots) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** Sliding-window counter per key. A limit of 0 means unlimited. */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit. Returns 0 when allowed, otherwise the seconds until the next hit is allowed. */
  take(key: string): number {
    if (this.limit === 0) return 0;
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.ceil((recent[0]! + this.windowMs - now) / 1000);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_KEYS) this.prune(now);
    return 0;
  }

  /** Drops expired keys, then the oldest keys, so memory stays bounded under many distinct IPs. */
  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
    for (const key of this.hits.keys()) {
      if (this.hits.size <= MAX_KEYS * 0.9) break;
      this.hits.delete(key);
    }
  }
}

const HOUR = 60 * 60 * 1000;
const MAX_KEYS = 10_000;

export const limits = {
  addsPerIp: new RateLimit(config.addsPerHourPerIp, HOUR),
  addsGlobal: new RateLimit(config.addsPerDay, 24 * HOUR),
  searchesPerIp: new RateLimit(config.searchesPerMinutePerIp, 60 * 1000),
  rendersPerIp: new RateLimit(config.rendersPerHourPerIp, HOUR),
  loginsPerIp: new RateLimit(config.loginAttemptsPer15MinPerIp, 15 * 60 * 1000),
};

export function tooMany(retryAfterSec: number, message: string): Response {
  return Response.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfterSec) } });
}

/**
 * The address limits are counted against. Behind a proxy it is the last X-Forwarded-For entry:
 * the one the proxy added. Earlier entries come from the client and can be forged.
 */
export function clientIp(req: Request, server: Server<unknown>): string {
  const forwarded = config.trustProxy ? req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;
  return limitKey(forwarded || server.requestIP(req)?.address || "unknown");
}

/** One IPv6 user usually owns a whole /64, so count it as one; IPv4-mapped addresses become IPv4. */
function limitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).join(":")}::/64`;
}
