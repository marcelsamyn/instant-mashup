import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

const COOKIE = "mashup_access";
const MAX_AGE_SEC = 90 * 24 * 60 * 60;

/**
 * The cookie holds an HMAC of a fixed label keyed by the password: nothing secret is stored in
 * the browser, there is no session table, and changing the password signs everyone out.
 */
const token = config.accessPassword
  ? new Bun.CryptoHasher("sha256", config.accessPassword).update("instant-mashup-access-v1").digest("hex")
  : null;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

export function hasAccess(req: Request): boolean {
  if (!token) return true;
  const value = cookieValue(req);
  return value !== null && same(value, token);
}

export const accessRequired = (): Response => Response.json({ error: "Enter the access password" }, { status: 401 });

/** Checks a password; on success returns the Set-Cookie header value. */
export function login(req: Request, password: string): string | null {
  if (!token || !config.accessPassword || !same(password, config.accessPassword)) return null;
  const secure = new URL(req.url).protocol === "https:" || (config.trustProxy && req.headers.get("x-forwarded-proto") === "https");
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}${secure ? "; Secure" : ""}`;
}
