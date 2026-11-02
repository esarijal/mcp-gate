# mcp-gate

Satu gerbang MCP untuk banyak akun. Satu konektor di Claude bisa menjangkau **beberapa akun Buffer sekaligus**
(dan nantinya layanan lain), tanpa gonta-ganti login. Berjalan gratis di Cloudflare Workers dan dilindungi OAuth 2.1.

```
Claude ──OAuth──▶ mcp-gate (Cloudflare Worker) ──API key akun A──▶ Buffer
                                             └──API key akun B──▶ Buffer
```

## Tool yang tersedia

| Tool | Izin | Fungsi |
|---|---|---|
| `buffer_list_accounts` | baca | Daftar label akun yang tersambung |
| `buffer_get_account` | baca | Detail akun dan organisasinya |
| `buffer_list_channels` | baca | Daftar channel (Instagram, Threads, dll.) beserta ID |
| `buffer_list_posts` | baca | Daftar postingan, filter per channel/status |
| `buffer_create_post` | tulis | Buat postingan: antrean, langsung, terjadwal, draf, gambar/video, utas |
| `buffer_edit_post` | tulis | Ubah postingan yang belum tayang |
| `buffer_delete_post` | tulis | Hapus postingan |

Setiap tool punya parameter `account` berisi label akun, misalnya `kawanceritamu` atau `esa_rijal`.

## Yang kamu butuhkan

- Akun Cloudflare (gratis) dan Node.js 22+ di komputermu.
- Satu **API key Buffer per akun**: login ke tiap akun Buffer → Settings → API → buat key.
  Catatan: paket gratis Buffer memberi 1 API key, dan semua key serta koneksi MCP di satu organisasi berbagi kuota
  (150 request per 15 menit, 600 per hari).

## Deploy (sekali saja)

```bash
git clone https://github.com/esarijal/mcp-gate && cd mcp-gate
npm install
npx wrangler login
```

**1. Buat penyimpanan KV untuk OAuth**, lalu tempel `id` yang muncul ke `wrangler.jsonc` (bagian `kv_namespaces`):
```bash
npx wrangler kv namespace create OAUTH_KV
```

**2. Deploy pertama** untuk mendapatkan URL Worker:
```bash
npx wrangler deploy
```
Catat URL-nya, misalnya `https://mcp-gate.namamu.workers.dev`. Ganti nilai `PUBLIC_URL` di `wrangler.jsonc` dengan URL itu.

**3. Isi rahasia.** Passphrase minimal 32 karakter; simpan di password manager.
```bash
openssl rand -base64 33                      # contoh cara membuat passphrase acak
npx wrangler secret put OWNER_PASSPHRASE

# Satu per akun Buffer. Bagian setelah BUFFER_KEY_ menjadi label akun.
npx wrangler secret put BUFFER_KEY_KAWANCERITAMU
npx wrangler secret put BUFFER_KEY_ESARIJAL
```

**4. Deploy ulang** supaya `PUBLIC_URL` terpakai:
```bash
npx wrangler deploy
```

## Menyambungkan ke Claude

**1. Buat kredensial konektor.** Buka `https://mcp-gate.namamu.workers.dev/setup`, masukkan passphrase,
lalu salin **Client ID** dan **Client Secret** yang muncul (secret hanya tampil sekali).

**2. Tambahkan konektor di Claude.** Buka Settings → Connectors → Add custom connector:
- URL: `https://mcp-gate.namamu.workers.dev/mcp`
- Advanced settings: tempel OAuth Client ID dan OAuth Client Secret dari langkah 1.

**3. Klik Connect.** Halaman persetujuan mcp-gate terbuka. Pastikan tujuan akses tertulis `claude.ai`,
pilih izin (baca saja, atau baca + tulis), masukkan passphrase, lalu klik **Izinkan**.

Catatan:
- Menjalankan `/setup` lagi akan **mencabut** kredensial lama beserta semua koneksinya. Pakai ini juga untuk
  memutus semua koneksi kalau curiga ada yang bocor.
- claude.ai dan claude.com memakai kredensial yang sama. Menyambung dari salah satunya akan menggantikan koneksi di yang lain.
- Pendaftaran klien otomatis (DCR) sengaja dimatikan demi keamanan. Kalau aplikasimu tidak punya kolom
  Client ID/Secret, aktifkan dengan var `ENABLE_DCR="true"`. Itu membuka endpoint `/oauth/register` ke publik,
  meski tetap dibatasi rate limit dan allowlist redirect.

## Menambah akun Buffer baru

```bash
npx wrangler secret put BUFFER_KEY_NAMAAKUNBARU
```
Tidak perlu deploy ulang dan tidak perlu menyambung ulang di Claude.

## Menambah layanan lain (Gmail, dll.)

Buat folder `src/modules/<layanan>/` yang mengekspor daftar `Tool` (lihat `src/modules/buffer/tools.ts` sebagai contoh),
lalu daftarkan di `src/modules/index.ts`. Setiap tool wajib punya `scope` (`mcp:read` atau `mcp:write`) dan
`inputSchema` yang ketat; argumen divalidasi otomatis sebelum handler dipanggil.

## Keamanan

Ringkasan kontrol ada di [SECURITY-DESIGN.md](SECURITY-DESIGN.md). Hal yang perlu kamu jaga:

- **Passphrase = kunci semua akun.** Panjang, acak, dan jangan dipakai di tempat lain.
- Beri izin **baca saja** kalau koneksi itu tidak perlu memposting.
- Curiga key bocor? Buat ulang API key di Buffer, lalu `wrangler secret put` lagi.
- Mencabut semua koneksi: jalankan `/setup` lagi. Kalau passphrase yang bocor, ganti dulu `OWNER_PASSPHRASE`.

## Pengembangan

```bash
cp .dev.vars.example .dev.vars     # isi nilai uji; tambahkan PUBLIC_URL=http://localhost:8787
npm run typecheck
npm test                            # tes unit
npm run dev                         # jalankan lokal di http://localhost:8787
BASE=http://localhost:8787 PASS=<passphrase-uji> npm run test:e2e   # tes OAuth & serangan end-to-end
```

Lisensi: MIT
