# Gap Tracker — live-manager-2 vs StreamFlow

Dibuat 2026-08-31. Update tiap ada progress: pindahkan item antar section, jangan hapus histori DONE/FINDING.

## TODO (urut prioritas)

_(kosong — seluruh gap yang disepakati sudah dikerjakan)_

### Dropped
- ~~Multi-user/team management (role, kuota per-user, status)~~ — **di-skip atas keputusan user (2026-08-31)**. Single-operator, kolom `role` di skema biarkan dead code, jangan dibangun.
- ~~Impor dari Mega.nz~~ — **di-skip atas keputusan user (2026-09-01)**. Google Drive sudah cukup sebagai sumber cloud. Kalau suatu saat dibutuhkan: wajib dependency `megajs`, sebab protokol Mega memakai enkripsi sisi klien sendiri — tidak ada jalan "tulis sendiri" yang wajar seperti pada disk/bandwidth/TUS.

## IN PROGRESS
_(kosong)_

## DONE

### Impor video dari Google Drive — 2026-08-31
Nol dependency baru: `googleapis` sudah ada, dan koneksi OAuth YouTube yang ada
dipakai ulang — `include_granted_scopes: true` memang sudah aktif sejak awal.
- `services/youtube.js` — `drive.readonly` ditambahkan ke `SCOPES`.
  **Konsekuensi untuk pengguna**: akun yang sudah terhubung sebelum ini tidak
  punya izin Drive dan harus dihubungkan ulang. Akun lama tetap berfungsi penuh
  untuk rotasi; hanya impor Drive-nya yang tidak aktif, dan UI mengatakan persis
  itu, bukan sekadar "gagal".
- `services/drive.js` (baru) — daftar/cari video (termasuk Shared Drive), ambil
  metadata, unduh sebagai stream. Dibangun di atas `youtube.clientForAccount`
  sehingga penyegaran token dan penyimpanan token terenkripsi ikut terpakai.
  Tanda kutip pada kata kunci dilolosi sebelum masuk query Drive.
- `services/videoImport.js` (baru) — unduhan berkas gigabyte tidak muat dalam
  satu siklus permintaan-jawaban, jadi berjalan di latar dengan job berstatus
  (`downloading` → `processing` → `done`/`error`) yang dipantau lewat polling.
  Job sengaja hanya di memori: kalau aplikasi mati, sumbernya masih utuh di
  Drive dan pengguna tinggal mengulang — beda dari unggahan berpotongan yang
  memang harus tahan restart karena berkasnya ada di sisi klien.
- `services/videoIngest.js` (baru) — pipeline pasca-berkas (magic byte →
  ffprobe → thumbnail → simpan) **dipindahkan keluar dari route** supaya ketiga
  jalur (multipart, berpotongan, impor) memakai satu jalur yang sama. Ini yang
  membuat berkas dari Drive tidak bisa lolos tanpa pemeriksaan isi.
- `routes/videos.js` + `views/videos/index.ejs` — modal daftar Drive dengan
  pencarian, tombol impor, dan tampilan kemajuan yang bertahan saat halaman
  dibuka ulang. Kelas modal digeneralkan (`.preview-*` → `.modal-*`) supaya
  dipakai bersama modal pratinjau, bukan menduplikasi CSS.
- Tes 35/35 pass (akses Drive di-patch ke sumber lokal supaya seluruh pipeline
  teruji tanpa OAuth): prasyarat izin (dua pesan berbeda untuk "belum ada akun"
  vs "akun belum diberi izin"), daftar & pencarian, siklus job sampai selesai,
  **byte identik dengan sumber (sha256)**, ffprobe/thumbnail terisi, berkas
  palsu berekstensi `.mp4` ditolak dengan berkas dibersihkan, kepemilikan job
  (pengguna lain tidak bisa melihat/membuang), dan CSRF.

### Unggahan berpotongan yang bisa dilanjutkan — 2026-08-31
Batas unggahan bawaan aplikasi ini **4 GB** (`MAX_UPLOAD_MB`), dan sebelumnya
koneksi putus di tengah berarti mengulang dari nol.
- **Tidak memakai TUS**, meski itu yang dipakai StreamFlow. Penentunya bukan soal
  selera: project ini tanpa build step, jadi `tus-js-client` hanya bisa masuk
  lewat CDN (melanggar prinsip offline-safe) atau vendor bundle. Kalau klien TUS
  harus ditulis tangan, memakai `@tus/server` di backend kehilangan gunanya.
  Hasilnya: protokol potongan sendiri, nol dependency.
- `services/chunkUpload.js` (baru) — unggahan parsial sebagai pasangan
  `<id>.part` + `<id>.json` di `storage/tmp`. Kemajuan = ukuran berkas `.part`
  itu sendiri, jadi tetap benar meski aplikasi direstart di tengah unggahan.
  Server yang memegang offset; klien hanya mengusulkan. Ada kunci per-id supaya
  dua permintaan bersamaan tidak menulis dobel, dan id divalidasi ketat sebab
  ia dipakai menyusun path.
- `routes/videos.js` — `POST /upload/init`, `GET/PUT/DELETE /upload/:id`,
  `POST /upload/:id/finish`. Pipeline pasca-unggah (`registerVideo`) **diekstrak
  dan dipakai bersama** jalur multipart lama supaya keduanya tidak bisa berbeda
  perlakuan; pemeriksaan magic byte dipakai ulang lewat `contentError()` yang
  baru diekspor dari `middleware/upload.js`.
- `public/js/app.js` — `LM.resumableUpload()`: potongan 8 MB, mundur bertahap
  saat gagal, dan menyambung dari offset yang diakui server. Id disimpan di
  localStorage sehingga berkas yang sama masih bisa disambung setelah halaman
  dimuat ulang. Tanpa `File.slice`, formulir jatuh kembali ke multipart lama.
- `services/scheduler.js` — `chunkUpload.sweep()` ikut pembersihan harian;
  tanpa itu unggahan gagal menumpuk diam-diam di `storage/tmp`.
- Tes 39/39 pass: protokol lengkap, resume setelah "putus", offset usang/melompat
  ditolak dengan posisi benar, kepemilikan (pengguna lain tidak bisa melihat,
  menyambung, atau menyelesaikan unggahan orang lain), id berbentuk path ditolak,
  finish sebelum lengkap → 409, **hasil akhir identik byte-per-byte dengan sumber
  (sha256)**, konten palsu tetap ditolak di jalur baru, pembatalan, CSRF, sweep,
  plus regresi jalur multipart lama.

**Bug yang ditemukan & diperbaiki saat pengujian**: `fetch()` mengirim
`Accept: */*`, sedangkan `wantsJson()` (`middleware/auth.js:54`) hanya mengenali
JSON dari header `Accept`. Akibatnya setiap error dari endpoint API berubah jadi
redirect HTML dan pesannya tidak pernah sampai ke klien. Diperbaiki dengan
mengirim `Accept: application/json` di `LM.resumableUpload` **dan** `LM.post`
(yang punya cacat laten sama).

### Bandwidth keluar di dashboard — 2026-08-31
Node tidak punya API bawaan untuk throughput network (beda dengan disk yang
ternyata punya `fs.statfsSync`), jadi ini keputusan user: **pilih sumber bitrate
FFmpeg, tanpa dependency** — bukan `systeminformation` seperti StreamFlow.
Konsekuensi yang disepakati: mengukur trafik siaran aplikasi ini saja (bukan
total mesin), dan bernilai 0 saat tidak ada siaran.
- `services/streamManager.js` — `parseBitrate()` ("2500.3kbits/s" → 2500300) dan
  `egress()` yang menjumlahkan bitrate seluruh siaran berjalan. Data ini memang
  sudah di-parse di `STATS_RE` (baris 117) sejak awal, cuma belum diagregasi.
  Siaran yang belum melapor bitrate dilewati, bukan dihitung nol.
- `utils/helpers.js` — `formatBitrate()`, kelipatan 1000 (konvensi jaringan),
  sengaja berbeda dari `formatBytes` yang memakai 1024.
- `routes/api.js` mengirim `egress.text` yang sudah diformat server supaya
  formatter tidak perlu ditulis ulang di klien; dashboard memperbaruinya lewat
  polling `/api/overview` yang sudah ada.
- Tes 31/31 pass: 14 kasus `parseBitrate` (termasuk "N/A", string kosong, null,
  satuan salah), 8 `formatBitrate`, `egress()` tanpa siaran, plus integrasi
  dashboard plus `/api/overview` dengan `egress` dipatch bernilai nyata.
- Format token diverifikasi ke FFmpeg sungguhan, bukan diasumsikan: keluaran
  nyata `"235.9kbits/s"` → 235900.

### Pratinjau video di galeri — 2026-08-31
- **Memakai `<video>` bawaan browser, bukan video.js.** Kontrol bawaan sudah
  punya scrub/volume/kecepatan/fullscreen, sementara video.js berarti CDN
  (melanggar prinsip offline-safe di `icon.ejs`) atau vendor ~1 MB ke repo
  tanpa build step. Penting: video.js **tidak** akan menambah dukungan format —
  ia memakai codec browser yang sama.
- `public/js/app.js` — `LM.preview(src, title)` membangun modal (DOM dibuat
  lewat createElement/textContent, bukan innerHTML, supaya judul video tidak
  bisa jadi jalur XSS), plus pemicu delegasi `[data-preview-src]`. Esc, klik
  backdrop, dan tombol Tutup semuanya menutup; saat ditutup `src` dikosongkan
  supaya unduhan berhenti, bukan sekadar dijeda.
- `views/videos/index.ejs` — thumbnail jadi tombol dengan ikon play saat disorot.
  `public/css/app.css` — gaya modal + badge play.
- mkv/avi/flv/ts/mpg tidak bisa diputar browser mana pun: event `error` pada
  `<video>` menampilkan penjelasan + tautan unduh, dengan pesan tegas bahwa
  file tetap sah dan tetap bisa disiarkan FFmpeg.
- Tes 12/12 pass: markup galeri, `data-preview-src` menunjuk file video (bukan
  thumbnail), judul bertanda kutip lolos escaping, `/media` menjawab **206
  Partial Content** untuk Range request (syarat mutlak scrub) dan tetap menolak
  akses tanpa sesi (302).
- **Belum teruji otomatis**: pemutaran nyata di browser dan cabang fallback
  `error` — tidak ada jsdom/browser headless di sini, dan saya tidak menambah
  dependency untuk itu. Perlu pengecekan manual sekali di browser.

### Disk space monitoring asli — 2026-08-31
Sebelumnya "Storage" cuma menjumlahkan folder video/thumbnail aplikasi, jadi disk
server bisa penuh tanpa peringatan apa pun.
- `services/system.js` — `diskUsage()` baru memakai `fs.statfsSync` pada partisi
  tempat `config.paths.storage` berada; `snapshot()` menambah field `disk`
  (field lama tidak diubah, consumer aman). Tanpa dependency baru — StreamFlow
  memakai `systeminformation` untuk ini.
- `fs.statfs` baru ada di Node 18.15 sedangkan `engines` masih `>=18.0.0`, jadi
  ketiadaannya dan filesystem yang menolak statfs menghasilkan `null`, bukan crash;
  UI menampilkan "tidak terbaca di sistem ini".
- `views/dashboard.ejs` — baris Disk (sisa/total + meter + persen) di kartu Sistem,
  plus banner peringatan saat pemakaian ≥90% yang mengarahkan ke galeri.
- Impact analysis: LOW (`snapshot` → `routes/api.js`, `routes/dashboard.js`;
  perubahan aditif). `detect_changes` scope=all: risk low, 0 process terdampak.
- Tes 26/26 pass: 11 unit (konsistensi total/used/free/percent, fallback saat
  `statfsSync` tidak ada, fallback saat statfs melempar error), 9 integrasi
  dashboard + `/api/overview`, 6 untuk cabang peringatan ≥90% (di-boot dengan
  `snapshot` yang di-patch supaya kondisi disk penuh bisa diuji sungguhan).

### UI drag-and-drop reorder varian rotasi — 2026-08-31
Endpoint `POST /:id/items/reorder` akhirnya punya UI; sebelumnya urutan hanya bisa
diatur lewat urutan pembuatan.
- `public/js/app.js` — handler generik `[data-sortable]` (baris `[data-sort-id]`,
  pegangan `[data-sort-handle]`, nomor `[data-sort-index]`), mengikuti pola
  `data-tab`/`data-counter`/`data-toggles` yang sudah ada. HTML5 drag-and-drop
  native, tanpa library. Simpan lewat `LM.post` (otomatis kirim `X-CSRF-Token`),
  dilewati kalau urutan tidak berubah.
- `views/rotations/detail.ejs` — wadah + atribut per baris, `.idx` jadi pegangan.
- `views/partials/icon.ejs` — ikon `grip` baru. `public/css/app.css` — nomor
  berganti jadi grip saat baris disorot, `.dragging` diredupkan.
- Impact analysis: LOW (`reorderItems` → 2 caller langsung, 0 process terdampak);
  perubahan lain murni aditif (template/CSS/JS baru).
- Tes integrasi 15/15 pass: boot app sungguhan + login + render + simpan urutan +
  reload. Termasuk verifikasi endpoint menolak request tanpa CSRF (403) dan
  urutan tidak berubah karenanya. DB dibackup & dikembalikan, tidak tersentuh.
- Batasan diketahui: HTML5 DnD tidak jalan di layar sentuh (app ini panel admin
  desktop; sebelumnya tidak ada cara reorder sama sekali, jadi tetap peningkatan).

### Validasi upload pakai magic byte — 2026-08-31
Ekstensi tidak lagi dipercaya; isi file diperiksa dari signature.
- `utils/filetype.js` (baru) — sniffing 384 byte pertama, tanpa dependency baru.
  Tercakup: MP4/MOV, Matroska/WebM, AVI, FLV, MPEG-TS, MPEG-PS, JPEG, PNG, WebP —
  seluruh isi `VIDEO_EXT` + `IMAGE_EXT`.
- `middleware/upload.js` — `verifyVideoContent` / `verifyImageContent`, dipasang
  setelah `csrf.verify` di 5 endpoint upload (`routes/videos.js` ×1,
  `routes/rotations.js` ×4). Satu file busuk membatalkan seluruh batch.
- Impact analysis: LOW (`extensionFilter`, `handleUploadError` → cuma 2 file route,
  0 process terdampak).
- Tes: 25/25 pass — 11 file media asli hasil ffmpeg diterima, 6 file palsu
  (PE/ELF executable, PHP shell, ZIP, teks polos, file kosong) ditolak 400,
  PNG yang dinamai `.mp4` ditolak, file hilang dari disk tidak bikin crash.

## FINDINGS
Hasil investigasi gap-analysis (GitNexus query/FTS lagi degraded di mesin ini — DLL OpenSSL/VC++ Redist hilang, jadi verifikasi pakai grep + context() manual per simbol, bukan semantic search):

- **Auto-restart ffmpeg crash**: live-manager-2 (`services/streamManager.js` `handleExit`) event-driven via `proc.on('close')`, exponential backoff (5s→120s, max 10x). Lebih matang dari StreamFlow (flat 3s retry). Yang StreamFlow punya dan live-manager-2 nggak: deteksi proses "hidup tapi macet" (polling `lastActivity` staleness tiap interval). Minor gap, bukan prioritas.
- **Shuffle rotasi**: sudah ada (`services/rotationEngine.js`, `models/rotation.js`) — bukan gap.
- **Enkripsi credential/stream key**: sudah ada (`utils/crypto.js`) — bukan gap.
- **CSRF protection**: sudah ada, custom middleware (`middleware/csrf.js`) — bukan gap.
- **Audio codec compatibility check (AAC untuk copy-mode)**: sudah ada (`services/ffmpeg.js` `isFlvSafeAudio`), malah lebih permisif (izinkan MP3 juga) — bukan gap.
- **Search video di galeri**: sudah ada tapi server-side (`?q=` + reload), StreamFlow client-side live-filter. Beda UX, bukan gap fitur.
- **`role` di tabel users**: kolom ada (`db/migrate.js`) tapi dead code, nggak pernah dibaca di route manapun. Konfirmasi hasil audit multi-user gap (sekarang di-drop, lihat section Dropped).
- **Pembersihan file unggahan yatim sudah ada**: `middleware/errors.js` `cleanupUploads()` menghapus `req.file`/`req.files` dari disk tiap kali request berakhir dengan error. Jadi middleware baru cukup `next(err)` — tidak perlu `unlinkSync` sendiri (versi pertama saya duplikat ini, sudah dibuang). Berlaku juga untuk kegagalan CSRF: file tidak menumpuk.
- **`file-type` (dipakai StreamFlow) ESM-only sejak v17**: bakal butuh `await import()` di codebase CJS ini. Signature media itu himpunan kecil dan stabil, jadi ditulis sendiri di `utils/filetype.js` — sejalan dengan pola project (CSRF, session store, system monitor juga ditulis sendiri).
- **`.mpg`/`.mpeg` tidak bisa dites dengan `rate=10`**: encoder MPEG-1/2 menolak framerate itu ("MPEG-1/2 does not support 10/1 fps"). Pakai `rate=25` kalau perlu bikin fixture MPEG-PS lagi.
- **Cara menjalankan app untuk tes**: `app.js` hanya listen kalau jadi main module (`require.main === module`). Dari skrip lain: `require('./app.js').boot()`. Berguna untuk mem-patch modul (mis. `system.snapshot`) sebelum boot demi menguji cabang yang sulit dibuat nyata.
- **DB tidak punya override env**: `config.paths.db` hardcoded ke `db/livemanager.db`, jadi tes integrasi apa pun menyentuh DB kerja. Pola yang dipakai di sini: backup file DB → jalankan tes → restore (plus hapus `-wal`/`-shm`). Kalau nanti tes makin sering, pertimbangkan menambah env `DB_PATH`.
- **Nilai disk mesin dev (2026-08-31)**: partisi D: 931,5 GB, terpakai 17,1% — jadi cabang peringatan ≥90% tidak akan pernah muncul secara alami saat tes.
- **`detect_changes` bisa memberi HIGH risk palsu dari baris `module.exports`**: menambah nama ke daftar export membuat baris itu berubah, dan GitNexus mengatribusikan perubahan baris tersebut ke SEMUA simbol yang namanya tersebut di situ. Saat `egress`/`parseBitrate` ditambahkan, `recoverOnBoot` dan `shutdown` ikut ditandai "touched" → risk HIGH, 7 proses Boot terdampak, padahal `git diff -U0` membuktikan bodinya tidak tersentuh (cuma bergeser 30 baris). Cara memastikannya: `git diff -U0 <file>` untuk melihat hunk sebenarnya, lalu uji perilaku simbol yang ditandai. Sudah diverifikasi dengan tes khusus `recoverOnBoot` (9/9 pass: stream `live` yang tertinggal → `idle` bila auto_restart, `error` + pesan sebab bila tidak, pid dibersihkan, log peringatan tertulis). Jangan otomatis menganggap HIGH di sini sebagai bahaya nyata — tapi jangan pula melewatinya tanpa bukti.
- **Node tidak punya API bawaan untuk throughput network**: `os.networkInterfaces()` hanya memberi alamat, bukan penghitung byte. Pilihannya cuma dependency (`systeminformation`), kode per-OS (`/proc/net/dev` + PowerShell), atau sumber lain. Dipilih: agregasi bitrate FFmpeg. Kalau nanti butuh total trafik mesin (bukan cuma siaran), keputusan ini perlu ditinjau ulang.
- **`fetch()` + penanganan error server**: `wantsJson()` (`middleware/auth.js:54`) menilai dari `req.xhr`, awalan path `/api/`, atau header `Accept`. `fetch()` mengirim `Accept: */*`, jadi endpoint JSON di luar `/api/` mengembalikan **redirect HTML** saat error dan pesannya hilang. Setiap pemanggil fetch harus menyertakan `Accept: application/json`. Sudah diperbaiki di `LM.post` dan `LM.resumableUpload`; ingat ini kalau menambah pemanggil baru.
- **Require dari scratchpad**: modul project bisa di-require lewat path absolut, tapi dependency-nya (mis. `better-sqlite3`) tidak — harus ditunjuk ke `<ROOT>/node_modules/<nama>` karena resolusi mengikuti lokasi file skrip, bukan cwd.
