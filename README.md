# LiveManager

Aplikasi web untuk mengelola live streaming multi-platform dari file video (siaran 24/7),
**ditambah rotasi otomatis judul, thumbnail, deskripsi, dan tags** pada siaran YouTube yang
sedang berjalan.

Terinspirasi [StreamFlow](https://github.com/bangtutorial/streamflow) — arsitekturnya sengaja
dibuat mirip (Express + EJS + SQLite + FFmpeg, satu proses Node) supaya ringan di VPS 1 GB dan
gampang di-deploy.

---

## Daftar Isi

- [Fitur](#fitur)
- [Cara kerja rotasi metadata](#cara-kerja-rotasi-metadata)
- [Batas kuota YouTube API](#batas-kuota-youtube-api-baca-ini-dulu)
- [Kebutuhan sistem](#kebutuhan-sistem)
- [Instalasi](#instalasi)
- [Menghubungkan channel YouTube](#menghubungkan-channel-youtube)
- [Panduan pemakaian](#panduan-pemakaian)
- [Deployment](#deployment)
- [Struktur proyek](#struktur-proyek)
- [Pemecahan masalah](#pemecahan-masalah)
- [Catatan keamanan](#catatan-keamanan)

---

## Fitur

### Streaming

- **Multi-platform sekaligus** — YouTube, Facebook, TikTok, Twitch, Shopee, atau RTMP/RTMPS
  kustom. Video di-encode **sekali** lalu disalurkan ke semua tujuan lewat muxer `tee` FFmpeg.
- **Dua mode encoding**
  - *Copy* — meneruskan stream apa adanya. CPU hampir nol, cocok untuk VPS kecil. Sumber harus
    sudah H.264.
  - *Re-encode* — atur ulang resolusi (sampai 1080p), bitrate, FPS, preset x264, dan orientasi
    (landscape / portrait untuk Shorts & TikTok).
- **Loop tanpa batas** untuk siaran 24/7, dengan `-fflags +genpts` agar timestamp tidak kacau
  setiap file diulang.
- **Playlist multi-video** — satu siaran bisa memutar beberapa video berurutan lewat concat demuxer
  FFmpeg, bukan hanya mengulang satu file. Urutannya bisa diacak, dan `-stream_loop` mengulang
  seluruh daftar dari awal. Video yang spesifikasinya tidak seragam **ditolak sebelum siaran
  dimulai**, bukan dibiarkan gagal di tengah — lihat [Susun playlist](#1-unggah-video).
- **Auto-restart** dengan backoff bertingkat (5 detik → 2 menit, maksimal 10 percobaan). Hitungan
  di-reset setiap kali siaran sempat berjalan stabil lebih dari 1 menit.
- **Penjadwalan** — mulai pada waktu tertentu, berhenti pada waktu tertentu, atau batasi durasi.
- **Audio senyap otomatis** untuk video tanpa track audio (platform menolak siaran tanpa audio).
- **Monitoring real-time** — FPS, bitrate, speed, dan log FFmpeg langsung di halaman detail.

### Rotasi metadata (fitur utama)

- **Dua mode rotasi:**
  - **Bundle** — satu varian berisi judul + deskripsi + tags + thumbnail, diganti bersamaan.
    Cocok untuk A/B test karena hasilnya bisa diatribusikan ke satu kombinasi utuh.
  - **Independent** — tiap field punya daftar dan intervalnya sendiri. Misalnya 10 judul berganti
    tiap 30 menit sementara 5 thumbnail berganti tiap 2 jam.
- **Tiga urutan:** berurutan, acak tanpa pengulangan (shuffle), dan acak berbobot.
- **Placeholder dinamis** — `{{jam}}`, `{{tanggal}}`, `{{hari}}`, `{{uptime}}`, `{{putaran}}`, dan
  lainnya, dihitung ulang setiap rotasi. Berguna agar judul siaran 24/7 tetap terasa segar.
- **Penjaga kuota** — rotasi ditunda otomatis sebelum kuota YouTube API habis, bukan setelah API
  menolak.
- **Deteksi broadcast otomatis** — mencari siaran aktif di channel lewat API, jadi kamu tidak perlu
  menyalin video ID setiap kali siaran baru dimulai.
- **Jitter** — menggeser waktu rotasi secara acak agar beberapa stream tidak menabrak API bersamaan.
- **Tambah massal** — tempel puluhan judul sekaligus, atau unggah banyak thumbnail dalam sekali
  jalan.
- **Riwayat lengkap** — setiap perubahan tercatat beserta biaya kuotanya, untuk dicocokkan dengan
  grafik di YouTube Analytics.

### Lain-lain

- Galeri video dengan probe metadata otomatis (durasi, resolusi, codec) dan thumbnail hasil ekstrak
  frame, plus **pratinjau langsung di browser** tanpa perlu mengunduh dulu.
- **Unggahan berpotongan yang bisa dilanjutkan** — koneksi putus di tengah tidak berarti mengulang
  dari nol. Server yang memegang offset, dan kemajuannya bertahan meski aplikasi direstart.
- **Impor video dari Google Drive** — memakai ulang koneksi OAuth YouTube yang sudah ada, berjalan
  di latar dengan laporan kemajuan.
- **Validasi isi berkas dari magic byte** — ekstensi tidak dipercaya; berkas yang isinya bukan media
  ditolak meski dinamai `.mp4`.
- Peringatan kompatibilitas sebelum siaran (misalnya sumber bukan H.264 padahal mode Copy dipilih).
- Pratinjau perintah FFmpeg dengan stream key tersamarkan, untuk debug manual.
- Dashboard dengan checklist persiapan, meter kuota API, **sisa ruang disk sungguhan** (bukan hanya
  total berkas aplikasi, lengkap dengan peringatan saat pemakaian di atas 90%), dan **bandwidth
  keluar** dari agregasi bitrate siaran yang sedang berjalan.

---

## Cara kerja rotasi metadata

Ini bagian yang paling sering disalahpahami, jadi ditulis eksplisit.

**FFmpeg tidak bisa mengubah judul atau thumbnail siaran.** FFmpeg hanya mengirim paket video ke
server RTMP. Judul, deskripsi, tags, dan thumbnail adalah properti *video* di channel YouTube kamu.
Mengubahnya harus lewat **YouTube Data API v3** dengan izin OAuth dari pemilik channel.

Alurnya:

```
  file video ──FFmpeg──> RTMP ──> YouTube (siaran berjalan)
                                       ▲
                                       │ videos.update / thumbnails.set
                                       │
  LiveManager ──YouTube Data API v3────┘
     (tiap N menit, sesuai profil rotasi)
```

Karena itu:

- Rotasi **hanya berjalan saat stream berstatus LIVE**.
- Rotasi butuh **channel YouTube yang terhubung**, terpisah dari tujuan RTMP.
- **Thumbnail kustom butuh channel terverifikasi** di sisi YouTube. Kalau channel-mu belum
  terverifikasi, rotasi judul/deskripsi/tags tetap jalan, hanya thumbnail yang ditolak.
- Platform lain (TikTok, Twitch, Shopee) tidak menyediakan API publik serupa, jadi rotasi metadata
  di sana tidak tersedia.

---

## Batas kuota YouTube API (baca ini dulu)

Setiap project Google Cloud mendapat **10.000 unit kuota per hari**, reset pukul 00:00 Pacific Time
(sekitar 14:00–15:00 WIB). Biaya operasinya:

| Operasi | Biaya | Dipakai untuk |
|---|---:|---|
| `videos.list` | 1 | membaca metadata lama sebelum menimpanya |
| `videos.update` | 50 | menulis judul / deskripsi / tags |
| `thumbnails.set` | 50 | mengganti thumbnail |
| `liveBroadcasts.list` | 1 | mendeteksi siaran aktif |

Konsekuensi praktisnya:

| Yang dirotasi | Biaya per putaran | Maksimal per hari | Interval tersingkat untuk 24 jam |
|---|---:|---:|---|
| Judul + deskripsi + tags + thumbnail | **101** | ~99× | **~15 menit** |
| Judul + deskripsi + tags (tanpa thumbnail) | **51** | ~196× | **~8 menit** |
| Hanya judul | **51** | ~196× | **~8 menit** |

> `videos.update` menimpa **seluruh** snippet video, jadi judul, deskripsi, dan tags selalu terkirim
> dalam satu panggilan yang sama — merotasi ketiganya tidak lebih mahal daripada merotasi satu.
> Thumbnail selalu panggilan terpisah, jadi itulah yang menggandakan biaya.

Halaman detail profil rotasi menghitung perkiraan pemakaian harian dan memberi peringatan merah
kalau intervalmu terlalu rapat. Kalau `stop_on_quota` aktif (default), rotasi ditunda 30 menit
saat kuota menipis alih-alih membanjiri log dengan error.

Butuh lebih banyak? Ajukan penambahan kuota di Google Cloud Console — prosesnya panjang dan tidak
selalu disetujui. Cara yang lebih praktis: pakai project Google Cloud terpisah untuk tiap channel.

---

## Kebutuhan sistem

- **Node.js 18+** (diuji pada Node 22)
- **FFmpeg + ffprobe** terpasang dan bisa diakses dari PATH
- **Liquidsoap 2.x** — hanya untuk siaran ala radio (musik + gambar latar). Siaran video tidak
  membutuhkannya. Sudah termasuk di image Docker.
- **1 core CPU / 1 GB RAM** untuk mode Copy. Mode Re-encode 1080p butuh setidaknya 2 core.
- Port `7575` (bisa diubah)

Cek FFmpeg:

```bash
ffmpeg -version
```

Kalau belum ada:

```bash
sudo apt update && sudo apt install -y ffmpeg
```

Di Windows, unduh dari [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) lalu tambahkan foldernya ke
PATH, atau isi `FFMPEG_PATH` dan `FFPROBE_PATH` di `.env`.

---

## Instalasi

```bash
git clone <repo-kamu> livemanager
cd livemanager
npm install
```

Buat file konfigurasi:

```bash
cp .env.example .env
npm run generate-secret
```

Salin dua baris yang dicetak (`SESSION_SECRET` dan `ENCRYPTION_KEY`) ke dalam `.env`, lalu sesuaikan
`APP_URL` dengan alamat yang benar-benar kamu pakai di browser.

Jalankan:

```bash
npm start
```

Buka `http://localhost:7575`. Halaman **Setup** akan muncul untuk membuat akun admin — halaman ini
hanya tampil sekali.

### Catatan untuk npm 12+

npm versi 12 ke atas memblokir install script milik dependency secara default, sehingga binary
native `better-sqlite3` tidak ikut terunduh. Script `postinstall` proyek ini menanganinya secara
otomatis. Kalau tetap gagal, jalankan manual:

```bash
cd node_modules/better-sqlite3 && npx prebuild-install --runtime=node
```

---

## Menghubungkan channel YouTube

Rotasi metadata butuh OAuth Client milikmu sendiri. Google tidak mengizinkan aplikasi pihak ketiga
memakai kredensial bersama untuk ini.

1. Buka [Google Cloud Console](https://console.cloud.google.com/), buat project baru.
2. **APIs & Services → Library** → aktifkan **YouTube Data API v3**.
3. **OAuth consent screen** → pilih *External*, isi nama aplikasi, lalu tambahkan email Google kamu
   sebagai **Test user**.
4. **Credentials → Create Credentials → OAuth client ID** → tipe **Web application**.
5. Pada **Authorized redirect URIs**, masukkan persis:

   ```
   http://localhost:7575/accounts/youtube/callback
   ```

   Ganti sesuai `APP_URL` milikmu. Alamat yang benar selalu ditampilkan di halaman
   **Pengaturan** aplikasi — salin dari sana agar tidak salah ketik.

6. Salin **Client ID** dan **Client Secret** ke halaman **Pengaturan** LiveManager.
7. Buka halaman **Akun YouTube** → **Hubungkan Channel**.

> **Penting untuk siaran 24/7:** selama consent screen masih berstatus *Testing*, refresh token
> Google kedaluwarsa setiap **7 hari** dan channel harus dihubungkan ulang. Untuk pemakaian jangka
> panjang, ubah statusnya ke *Production* (**Publish app**). Untuk aplikasi yang hanya kamu pakai
> sendiri, Google umumnya tidak menuntut proses verifikasi penuh.

---

## Panduan pemakaian

### 1. Unggah video

**Galeri Video** → pilih file. Aplikasi otomatis membaca durasi, resolusi, dan codec lewat ffprobe,
lalu mengambil satu frame sebagai thumbnail. Isi berkas diperiksa dari *magic byte*, jadi berkas
yang bukan media ditolak walaupun ekstensinya benar.

Ada tiga jalan masuk, dan ketiganya melewati pemeriksaan yang sama:

- **Unggah biasa** — untuk berkas kecil. Batasnya `MAX_UPLOAD_MB` (bawaan 4 GB).
- **Unggah berpotongan** — dipakai otomatis oleh browser yang mendukung `File.slice`. Berkas dikirim
  per 8 MB; kalau koneksi putus, unggahan disambung dari offset terakhir yang diakui server —
  termasuk setelah halaman dimuat ulang. Unggahan yang ditinggalkan disapu otomatis tiap hari.
- **Impor dari Google Drive** — tombol **Impor dari Drive** membuka daftar video di Drive (termasuk
  Shared Drive) beserta pencariannya. Unduhan berjalan di latar, jadi halaman boleh ditutup.
  Prasyaratnya izin `drive.readonly`: **akun YouTube yang dihubungkan sebelum fitur ini ada harus
  dihubungkan ulang** agar izinnya ikut diberikan. Akun lama tetap berfungsi penuh untuk rotasi —
  hanya impor Drive-nya yang tidak aktif.

Thumbnail di galeri bisa diklik untuk **pratinjau** langsung di halaman. Format yang tidak didukung
browser (mkv, avi, flv, ts, mpg) menampilkan penjelasan dan tautan unduh — berkasnya tetap sah dan
tetap bisa disiarkan FFmpeg.

Untuk mode Copy, video sumber harus **H.264**. Kalau bukan, aplikasi akan memperingatkan di halaman
detail stream. Konversi lebih dulu:

```bash
ffmpeg -i sumber.mkv -c:v libx264 -preset slow -crf 20 -c:a aac -b:a 128k hasil.mp4
```

**Susun playlist (opsional).** Kalau satu video terasa terlalu berulang untuk siaran 24 jam, buka
**Playlist** → **Playlist Baru**, tambahkan video, lalu atur urutannya dengan menyeret barisnya.
Aktifkan **acak** kalau ingin urutannya diundi setiap siaran dimulai.

Concat demuxer FFmpeg menyambung berkas **tanpa menormalkannya**, jadi keseragaman isi playlist itu
penting:

| Kondisi | Mode Copy | Mode Re-encode |
|---|---|---|
| Resolusi berbeda | ditolak — siaran akan rusak | dinormalkan, perpindahan bisa tersendat |
| Codec video berbeda | ditolak | dinormalkan |
| Sebagian video tanpa audio | **ditolak** | **ditolak** |
| FPS berbeda | diperingatkan | dinormalkan |

Sebagian video tanpa audio ditolak di kedua mode: re-encode bisa menyeragamkan gambar, tapi tidak
bisa memunculkan track audio yang memang tidak ada, dan susunan stream yang berubah di tengah siaran
membuat platform memutus koneksi. Halaman playlist menampilkan peringatan untuk kedua mode sebelum
kamu memilihnya di form stream.

### 2. Tambah tujuan RTMP

**Tujuan RTMP** → pilih platform (URL RTMP terisi otomatis) → tempel stream key dari YouTube Studio
atau Creator Studio platform terkait. Stream key disimpan terenkripsi AES-256-GCM.

### 3. Buat profil rotasi

**Profil Rotasi** → **Profil Baru** → pilih mode:

**Bundle** — isi varian satu per satu (judul + deskripsi + tags + thumbnail), atau pakai
**Tambah Massal** untuk menempel puluhan judul sekaligus. Di tab **Pengaturan**, tentukan field mana
saja yang ikut dirotasi — mematikan thumbnail memangkas biaya kuota separuh.

**Independent** — buka tab **Field Independent**, aktifkan field yang diinginkan, atur interval
masing-masing, lalu isi daftar nilainya. Untuk deskripsi, pisahkan antar entri dengan baris berisi
`---`.

Contoh judul dengan placeholder:

```
🔴 LIVE Lofi Hip Hop — Belajar & Fokus | {{jam}} WIB
Musik {{hari}} Malam · Sudah {{uptime}} mengudara
```

### 4. Buat stream

**Stream → Stream Baru**:

- **Sumber & Tujuan** — pilih **Satu Video** atau **Playlist** lewat tab sumber, lalu centang tujuan
  RTMP (boleh lebih dari satu).
- **Encoding** — Copy untuk hemat CPU, Re-encode kalau perlu mengubah resolusi/bitrate.
- **Rotasi Metadata** — pilih profil rotasi, pilih channel YouTube, aktifkan rotasi.
- **Jadwal** — opsional.

Tekan **Mulai Siaran**. Halaman detail menampilkan status FFmpeg, log real-time, varian yang akan
tayang berikutnya, dan tombol **Rotasi Sekarang** untuk memaksa pergantian.

### 5. Menganalisis hasil

Halaman **Riwayat Rotasi** mencatat waktu setiap pergantian. Cocokkan stempel waktunya dengan grafik
di YouTube Analytics (Jangkauan → Rasio klik-tayang tampilan thumbnail) untuk melihat varian mana
yang paling menarik penonton.

> LiveManager mencatat *apa yang dipasang dan kapan*, bukan performanya. YouTube tidak menyediakan
> API yang memecah CTR per rentang waktu, jadi perbandingannya dilakukan manual di YouTube Studio.

---

## Deployment

### PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Jalankan **satu instance saja**. Proses FFmpeg dan penjadwal rotasi disimpan di memori proses, jadi
cluster mode akan menjalankan siaran yang sama berkali-kali.

### Docker

```bash
cp .env.example .env
npm run generate-secret   # salin hasilnya ke .env
docker compose up -d
```

Folder `storage/`, `db/`, dan `logs/` di-mount sebagai volume agar bertahan melewati rebuild.

Image sudah membawa liquidsoap untuk siaran ala radio (menambah ±100 MB di disk). Liquidsoap
butuh ±7–20 detik sebelum siap, jadi tombol **Mulai** pada siaran radio baru menjawab setelah
liquidsoap benar-benar melayani audio — bukan tanda macet. Di dalam container aplikasi berjalan
sebagai root, sehingga skrip liquidsoap mengizinkan root secara eksplisit; audionya tetap hanya
bisa dijangkau dari dalam container (harbor terikat ke `127.0.0.1`).

`.dockerignore` menjaga image tetap bersih: `.env`, database, isi `storage/`, dan `node_modules`
dari mesin build tidak ikut disalin — dependensi dipasang ulang di dalam image, dan data hidup di
volume di atas.

### Di belakang Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name live.domainkamu.com;

    # Upload video besar
    client_max_body_size 4096M;

    location / {
        proxy_pass http://127.0.0.1:7575;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Upload video bisa berlangsung lama
        proxy_read_timeout    3600s;
        proxy_send_timeout    3600s;
        proxy_request_buffering off;
    }
}
```

Jangan lupa set `APP_URL=https://live.domainkamu.com` di `.env` dan daftarkan ulang redirect URI di
Google Cloud Console.

---

## Struktur proyek

```
app.js                    entry point, wiring Express
config/index.js           konfigurasi terpusat dari .env
db/
  index.js                koneksi better-sqlite3 (WAL)
  migrate.js              migrasi berbasis PRAGMA user_version
models/                   akses data (user, video, playlist, destination, account, stream, rotation)
services/
  ffmpeg.js               probe, thumbnail, builder argumen FFmpeg, daftar concat playlist
  streamManager.js        siklus hidup proses FFmpeg, auto-restart, statistik, bandwidth keluar
  rotationEngine.js       penjadwal & pelaksana rotasi metadata
  youtube.js              OAuth + YouTube Data API v3
  drive.js                daftar, cari, dan unduh video dari Google Drive
  videoImport.js          job impor Drive di latar (downloading → processing → done)
  videoIngest.js          pipeline pasca-berkas: magic byte → ffprobe → thumbnail → simpan
  chunkUpload.js          protokol unggahan berpotongan yang bisa dilanjutkan
  scheduler.js            jadwal mulai/berhenti siaran + pembersihan harian
  template.js             placeholder dinamis
  system.js               statistik CPU/RAM + ruang disk asli (statfs)
utils/                    helper, kripto, logger, sniffing tipe berkas (filetype.js)
middleware/               auth, csrf, session store, upload, error handler
routes/                   handler HTTP
views/                    template EJS
public/                   CSS & JS klien (tanpa CDN, jalan offline)
storage/                  video, thumbnail, serta unggahan/impor yang belum selesai (tmp/)
tests/                    skrip tes Node polos — lihat tests/README.md
```

### Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | jalankan aplikasi |
| `npm run dev` | jalankan dengan nodemon |
| `npm test` | jalankan seluruh tes (butuh ffmpeg; menyentuh DB kerja dengan backup & restore) |
| `npm run migrate` | jalankan migrasi database saja |
| `npm run generate-secret` | buat SESSION_SECRET & ENCRYPTION_KEY |
| `npm run reset-password` | daftar user / reset password lewat terminal |

---

## Pemecahan masalah

**Siaran langsung berhenti setelah dimulai**
Buka halaman detail stream dan baca log. Penyebab tersering: stream key salah, atau sumber bukan
H.264 padahal mode Copy dipakai. Ganti ke mode Re-encode untuk memastikan.

**`speed=` jauh di bawah 1x**
CPU tidak sanggup meng-encode secara real-time, siaran akan tersendat. Turunkan resolusi, pakai
preset lebih cepat, atau pindah ke mode Copy.

**Rotasi tidak jalan padahal sudah aktif**
Cek berurutan: (1) stream berstatus LIVE, (2) channel YouTube terhubung dan statusnya *connected*,
(3) tombol **Deteksi Broadcast** menemukan video ID, (4) kuota masih tersisa. Semua kegagalan
tercatat di log stream dan di halaman Riwayat Rotasi.

**"Belum ada siaran aktif yang terdeteksi"**
YouTube baru menandai broadcast sebagai `active` beberapa saat setelah data mulai masuk. Tunggu
1–2 menit. Kalau tetap tidak terdeteksi, matikan *Deteksi broadcast otomatis* dan isi video ID
manual.

**"Playlist tidak bisa disiarkan" saat menekan Mulai Siaran**
Isi playlist tidak seragam. Pesannya menyebut sebabnya: resolusi berbeda, codec video berbeda, atau
sebagian video tidak punya audio. Dua yang pertama selesai dengan pindah ke mode Re-encode; yang
ketiga harus dibereskan di berkasnya (tambahkan track audio senyap, atau keluarkan video itu dari
playlist).

**"Liquidsoap gagal disiapkan: …" pada siaran radio**
Siaran radio menjalankan liquidsoap lebih dulu dan baru menyalakan FFmpeg setelah liquidsoap siap.
Kalau langkah itu gagal, siaran langsung ditandai error — tidak diulang otomatis, karena mengulang
tidak akan menolong. Lanjutan pesannya menyebut sebabnya:
- *liquidsoap tidak ditemukan* — paketnya belum terpasang (`sudo apt install -y liquidsoap`), atau
  isi `LIQUIDSOAP_PATH` di `.env` dengan lokasi binary-nya. Image Docker sudah membawanya.
- *liquidsoap keluar sebelum harbor siap (kode N)* — diikuti baris terakhir keluaran liquidsoap
  sendiri, yang biasanya langsung menunjuk masalahnya.
- *harbor liquidsoap tidak terbuka dalam 45 detik* — mesin terlalu sibuk atau terlalu lemah.
  Liquidsoap butuh ±7–20 detik untuk siap di mesin 4 core.

Setelah sebabnya dibereskan, tekan **Mulai** lagi.

**Tombol Impor dari Drive bilang akunnya belum diberi izin**
Akun itu dihubungkan sebelum izin `drive.readonly` ditambahkan. Buka **Akun YouTube** lalu hubungkan
ulang channel tersebut. Rotasi metadata tetap berjalan normal selama akun belum dihubungkan ulang.

**Unggahan besar terputus di tengah**
Pilih berkas yang sama sekali lagi di form unggah — unggahan disambung dari potongan terakhir yang
sudah diterima server, bukan diulang dari nol. Unggahan yang ditinggalkan lebih dari sehari dihapus
oleh pembersihan harian.

**Pratinjau video hanya menampilkan pesan, bukan gambar**
Browser tidak punya codec untuk mkv/avi/flv/ts/mpg. Ini batasan browser, bukan berkasnya: FFmpeg
tetap bisa menyiarkannya. Pakai tautan unduh di dalam modal kalau ingin memeriksanya sendiri.

**Thumbnail ditolak**
Channel belum terverifikasi di YouTube, atau file melebihi 2 MB. Verifikasi channel di
`youtube.com/verify`.

**"Otorisasi YouTube tidak berlaku lagi"**
Refresh token kedaluwarsa — biasanya karena consent screen masih berstatus *Testing* (berlaku
7 hari). Publish aplikasinya, lalu hubungkan ulang channel.

**Lupa password**

```bash
npm run reset-password                          # lihat daftar user
npm run reset-password -- admin passwordbaru123 # ganti password
```

**`Could not locate the bindings file` (better-sqlite3)**

```bash
cd node_modules/better-sqlite3 && npx prebuild-install --runtime=node
```

---

## Catatan keamanan

- Password di-hash dengan bcrypt; session ID diregenerasi setelah login untuk mencegah session
  fixation.
- Stream key, refresh token OAuth, dan Google Client Secret disimpan terenkripsi **AES-256-GCM**
  memakai `ENCRYPTION_KEY`. Kalau kunci ini diganti, semua akun YouTube harus dihubungkan ulang.
- Proteksi CSRF pada seluruh request yang mengubah data. Rute unggahan berkas memakai verifikasi
  tertunda (setelah multer mengurai body) — lihat komentar di `middleware/csrf.js`.
- Berkas unggahan diverifikasi dari *magic byte*, bukan dari ekstensi atau `Content-Type` kiriman
  klien. Berlaku sama untuk unggahan biasa, unggahan berpotongan, dan impor Drive.
- Video dan thumbnail hanya bisa diakses setelah login; unggahan dan impor milik satu pengguna tidak
  bisa dilihat, disambung, atau dibatalkan pengguna lain.
- Rate limit pada endpoint login.
- **Jangan pernah** mengekspos aplikasi ini ke internet tanpa HTTPS. Siapa pun yang punya stream key
  kamu bisa menyiarkan apa pun ke channelmu.

---

## Lisensi

MIT.
