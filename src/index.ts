import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize, type EnvWithOAuth } from "./auth/authorize.ts";
import { handleSetup } from "./auth/setup.ts";
import { allowedRedirectHosts, applySecurityHeaders, rateLimited, redirectAllowed } from "./auth/security.ts";
import { handleMcpHttp } from "./core/mcp.ts";
import { ALL_SCOPES, type Env } from "./core/types.ts";
import { allTools } from "./modules/index.ts";

/**
 * mcp-gate: satu gerbang MCP untuk banyak akun, dilindungi OAuth 2.1.
 *
 *   /mcp           endpoint MCP (butuh access token)
 *   /authorize     login pemilik + persetujuan izin
 *   /setup         buat Client ID & Secret untuk Claude (butuh passphrase)
 *   /oauth/token, /.well-known/*   dikelola library OAuth
 *   /oauth/register                hanya aktif bila ENABLE_DCR="true"
 */

type AuthedCtx = ExecutionContext & { auth?: { scope: string[] } };

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: AuthedCtx): Promise<Response> {
    const scopes = ctx.auth?.scope ?? [];
    return handleMcpHttp(request, allTools, env, { scopes }, allowedRedirectHosts(env));
  },
};

const defaultHandler = {
  async fetch(request: Request, env: EnvWithOAuth): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/setup") return handleSetup(request, env);
    if (pathname === "/") {
      return new Response("mcp-gate aktif.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

const dcrEnabled = (env: Env) => env.ENABLE_DCR === "true";

let cached: { key: string; provider: OAuthProvider<Env> } | null = null;

function publicOrigin(env: Env): string | null {
  const raw = typeof env.PUBLIC_URL === "string" ? env.PUBLIC_URL.trim() : "";
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.hostname.includes("GANTI")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getProvider(env: Env, origin: string): OAuthProvider<Env> {
  const key = `${origin}|${allowedRedirectHosts(env).join(",")}|${dcrEnabled(env)}`;
  if (cached?.key === key) return cached.provider;

  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    // DCR membuka penulisan KV ke publik; mati kecuali diaktifkan eksplisit.
    ...(dcrEnabled(env) ? { clientRegistrationEndpoint: "/oauth/register" } : {}),
    // CIMD dimatikan: klien kita hanya Claude dengan kredensial dari /setup.
    clientIdMetadataDocumentEnabled: false,
    scopesSupported: [...ALL_SCOPES],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    refreshTokenIdleTTL: 14 * 24 * 3600,
    clientRegistrationTTL: 30 * 24 * 3600,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    },
    // Bila DCR aktif: tolak klien yang redirect-nya bukan ke host yang diizinkan.
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      const list = Array.isArray(uris) ? uris : [];
      const hosts = allowedRedirectHosts(env);
      if (!list.length || !list.every((u) => typeof u === "string" && redirectAllowed(u, hosts))) {
        return { code: "invalid_redirect_uri", description: "redirect_uri tidak diizinkan oleh gerbang ini.", status: 400 };
      }
    },
    onError: ({ code, status, internal }) => {
      console.warn("oauth error", status, code, internal?.reason ?? "");
    },
  });
  cached = { key, provider };
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = publicOrigin(env);
    if (!origin) {
      return applySecurityHeaders(new Response("Gerbang belum dikonfigurasi (PUBLIC_URL).", { status: 503 }));
    }
    const url = new URL(request.url);
    if (url.origin !== origin) {
      // Hanya layani host resmi (mencegah kebingungan issuer/audience lewat host lain).
      return applySecurityHeaders(new Response("Not Found", { status: 404 }));
    }
    if (url.pathname === "/oauth/register") {
      if (!dcrEnabled(env)) return applySecurityHeaders(new Response("Not Found", { status: 404 }));
      if (await rateLimited(env, request, "register")) {
        return applySecurityHeaders(
          new Response(JSON.stringify({ error: "slow_down" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "60" },
          }),
        );
      }
    }
    const res = await getProvider(env, origin).fetch(request, env, ctx);
    return applySecurityHeaders(res);
  },
} satisfies ExportedHandler<Env>;
