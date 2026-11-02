# Rancangan Keamanan mcp-gate

Dokumen ini menjelaskan ancaman yang dipertimbangkan dan cara mcp-gate menanganinya.
Ini **bukan** pengganti pentest independen.

## Aset yang dilindungi
- API key Buffer setiap akun (bisa memposting atas nama akun-akun tersebut).
- Kemampuan memposting, mengubah, dan menghapus postingan.
- Ketersediaan gerbang (kuota gratis Cloudflare KV: 1.000 tulis/hari).

## Batas kepercayaan
| Pihak | Dipercaya? |
|---|---|
| Pemilik (pemegang `OWNER_PASSPHRASE`) | Ya |
| Klien MCP yang sudah diizinkan pemilik (Claude) | Ya, sebatas scope yang diberikan |
| Siapa pun di internet | Tidak |
| Isi yang dibaca model (postingan, halaman web) | Tidak. Bisa berisi prompt injection |

## Kontrol

### Autentikasi & otorisasi
- **OAuth 2.1** lewat `@cloudflare/workers-oauth-provider` (library resmi Cloudflare): token dan secret disimpan di KV
  hanya sebagai hash, refresh token dirotasi, token terikat ke satu resource (RFC 8707), implicit grant mati.
- **PKCE S256 wajib untuk semua klien**, termasuk klien confidential.
- Tidak ada token di URL. Token hanya diterima lewat header `Authorization: Bearer`.
- **Klien didaftarkan oleh pemilik saja** lewat `/setup` (butuh passphrase), menghasilkan Client ID + Secret.
  Pendaftaran klien anonim (DCR) dan CIMD **dimatikan** secara default.
- Login pemilik memakai `OWNER_PASSPHRASE` (minimal 32 karakter, minimal 10 karakter berbeda), dibandingkan
  sebagai hash SHA-256 dengan perbandingan waktu-konstan. Passphrase baru diperiksa setelah permintaan otorisasi
  tervalidasi.
- **Allowlist redirect** (`ALLOWED_REDIRECT_HOSTS`, default `claude.ai,claude.com`): hanya `https`, host persis,
  tanpa port atau kredensial. Dicek saat otorisasi dan sebelum setiap redirect error (anti open-redirect).
- **Scope**: `mcp:read` (baca) dan `mcp:write` (posting/ubah/hapus). Default yang tercentang hanya scope yang diminta
  (atau baca saja). Tool tulis ditolak tanpa `mcp:write` dan tidak ditampilkan di daftar tool, termasuk lewat batch.

### Ketersediaan
- **Tidak ada penulisan KV sebelum passphrase terverifikasi.** Halaman `/authorize` tidak menyimpan transaksi;
  permintaan divalidasi ulang dari URL setiap langkah.
- Rate limit per IP (IPv6 per /64) untuk `/authorize` dan `/setup`.
- Panggilan ke Buffer memakai timeout 20 detik dan tidak mengikuti redirect.

### Halaman HTML
- Semua data dari klien di-escape (anti-XSS).
- CSP ketat (`default-src 'none'`, `frame-ancestors 'none'`, `form-action` hanya ke diri sendiri + host redirect),
  `X-Frame-Options: DENY`, `Cache-Control: no-store`.
- CSRF tidak relevan karena setiap aksi membutuhkan passphrase di form yang sama.

### Endpoint MCP
- Validasi header `Origin` (anti DNS-rebinding, sesuai spesifikasi MCP).
- Hanya host `PUBLIC_URL` yang dilayani.
- Hanya `POST` + `application/json`, batas body 64 KB (dihitung dari stream, bukan header), batas batch 10 pesan.
- Setiap argumen tool divalidasi ketat (tipe, panjang, pola, enum, URL https tanpa kredensial, tanpa properti asing).
- Query GraphQL konstan; data pengguna hanya lewat variabel (anti-injeksi). Tidak ada tool GraphQL bebas.
- Pesan error tidak membocorkan detail internal atau API key.

### Rahasia & log
- Semua rahasia disimpan sebagai Cloudflare Secret, tidak pernah di kode/repo.
- Log invocation Workers dimatikan. Kode hanya mencatat teks tetap dan kode alasan, tidak pernah token, key, atau passphrase.

## Pengujian
- `npm test`: 22 tes unit (validator, scope, Origin, batas body, kebocoran key, allowlist redirect, XSS escape, dll.).
- `npm run test:e2e`: 23 skenario serangan terhadap Worker yang berjalan di runtime Cloudflare lokal
  (token palsu, kode dipakai ulang, PKCE dilewati, klien lain menukar kode, brute force, open redirect, scope escalation, dll.).
- Review keamanan independen oleh agen terpisah; temuannya sudah diperbaiki dan diverifikasi ulang.

## Risiko tersisa
- **Prompt injection**: model yang diberi izin tulis bisa dibujuk konten berbahaya untuk memposting.
  Mitigasi: anotasi `destructiveHint`, peringatan di deskripsi tool, dan pilihan memberi izin baca saja.
- **Phishing tautan otorisasi**: penyerang bisa mengirim tautan `/authorize` dari konektor Claude miliknya.
  Mitigasi: peringatan di halaman, dan ID klien ditampilkan; pemilik hanya memasukkan passphrase setelah menekan
  "Connect" sendiri. Klien tanpa Client Secret yang benar tetap tidak bisa menukar kode.
- Rate limit Cloudflare bersifat perkiraan dan per lokasi. Pertahanan utama tetap passphrase yang panjang dan acak.
- Pemegang passphrase memegang semua akun. Simpan di password manager.
- Keamanan sisi Buffer berada di luar kendali sistem ini; rotasi API key bila curiga.
