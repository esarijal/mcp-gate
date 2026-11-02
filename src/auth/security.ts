import type { Env } from "../core/types.ts";

export const MIN_PASSPHRASE_LENGTH = 32;
const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

export function allowedRedirectHosts(env: Env): string[] {
  const raw = typeof env.ALLOWED_REDIRECT_HOSTS === "string" ? env.ALLOWED_REDIRECT_HOSTS : "";
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]{1,253}$/.test(h));
  return hosts.length ? hosts : DEFAULT_REDIRECT_HOSTS;
}

/** Redirect hanya boleh ke https://<host yang diizinkan> (pencocokan host persis). */
export function redirectAllowed(redirectUri: string, hosts: string[]): boolean {
  try {
    const url = new URL(redirectUri);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      !url.username &&
      !url.password &&
      hosts.includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Bandingkan passphrase lewat hash SHA-256 dengan perbandingan waktu-konstan,
 * jadi panjang dan isi passphrase tidak bocor lewat timing.
 */
export async function passphraseMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export const MIN_DISTINCT_CHARS = 10;

/** Passphrase dianggap terkonfigurasi hanya bila panjang (>=32) dan cukup acak (>=10 karakter berbeda). */
export function ownerPassphrase(env: Env): string | null {
  const p = env.OWNER_PASSPHRASE;
  if (typeof p !== "string" || p.length < MIN_PASSPHRASE_LENGTH) return null;
  if (new Set(p).size < MIN_DISTINCT_CHARS) return null;
  return p;
}

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"'`=/]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Header keamanan yang dipasang di semua respons. */
export function applySecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  if (!h.has("Content-Security-Policy")) {
    h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "DENY");
  h.delete("Server");
  h.delete("X-Powered-By");
  return out;
}

/** Rate limit per IP. Kalau binding tidak tersedia (mis. uji lokal), lolos. */
export async function rateLimited(env: Env, request: Request, bucket: string): Promise<boolean> {
  const limiter = env.AUTH_LIMITER;
  if (!limiter) return false;
  const ip = clientKey(request.headers.get("cf-connecting-ip"));
  const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
  return !success;
}

/** IPv4 apa adanya; IPv6 dipotong ke /64 supaya satu pelanggan tidak bisa memutar ribuan alamat. */
export function clientKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return full.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
