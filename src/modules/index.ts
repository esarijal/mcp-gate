import type { Tool } from "../core/types.ts";
import { bufferTools } from "./buffer/tools.ts";

/**
 * Daftar semua modul yang aktif di gerbang.
 * Menambah layanan baru: buat folder src/modules/<nama>/ yang mengekspor Tool[],
 * lalu tambahkan di sini. Beri nama tool berawalan <nama>_ agar tidak bentrok.
 */
export const allTools: Tool[] = [...bufferTools];

const names = new Set<string>();
for (const t of allTools) {
  if (names.has(t.name)) throw new Error(`Nama tool ganda: ${t.name}`);
  names.add(t.name);
}
