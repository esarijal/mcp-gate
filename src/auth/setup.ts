import { escapeHtml, allowedRedirectHosts, ownerPassphrase, passphraseMatches, rateLimited } from "./security.ts";
import { errorPage, htmlPage, readForm, type EnvWithOAuth } from "./authorize.ts";

/**
 * /setup : pemilik membuat Client ID & Client Secret OAuth untuk Claude.
 * Ini pengganti pendaftaran klien anonim (DCR), yang dimatikan secara default
 * supaya orang luar tidak bisa menulis ke KV. Tidak ada penulisan KV sebelum
 * passphrase terverifikasi.
 */

/** Alamat callback OAuth konektor kustom Claude. */
export function callbackUris(env: EnvWithOAuth): string[] {
  return allowedRedirectHosts(env).map((h) => `https://${h}/api/mcp/auth_callback`);
}

function form(message = ""): Response {
  return htmlPage(
    "Setup mcp-gate",
    `<h1>Buat kredensial konektor</h1>
<p class="muted">Halaman ini membuat Client ID &amp; Client Secret untuk ditempel di
<strong>Advanced settings</strong> konektor kustom di Claude.</p>
<p class="warn">Setiap kali dijalankan, kredensial lama DICABUT dan semua koneksi yang memakainya terputus.</p>
${message ? `<p class="warn">${escapeHtml(message)}</p>` : ""}
<form method="post" autocomplete="off">
<label for="pp"><strong>Passphrase pemilik</strong></label>
<input id="pp" type="password" name="passphrase" maxlength="512" autocomplete="current-password">
<div class="row"><button class="primary" name="go" value="1">Buat kredensial</button></div>
</form>`,
  );
}

export async function handleSetup(request: Request, env: EnvWithOAuth): Promise<Response> {
  if (await rateLimited(env, request, "setup")) {
    return errorPage("Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.", 429);
  }
  const expected = ownerPassphrase(env);
  if (!expected) return errorPage("Gerbang belum dikonfigurasi dengan benar.", 503);

  if (request.method === "GET") return form();
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });

  const body = await readForm(request);
  if (body instanceof Response) return body;
  const given = body.get("passphrase") ?? "";
  if (given.length > 512 || !(await passphraseMatches(given, expected))) {
    console.warn("setup: passphrase salah");
    return errorPage("Passphrase salah.", 403);
  }

  // Rotasi: hapus semua klien lama (beserta grant & token-nya) supaya secret lama tidak hidup selamanya.
  const oauth = env.OAUTH_PROVIDER;
  let revoked = 0;
  let cursor: string | undefined;
  do {
    const page = await oauth.listClients({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const c of page.items) {
      await oauth.deleteClient(c.clientId);
      revoked++;
    }
    cursor = page.cursor;
  } while (cursor);

  const redirectUris = callbackUris(env);
  const client = await oauth.createClient({
    clientName: "Claude",
    redirectUris,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  if (!client.clientSecret) return errorPage("Gagal membuat client secret.", 500);

  return htmlPage(
    "Kredensial mcp-gate",
    `<h1>Kredensial siap</h1>
<p class="warn">Salin sekarang. Client Secret hanya ditampilkan sekali ini.</p>
<p class="muted">${revoked ? `${revoked} kredensial lama dicabut beserta semua koneksinya.` : "Ini kredensial pertama."}</p>
<p><strong>OAuth Client ID</strong><br><code>${escapeHtml(client.clientId)}</code></p>
<p><strong>OAuth Client Secret</strong><br><code>${escapeHtml(client.clientSecret)}</code></p>
<p class="muted">Callback yang diizinkan: ${redirectUris.map((u) => `<code>${escapeHtml(u)}</code>`).join(" ")}</p>
<p class="muted">Tempel keduanya di Claude: Settings → Connectors → Add custom connector → Advanced settings.</p>`,
  );
}
