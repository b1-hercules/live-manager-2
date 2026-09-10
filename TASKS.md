# Gap Tracker — live-manager-2 vs StreamFlow

Dibuat 2026-08-31. Update tiap ada progress: pindahkan item antar section, jangan hapus histori DONE/FINDING.

## TODO (urut prioritas)

_(kosong — gap yang disepakati sudah dikerjakan)_

### Dropped
- ~~Multi-user/team management (role, kuota per-user, status)~~ — **di-skip atas keputusan user (2026-08-31)**. Single-operator, kolom `role` di skema biarkan dead code, jangan dibangun.
- ~~Impor dari Mega.nz~~ — **di-skip atas keputusan user (2026-09-01)**. Google Drive sudah cukup sebagai sumber cloud. Kalau suatu saat dibutuhkan: wajib dependency `megajs`, sebab protokol Mega memakai enkripsi sisi klien sendiri — tidak ada jalan "tulis sendiri" yang wajar seperti pada disk/bandwidth/TUS.

## IN PROGRESS

### Siaran ala radio (musik + gambar + spektrum) — dirancang 2026-09-10

Diminta user: siaran dari daftar musik, bukan berkas video jadi, dengan latar
gambar bergantian dan overlay spektrum audio yang **letak dan ukurannya bisa
diatur**. Syarat mutlak: siaran MP4 yang sudah ada **harus tetap jalan** — ini
mode ketiga yang hidup berdampingan, bukan penggantian mesin.

**Lapisan media: SELESAI** (lihat DONE). **Mesin siaran: belum dikodekan.**

#### Cetak biru diambil dari proyek yang sudah terbukti

User menunjuk `D:LIVE-v2morning-stillness-live-v2` — liquidsoap + ffmpeg
yang sudah berjalan berjam-jam di produksi. Membaca `config/radio.liq` dan
`scripts/stream.sh` di sana **mengoreksi rancangan awal saya** dan menjawab
seluruh pertanyaan terbuka. Jangan merancang ulang dari nol; sadur dari sana.

**KOREKSI TERPENTING — harbor, bukan selang.** Rancangan awal saya
menyambungkan liquidsoap ke FFmpeg lewat pipe stdout→stdin. Itu salah untuk
siaran 24/7. Yang terbukti memakai `output.harbor` (server HTTP kecil di dalam
liquidsoap sendiri, bukan Icecast terpisah), dan FFmpeg membacanya dengan:

    -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2 -i http://127.0.0.1:PORT/...

Kalau liquidsoap tersendat atau restart, FFmpeg **menyambung ulang sendiri**.
Selang tidak bisa: pipe putus = FFmpeg mati. Inilah jawaban sesungguhnya atas
"kenapa tahan berjam-jam" — pilihan rancangan, bukan keberuntungan. Harganya
audio dikemas ulang jadi MP3 192k di tengah; ketahanan lebih berharga daripada
satu generasi kompresi di sini.

#### Yang WAJIB disadur (tidak akan ditemukan dengan menebak)

- `-thread_queue_size 512` pada input live
- Latar gambar **di-pre-render jadi BMP** sekali, bukan dipakai sebagai PNG:
  `-loop 1` membongkar ulang berkasnya SETIAP frame (24×/detik); BMP nyaris
  sekadar salin memori
- `eof_action=endall` pada overlay latar↔spektrum — tanpa ini, saat latar habis
  sementara audio terus mengalir, FFmpeg membeku di frame terakhir selamanya
- **Menyamakan fps pada setiap overlay yang di-loop** — jebakan pertumbuhan
  memori ffmpeg (framesync menyulam dua clock berbeda melintasi tiap
  `-stream_loop`). Ini inti ketahanan berjam-jam
- liquidsoap: `mksafe` (sumber tidak mati saat gagal) dan
  `normalize(target=-14.0)` (volume antar lagu rata)
- Setelan spektrum yang sudah matang: `ascale=cbrt:fscale=log:averaging=2`,
  `colorkey=0x000000:0.08:0.0` (toleransi 0.30 terlalu longgar),
  `colorchannelmixer=aa=0.45`, dan mode cermin (crop separuh → hflip → hstack)
- `colors` pada showfreqs menerima **daftar per kanal** (`0xRRGGBB|0xRRGGBB`),
  bukan satu nilai — satu nilai diabaikan diam-diam, spektrum keluar putih

#### Yang SENGAJA TIDAK dibawa (keputusan user, 2026-09-10)

Perancah yang sudah ada padanan lebih baiknya di sini:

| Proyek lama | Padanan di sini |
|---|---|
| `secrets/*.txt` kunci teks polos | terenkripsi di `destinations` |
| `while true; sleep 5` | `handleExit`: backoff 5→120 dtk, maks 10× |
| systemd unit per orientasi | kolom `orientation` + `RESOLUTIONS` |
| `.env` + `layout.env` | database + halaman Pengaturan |
| `web/app.py` (panel Flask) | aplikasi ini sendiri |
| `bin/*.sh` | `streamManager` men-spawn langsung |

Dan fitur yang **ditolak user secara eksplisit**: watchdog, teks "now playing",
logo, CTA gif, VFX kilau, tombol Skip lewat telnet. Jangan diam-diam
menambahkannya. Konsekuensi tanpa watchdog, disepakati: siaran yang macet di
"preparing stream" (FFmpeg tetap mengirim, YouTube tidak live) tidak akan
terdeteksi. Modalnya sudah ada (`detectActiveBroadcast`) kalau nanti berubah
pikiran.

Akibat pemangkasan itu skrip liquidsoap menyusut ~sepertiga dan rangkaian
filter tinggal: latar → skala/crop → fps, spektrum → colorkey → overlay.

#### Rancangan yang disepakati

- **Sumber radio** = `streams.playlist_id` menunjuk playlist ber-`kind='audio'`.
  Tidak perlu kolom pembeda baru; `models/stream.js` sudah JOIN `playlists`,
  cukup ikut mengambil `pl.kind`.
- **Gambar latar**: tabel baru `stream_backgrounds(stream_id, filepath, position)`
  — keputusan user 2026-09-10. Memakai ulang `uploadThumbnails.array(...,30)` +
  `verifyImageContent` yang sudah teruji, dan `probe()` tidak perlu disentuh
  sama sekali (gambar tak punya durasi/fps/codec), sehingga `kind` tetap dua
  nilai saja.
- **Daftar lagu untuk liquidsoap** ditulis sebagai berkas daftar per-stream,
  pola yang sama dengan `concatPathFor()`. Dengan `reload_mode="watch"`,
  mengubah playlist lewat UI membuat berkas itu ditulis ulang dan liquidsoap
  memungutnya **tanpa memutus siaran** — inilah janji yang membuat liquidsoap
  dipilih. (`watch` berbasis notifikasi filesystem, bukan polling: nol kerja
  saat tidak ada perubahan.)
- **Urutan mematikan**: FFmpeg dulu, baru liquidsoap. Karena `-reconnect`,
  membunuh liquidsoap lebih dulu hanya membuat FFmpeg berputar mencoba
  menyambung.
- **Port harbor** perlu dialokasikan per siaran dan tidak boleh bentrok.

#### Kemajuan

**Langkah 1-3 SELESAI (2026-09-10), teruji di Windows tanpa liquidsoap.**

- **Migrasi v6** — tabel `stream_backgrounds(stream_id, filepath, position)` plus
  kolom setelan spektrum di `streams` (`spectrum_mode`, `_x`, `_y`, `_width`,
  `_height`, `_color`, `_mirror`) dan `background_rotate_minutes`. Semuanya
  bernilai bawaan, jadi baris lama benar tanpa disentuh. `spectrum_x` NULL
  berarti "di tengah mendatar".
- **`services/liquidsoap.js` (baru)** — menyusun skrip .liq dan berkas daftar lagu
  per siaran, alokasi port harbor, spawn, dan penyapuan berkas yatim (pola yang
  sama dengan `sweepConcatFiles`). Harbor diikat ke 127.0.0.1; bawaan liquidsoap
  0.0.0.0 akan membuat audio siaran bisa didengarkan siapa pun.
- **`services/ffmpeg.js`** — `buildRadioArgs()` sebagai **fungsi baru terpisah**,
  bukan cabang di dalam `buildArgs()`. Impact analysis `buildArgs` mengembalikan
  **HIGH** (23 simbol; proses `startDueStreams`, `commandPreview`, `timer` — yaitu
  start terjadwal, pratinjau, dan auto-restart). Menyisipkan cabang di sana berarti
  mempertaruhkan seluruh siaran video demi fitur baru. Dibuktikan aman: md5 badan
  `buildArgs` sebelum dan sesudah **identik** (`f6ff7f2cbd08378bd63f9a1428f5dcd3`).
  Pemilihan jalur nanti dilakukan `streamManager` di langkah 4. Ikut ditambahkan:
  `radioCanvas`, `buildSpectrumFilter`, `spectrumColor`, `buildBackgroundList`,
  `prerenderBackground`, `cleanupBackgroundList`.
- **`tests/test-radio.js` (baru)** — 37/37 pass. Liquidsoap tidak dibutuhkan:
  harbor digantikan server HTTP yang lajunya dibatasi seperti MP3 192 kbps, dan
  itulah yang membuat pengujian pacing berarti. Meliputi render sungguhan
  (pergantian latar tepat waktu 4/4 termasuk setelah loop), ambang realtime, dan
  kontrol senyap untuk membuktikan spektrum bereaksi pada audio.

**Langkah 4 (streamManager mengawasi 2 proses) belum dikerjakan** — ini bagian
paling berisiko; jalankan impact analysis dulu dan berhenti kalau HIGH/CRITICAL.
Berikutnya lagi: UI, lalu Dockerfile.

**Langkah 4 SELESAI (2026-09-10) — streamManager mengawasi dua proses.**

- **`models/streamBackground.js` (baru)** — CRUD gambar latar per siaran.
- **`services/streamManager.js`** — `isRadioStream()`, `resolveRadioSource()`,
  `prepareRadioFiles()`, `cleanupRadioFiles()`, `cleanupStreamFiles()`,
  `handleLiquidsoapOutput()`. Percabangan radio dipasang di `start()` dan
  `commandPreview()`; `launch()` menjalankan liquidsoap lalu FFmpeg.

  **`resolveSource()` TIDAK disentuh** — impact analysis atasnya HIGH (16 simbol;
  proses `startDueStreams`, `commandPreview`, `timer`). Dibuktikan dengan
  membandingkan isinya terhadap git, mengabaikan akhir-baris: IDENTIK. Begitu
  pula `buildArgs()` di ffmpeg.js. Pola ini dipakai dua kali sekarang dan
  terbukti: kalau sebuah simbol HIGH menghalangi, tambah fungsi baru dan
  pindahkan percabangannya ke pemanggil — jangan menyisipkan cabang ke dalamnya.

  Keputusan pengawasan proses yang perlu diingat:
  - Liquidsoap mati duluan → FFmpeg ikut dimatikan, SENGAJA, supaya penanganannya
    jatuh ke `handleExit` yang sudah ada berikut backoff-nya, bukan jalur baru.
  - `handleExit` selalu mematikan liquidsoap di semua cabang; yang lama hanya
    akan menahan port harbor-nya.
  - FFmpeg gagal di-spawn → liquidsoap yang terlanjur hidup ikut dimatikan.
  - Port harbor dipertahankan lintas auto-restart; kalau tidak, tiap putaran
    restart membakar satu port baru sampai rentangnya habis.
  - Log liquidsoap TIDAK boleh lewat `handleOutput`: penyaringnya mencatat setiap
    baris bermuatan kata "error" ke database, dan liquidsoap rutin mencetaknya
    saat berjalan normal.

- **`tests/test-radio-manager.js` (baru)** — 26/26 pass.
- **`tests/test-concat-cleanup.js` DISUNTING**: asersi pesan log saat boot
  dilonggarkan ke bagian yang stabil. Penyapuan boot kini menghitung dua jenis
  berkas (daftar concat video DAN berkas radio), jadi pesannya tidak lagi
  menyebut "playlist". Ini satu-satunya tes lama yang diubah.

**Berikutnya: UI (form siaran, unggah latar, setelan spektrum), lalu Dockerfile.**

**Langkah 5 SELESAI (2026-09-10) — UI.**

Perjalanan penggunanya kini utuh: unggah musik di tab Musik galeri
(`/videos?kind=audio`) → buat playlist berjenis Musik → isi (pemilihnya
otomatis hanya menawarkan musik) → buat siaran lewat tab ketiga "Radio (Musik)"
di form → unggah gambar latar di halaman detail siaran.

- `models/playlist.js` — `create()` menyimpan `kind`; `listByUser()` bisa
  disaring. `update()` SENGAJA tidak menyentuh `kind`: playlist video yang
  berubah jadi musik membawa serta isinya yang salah jenis, dan itu baru
  ketahuan saat siaran dijalankan.
- `models/stream.js` — **`updateRadioSettings()` sebagai pintu terpisah**, bukan
  delapan kolom baru dititipkan ke `normalize()`/`create()`/`update()` yang
  dilalui SETIAP siaran. Pola yang sama seperti `buildArgs` dan `resolveSource`,
  dan di sini bahkan tidak perlu impact analysis untuk memutuskannya. Semua
  nilai dijepit di model, bukan di filtergraph: warna hanya `#RRGGBB`, sebab
  nilai ini berujung di perintah FFmpeg tempat koma dan titik dua memisahkan
  filter.
- `middleware/upload.js` — `verifyMediaContent` memilih keluarga signature dari
  field `kind` di form. Mempercayai body di sini aman: yang ditentukannya hanya
  signature MANA yang harus cocok, dan isi berkas tetap yang memutuskan.
- `routes/videos.js` — galeri bertab (video / musik), unggah biasa dan
  berpotongan sama-sama meneruskan `kind`. Impor Drive tetap khusus video.
- `routes/playlists.js` — pemilih isi mengikuti jenis playlist, dan jenis yang
  tidak cocok ditolak di server (form yang dipalsukan tidak lolos).
- `routes/streams.js` — playlist dipisah per jenis di `formContext`; route
  gambar latar (`POST /:id/backgrounds`, `/reorder`, `/:bgId/delete`);
  `radioWarnings()` menampilkan dua hal yang membuat siaran GAGAL DIMULAI di
  halaman detail, bukan menunggu tombol Mulai ditekan.
- View: tab galeri, pemilih jenis playlist, tab ketiga di form siaran beserta
  setelan spektrum, dan panel gambar latar di detail siaran.

Catatan: gambar latar diunggah SETELAH siaran dibuat (unggah butuh multipart
dan id siaran), jadi siaran radio bisa berada dalam keadaan belum bisa dimulai.
Itu disengaja dan ditandai jelas di halaman detail.

Pembersihan panel sumber di form sekarang mencakup KETIGA panel. Panel Playlist
dan Radio sama-sama mengirim `playlist_id`; tanpa pengosongan, berpindah tab
mengirim dua nilai dan yang menang ditentukan urutan DOM, bukan pilihan pengguna.

**Berikutnya: langkah 6 — Dockerfile + liquidsoap.**

**Langkah 6 SELESAI (2026-09-10) — liquidsoap sungguhan, pertama kali.**

Mesin kerja pindah ke Ubuntu 24.04, dan liquidsoap untuk pertama kalinya benar-benar
dijalankan. Hasilnya dua cacat di jalur start radio yang mustahil terlihat di Windows
(rinciannya di FINDINGS):
- **Balapan harbor** — FFmpeg dijalankan seketika, harbor baru terbuka ±15 dtk
  kemudian, dan `-reconnect` tidak menolong koneksi pertama. Siaran radio **tidak
  pernah bisa live**; restart otomatis memulai kedua proses dari nol.
- **Liquidsoap tidak ada / langsung keluar** → restart berulang ±12,6 menit dengan
  pesan akhir yang menyalahkan FFmpeg, karena `spawn()` tidak melempar.

Perbaikan — rancangan dipilih user: "tunggu harbor, baru jawab".
- `services/liquidsoap.js` — `waitForHarbor(port, proc, { timeoutMs, shouldAbort })`,
  batas 45 dtk. Murni sisipan: `git diff -U0` membuktikan nol baris lama dihapus.
- `services/streamManager.js` — `startRadioEngine()` baru, dipanggil `start()` untuk
  radio sebelum `launch()`; kegagalannya final (status error berisi baris terakhir
  keluaran liquidsoap), bukan diputar ke auto-restart. `launch()` kini menerima
  proses liquidsoap yang sudah siap (`liq.proc`); blok spawn lama — yang `catch`-nya
  tak pernah jalan — dibuang. Mulai ganda ditolak lewat `radioStarting`.
  **`stop()` TIDAK disentuh**: penghentian selama menunggu terbaca dari status yang
  bukan lagi `starting` (`stop()` tanpa proses sudah mengembalikannya ke idle).
- Impact: `launch` **HIGH** (12 simbol), `start` MEDIUM (12 simbol, 6 langsung).
  Jalur video tidak berubah: `liq === null` → `lsProc` null seperti sebelumnya.
  `detect_changes` akhir (setelah `.dockerignore` dan perbaikan `stop()`): **CRITICAL**,
  8 berkas, 49 simbol, 16 proses — kini termasuk alur `CommandPreview`. CLI-nya memotong
  daftar di 15 simbol meski diberi `--limit 300`, jadi diverifikasi dengan membandingkan
  badan fungsi HEAD vs working tree (akhir baris dinormalkan): dari 42 fungsi di
  `streamManager.js` dan `liquidsoap.js`, yang BERBEDA hanya `start`, `launch`, `stop`,
  dan `buildScript` — tepat yang disengaja. `commandPreview`, `handleExit`,
  `resolveSource`, `recoverOnBoot`, dan sisanya IDENTIK; tanda CRITICAL itu pergeseran
  baris, didukung tes pratinjau yang tetap lulus.
- Konsekuensi yang disepakati: tombol Mulai siaran radio menunggu ±15–20 dtk.

Tes `tests/test-radio-live.js` (baru): liquidsoap asli + sink RTMP, lewat route.
Dibuktikan **MERAH** pada kode lama — 4 pass, 15 fail (POST dijawab 447 ms, siaran tak
pernah mengalir, restart berulang, harbor tak pernah mendengarkan) — lalu hijau
**35/35**: POST dijawab setelah 17,7 dtk, siaran mengalir tanpa restart, harbor hanya
127.0.0.1, Stop selama menunggu membatalkan dalam 209 ms tanpa FFmpeg dijalankan,
Mulai kedua ditolak seketika dengan tetap SATU liquidsoap, dan liquidsoap yang langsung
keluar berakhir error dalam 0,4 dtk berikut kata-katanya sendiri. Suite penuh:
**439 pass, 3 fail** — ketiganya kegagalan lama FFmpeg 6.1 mode copy, sama persis
dengan baseline sebelum perubahan (404 pass, 3 fail).

Ikut diubah: `Dockerfile` (+liquidsoap), `.dockerignore` (baru — lihat FINDINGS),
`.env.example` (`LIQUIDSOAP_PATH`), README (Kebutuhan sistem, Docker, Pemecahan
masalah), `tests/README.md` (migrate, liquidsoap, port). Atas keputusan user juga
diperbaiki: Stop selama jeda auto-restart (`stop()`, tes baru
`tests/test-stop-restart-delay.js`). Suite akhir: **448 pass, 3 fail** — tiga
kegagalan lama FFmpeg 6.1 mode copy yang diputuskan dicatat saja.

**Uji image Docker** (liquidsoap 2.1.3, FFmpeg 5.1, berjalan sebagai root) menemukan dua
penghalang lagi yang membuat mode radio **mati total di image** sejak langkah 1 — `:=`
ditolak liquidsoap 2.1, lalu penolakan root (rinciannya di FINDINGS). Keduanya diperbaiki
di `buildScript()` (impact LOW): `.set([...])` dan `settings.init.allow_root.set(true)`,
dijaga dua asersi baru di `tests/test-radio.js`. Image dibangun ulang dengan kode final, lalu
**`test-radio-live.js` dijalankan DI DALAM container sebagai root: 35/35** — POST dijawab
setelah 7,5 dtk, siaran mengalir dengan track video + audio, harbor hanya 127.0.0.1, Stop
selama menunggu membatalkan dalam 205 ms. (`procps` dipasang sementara di container uji
itu saja karena tesnya memakai `pgrep`; aplikasinya sendiri tidak butuh.)

#### Sisa yang belum diverifikasi

~~Pertambahan ukuran image Docker setelah `apt-get install liquidsoap`~~ — **diukur
2026-09-10**: dua build dari konteks yang sama, hanya lapisan apt yang berbeda.
`docker images`: 1,91 GB dengan liquidsoap versus 1,81 GB tanpa → **±100 MB di
disk**. `docker image inspect` melaporkan 432,1 MB versus 411,2 MB (+20,9 MB) —
kemungkinan ukuran terkompresi, belum dipastikan. Angka mutlak 1,9 GB membengkak
karena `COPY . .` tanpa `.dockerignore` (lihat FINDINGS), bukan karena liquidsoap.

## DONE

### Lapisan media: berkas musik masuk ke daftar yang sama — 2026-09-09

Fondasi untuk siaran ala radio, dan sepenuhnya berdiri sendiri: tidak ada
liquidsoap di sini, semuanya teruji di Windows.

**Keputusan user (2026-09-09): perluas tabel `videos`, bukan tabel terpisah.**
Diambil setelah sensus, bukan perkiraan. Angkanya: jalur "perluas" menyentuh
±11 titik (13 sentuhan SQL yang terpusat di 3 model, hanya **3** yang perlu
disaring `kind`), sedangkan tabel terpisah berarti mengembarkan ±1.440 baris
mesin teruji — chunkUpload (184), videoImport (139), videoIngest (48),
models/playlist (138), routes/playlists (120), routes/videos (252), views (559).

Harga dari keputusan ini, dicatat supaya tidak terlupa: `kind` **wajib**
disaring di galeri video, pemilih sumber stream, dan pemilih isi playlist.

- `db/migrate.js` — **migrasi v5**: `kind` di `videos` dan `playlists`
  (`DEFAULT 'video'`, jadi seluruh baris lama benar tanpa disentuh), plus index
  `idx_videos_user_kind(user_id, kind)`.
- `utils/filetype.js` — 5 signature audio: MP3, FLAC, M4A, OGG, WAV.
- `middleware/upload.js` — `verifyAudioContent`. Satu baris saja: validatornya
  ternyata sudah ditulis sebagai pabrik `verifyContent(family, label)`.
- `services/ffmpeg.js` `probe()` — menerima berkas tanpa track video,
  mengembalikan `kind`. Kunci `width`/`height`/`fps` tetap ada bernilai 0 supaya
  bentuk objek bagi pemanggil lama tidak berubah.
- `services/videoIngest.js` — parameter `kind` (bawaan `'video'`), thumbnail
  dilewati untuk musik.
- `models/video.js` — `listByUser`/`countByUser` menyaring `kind` dengan
  **bawaan `'video'`**, sehingga ketiga pemanggil lama otomatis benar tanpa
  diubah sebaris pun; lupa menyaring berarti mendapat perilaku lama yang benar,
  bukan kebocoran. `totalSize` sengaja TIDAK menyaring — musik memakan disk
  sama nyatanya.

**Impact analysis sebelum tiap simbol disentuh**: `probe` LOW (16 simbol, 2
pemanggil langsung), `register` LOW (5 simbol, 3 pemanggil langsung).

- Tes baru `tests/test-media-kind.js`, 30/30 pass, memakai berkas media nyata
  hasil ffmpeg. **Dibuktikan bisa merah**: urutan signature M4A sengaja dibalik
  ke setelah MP4/MOV, tes berbunyi (2 gagal), lalu dipulihkan.
- Suite penuh 314 pass, 0 fail sebelum tes baru ditambahkan.

### Pemeriksaan kesehatan API Google — 2026-09-09

Diminta user: satu tombol yang menjawab "apakah Google OAuth, YouTube Data API
v3, dan Drive API v3 masih valid". Pemicunya **manual saja** atas keputusan user
(2026-09-09) — scheduler tidak disentuh, jadi tidak ada biaya kuota di latar
belakang.

**Bug yang ditemukan saat mengerjakannya: impor Drive tidak pernah berfungsi.**
`services/drive.js` `clientFor()` mengoper hasil `youtube.clientForAccount()`
sebagai `auth` ke `google.drive()`. Yang dioper itu **objek layanan YouTube**,
bukan klien OAuth. googleapis menerimanya tanpa protes saat objeknya dibangun,
sehingga kegagalannya baru muncul di panggilan pertama sebagai
`authClient.request is not a function` — artinya `listVideos`, `fileInfo`, dan
`download` semuanya mati sejak fitur Drive dirilis (2026-08-31). Lolos karena
`tests/test-driveimport.js` menguji lapisan scope dan database saja, tidak
pernah menyentuh auth.

- `services/youtube.js` — `authClientForAccount()` dipisah dari
  `clientForAccount()`. Yang pertama mengembalikan klien OAuth mentah; yang
  kedua tetap mengembalikan objek layanan seperti sebelumnya, sehingga
  rotationEngine dan route lama tidak ikut berubah. `wrapError()` mendapat
  cabang `access_not_configured`, ditaruh **sebelum** cabang 403 umum supaya
  "API belum diaktifkan di Cloud Console" tidak tersamar jadi "izin ditolak".
  `wrapError` dan `authClientForAccount` diekspor.
- `services/drive.js` — memakai `authClientForAccount()`. `clientFor` diekspor
  supaya tes bisa memeriksa `auth` yang terpasang tanpa menyentuh jaringan.
- `services/apiHealth.js` (baru) — empat pemeriksaan berurutan yang saling
  menggugurkan: kredensial → token → YouTube → Drive. Kalau token mati, dua
  yang terakhir ditandai **dilewati**, bukan gagal; kegagalan turunan itulah
  yang membuat orang mengejar penyebab keliru. Kuota habis dipetakan ke `warn`,
  bukan `fail` — API-nya sehat, jatahnya saja yang tandas.
- `routes/accounts.js` — `POST /accounts/:id/health`. Selalu 200: hasil "gagal"
  adalah jawaban sah dari sebuah pemeriksaan, bukan galat HTTP. `/test` lama
  dibiarkan; ia menjawab pertanyaan berbeda (adakah siaran aktif).
- `views/accounts/index.ejs` — tombol "Cek API" + panel rincian per-pemeriksaan.
  Pesan dari Google ditulis lewat `textContent`, bukan `innerHTML`.

**Impact analysis sebelum menyentuh simbol**: `clientForAccount` MEDIUM (24
simbol, 6 pemanggil langsung, proses `runBundle`/`runIndependent`) — perubahannya
murni ekstraksi, perilaku bagi pemanggil lama identik dan dijaga tes.
`wrapError` LOW (13 simbol). `probe` LOW (16 simbol, 2 pemanggil langsung) —
belum disentuh, dicatat untuk fitur musik nanti.

- Tes baru `tests/test-apihealth.js`, 23/23 pass, murni (tanpa jaringan, tanpa
  DB kerja). Termasuk penjagaan regresi langsung:
  `drive.clientFor(...).context._options.auth` wajib instance OAuth2.
  **Dibuktikan bisa gagal** — bug-nya sengaja dikembalikan, tes berbunyi
  (2 gagal), lalu perbaikan dipulihkan. Tes regresi yang tidak pernah terbukti
  merah tidak menjaga apa pun.
- Suite penuh: 314 pass, 0 fail dari 14 berkas.

### Kebersihan daftar concat playlist — 2026-09-02
Cacat yang tercatat di TODO pagi ini, sekarang ditutup. Yang paling mengganggu
bukan berkas menumpuknya, melainkan **sebuah request GET yang menulis ke disk**:
membuka halaman detail stream playlist memanggil `commandPreview()` →
`resolveSource()` → `buildConcatSource()`, dan itu menulis berkas daftar.

**Perilaku FFmpeg diuji dulu sebelum mendesain sweep** (bukan diasumsikan):
berkas daftar concat **dipegang terbuka selama siaran berlangsung**. Percobaan
menghapusnya di detik ke-3 dari siaran 12 detik ditolak sistem dengan
`Device or resource busy`, sementara prosesnya jalan terus melewati tiga
putaran dan keluar bersih. Karena itu sweep **melewati** siaran yang berjalan,
bukan sekadar "sebaiknya jangan disentuh".

- `services/ffmpeg.js` — `buildConcatSource(streamId, items, { write })`;
  `write: false` menyusun sumber tanpa menyentuh disk, dipakai pratinjau.
  Ditambah `concatPathFor()` (satu berkas per stream, bukan per playlist) dan
  `sweepConcatFiles(isOrphan)` yang menerima predikat dari pemanggil — ffmpeg.js
  sengaja tidak tahu-menahu soal peta `running`.
- `services/streamManager.js` — `commandPreview` memakai `{ write: false }`;
  `cleanupConcatFile()` kini juga dipanggil di **kedua** cabang terminal
  `handleExit` (auto-restart mati, dan jatah restart habis) serta di `stop()`
  saat prosesnya sudah tidak ada; `recoverOnBoot()` menyapu semua daftar sisa
  (saat boot belum ada siaran berjalan, jadi semuanya pasti yatim);
  `sweepConcatFiles()` diekspor untuk scheduler.
- `services/scheduler.js` — sweep ikut pembersihan harian, di blok try sendiri
  supaya kegagalannya tidak membatalkan pembersihan lain.

**Impact analysis: HIGH** — `resolveSource` (16 simbol, 3 proses:
`startDueStreams`, `commandPreview`, `timer` restart-otomatis) dan `handleExit`
(8 simbol, proses `launch` ×7). Bukan false positive: keduanya memang diubah,
dan jalur restart otomatis memanggil `start()` lagi sehingga daftar ditulis
ulang — itulah sebabnya pembersihan hanya dipasang di cabang yang benar-benar
terminal. Index GitNexus sempat hilang (`.gitnexus/lbug` tidak ada) dan dibangun
ulang dulu sebelum analisis dipercaya.

- Tes baru `tests/test-concat-cleanup.js`, 29/29 pass: 14 unit (dry-run tidak
  menulis, isi & format daftar, cleanup idempoten, sweep hanya menyentuh yang
  yatim dan tidak menyenggol berkas unggahan atau nama di luar pola), plus
  integrasi — **membuka detail 4× tidak menulis apa pun**, siaran nyata menulis
  daftarnya, sink RTMP dimatikan → siaran gagal permanen → daftar hilang, dan
  daftar sisa dihapus saat aplikasi boot.
- **Rotasi metadata × playlist dibuktikan bertumpuk**: siaran bersumber playlist
  dengan rotasi aktif tetap menyimpan `rotation_state` dengan profil yang benar
  dan menjalankan rotasi pertama (`rotate_on_start`). Memang tidak ada
  ketergantungan di antara keduanya — `rotationEngine` bekerja dari
  `youtube_video_id`/`resolved_video_id` (id broadcast YouTube), bukan dari
  `streams.video_id` — tapi sekarang ada tesnya, bukan cuma pembacaan kode.
- Suite penuh setelah perbaikan: **291 pass, 0 fail, 13/13 berkas**.

### Tes masuk repo + dokumentasi menyusul fitur — 2026-09-02
Bukan fitur baru; menutup dua utang yang menumpuk selama tujuh fitur terakhir.

- **13 skrip tes dipindahkan dari folder temp ke `tests/`** (~262 assertion).
  Sebelumnya seluruh bukti pengujian hidup di `%TEMP%` dan bisa hilang kapan saja
  saat Windows membersihkannya, sementara repo sendiri nol tes. Path absolut
  `D:/LIVE-MANAGER-2` diganti `path.resolve(__dirname, '..')`, dan
  `require(path.join(ROOT, 'node_modules/better-sqlite3'))` disederhanakan jadi
  `require('better-sqlite3')` — akal-akalan itu hanya perlu selagi skripnya di luar repo.
- **`tests/run.js` + `npm test`** — menjalankan berurutan, bukan paralel, karena
  tes integrasi memakai database kerja dengan pola backup/restore. Saringan nama
  didukung (`npm test -- playlist`).
- **Kunci `tests/.run.lock`.** Saat verifikasi, saya sendiri menjalankan
  `test-disk.js` bersamaan dengan suite yang sedang berjalan: dua proses berebut
  DB dan port 7598, hasilnya satu kegagalan palsu (11 pass, 1 fail) yang lulus
  20/20 begitu dijalankan sendirian. Kunci ini menutup jalur itu, sekaligus
  mencegah database kerja dikembalikan dari backup basi. `--force` untuk kunci
  yang tertinggal dari proses mati.
- Runner mengulang baris `FAIL` di ringkasan akhir dan membaca hitungan dari
  kemunculan **terakhir**, supaya satu kegagalan tidak tenggelam di ratusan baris.
- **README + `.env.example`**: tujuh fitur terakhir sebelumnya tidak tercatat sama
  sekali di dokumen pengguna. Ditambahkan playlist (termasuk tabel keseragaman
  Copy vs Re-encode), tiga jalur unggah, impor Drive berikut keharusan
  menghubungkan ulang akun lama, pratinjau, monitor disk, bandwidth, validasi
  magic byte, struktur berkas baru, `npm test`, dan 4 entri pemecahan masalah.
- Berkas konfigurasi agen (`.claude/`, `.gitnexus/`, `CLAUDE.md`, `AGENTS.md`)
  masuk `.gitignore` — keputusan user, dianggap konfigurasi lokal.
- Verifikasi setelah pemindahan: **262 pass, 0 fail, 12/12 berkas** dari lokasi
  barunya, plus app boot bersih dan skema DB tetap v4.

### Playlist multi-video — 2026-09-01
Gap yang terlewat di analisis awal, ditemukan saat user bertanya "berapa video untuk
live 24 jam" — jawabannya terpaksa "satu", karena `streams.video_id` tunggal.

**Koreksi analisis 2026-08-31**: saya menulis "shuffle rotasi sudah ada, bukan gap".
Keliru — `shuffleArray` StreamFlow dipanggil `buildFFmpegArgsForPlaylist` (mengacak
urutan **video**), sedangkan `shuffle` di sini mengacak urutan **varian metadata**.
Beda fitur.

**Perilaku concat demuxer diuji empiris dulu sebelum mendesain** (bukan diasumsikan):
| Uji | Hasil |
| --- | --- |
| Spec sama + copy | 6,02s dari 2×3s — benar |
| Spec beda + copy | 7,22s **dan** frame 720p tercampur di stream 480p — rusak |
| Spec beda + re-encode | resolusi ternormalisasi, timestamp tetap meleset di sambungan |
| `-stream_loop -1` + concat | 14,1s dari playlist 6s — loop seluruh daftar, jalan |
| Path absolut Windows | jalan dengan garis miring maju |

Temuan kedua itulah alasan adanya `playlistBlockers()`: playlist tak seragam di mode
Copy **ditolak sebelum siaran mulai**, bukan dibiarkan gagal di tengah.

- Migrasi **v4**: tabel `playlists`, `playlist_items`, kolom `streams.playlist_id`.
  Video sama boleh muncul berkali-kali (kunci = `playlist_items.id`).
- `services/ffmpeg.js` — `buildConcatSource()` (kutip tunggal di-escape `'\''`,
  path garis miring maju), `cleanupConcatFile()`, `playlistWarnings()`,
  `playlistBlockers()`. `buildArgs` menerima sumber playlist; jalur video tunggal
  **tidak diubah sama sekali** dan itu diuji dengan perbandingan argumen persis.
- `services/streamManager.js` — `resolveSource()` menentukan video atau playlist,
  memeriksa berkas ada, menolak playlist bermasalah, dan mengacak bila diminta.
- `models/playlist.js`, `routes/playlists.js`, `views/playlists/*`, entri sidebar,
  serta pilihan sumber di form stream (tab Video/Playlist).
- Drag-and-drop memakai ulang `[data-sortable]` dari fitur reorder rotasi.

**Impact analysis: CRITICAL** (47 simbol, 92 flow) — dan berbeda dari kasus
sebelumnya, ini bukan false positive: `start`, `launch`, `handleExit`, `buildArgs`,
`normalize`, `create`, `update`, `findById` memang berubah. Karena itu jalur lama
diuji terpisah, bukan hanya jalur baru.

- Tes 70/70 pass: 32 fondasi (termasuk argumen video tunggal identik + siaran
  concat nyata), 30 end-to-end (**siaran playlist benar-benar mengalir ke RTMP**,
  kepemilikan, reorder, penolakan playlist campuran, pembersihan berkas concat),
  8 regresi video tunggal (**siaran nyata mengalir, tanpa berkas concat**).

**Bug yang ditemukan & diperbaiki saat pengujian**: `playlistBlockers()` semula
keluar lebih awal saat mode re-encode, sehingga playlist dengan sebagian video
tanpa audio lolos. Re-encode bisa menyeragamkan gambar, tapi tidak bisa memunculkan
track audio yang tidak ada — susunan stream berubah di tengah siaran dan platform
memutus koneksi. Sekarang pemeriksaan audio berlaku di kedua mode.

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
- **WAL bisa menelan migrasi saat tes backup/restore DB**: `db/index.js` memakai `journal_mode = WAL`, jadi tulisan baru (termasuk migrasi) awalnya hanya ada di `livemanager.db-wal`. Pola tes "salin `.db` → jalankan → kembalikan `.db` + hapus `-wal`" **membuang** apa pun yang belum di-checkpoint. Migrasi v4 sempat hilang diam-diam karenanya (`user_version` balik ke 3, lalu `test-recoveronboot` gagal dengan "table streams has no column named playlist_id"). Perbaikannya: `pragma('wal_checkpoint(TRUNCATE)')` sebelum menyalin. Sudah ditambahkan ke semua skrip tes; ingat ini kalau membuat skrip baru yang menyentuh DB.
- **Require dari scratchpad**: modul project bisa di-require lewat path absolut, tapi dependency-nya (mis. `better-sqlite3`) tidak — harus ditunjuk ke `<ROOT>/node_modules/<nama>` karena resolusi mengikuti lokasi file skrip, bukan cwd. Sejak tes pindah ke `tests/` (2026-09-02) ini tidak berlaku lagi untuk tes; masih berlaku untuk skrip sekali pakai di luar repo.
- **FFmpeg memegang berkas daftar concat tetap terbuka selama siaran** (2026-09-02, diuji): `rm` pada berkas daftar di tengah siaran ditolak Windows dengan `Device or resource busy`, dan siaran tetap berjalan melewati putaran berikutnya. Konsekuensinya: pembersihan berkas daftar tidak boleh menyentuh siaran yang berjalan (di Windows memang mustahil, tapi jangan andalkan itu di Linux), dan `cleanupConcatFile` harus tetap menelan error — gagal menghapus bukan kondisi luar biasa.
- **Status stream jangan dibaca dari HTML di dalam tes** (2026-09-02): halaman detail menampilkan baris log ber-level `ERROR` selagi siaran masih hidup, jadi mencocokkan kata "ERROR" di halaman membuat pemeriksaan lolos terlalu cepat — satu tes sempat gagal karena ini, bukan karena kodenya. Baca `streams.status` dari database lewat koneksi read-only.
- **Tes tidak boleh dijalankan paralel** (2026-09-02): pola backup/restore DB membuat dua proses tes saling menimpa, dan port 7588–7599 dipakai bergantian. Gejalanya kegagalan yang tidak bisa diulang — satu berkas gagal di dalam suite, lulus penuh saat dijalankan sendirian. `tests/run.js` sekarang memasang kunci untuk mencegahnya; catatan lengkapnya di `tests/README.md`.
- **googleapis menerima objek layanan sebagai `auth` tanpa protes** (2026-09-09, diuji): `google.drive({ auth: google.youtube(...) })` **tidak melempar** saat dibangun. Kegagalannya baru muncul di panggilan pertama, sebagai `authClient.request is not a function` — pesan yang tidak menyebut-nyebut penyebab sebenarnya. Akibatnya seluruh impor Drive mati diam-diam sejak 2026-08-31. Pelajaran untuk tes: memeriksa "modul bisa di-require" atau "objek klien terbentuk" tidak membuktikan apa pun soal auth. Yang membuktikan: `client.context._options.auth instanceof google.auth.OAuth2` — murah, tanpa jaringan, dan langsung merah kalau salah pasang. Selalu oper `authClientForAccount()`, jangan pernah `clientForAccount()`.
- **`-stream_loop` gagal pada input concat tanpa track video** (2026-09-09, diuji): daftar concat berisi MP3 atau M4A yang dijalankan dengan `-stream_loop -1` berhenti setelah satu putaran dengan `Task finished with error code: -1 (Operation not permitted)`. Diuji dengan daftar 2×2 detik meminta 9 detik → keluar 4,0 detik. Sumber MP4 pada perintah yang sama **loop normal** (minta 11 detik dari daftar 4 detik → keluar 11,0 detik), jadi playlist video yang sudah ada tidak terdampak. Jalan keluar yang terbukti: gabungkan daftar jadi satu berkas dulu, baru `-stream_loop -1` pada berkas tunggal itu (keluar 9,0 detik sesuai permintaan). Relevan untuk fitur siaran musik; `-nostdin` wajib saat menguji di latar belakang, tanpa itu FFmpeg mati karena membaca stdin dan gejalanya menyerupai bug ini.
- **Daftar concat dibaca sekali saja, tidak pernah dibaca ulang** (2026-09-09, diuji): playlist 2 video senyap di-loop tak-hingga, berkas daftar ditimpa di detik ke-8 dengan tambahan berkas bernada 1000 Hz. Rekaman 20 detik penuh tetap `mean_volume: -91.0 dB` dan `max_volume: -91.0 dB` — nada itu tidak pernah muncul, padahal loop-nya jelas berjalan (20 detik dari daftar 4 detik). FFmpeg mengurai berkas daftar saat membuka input; putaran berikutnya memakai salinan di memori. Konsekuensinya: **mengubah playlist saat siaran berjalan mustahil dengan concat demuxer** — satu-satunya cara adalah merestart proses, yang berarti siaran terputus. Ini alasan utama liquidsoap (`playlist(reload_mode="watch")`) dipertimbangkan untuk fitur siaran musik.
- **Jangan hitung migrasi dengan `grep "function v"`** (2026-09-09, tertipu sendiri): migrasi v4 di `db/migrate.js` ditulis sebagai arrow function tanpa nama (`(d) => {`), sementara v1–v3 memakai `function vN(d)`. Grep saya menghitung 3, padahal array berisi 4, dan dari situ saya menyimpulkan (keliru) bahwa nomor versi pernah "terbakar". Database di `user_version = 4` sebetulnya konsisten sejak awal. Cara benar menghitungnya: evaluasi panjang array-nya. Kenapa ini penting: `migrate()` berhenti pada `current >= MIGRATIONS.length`, jadi menyisipkan langkah bernomor salah membuat migrasi **dilewati diam-diam di database lama sementara tetap jalan di instalasi baru** — diuji pada salinan: DB v4 + 4 migrasi → tidak ada yang jalan; DB v4 + 5 migrasi → v5 jalan; DB baru + 5 migrasi → v1..v5 jalan.
- **Sampul album membuat MP3 terlihat seperti video** (2026-09-09, diuji): `ffprobe` atas MP3 bersampul melaporkan dua stream — `codec_type=audio` dan `codec_type=video, codec=mjpeg, disposition.attached_pic=1`. Tanpa menyaring `attached_pic`, `probe()` menemukan "track video", mencatat berkas musik sebagai video, dan mewarisi dimensi gambar sampulnya; siaran lalu memutar satu frame beku. Bug ini tidak terlihat sampai siaran sungguhan berjalan. Saringannya ada di `probe()` dan dijaga `tests/test-media-kind.js`.
- **M4A dan MP4 sama-sama diawali atom `ftyp`** (2026-09-09, diuji): pembedanya hanya brand di offset 8 — `M4A ` versus `isom`. Karena `SIGNATURES` di `utils/filetype.js` dipakai dengan `.find()`, entri M4A **wajib** berada sebelum entri MP4/MOV; kalau dibalik, setiap berkas musik AAC lolos sebagai video. Sudah dibuktikan bisa merah: urutan sengaja dibalik → 2 tes gagal. Catatan serupa untuk MP3 tanpa tag ID3: syarat sync 11 bit (`b[0]===0xFF && (b[1]&0xE0)===0xE0`) sengaja ketat supaya tidak menyambar JPEG, yang juga diawali 0xFF.
- **`-stream_loop` bekerja pada concat gambar** (2026-09-09, diuji): berbeda dari concat audio-only yang gagal. Slideshow `ffconcat` 3 gambar × 2 detik diminta 14 detik → keluar 14,0 detik, dan pergantian gambarnya tepat waktu pada 7 dari 7 sampel termasuk setelah loop. Polanya sekarang jelas: `-stream_loop` bekerja selama input punya track video. Mode radio memakai concat hanya untuk gambar, jadi jebakan audio-only itu terhindari.
- **Rantai FFmpeg ala radio sudah terbukti utuh** (2026-09-09, diuji): audio dari `pipe:0` + slideshow + `showfreqs`/`showwaves` → `colorkey` → `overlay` menghasilkan H.264 + AAC yang benar. Spektrum terbukti tergambar (luma area overlay 170,5 saat berbunyi versus 100,7 saat senyap), dan `size=WxH` + `overlay=x:y` memang mengatur ukuran dan letaknya. Satu jebakan kosmetik: opsi `colors` pada `showfreqs` menerima **daftar warna per kanal dipisah `|`** (`0x00FF88|0x00FF88` untuk stereo), bukan satu nilai — satu nilai diabaikan diam-diam dan spektrumnya keluar putih.
- **`-re` MEMATIKAN siaran radio; audio harbor yang memacunya** (2026-09-10, diukur): input latar mode radio adalah daftar ffconcat berisi satu entri per gambar dengan `duration = rotateMinutes * 60` — bawaannya 7200 detik. `-re` memacu input menurut timestamp-nya sendiri, jadi ia menunggu 7200 detik sebelum frame berikutnya. Diukur pada gambar BMP yang sama, meminta 8 detik keluaran dengan audio harbor tiruan berlaju realtime: **concat + `-re` tidak selesai dalam 33 detik**, sedangkan **concat tanpa `-re` selesai 9,3 detik pada `speed=1.04x`**; `-loop 1` dengan maupun tanpa `-re` sama-sama 9,3 detik. Kesimpulannya yang memacu rangkaian ini adalah audio harbor yang memang mengalir realtime, bukan `-re` — dan `-re` justru berbahaya di sini. Instalasi lama memakai `-re` dengan aman karena latarnya `-loop 1 -framerate N` (yang memancarkan frame pada fps sungguhan), bukan concat berdurasi panjang; jangan menyalin `-re`-nya begitu saja. Dijaga `tests/test-radio.js` lewat pemeriksaan "TIDAK ada -re pada input latar" dan ambang realtime.
- **Slideshow ffconcat berganti TANPA jeda siaran** (2026-09-10, diuji): berbeda dari instalasi lama yang menjalankan ulang FFmpeg setiap pergantian gambar (jeda ~5 detik tiap rotasi). Daftar 3 gambar berdurasi 2 detik yang diminta 9 detik berganti tepat waktu pada 4 dari 4 sampel termasuk setelah daftarnya berputar. Syaratnya cuma satu: jangan pasang `-re` (lihat temuan di atas).
- **Batang `showfreqs` jauh lebih pendek dari kotaknya** (2026-09-10, diukur): dengan `ascale=cbrt` dan derau pink a=0.5, batangnya hanya mengisi pita 20px paling bawah dari kotak setinggi 120px. Akibatnya menguji "apakah spektrum tergambar" dengan merata-ratakan seluruh kotak MENYESATKAN — selisihnya cuma 0,9 luma dan terbaca seperti gagal, padahal pada pita yang benar selisihnya 40 luma (115,4 saat berbunyi versus 75,3 saat senyap). Ukur luma puncak antar pita, jangan rata-rata kotak. Untuk UI: kotak spektrum yang tinggi akan tampak banyak kosong pada musik yang tidak keras — itu perilaku `showfreqs`, bukan bug.
- **`test-concat-cleanup` bisa gagal karena mesin berat, bukan karena kode** (2026-09-10): asersi "siaran playlist benar-benar mengalir" menunggu `stats.frame > 0` dari sink RTMP sungguhan dengan batas waktu. Saat mesin sibuk ia gagal, dan berkas itu memakan **47 detik**; saat normal lolos dalam **22 detik**. Cara memastikannya sebelum menyalahkan perubahan sendiri: jalankan berkas itu sendirian (`npm test -- concat`) dan bandingkan durasinya dengan run yang sehat. Durasi yang membengkak dua kali lipat adalah tandanya.
- **Jangan salurkan `npm test` lewat `tail` saat dijalankan di latar belakang** (2026-09-10): keluaran yang tersimpan hanya ringkasannya, dan detail asersi yang gagal ikut hilang — persis yang dibutuhkan untuk mendiagnosis. Simpan keluaran utuh, potong saat membacanya.
- **`liquidsoap.checkAvailability()` tidak pernah dipanggil; GitNexus bilang sebaliknya** (2026-09-10, diverifikasi dengan grep): `context` untuk simbol ini melaporkan pemanggil `app.js` `boot` dan `routes/settings.js`, padahal kedua berkas itu memanggil `ffmpegService.checkAvailability()` — fungsi bernama sama di `services/ffmpeg.js`. Index mengatribusikan panggilan ke KEDUA simbol yang namanya kembar. Akibat nyatanya: aplikasi tidak pernah memeriksa ketersediaan liquidsoap, dan halaman Pengaturan hanya menampilkan status FFmpeg. Pelajaran umum: untuk nama yang kembar lintas modul, jawaban `context`/`impact` wajib dicek silang dengan grep pada pola `<modul>.<nama>(`.
- **Mesin kerja pindah ke Ubuntu 24.04 (2026-09-10)**: `better-sqlite3@11.10.0` tidak punya prebuilt untuk Node 24 (`No prebuilt binaries found (target=24.21.0)`) dan jatuh ke kompilasi yang butuh `make`. Dipakai Node 22 lewat `mise exec node@22 -- ...` — sama dengan base image `node:22-bookworm-slim`, jadi tes berjalan di runtime produksi. Versi liquidsoap berbeda di tiap tempat: Ubuntu 24.04 **2.2.4**, Debian bookworm (image Docker) **2.1.3**, trixie **2.3.2**; FFmpeg 6.1 di host versus 5.1 di image. Lulus di host tidak membuktikan image.
- **`spawn()` TIDAK melempar untuk binary yang tidak ada** (2026-09-10, diuji di Node 22.23.2 dan 24.21.0, hasil identik): kembaliannya objek dengan `pid === undefined`, lalu event `error` (`ENOENT`), disusul `close` dengan kode **-2**. Akibatnya `try/catch` di sekitar `liquidsoap.spawnEngine()` dalam `launch()` tidak pernah menangkap "liquidsoap tidak terpasang": FFmpeg tetap dijalankan, status sempat `live`, lalu handler `close` liquidsoap mematikan FFmpeg dan siaran jatuh ke auto-restart berulang alih-alih gagal dengan pesan jelas. Dihitung dari konstanta `streamManager.js`: jeda 5+10+20+40+80+120×5 = **±12,6 menit** bolak-balik (uptime tiap putaran tak pernah melewati `STABLE_AFTER_MS` 60 dtk, jadi hitungan tidak di-reset), berakhir "Gagal setelah 10 percobaan restart"; tanpa auto-restart pesannya "FFmpeg berhenti (kode null)" — menyalahkan FFmpeg. Penyebab sebenarnya hanya ada di satu baris log "Proses liquidsoap error: spawn liquidsoap ENOENT". Ketiga calon titik perbaikan (`launch`, `resolveRadioSource`, `prepareRadioFiles`) HIGH lewat proses `start`/`startDueStreams`/`timer`. Pola `try { spawn } catch` yang sama juga ada di jalur FFmpeg (`ffmpeg.spawnStream`), perilaku lama yang belum disentuh.
- **Liquidsoap sungguhan butuh ±15 detik sebelum harbor terbuka, dan `-reconnect` TIDAK menolong koneksi pertama** (2026-09-10, diukur di Ubuntu 24.04, liquidsoap 2.2.4, FFmpeg 6.1): "Standard library loaded in 13.93 seconds", harbor terbuka pada 14,8 dtk — sama pada putaran kedua (13,44 dtk; tidak ada cache). FFmpeg dengan flag persis `buildRadioArgs()` (`-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2`) terhadap port yang belum dibuka: **gagal dalam 213 ms**, "Connection refused". Menambah `-reconnect_on_network_error 1` dengan `delay_max 2`: menyerah dalam 1,5 dtk. Dengan `delay_max 16`: mencoba ulang pada +3/+7/+15 dtk dan berhasil, tetapi baru tersambung ±9 dtk setelah harbor siap, dan `delay_max` itu ikut mengubah perilaku sambung-ulang di tengah siaran. Akibatnya bagi `launch()` — yang menjalankan FFmpeg seketika setelah liquidsoap dengan anggapan "-reconnect membuat ia mencoba lagi sendiri" — FFmpeg mati sebelum harbor siap, `handleExit` membunuh liquidsoap, dan restart memulai keduanya dari nol; harbor tidak pernah sempat siap. **Disimpulkan dari dua pengukuran di atas plus pembacaan kode, belum diamati lewat aplikasi.** Tes lama tidak menangkapnya karena harbor tiruannya sudah mendengarkan sebelum FFmpeg jalan. Instalasi lama selamat karena liquidsoap hidup terus sebagai layanan terpisah dan hanya FFmpeg yang diulang.
- **Uji asap liquidsoap 2.2.4 dengan skrip dari `buildScript()` asli: LULUS** (2026-09-10): harbor terikat `127.0.0.1` saja (dibaca dari `/proc/net/tcp`: `0100007F`), rekaman 10,0 dtk bersuara (mean −20,7 dB), dan `reload_mode="watch"` terbukti — 3 dtk setelah daftar ditulis ulang muncul "Reloading playlist", lalu lagu yang BARU ditambahkan benar-benar diputar. Liquidsoap 2.1.3 (image Docker) belum diuji.
- **Tes integrasi mengandaikan database kerja yang SUDAH dimigrasi** (2026-09-10): di checkout baru `db/livemanager.db` belum ada (di-`.gitignore`), tes pertama membuatnya sebagai berkas kosong, dan 13 dari 17 berkas tes gagal dengan `no such table: users` (172 pass, 11 fail) — kegagalan lingkungan, bukan kode. Obatnya `npm run migrate` sekali sebelum `npm test`. Tanda pengenalnya: banyak berkas "0 pass, 1 fail" dalam 1–9 detik.
- **FFmpeg 6.1 tidak mencetak `frame=`/`fps=` pada mode copy, jadi `STATS_RE` buta** (2026-09-10, diuji): baris progres perintah copy aplikasi di Ubuntu 24.04 berbentuk `size=     127kB time=00:00:07.65 bitrate= 135.6kbits/s speed=1.07x` — tanpa `frame=` dan `fps=`, pada `-loglevel warning` maupun `info` (dugaan awal soal loglevel keliru). `STATS_RE` di `streamManager.js` mewajibkan keduanya, sehingga `state.stats` tak pernah terisi: frame 0, bitrate `-`, bandwidth dashboard 0. Siarannya sendiri MENGALIR — koneksi TCP ke sink `ESTAB` sepanjang tes. Inilah ketiga kegagalan baseline di Linux (404 pass, 3 fail setelah migrasi): `test-single-video-regression`, `test-playlist-e2e`, `test-concat-cleanup`, semuanya asersi "benar-benar mengalir" yang membaca `stats.frame`. Mode radio me-re-encode video, jadi `frame=` tetap ada di sana. FFmpeg 5.1 (image Docker) belum diperiksa. Belum diperbaiki — menyentuh jalur keluaran setiap siaran.
- **Stop selama jeda auto-restart membuat siaran tertahan di `stopping`** (2026-09-10, dibuktikan dengan siaran VIDEO biasa, tanpa mengubah kode): tujuan RTMP sengaja mati → FFmpeg gagal → `handleExit` masuk jeda 5 dtk (status `starting`, `restart_count` 1) → Stop ditekan di tengah jeda. Status 3 dtk dan 13 dtk kemudian tetap `stopping`, `ended_at` kosong, `runtime` masih tampil di `/api/overview`. Sebabnya: selama jeda, state masih ada di `running`; `stop()` membatalkan timer lalu memanggil `killProcess()` pada FFmpeg yang SUDAH keluar sendiri — tidak ada event `close` baru, jadi `handleExit` tidak pernah berjalan lagi dan semua pembersihannya (status idle, berkas sementara, sesi, `rotationEngine.onStreamStop`) terlewat. Menekan Mulai lagi memulihkannya, dan `recoverOnBoot` membereskannya saat aplikasi restart. Rotasi metadata TIDAK ikut berjalan untuk siaran yang tertahan: `rotationEngine.tick()` memakai `listRotating()` yang hanya memilih status `live`, jadi kuota YouTube tidak terbakar — padahal `ACTIVE_STATUSES` memuat `stopping`. Bug lama, bukan dari langkah 6; berlaku untuk semua mode. **Diperbaiki** atas keputusan user, hanya di `stop()` (impact MEDIUM, 13 simbol, 6 langsung; `handleExit` tidak disentuh): kalau state punya `restartTimer` — tanda `handleExit` sudah berjalan untuk proses yang mati dan sedang menunggu jeda — `stop()` langsung melakukan penutupan final yang sama dengan cabang `stopping` di `handleExit` (hapus dari `running`, bersihkan berkas, status idle + `ended_at`, log, `rotationEngine.onStreamStop`). Tes `tests/test-stop-restart-delay.js` (baru) dibuktikan MERAH dulu — 2 pass, 5 fail (tertahan `stopping`, `ended_at` kosong, `runtime` tetap tampil) — lalu hijau 7/7.
- **Liquidsoap 2.1.3 (image Docker) MENOLAK `settings.harbor.bind_addrs := [...]` — mode radio mati total di image** (2026-09-10, diuji di container `livemanager:step6`): `At radio.liq, line 10, char 0-26: ... Error 5: this value has type () -> _ but it should be a subtype of ref(_)`, liquidsoap keluar dengan kode 1 sebelum sempat membuka harbor. Berlaku sejak langkah 1: tak terlihat di Windows (liquidsoap tak pernah jalan) maupun di Ubuntu 24.04 (2.2.4 menerima `:=` sebagai alias `.set()`). Diperbaiki jadi `.set([...])`, sama dengan dua baris setelan di atasnya yang lolos pemeriksaan tipe 2.1.3. Pelajaran: uji asap wajib dijalankan pada versi liquidsoap yang benar-benar dipakai produksi, bukan versi host.
- **Liquidsoap menolak jalan sebagai root — dan container menjalankan aplikasi sebagai root** (2026-09-10, diuji di container setelah `:=` diperbaiki): `init: security exit, root euid & guid (user & group). Override with settings.init.allow_root.set(true)`, kode keluar 255. `Dockerfile` tidak punya `USER`, jadi setiap siaran radio di image Docker gagal di sini. Hal yang sama berlaku untuk instalasi PM2 yang dijalankan sebagai root di VPS. Dengan perbaikan langkah 6, kegagalan ini tampil sebagai error berisi kalimat liquidsoap tersebut, bukan restart berulang. **Diperbaiki** atas keputusan user dengan `settings.init.allow_root.set(true)` di skrip — liquidsoap hanya menyamai hak proses Node yang menjalankannya, harbor tetap loopback, tanpa telnet; `USER node` di Dockerfile ditolak karena mematahkan kepemilikan volume instalasi lama. Uji asap sesudahnya: **2.1.3 sebagai root** — harbor 127.0.0.1 terbuka setelah 7,2 dtk, rekaman 10 dtk bersuara (−20,3 dB), reload watch memutar lagu baru; **2.2.4 non-root** — setelan itu tidak mengganggu (harbor 15,6 dtk, rekaman utuh, reload bekerja).
- **FFmpeg 5.1 (image Docker) MASIH mencetak `frame=` pada mode copy** (2026-09-10, argumen persis aplikasi): `frame=  190 fps= 25 q=-1.0 Lsize=     125kB time=00:00:07.50 bitrate= 136.4kbits/s speed=   1x`. Jadi masalah `STATS_RE` hanya mengenai instalasi bare-metal dengan FFmpeg ≥6.1, bukan image Docker.
- **`COPY . .` menimpa `node_modules` hasil `npm install` di image** (2026-09-10, diuji): `nodemon` — devDependency — ada di image padahal `npm install --omit=dev`. (Hash `better_sqlite3.node` yang sama dengan host ternyata BUKAN bukti, meski sempat dipakai begitu: setelah `.dockerignore` dipasang pun hash di image tetap `d7d9272b12d11c1d`, karena host dan image sama-sama mengunduh prebuilt Node 22 linux-x64 yang identik.) Repo tidak punya `.dockerignore`, sehingga ikut tersalin: `node_modules` host (147 MB), `.gitnexus` (57 MB), `.git`, `.claude/`, dan `db/livemanager.db` (database kerja, berisi token terenkripsi) — begitu pula `.env` kalau ada di mesin build. Konsekuensi yang disimpulkan (belum diuji): image yang dibangun dari host Windows akan membawa binary `better-sqlite3` win32 ke container Linux. Masalah lama; Dockerfile di HEAD punya `COPY . .` yang sama. **Diperbaiki dengan `.dockerignore`** atas keputusan user: konteks build turun dari ±200 MB jadi 1,0 MB, image 1,67 GB (dari 1,91 GB); `.git`, `.gitnexus`, `.claude`, dan database kerja tidak lagi ada di image, `nodemon` hilang (node_modules kini hasil `npm install --omit=dev` image sendiri), better-sqlite3 tetap termuat, dan uji asap radio di container tetap lulus.
