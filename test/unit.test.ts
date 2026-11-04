import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/core/validate.ts";
import { handleMessage, handleMcpHttp, originAllowed, MAX_BODY_BYTES } from "../src/core/mcp.ts";
import { listAccounts, resolveApiKey } from "../src/modules/buffer/accounts.ts";
import { bufferGraphQL, toUtcIso, unwrapMutation } from "../src/modules/buffer/client.ts";
import { bufferTools } from "../src/modules/buffer/tools.ts";
import { clientKey, escapeHtml, ownerPassphrase, passphraseMatches, redirectAllowed } from "../src/auth/security.ts";
import type { Env, JsonSchema } from "../src/core/types.ts";

const env = (extra: Record<string, unknown> = {}) =>
  ({ OAUTH_KV: {} as KVNamespace, BUFFER_KEY_KAWANCERITAMU: "key-a", BUFFER_KEY_ESA_RIJAL: "key-b", ...extra }) as Env;

const READ = { scopes: ["mcp:read"] };
const ALL = { scopes: ["mcp:read", "mcp:write"] };
const call = (name: string, args: unknown, ctx = ALL, e = env()) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, bufferTools, e, ctx);
const textOf = (r: unknown) => (r as { result: { content: { text: string }[] } }).result.content[0]!.text;
const isErr = (r: unknown) => (r as { result: { isError?: boolean } }).result.isError === true;

// ---------------- validator ----------------

test("validator menolak properti asing, termasuk __proto__", () => {
  const s: JsonSchema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  assert.throws(() => validate(s, { b: 1 }), /tidak dikenal/);
  assert.throws(() => validate(s, JSON.parse('{"__proto__":{"x":1}}')), /tidak dikenal/);
  assert.throws(() => validate(s, JSON.parse('{"constructor":1}')), /tidak dikenal/);
});

test("validator menegakkan tipe, panjang, pola, enum, dan https", () => {
  assert.throws(() => validate({ type: "string", maxLength: 3 }, "abcd"), /maksimal/);
  assert.throws(() => validate({ type: "string", pattern: "^[a-z]+$" }, "ab$"), /format/);
  assert.throws(() => validate({ type: "string", enum: ["x"] }, "y"), /salah satu/);
  assert.throws(() => validate({ type: "string", format: "https-url" }, "http://a.com/x.jpg"), /https/);
  assert.throws(() => validate({ type: "string", format: "https-url" }, "https://u:p@a.com/x"), /kredensial/);
  assert.throws(() => validate({ type: "string", format: "https-url" }, "javascript:alert(1)"), /https/);
  assert.throws(() => validate({ type: "array", maxItems: 1, items: { type: "string" } }, ["a", "b"]), /maksimal/);
  assert.throws(() => validate({ type: "integer" }, 1.5), /bulat/);
  assert.throws(() => validate({ type: "integer" }, Infinity), /angka/);
  assert.throws(() => validate({ type: "object" }, []), /objek/);
});

// ---------------- akun ----------------

test("akun dibaca dari BUFFER_KEY_* dan label dinormalisasi", () => {
  assert.deepEqual([...listAccounts(env()).keys()].sort(), ["esa_rijal", "kawanceritamu"]);
  assert.equal(resolveApiKey(env(), "Esa-Rijal").apiKey, "key-b");
});

test("akun wajib disebut bila lebih dari satu; key tidak pernah muncul di pesan error", () => {
  assert.throws(() => resolveApiKey(env(), undefined), (e: Error) => /wajib/.test(e.message) && !/key-/.test(e.message));
  assert.throws(() => resolveApiKey(env(), "tidakada"), (e: Error) => !/key-/.test(e.message));
});

test("buffer_list_accounts hanya mengembalikan label, bukan API key", async () => {
  const r = await call("buffer_list_accounts", {}, READ);
  assert.ok(!textOf(r).includes("key-a") && !textOf(r).includes("key-b"));
  assert.match(textOf(r), /kawanceritamu/);
});

// ---------------- scope ----------------

test("tools/list menyembunyikan tool tulis tanpa scope mcp:write", async () => {
  const r = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bufferTools, env(), READ)) as {
    result: { tools: { name: string }[] };
  };
  const names = r.result.tools.map((t) => t.name);
  assert.ok(names.includes("buffer_list_posts"));
  assert.ok(!names.includes("buffer_create_post") && !names.includes("buffer_delete_post"));
});

test("tool tulis ditolak tanpa scope mcp:write, sebelum ada panggilan ke Buffer", async () => {
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("{}");
  }) as typeof fetch;
  try {
    const r = await call("buffer_delete_post", { account: "esa_rijal", postId: "abc" }, READ);
    assert.ok(isErr(r) && /izin/.test(textOf(r)));
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("tanpa scope apa pun, tidak ada tool yang terlihat", async () => {
  const r = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bufferTools, env(), { scopes: [] })) as {
    result: { tools: unknown[] };
  };
  assert.equal(r.result.tools.length, 0);
});

// ---------------- validasi argumen tool ----------------

test("argumen tool divalidasi sebelum menyentuh jaringan", async () => {
  const cases: unknown[] = [
    { account: "esa_rijal", channelId: "../../etc", text: "x" },
    { account: "esa_rijal", channelId: "abc", text: "" },
    { account: "esa_rijal", channelId: "abc", text: "x", imageUrls: ["http://evil/x.jpg"] },
    { account: "esa_rijal", channelId: "abc", text: "x", extra: 1 },
    { account: "esa_rijal", channelId: "abc", text: "x".repeat(10_001) },
    { account: "<script>", channelId: "abc", text: "x" },
    "bukan-objek",
  ];
  const orig = globalThis.fetch;
  globalThis.fetch = (() => assert.fail("tidak boleh fetch")) as typeof fetch;
  try {
    for (const args of cases) assert.ok(isErr(await call("buffer_create_post", args)), JSON.stringify(args).slice(0, 60));
  } finally {
    globalThis.fetch = orig;
  }
});

test("dueAt di masa lalu atau tanpa zona waktu ditolak", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => assert.fail("tidak boleh fetch")) as typeof fetch;
  try {
    for (const dueAt of ["2020-01-01T00:00:00+07:00", "2030-01-01T10:00:00", "besok"]) {
      assert.ok(isErr(await call("buffer_create_post", { account: "esa_rijal", channelId: "abc", text: "x", dueAt })));
    }
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------------- klien Buffer ----------------

test("klien Buffer mengirim Bearer, memakai variabel GraphQL, dan tidak membocorkan detail", async () => {
  const orig = globalThis.fetch;
  let seen: { url: string; auth: string | null; body: { query: string; variables: Record<string, unknown> } } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = {
      url,
      auth: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    };
    return Response.json({ data: { createPost: { __typename: "PostActionSuccess", post: { id: "p1" } } } });
  }) as typeof fetch;
  try {
    const text = 'kutip " dan } { mutation deletePost';
    const r = await call("buffer_create_post", { account: "esa_rijal", channelId: "abc", text });
    assert.ok(!isErr(r), textOf(r));
    assert.equal(seen!.url, "https://api.buffer.com");
    assert.equal(seen!.auth, "Bearer key-b");
    // Teks pengguna tidak pernah disisipkan ke dalam string query.
    assert.ok(!seen!.body.query.includes("kutip"));
    assert.equal((seen!.body.variables.input as { text: string }).text, text);
  } finally {
    globalThis.fetch = orig;
  }
});

test("error Buffer: 401, 429, MutationError ditangani dengan pesan aman", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
    await assert.rejects(bufferGraphQL("k", "query{x}"), /API key/);
    globalThis.fetch = (async () => new Response("", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch;
    await assert.rejects(bufferGraphQL("k", "query{x}"), /30 detik/);
    // Workers menolak redirect "error"; redirect wajib "manual" dan 3xx tidak diikuti.
    let redirectMode: RequestRedirect | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      redirectMode = init.redirect;
      return new Response("", { status: 302, headers: { location: "https://evil.example/" } });
    }) as typeof fetch;
    await assert.rejects(bufferGraphQL("k", "query{x}"), /redirect/);
    assert.equal(redirectMode, "manual");
    globalThis.fetch = (async () => {
      throw new TypeError("internal-secret-detail");
    }) as typeof fetch;
    await assert.rejects(bufferGraphQL("k", "query{x}"), (e: Error) => !e.message.includes("internal-secret-detail"));
  } finally {
    globalThis.fetch = orig;
  }
  assert.throws(() => unwrapMutation({ __typename: "NotFoundError", message: "Channel not found" }, "x"), /Channel not found/);
  assert.throws(() => unwrapMutation({ __typename: "LimitReachedError", message: "queue full" }, "x"), /queue full/);
  assert.equal(unwrapMutation({ __typename: "PostActionSuccess", post: {} }, "x").__typename, "PostActionSuccess");
});

test("kesalahan tak terduga tidak membocorkan pesan internal", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: { createPost: null } })) as typeof fetch;
  try {
    const r = await call("buffer_create_post", { account: "esa_rijal", channelId: "abc", text: "x" });
    assert.ok(isErr(r));
  } finally {
    globalThis.fetch = orig;
  }
});

test("toUtcIso mengonversi WIB ke UTC", () => {
  assert.equal(toUtcIso("2026-11-05T19:30:00+07:00"), "2026-11-05T12:30:00.000Z");
});

// ---------------- HTTP MCP ----------------

const req = (body: string, headers: Record<string, string> = {}, method = "POST") =>
  new Request("https://gate.test/mcp", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body } : {}),
  });
const HOSTS = ["claude.ai", "claude.com"];

test("Origin asing ditolak (anti DNS-rebinding), Origin claude.ai diterima", async () => {
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal((await handleMcpHttp(req(ping, { origin: "https://evil.example" }), bufferTools, env(), ALL, HOSTS)).status, 403);
  assert.equal((await handleMcpHttp(req(ping, { origin: "http://claude.ai" }), bufferTools, env(), ALL, HOSTS)).status, 403);
  assert.equal((await handleMcpHttp(req(ping, { origin: "https://claude.ai" }), bufferTools, env(), ALL, HOSTS)).status, 200);
  assert.equal((await handleMcpHttp(req(ping), bufferTools, env(), ALL, HOSTS)).status, 200);
  assert.equal(originAllowed("null", HOSTS), false);
});

test("hanya POST application/json, body dibatasi, batch dibatasi", async () => {
  assert.equal((await handleMcpHttp(req("", {}, "GET"), bufferTools, env(), ALL, HOSTS)).status, 405);
  assert.equal((await handleMcpHttp(req("{}", { "content-type": "text/plain" }), bufferTools, env(), ALL, HOSTS)).status, 415);
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(MAX_BODY_BYTES) });
  assert.equal((await handleMcpHttp(req(big), bufferTools, env(), ALL, HOSTS)).status, 413);
  assert.equal((await handleMcpHttp(req("{bad json"), bufferTools, env(), ALL, HOSTS)).status, 400);
  const batch = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })));
  assert.equal((await handleMcpHttp(req(batch), bufferTools, env(), ALL, HOSTS)).status, 400);
  const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal((await handleMcpHttp(req(notif), bufferTools, env(), ALL, HOSTS)).status, 202);
});

test("pesan JSON-RPC rusak ditangani tanpa crash", async () => {
  for (const m of [null, 1, "x", [], { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }]) {
    const r = (await handleMessage(m, bufferTools, env(), ALL)) as { error?: unknown };
    assert.ok(r?.error, JSON.stringify(m));
  }
  const unknown = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }, bufferTools, env(), ALL)) as {
    error: { message: string };
  };
  assert.ok(!unknown.error.message.includes("x")); // nama dari penyerang tidak dipantulkan
});

// ---------------- auth helper ----------------

test("redirect hanya ke https host yang diizinkan, pencocokan persis", () => {
  assert.ok(redirectAllowed("https://claude.ai/api/mcp/auth_callback", HOSTS));
  for (const bad of [
    "http://claude.ai/cb",
    "https://claude.ai.evil.com/cb",
    "https://evilclaude.ai/cb",
    "https://user:pw@claude.ai/cb",
    "https://evil.com/?claude.ai",
    "javascript:alert(1)",
    "https://claude.ai@evil.com/cb",
    "https://claude.ai:444/cb",
    "https://claude.ai./cb",
  ]) {
    assert.ok(!redirectAllowed(bad, HOSTS), bad);
  }
});

test("passphrase dibandingkan dengan benar", async () => {
  const p = "a".repeat(40);
  assert.ok(await passphraseMatches(p, p));
  assert.ok(!(await passphraseMatches(p + "b", p)));
  assert.ok(!(await passphraseMatches("", p)));
});

test("passphrase lemah dianggap belum terkonfigurasi", () => {
  assert.equal(ownerPassphrase(env({ OWNER_PASSPHRASE: "a".repeat(40) })), null);
  assert.equal(ownerPassphrase(env({ OWNER_PASSPHRASE: "Ab1!".repeat(5) })), null);
  const good = "k8Fq2!xZr7Lm#Pw4Vn9Ty6Hc3Jd0Su5Ge";
  assert.equal(ownerPassphrase(env({ OWNER_PASSPHRASE: good })), good);
});

test("kunci rate limit IPv6 dipotong ke /64", () => {
  assert.equal(clientKey("2001:db8:aa:bb:1:2:3:4"), "2001:db8:aa:bb::/64");
  assert.equal(clientKey("2001:db8:aa:bb::9"), "2001:db8:aa:bb::/64");
  assert.equal(clientKey("2001:DB8:00aa:bb:ffff::1"), "2001:db8:aa:bb::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey(null), "unknown");
});

test("escapeHtml menetralkan payload XSS", () => {
  const out = escapeHtml(`"><script>alert(1)</script><img src=x onerror='a'>`);
  assert.ok(!/[<>"']/.test(out));
});
