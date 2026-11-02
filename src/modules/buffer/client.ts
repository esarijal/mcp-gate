import { UserError } from "../../core/types.ts";

/** Klien GraphQL minimal untuk API Buffer (https://developers.buffer.com). */
export const BUFFER_API_URL = "https://api.buffer.com";
const TIMEOUT_MS = 20_000;
const MAX_ERROR_LEN = 300;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export async function bufferGraphQL<T = Record<string, unknown>>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BUFFER_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new UserError(timedOut ? "Buffer tidak merespons (timeout). Coba lagi." : "Tidak bisa menghubungi Buffer.");
  }

  if (res.status === 401 || res.status === 403) {
    throw new UserError("Buffer menolak API key untuk akun ini (401/403). Periksa atau buat ulang API key-nya.");
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new UserError(
      `Batas request Buffer tercapai (429).${retry ? ` Coba lagi dalam ${retry} detik.` : ""} ` +
        "Ingat: semua API key dan koneksi MCP di satu organisasi berbagi kuota yang sama.",
    );
  }

  let body: GraphQLResponse<T>;
  try {
    body = (await res.json()) as GraphQLResponse<T>;
  } catch {
    throw new UserError(`Balasan Buffer tidak bisa dibaca (HTTP ${res.status}).`);
  }

  if (body.errors?.length) {
    const msg = body.errors
      .map((e) => String(e?.message ?? ""))
      .join("; ")
      .slice(0, MAX_ERROR_LEN);
    throw new UserError(`Buffer mengembalikan error: ${msg}`);
  }
  if (!res.ok || !body.data) {
    throw new UserError(`Permintaan ke Buffer gagal (HTTP ${res.status}).`);
  }
  return body.data;
}

/**
 * Mutasi Buffer mengembalikan union: sukses atau MutationError { message }.
 * Fungsi ini melempar UserError kalau yang kembali adalah error.
 */
export function unwrapMutation<T extends Record<string, unknown>>(payload: T | undefined, what: string): T {
  if (!payload) throw new UserError(`Buffer tidak mengembalikan hasil untuk ${what}.`);
  // Query kita selalu meminta __typename. Anggota sukses berakhiran "Success"
  // (PostActionSuccess, DeletePostSuccess); anggota lain adalah MutationError.
  const typename = String(payload.__typename ?? "");
  const message = payload.message as string | undefined;
  if (!typename.endsWith("Success")) {
    const reason = String(message ?? (typename || "alasan tidak diketahui")).slice(0, MAX_ERROR_LEN);
    throw new UserError(`Gagal ${what}: ${reason}`);
  }
  return payload;
}

/** Ubah waktu ISO 8601 (boleh dengan offset, mis. +07:00) menjadi UTC seperti yang diminta Buffer. */
export function toUtcIso(value: unknown, field = "dueAt"): string {
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || !/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    throw new UserError(
      `${field} harus format ISO 8601 lengkap dengan zona waktu, contoh 2026-11-05T19:30:00+07:00.`,
    );
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new UserError(`${field} tidak valid: ${s}`);
  return d.toISOString();
}
