// Uji end-to-end terhadap Worker yang berjalan (wrangler dev).
// Menjalankan alur OAuth lengkap dan skenario serangan dari luar.
// Pemakaian: BASE=http://localhost:8787 PASS=<passphrase> node test/e2e.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:8787";
const PASS = process.env.PASS;
if (!PASS) throw new Error("Set PASS");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let passed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ok   ${name}`);
  } catch (e) {
    results.push(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
const pause = () => new Promise((r) => setTimeout(r, 62_000));

const b64url = (buf) => buf.toString("base64url");
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const formPost = (path, data, extra = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams(data),
  });

async function setupClient(passphrase = PASS) {
  const r = await formPost("/setup", { passphrase, go: "1" });
  const html = await r.text();
  const codes = [...html.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => decode(m[1]));
  return { status: r.status, clientId: codes[0], clientSecret: codes[1], html };
}

function authorizeUrl(clientId, { scope = "mcp:read mcp:write", challenge, redirect = REDIRECT, extra = {} } = {}) {
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge ?? pkce().challenge,
    code_challenge_method: "S256",
    state: "st-" + b64url(randomBytes(6)),
    scope,
    resource: `${BASE}/mcp`,
    ...extra,
  }).toString();
  return url;
}

function approve(url, passphrase, scopes = ["mcp:read", "mcp:write"], decision = "approve") {
  const body = new URLSearchParams({ decision, passphrase });
  for (const s of scopes) body.append("scope", s);
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function exchange(client, code, verifier) {
  return formPost("/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  });
}

async function fullLogin(client, scopes) {
  const { verifier, challenge } = pkce();
  const url = authorizeUrl(client.clientId, { challenge });
  const r = await approve(url, PASS, scopes);
  assert.equal(r.status, 302, `approve status ${r.status}`);
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const t = await exchange(client, code, verifier);
  assert.equal(t.status, 200, `token ${t.status} ${await t.clone().text()}`);
  return await t.json();
}

const mcp = (token, body, headers = {}) =>
  fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------- permukaan publik
await check("metadata OAuth tersedia; implicit grant mati; DCR tidak diiklankan", async () => {
  const pr = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  assert.equal((await pr.json()).resource, `${BASE}/mcp`);
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.ok(!meta.response_types_supported.includes("token"));
  assert.equal(meta.registration_endpoint, undefined);
  assert.notEqual(meta.client_id_metadata_document_supported, true);
});

await check("DCR mati: /oauth/register -> 404", async () => {
  const r = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "x", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assert.equal(r.status, 404);
});

await check("/mcp tanpa token -> 401 dengan WWW-Authenticate", async () => {
  const r = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/i);
});

await check("/mcp dengan token palsu, di query, atau di path -> 401", async () => {
  for (const t of ["x", "a".repeat(64), "owner:owner:owner", "' OR 1=1 --"]) {
    assert.equal((await mcp(t, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
  }
  const q = await fetch(`${BASE}/mcp?access_token=x`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(q.status, 401);
  const p = await fetch(`${BASE}/mcp/sometoken`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(p.status, 401);
});

await check("Host lain (bukan PUBLIC_URL) -> 404", async () => {
  const r = await fetch(BASE.replace("localhost", "127.0.0.1") + "/.well-known/oauth-authorization-server");
  assert.equal(r.status, 404);
});

await check("header keamanan terpasang", async () => {
  const r = await fetch(`${BASE}/`);
  for (const h of ["x-content-type-options", "strict-transport-security", "content-security-policy", "x-frame-options", "referrer-policy"]) {
    assert.ok(r.headers.get(h), h);
  }
});

// ---------------------------------------------------------------- /setup
let client;
await check("/setup: passphrase salah -> 403, tanpa kredensial", async () => {
  const r = await setupClient("salah-" + "x".repeat(40));
  assert.equal(r.status, 403);
  assert.ok(!r.html.includes("Client Secret</strong>"));
});

await check("/setup: passphrase benar -> Client ID & Secret (no-store)", async () => {
  const r = await formPost("/setup", { passphrase: PASS, go: "1" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const codes = [...(await r.text()).matchAll(/<code>([^<]+)<\/code>/g)].map((m) => decode(m[1]));
  client = { clientId: codes[0], clientSecret: codes[1] };
  assert.ok(client.clientId && client.clientSecret?.length >= 20);
});

await check("/setup: hanya form-urlencoded yang diterima", async () => {
  const r = await fetch(`${BASE}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: PASS }) });
  assert.equal(r.status, 415);
});

// ---------------------------------------------------------------- /authorize
await check("GET /authorize tidak menulis state (tanpa Set-Cookie) dan aman dirender", async () => {
  const r = await fetch(authorizeUrl(client.clientId, { scope: "mcp:read" }), { redirect: "manual" });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.equal((r.headers.getSetCookie?.() ?? []).length, 0);
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  // Hanya scope yang diminta yang tercentang.
  assert.match(html, /value="mcp:read" checked/);
  assert.doesNotMatch(html, /value="mcp:write" checked/);
});

await check("redirect_uri tidak terdaftar / client_id palsu / tanpa PKCE -> error lokal, bukan redirect", async () => {
  for (const url of [
    authorizeUrl(client.clientId, { redirect: "https://evil.example/cb" }),
    authorizeUrl("client-palsu"),
  ]) {
    const r = await fetch(url, { redirect: "manual" });
    assert.notEqual(r.status, 302, url.toString());
  }
  const noPkce = new URL(`${BASE}/authorize`);
  noPkce.search = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: REDIRECT, state: "s" });
  const r = await fetch(noPkce, { redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  if (r.status === 302) assert.match(loc, /^https:\/\/claude\.ai\/.*error=/);
  else assert.doesNotMatch(await r.text(), /name="passphrase"/);
});

await check("passphrase salah -> 403 tanpa kode", async () => {
  const r = await approve(authorizeUrl(client.clientId), "tebakan-salah");
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("location"), null);
});

await check("passphrase tidak diperiksa pada permintaan otorisasi yang tidak valid (bukan oracle)", async () => {
  const bogus = `${BASE}/authorize?client_id=junk`;
  const wrong = await approve(bogus, "salah");
  const right = await approve(bogus, PASS);
  assert.equal(wrong.status, right.status);
  assert.equal(await wrong.text(), await right.text());
});

await check("scope asing diabaikan; scope kosong ditolak", async () => {
  assert.equal((await approve(authorizeUrl(client.clientId), PASS, ["admin", "mcp:admin"])).status, 400);
});

await check("Tolak -> redirect ke claude.ai dengan access_denied", async () => {
  const r = await approve(authorizeUrl(client.clientId), "", [], "deny");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location") ?? "", /^https:\/\/claude\.ai\/.*error=access_denied/);
});

await pause();

// ---------------------------------------------------------------- token
await check("kode: verifier salah ditolak, secret salah ditolak, kode sekali pakai", async () => {
  const { verifier, challenge } = pkce();
  const r = await approve(authorizeUrl(client.clientId, { challenge }), PASS);
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  assert.equal((await exchange(client, code, "verifier-salah-" + "x".repeat(40))).status, 400);
  assert.notEqual((await exchange({ ...client, clientSecret: "salah" }, code, verifier)).status, 200);
  const first = await exchange(client, code, verifier);
  const second = await exchange(client, code, verifier);
  assert.ok(!(first.status === 200 && second.status === 200), "kode tidak boleh dipakai dua kali");
});

await check("/setup merotasi: kredensial, kode, dan token lama mati", async () => {
  const old = client;
  const oldTokens = await fullLogin(old, ["mcp:read"]);
  const { verifier, challenge } = pkce();
  const r = await approve(authorizeUrl(old.clientId, { challenge }), PASS);
  const pendingCode = new URL(r.headers.get("location")).searchParams.get("code");

  const fresh = await setupClient();
  assert.equal(fresh.status, 200);
  assert.match(fresh.html, /1 kredensial lama dicabut/);
  client = { clientId: fresh.clientId, clientSecret: fresh.clientSecret };

  assert.notEqual((await exchange(old, pendingCode, verifier)).status, 200, "kode lama");
  assert.notEqual((await exchange(client, pendingCode, verifier)).status, 200, "kode lama dengan klien baru");
  assert.equal((await mcp(oldTokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401, "access token lama");
  const refresh = await formPost("/oauth/token", {
    grant_type: "refresh_token", refresh_token: oldTokens.refresh_token, client_id: old.clientId, client_secret: old.clientSecret,
  });
  assert.notEqual(refresh.status, 200, "refresh token lama");
  const fetchAuth = await fetch(authorizeUrl(old.clientId), { redirect: "manual" });
  assert.notEqual(fetchAuth.status, 200, "client_id lama tidak bisa memulai otorisasi");
});

await pause();

// ---------------------------------------------------------------- scope di MCP
let readOnly;
await check("login baca saja: tool tulis tidak terlihat dan tidak bisa dipanggil", async () => {
  readOnly = await fullLogin(client, ["mcp:read"]);
  assert.doesNotMatch(readOnly.scope, /mcp:write/);
  const list = await (await mcp(readOnly.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes("buffer_list_accounts") && !names.includes("buffer_create_post"));
  const batch = await (
    await mcp(readOnly.access_token, [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "buffer_delete_post", arguments: { account: "akun_uji", postId: "abc" } } },
    ])
  ).json();
  assert.equal(batch[0].result.isError, true);
});

let full;
await check("login penuh: initialize + semua tool terlihat", async () => {
  full = await fullLogin(client, ["mcp:read", "mcp:write"]);
  const init = await (
    await mcp(full.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } })
  ).json();
  assert.equal(init.result.serverInfo.name, "mcp-gate");
  const list = await (await mcp(full.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.ok(list.result.tools.some((t) => t.name === "buffer_create_post"));
});

await check("buffer_list_accounts tidak membocorkan API key", async () => {
  const r = await (await mcp(full.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "buffer_list_accounts", arguments: {} } })).json();
  const text = r.result.content[0].text;
  assert.match(text, /akun_uji/);
  assert.ok(!text.includes("kunci-rahasia-uji"));
});

await check("token valid + Origin asing -> 403", async () => {
  assert.equal((await mcp(full.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status, 403);
});

await check("refresh token berotasi; token dicabut tidak bisa dipakai", async () => {
  const r = await formPost("/oauth/token", {
    grant_type: "refresh_token", refresh_token: full.refresh_token, client_id: client.clientId, client_secret: client.clientSecret,
  });
  assert.equal(r.status, 200);
  const next = await r.json();
  assert.notEqual(next.refresh_token, full.refresh_token);
  const rev = await formPost("/oauth/token", {
    token: next.access_token, token_type_hint: "access_token", client_id: client.clientId, client_secret: client.clientSecret,
  });
  assert.equal(rev.status, 200);
  assert.equal((await mcp(next.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
});

await pause();
await check("brute force /authorize dan /setup dibatasi (429)", async () => {
  const s1 = [];
  for (let i = 0; i < 30; i++) s1.push((await approve(authorizeUrl(client.clientId), "tebak-" + i)).status);
  assert.ok(s1.includes(429), `authorize: ${[...new Set(s1)]}`);
  const s2 = [];
  for (let i = 0; i < 30; i++) s2.push((await setupClient("tebak-" + i + "x".repeat(30))).status);
  assert.ok(s2.includes(429), `setup: ${[...new Set(s2)]}`);
});

console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} lolos`);
