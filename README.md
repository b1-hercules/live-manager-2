# LiveManager

Aplikasi web untuk mengelola live streaming multi-platform dari file video (siaran 24/7),
**ditambah rotasi otomatis judul, thumbnail, deskripsi, dan tags** pada siaran YouTube yang
sedang berjalan.

Terinspirasi [StreamFlow](https://github.com/bangtutorial/streamflow) — arsitekturnya sengaja
dibuat mirip (Express + EJS + SQLite + FFmpeg, satu proses Node) supaya ringan di VPS 1 GB dan
gampang di-deploy.

---

## Daftar Isi

- [Mulai cepat: urutan persiapan](#mulai-cepat-urutan-persiapan) ← **baca ini dulu**
- [Fitur](#fitur)
- [Cara kerja rotasi metadata](#cara-kerja-rotasi-metadata)
- [Batas kuota YouTube API](#batas-kuota-youtube-api-baca-ini-dulu)
- [Kebutuhan sistem](#kebutuhan-sistem)
- [Instalasi](#instalasi) — termasuk cara menghentikan aplikasi
- [Menghubungkan channel YouTube](#menghubungkan-channel-youtube)
- [Panduan pemakaian](#panduan-pemakaian)
- [Deployment](#deployment) — Docker, membuka dashboard dari VPS, PM2, Nginx
- [Struktur proyek](#struktur-proyek)
- [Pemecahan masalah](#pemecahan-masalah)
- [Catatan keamanan](#catatan-keamanan)

---

## Mulai cepat: urutan persiapan

Kerjakan **dari atas ke bawah** — tiap langkah bergantung pada langkah sebelumnya.

**Pertanyaan pertama: butuh fitur Google atau tidak?** Menyiarkan ke YouTube, Facebook, TikTok,
dan lainnya **tidak butuh OAuth sama sekali** — cukup file video dan stream key. Kredensial Google
(OAuth) hanya dipakai dua fitur:

- rotasi judul, thumbnail, deskripsi, dan tags siaran YouTube, dan
- **Impor dari Drive** di Galeri Video.

Kalau belum butuh keduanya, lewati langkah bertanda *(Google)*.

1. **Isi `.env`, lalu jalankan aplikasi** — lewat [Docker](#docker-disarankan-untuk-vps)
   (disarankan untuk VPS) *atau* [`npm start`](#instalasi), jangan keduanya bersamaan. Tiga nilai
   ini wajib benar **sebelum** start pertama:
   - `SESSION_SECRET` dan `ENCRYPTION_KEY` — dari `npm run generate-secret`. `ENCRYPTION_KEY`
     mengunci stream key dan token Google; menggantinya belakangan berarti mengisi ulang semuanya.
   - `APP_URL` — alamat yang **persis** kamu ketik di browser. Nilai ini menjadi redirect URI
     OAuth di langkah 4, dan Google hanya menerima `http://localhost:…` atau `https://domain`,
     **bukan** `http://IP-VPS:7575`. VPS tanpa domain: pakai
     [SSH tunnel](#membuka-dashboard-dari-vps).
2. **Buat akun admin** — halaman Setup muncul sekali, saat aplikasi pertama kali dibuka.
3. **Pastikan FFmpeg terdeteksi** — Dashboard → kartu **Sistem** → FFmpeg `terdeteksi`. Tanpa
   FFmpeg siaran tidak bisa dimulai. Image Docker sudah membawanya.
4. *(Google)* **Buat OAuth Client di Google Cloud, lalu isi Client ID & Secret di Pengaturan** —
   rinciannya di [Menghubungkan channel YouTube](#menghubungkan-channel-youtube). Aktifkan
   **YouTube Data API v3** *dan* **Google Drive API**.
5. *(Google)* **Akun YouTube → Hubungkan Channel.** Butuh langkah 4. Baru setelah langkah ini
   tombol **Impor dari Drive** bisa menampilkan isi Drive.
6. **Galeri Video → unggah video** dari komputer, atau **Impor dari Drive** kalau langkah 5 sudah
   selesai. Untuk mode Copy, videonya harus H.264.
7. **Tujuan RTMP → tambah tujuan** — tempel stream key dari YouTube Studio (atau dari platform
   lain).
8. *(Google)* **Profil Rotasi → Profil Baru** — daftar judul/thumbnail yang akan digilir.
9. **Stream → Stream Baru** — pilih video (langkah 6) dan tujuan (langkah 7). Kalau memakai
   rotasi, pilih juga profil (langkah 8) dan channel (langkah 5). Tekan **Mulai Siaran**.

Jadi, **OAuth dulu atau video dulu?**

| Kasus | Urutan langkah |
|---|---|
| Video dari komputer, tanpa rotasi | 1 → 2 → 3 → 6 → 7 → 9. OAuth tidak perlu. |
| Video diambil dari Google Drive | OAuth **dulu** (4 → 5), baru impor di langkah 6. |
| Ingin rotasi judul/thumbnail | Semua langkah, 1 sampai 9. |

> Kotak **Langkah Persiapan** di Dashboard adalah checklist, bukan urutan. Tiga butirnya —
> kredensial OAuth, channel YouTube, dan profil rotasi — opsional, jadi kotak itu boleh tetap
> belum 6/6 kalau kamu tidak memakai fitur Google.

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

Ada dua cara menjalankan LiveManager — **pilih salah satu, jangan keduanya bersamaan**. Keduanya
berebut port 7575 dan memakai database yang sama, sehingga penjadwal dan siaran bisa berjalan dobel.

- **Docker** — disarankan untuk VPS. FFmpeg dan liquidsoap sudah ada di dalam image, jadi tidak
  ada yang perlu dipasang selain Docker. Langkahnya di [Docker](#docker-disarankan-untuk-vps).
- **Langsung dengan Node** (`npm start`) — dijelaskan di bawah. FFmpeg (dan liquidsoap untuk siaran
  radio) harus dipasang sendiri.

> Di Ubuntu 24.04, FFmpeg 6.1 bawaan sistem tidak mencetak `frame=`/`fps=` pada mode Copy, sehingga
> angka FPS, bitrate, dan bandwidth keluar tetap kosong walau siarannya berjalan normal. FFmpeg 5.1
> di image Docker tidak kena masalah ini.

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
hanya tampil sekali. Setelah itu ikuti [urutan persiapan](#mulai-cepat-urutan-persiapan).

### Menghentikan aplikasi

Bagian ini untuk `npm start`. Untuk Docker, lihat
[perintah sehari-hari Docker](#docker-disarankan-untuk-vps).

- **Terminal tempat `npm start` berjalan masih terbuka:** tekan **Ctrl+C**. Aplikasi menghentikan
  semua siaran dengan rapi dulu, lalu keluar — tunggu sampai log mencetak `Selesai.` (paling lama
  ±10 detik).
- **Terminalnya sudah ditutup, atau berjalan di latar** (`nohup`, `screen`, `tmux`): cari PID yang
  memegang port 7575, lalu kirim sinyal berhenti biasa.

  ```bash
  ss -ltnp | grep 7575     # contoh keluaran: users:(("node",pid=12345,fd=21))
  kill 12345               # ganti dengan PID milikmu; sama rapinya dengan Ctrl+C
  ```

  Kalau kolom `users:` kosong, prosesnya milik user lain — ulangi kedua perintah dengan `sudo`.
  Hindari `kill -9`: penutupan rapi dilewati, dan status siaran baru dibereskan saat aplikasi
  dinyalakan lagi.
- **Dijalankan lewat PM2:** `pm2 stop livemanager`. Supaya tidak ikut hidup lagi saat server
  reboot, lanjutkan dengan `pm2 delete livemanager && pm2 save`.

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
2. **APIs & Services → Library** → aktifkan **YouTube Data API v3**. Kalau ingin memakai
   **Impor dari Drive**, aktifkan juga **Google Drive API** — tanpanya daftar Drive gagal dengan
   *"Google Drive API has not been used in project … before or it is disabled"*.
3. **OAuth consent screen** → pilih *External*, isi nama aplikasi, lalu tambahkan email Google kamu
   sebagai **Test user**.
4. **Credentials → Create Credentials → OAuth client ID** → tipe **Web application**.
5. Pada **Authorized redirect URIs**, masukkan persis:

   ```
   http://localhost:7575/accounts/youtube/callback
   ```

   Ganti sesuai `APP_URL` milikmu. Alamat yang benar selalu ditampilkan di halaman
   **Pengaturan** aplikasi — salin dari sana agar tidak salah ketik.

   Google hanya menerima `http://localhost…` atau `https://…`. Alamat IP seperti
   `http://203.0.113.5:7575/…` **ditolak** saat disimpan. Dari VPS tanpa domain, pakai
   [SSH tunnel](#membuka-dashboard-dari-vps).

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

### Docker (disarankan untuk VPS)

Image membawa FFmpeg 5.1 dan liquidsoap, jadi di server cukup ada Docker. Data hidup di folder
`storage/`, `db/`, dan `logs/` milik host (di-mount sebagai volume), sehingga bertahan melewati
rebuild maupun `docker compose down`.

**1. Pasang Docker beserta plugin Compose** (Ubuntu 24.04):

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker $USER    # logout lalu login lagi supaya docker bisa dipakai tanpa sudo
docker compose version           # harus mencetak nomor versi
```

Paket `docker.io` saja **tidak** membawa perintah `docker compose` — gejalanya
`docker: unknown command: docker compose`. Kalau Docker dipasang dari repo resmi docker.com, nama
paket plugin-nya `docker-compose-plugin`.

**2. Kalau aplikasi masih berjalan lewat `npm start`, hentikan dulu** — lihat
[Menghentikan aplikasi](#menghentikan-aplikasi). Container memakai folder `db/` dan `storage/` yang
sama, jadi akun admin, video, tujuan RTMP, dan channel yang sudah dibuat tetap ada — asalkan isi
`.env` tidak diubah.

**3. Siapkan `.env`** di folder proyek. Berkas ini dibaca `docker compose`, tidak ikut masuk image.

```bash
cp .env.example .env     # lewati kalau .env sudah ada dari npm start — JANGAN ganti kuncinya
```

Isi `SESSION_SECRET` dan `ENCRYPTION_KEY`. Kalau ada Node di host, pakai `npm run generate-secret`.
Tanpa Node:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 48)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

Lalu isi `APP_URL` — baca [Membuka dashboard dari VPS](#membuka-dashboard-dari-vps) sebelum
memilih nilainya. Yang diteruskan ke container hanya `APP_URL`, `SESSION_SECRET`,
`ENCRYPTION_KEY`, `TZ`, dan `MAX_UPLOAD_MB` (lihat `docker-compose.yml`); `FFMPEG_PATH` dan
sejenisnya tidak dibutuhkan di sini.

**4. Bangun dan jalankan:**

```bash
docker compose up -d --build     # build pertama makan beberapa menit
docker compose logs -f           # tunggu "LiveManager berjalan di ..."; Ctrl+C hanya keluar dari log
```

Container menyala lagi sendiri setelah server reboot (`restart: unless-stopped`). Setelah itu buka
dashboard dan ikuti [urutan persiapan](#mulai-cepat-urutan-persiapan).

**Perintah sehari-hari** (jalankan dari folder proyek):

| Perintah | Fungsi |
|---|---|
| `docker compose ps` | status; kolom STATUS menjadi `healthy` begitu `/health` menjawab |
| `docker compose logs -f --tail 100` | ikuti log aplikasi |
| `docker compose stop` | **hentikan** aplikasi; siaran ikut dihentikan dengan rapi |
| `docker compose start` | nyalakan lagi |
| `docker compose restart` | restart aplikasi |
| `docker compose up -d` | terapkan perubahan `.env` — `restart` saja tidak membacanya ulang |
| `docker compose down` | hentikan dan hapus container; data di `storage/`, `db/`, `logs/` tetap aman |
| `git pull && docker compose up -d --build` | perbarui ke versi terbaru |

Di dalam container aplikasi berjalan sebagai **root**, jadi berkas baru di `storage/`, `db/`, dan
`logs/` dimiliki root. Kalau suatu saat kembali ke `npm start` sebagai user biasa, kembalikan dulu
kepemilikannya: `sudo chown -R $USER:$USER storage db logs`.

Image sudah membawa liquidsoap untuk siaran ala radio (menambah ±100 MB di disk). Liquidsoap
butuh ±7–20 detik sebelum siap, jadi tombol **Mulai** pada siaran radio baru menjawab setelah
liquidsoap benar-benar melayani audio — bukan tanda macet. Di dalam container aplikasi berjalan
sebagai root, sehingga skrip liquidsoap mengizinkan root secara eksplisit; audionya tetap hanya
bisa dijangkau dari dalam container (harbor terikat ke `127.0.0.1`).

`.dockerignore` menjaga image tetap bersih: `.env`, database, isi `storage/`, dan `node_modules`
dari mesin build tidak ikut disalin — dependensi dipasang ulang di dalam image, dan data hidup di
volume di atas.

### Membuka dashboard dari VPS

Google menolak redirect URI OAuth yang berupa alamat IP atau tidak memakai HTTPS — kecuali
`localhost`. Karena itu cara membuka dashboard menentukan apakah fitur Google (rotasi metadata dan
Impor dari Drive) bisa dipakai:

| Cara membuka dashboard | Isi `APP_URL` | Siaran & unggah | Hubungkan channel (OAuth) |
|---|---|---|---|
| `http://IP-VPS:7575` | `http://IP-VPS:7575` | bisa | **tidak bisa** — lalu lintasnya juga tidak terenkripsi |
| SSH tunnel, lalu `http://localhost:7575` | `http://localhost:7575` | bisa | bisa |
| Domain + [Nginx](#di-belakang-nginx) + HTTPS | `https://live.domainkamu.com` | bisa | bisa |

**SSH tunnel** adalah jalan termudah kalau belum punya domain. Jalankan di komputermu sendiri,
bukan di VPS:

```bash
ssh -L 7575:localhost:7575 user@IP-VPS
```

Biarkan sesi SSH itu terbuka, lalu buka `http://localhost:7575` di browser komputermu. Tunnel hanya
perlu terbuka selama kamu memakai dashboard — siaran dan rotasi tetap berjalan di VPS setelah
tunnel ditutup.

Dengan tunnel, port 7575 tidak perlu terbuka ke internet. Untuk menutupnya:

- **Docker** — ubah `ports` di `docker-compose.yml` menjadi `"127.0.0.1:7575:7575"`, lalu
  `docker compose up -d`. Memblokir lewat `ufw` saja **tidak cukup**: port yang dipublikasikan
  Docker melewati aturan ufw.
- **`npm start`** — set `HOST=127.0.0.1` di `.env`, lalu restart aplikasi.

### PM2

Alternatif Docker untuk yang menjalankan langsung dengan Node: aplikasi tetap hidup setelah
terminal ditutup dan menyala lagi setelah server reboot.

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Jalankan **satu instance saja**. Proses FFmpeg dan penjadwal rotasi disimpan di memori proses, jadi
cluster mode akan menjalankan siaran yang sama berkali-kali.

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

**`docker: unknown command: docker compose`**
Plugin Compose belum terpasang — paket `docker.io` tidak membawanya. Pasang
`sudo apt install -y docker-compose-v2` (atau `docker-compose-plugin` untuk Docker dari repo
docker.com), lihat [Docker](#docker-disarankan-untuk-vps).

**Port 7575 sudah dipakai (`EADDRINUSE`, `address already in use`, `port is already allocated`)**
Aplikasi sudah berjalan dengan cara lain — biasanya `npm start` yang belum dimatikan saat mencoba
Docker, atau sebaliknya. Hentikan salah satunya dulu ([Menghentikan aplikasi](#menghentikan-aplikasi)
atau `docker compose stop`). Jangan jalankan keduanya: mereka memakai database yang sama.

**`Error 400: redirect_uri_mismatch` saat Hubungkan Channel**
Redirect URI di Google Cloud Console tidak persis sama dengan yang tertulis di halaman
**Pengaturan**. Salin ulang dari sana. Kalau `APP_URL` baru saja diubah, perbarui juga
redirect URI-nya di Google Cloud, dan untuk Docker jalankan `docker compose up -d` supaya
`APP_URL` baru terbaca. Kalau Google menolak menyimpan redirect URI karena berisi alamat IP, pakai
[SSH tunnel atau domain](#membuka-dashboard-dari-vps).

**`EACCES: permission denied` di `storage/`, `db/`, atau `logs/`**
Biasanya muncul saat kembali ke `npm start` setelah memakai Docker: container menulis berkas sebagai
root. Kembalikan kepemilikannya dengan `sudo chown -R $USER:$USER storage db logs`.

**Impor dari Drive: "Google Drive API has not been used in project … before or it is disabled"**
Scope Drive sudah diberikan, tetapi API-nya belum diaktifkan di project Google Cloud. Buka
**APIs & Services → Library → Google Drive API → Enable**, tunggu beberapa menit, lalu coba lagi.
Channel tidak perlu dihubungkan ulang.

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
