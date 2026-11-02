import { UserError, type Env } from "../../core/types.ts";

/**
 * Akun Buffer dibaca dari secret berawalan BUFFER_KEY_.
 *   BUFFER_KEY_KAWANCERITAMU=xxx  ->  akun "kawanceritamu"
 *   BUFFER_KEY_ESA_RIJAL=yyy      ->  akun "esa_rijal"
 *
 * Alternatif: satu secret BUFFER_ACCOUNTS berisi JSON {"label": "api-key", ...}.
 * API key tidak pernah dikembalikan ke klien; hanya labelnya.
 */
const PREFIX = "BUFFER_KEY_";
const LABEL_RE = /^[a-z0-9_]{1,40}$/;

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function listAccounts(env: Env): Map<string, string> {
  const accounts = new Map<string, string>();

  const json = env.BUFFER_ACCOUNTS;
  if (typeof json === "string" && json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new UserError("Konfigurasi akun di server tidak valid. Hubungi pemilik gerbang.");
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [label, key] of Object.entries(parsed as Record<string, unknown>)) {
        const norm = normalizeLabel(label);
        if (typeof key === "string" && key && LABEL_RE.test(norm)) accounts.set(norm, key);
      }
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PREFIX) || typeof value !== "string" || !value) continue;
    const norm = normalizeLabel(name.slice(PREFIX.length));
    if (LABEL_RE.test(norm)) accounts.set(norm, value);
  }
  return accounts;
}

export function resolveApiKey(env: Env, account: unknown): { label: string; apiKey: string } {
  const accounts = listAccounts(env);
  if (accounts.size === 0) {
    throw new UserError("Belum ada akun Buffer yang dikonfigurasi di gerbang.");
  }
  const available = [...accounts.keys()].join(", ");

  if (account === undefined || account === null || account === "") {
    if (accounts.size === 1) {
      const [label, apiKey] = [...accounts.entries()][0]!;
      return { label, apiKey };
    }
    throw new UserError(`Parameter "account" wajib diisi. Akun yang tersedia: ${available}.`);
  }

  const label = normalizeLabel(String(account));
  const apiKey = accounts.get(label);
  if (!apiKey) {
    throw new UserError(`Akun tidak ditemukan. Akun yang tersedia: ${available}.`);
  }
  return { label, apiKey };
}
