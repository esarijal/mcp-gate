import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { ALL_SCOPES, type Env, type Scope } from "../core/types.ts";
import {
  allowedRedirectHosts,
  escapeHtml,
  ownerPassphrase,
  passphraseMatches,
  rateLimited,
  redirectAllowed,
} from "./security.ts";

/**
 * /authorize : pemilik memasukkan passphrase dan memilih izin dalam satu halaman.
 *
 * Penting untuk ketersediaan: halaman ini TIDAK menulis ke KV sebelum passphrase
 * terverifikasi. Permintaan otorisasi divalidasi ulang dari URL pada setiap langkah
 * (form dikirim balik ke URL yang sama), jadi tidak perlu transaksi tersimpan.
 */

export type EnvWithOAuth = Env & { OAUTH_PROVIDER: OAuthHelpers };

const SCOPE_LABEL: Record<Scope, string> = {
  "mcp:read": "Baca: lihat akun, channel, dan postingan",
  "mcp:write": "Tulis: buat, ubah, dan hapus postingan",
};

export const MAX_FORM_BYTES = 8 * 1024;

export function htmlPage(title: string, body: string, status = 200, formTargets: string[] = []): Response {
  const formAction = ["'self'", ...formTargets.map((h) => `https://${h}`)].join(" ");
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#e2e0da;--accent:#1f5f4a;--warn:#9a3412}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--muted:#a3a19b;--card:#1e1e1c;--line:#34332f;--accent:#6fc3a3;--warn:#fb923c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:460px;margin:48px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
.warn{color:var(--warn);font-weight:600}label{display:block;margin:8px 0}
code{font:13px ui-monospace,Menlo,monospace;word-break:break-all;background:var(--bg);padding:2px 4px;border-radius:4px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);font:inherit;cursor:pointer;background:transparent;color:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--card)}
</style></head><body><main><div class="card">${body}</div></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
        "X-Frame-Options": "DENY",
      },
    },
  );
}

export function errorPage(message: string, status = 400): Response {
  return htmlPage(
    "Tidak bisa melanjutkan",
    `<h1>Tidak bisa melanjutkan</h1><p>${escapeHtml(message)}</p>
<p class="muted">Tutup halaman ini dan ulangi penyambungan dari aplikasimu.</p>`,
    status,
  );
}

function consentPage(details: ConsentDescription, requested: string[], hosts: string[]): Response {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Diterbitkan oleh <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "Nama aplikasi ini ditetapkan sendiri oleh aplikasinya dan tidak terverifikasi.";
  const wanted = requested.filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));
  const ticked = new Set<Scope>(wanted.length ? wanted : ["mcp:read"]);
  const scopes = ALL_SCOPES.map(
    (s) =>
      `<label><input type="checkbox" name="scope" value="${escapeHtml(s)}"${ticked.has(s) ? " checked" : ""}> ${escapeHtml(SCOPE_LABEL[s])}</label>`,
  ).join("");
  return htmlPage(
    "Izinkan akses mcp-gate",
    `<h1>Izinkan <em>${name}</em> memakai mcp-gate?</h1>
<p class="muted">${origin} ID klien: <code>${escapeHtml(details.clientId)}</code></p>
<p>Akses akan dikirim ke <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p class="warn">Lanjutkan hanya kalau kamu sendiri yang baru saja menekan "Connect" di aplikasi itu.
Jangan pernah memasukkan passphrase dari tautan yang dikirim orang lain.</p>
<form method="post" autocomplete="off">
<p><strong>Izin yang diberikan</strong></p>${scopes}
<label for="pp"><strong>Passphrase pemilik</strong></label>
<input id="pp" type="password" name="passphrase" maxlength="512" autocomplete="current-password">
<div class="row"><button name="decision" value="deny">Tolak</button>
<button class="primary" name="decision" value="approve">Izinkan</button></div>
</form>`,
    200,
    hosts,
  );
}

function handleAuthError(error: unknown, hosts: string[]): Response {
  if (error instanceof AuthorizationError) {
    // Redirect hanya ke host tepercaya; selain itu tampilkan error lokal (anti open-redirect).
    if (error.redirectTo && error.redirectUri && redirectAllowed(error.redirectUri, hosts)) {
      return Response.redirect(error.redirectTo, 302);
    }
    return errorPage(error.description || "Permintaan otorisasi tidak valid.");
  }
  if (error instanceof CimdFetchError) return errorPage("Aplikasi ini tidak bisa diverifikasi.");
  throw error;
}

/** Validasi permintaan otorisasi dari URL dan pastikan tujuannya tepercaya. */
async function parseTrusted(oauth: OAuthHelpers, request: Request, hosts: string[]): Promise<AuthRequest | Response> {
  const authReq = await oauth.parseAuthRequest(request);
  if (!redirectAllowed(authReq.redirectUri, hosts)) {
    return errorPage("Aplikasi ini tidak diizinkan menyambung ke gerbang.", 403);
  }
  // PKCE S256 wajib untuk SEMUA klien, termasuk confidential (OAuth 2.1 / MCP).
  if (!authReq.codeChallenge || authReq.codeChallengeMethod !== "S256") {
    return Response.redirect(
      authorizationErrorRedirect(authReq, "invalid_request", "PKCE S256 wajib."),
      302,
    );
  }
  return authReq;
}

export async function readForm(request: Request): Promise<URLSearchParams | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_FORM_BYTES) return errorPage("Permintaan terlalu besar.", 413);
  const ct = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded(\s*;|$)/i.test(ct)) return errorPage("Format form tidak valid.", 415);
  const raw = await request.text();
  if (raw.length > MAX_FORM_BYTES) return errorPage("Permintaan terlalu besar.", 413);
  return new URLSearchParams(raw);
}

export async function handleAuthorize(request: Request, env: EnvWithOAuth): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const hosts = allowedRedirectHosts(env);

  if (await rateLimited(env, request, "authorize")) {
    return errorPage("Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.", 429);
  }
  const expected = ownerPassphrase(env);
  if (!expected) return errorPage("Gerbang belum dikonfigurasi dengan benar.", 503);

  try {
    if (request.method === "GET") {
      const authReq = await parseTrusted(oauth, request, hosts);
      if (authReq instanceof Response) return authReq;
      const details = await oauth.describeConsent(authReq);
      return consentPage(details, authReq.scope, hosts);
    }

    if (request.method === "POST") {
      const form = await readForm(request);
      if (form instanceof Response) return form;

      const authReq = await parseTrusted(oauth, request, hosts);
      if (authReq instanceof Response) return authReq;

      if (form.get("decision") !== "approve") {
        return Response.redirect(authorizationErrorRedirect(authReq, "access_denied"), 302);
      }

      const given = form.get("passphrase") ?? "";
      if (given.length > 512 || !(await passphraseMatches(given, expected))) {
        console.warn("authorize: passphrase salah");
        return errorPage("Passphrase salah. Ulangi penyambungan dari awal.", 403);
      }

      const picked = [...new Set(form.getAll("scope"))].filter((s): s is Scope =>
        (ALL_SCOPES as string[]).includes(s),
      );
      if (!picked.length) return errorPage("Pilih minimal satu izin.", 400);

      const { redirectTo } = await oauth.completeAuthorization({
        request: authReq,
        userId: "owner",
        metadata: { label: "owner" },
        scope: picked,
        props: { role: "owner" },
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  } catch (error) {
    return handleAuthError(error, hosts);
  }
}
