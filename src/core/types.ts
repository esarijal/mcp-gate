/**
 * Tipe dasar yang dipakai semua modul.
 * Sebuah modul (Buffer, Gmail, dst.) cukup mengekspor daftar Tool.
 */

export interface Env {
  /** KV untuk penyimpanan OAuth (wajib). */
  OAUTH_KV: KVNamespace;
  /** Rate limiter untuk endpoint login & registrasi (opsional tapi disarankan). */
  AUTH_LIMITER?: RateLimit;
  /** URL publik Worker, mis. https://mcp-gate.nama.workers.dev */
  PUBLIC_URL?: string;
  /** Passphrase pemilik untuk menyetujui koneksi (minimal 32 karakter). */
  OWNER_PASSPHRASE?: string;
  /** Daftar host redirect yang diizinkan, dipisah koma. Default: claude.ai,claude.com */
  ALLOWED_REDIRECT_HOSTS?: string;
  /** "true" untuk mengaktifkan pendaftaran klien dinamis (DCR). Default mati. */
  ENABLE_DCR?: string;
  /** Secret akun Buffer: BUFFER_KEY_<LABEL>, atau BUFFER_ACCOUNTS (JSON). */
  [key: string]: unknown;
}

export type Scope = "mcp:read" | "mcp:write";
export const ALL_SCOPES: Scope[] = ["mcp:read", "mcp:write"];

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Scope yang dibutuhkan untuk memanggil tool ini. */
  scope: Scope;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>, env: Env) => Promise<ToolResult>;
}

/** Subset JSON Schema yang didukung validator kita (lihat core/validate.ts). */
export interface JsonSchema {
  type: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  format?: "https-url" | "date-time";
}

/** Kesalahan yang pesannya aman dan berguna untuk ditampilkan ke pengguna. */
export class UserError extends Error {}

export function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
