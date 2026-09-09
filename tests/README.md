# Tes

Skrip Node polos, tanpa framework — sesuai pola project ini yang tidak memakai
build step dan menahan diri menambah dependency.

```bash
npm test                 # semua, berurutan
npm test -- playlist     # hanya berkas yang namanya mengandung "playlist"
npm test -- --force      # abaikan kunci (lihat di bawah)
```

Runner memasang kunci `tests/.run.lock` selama berjalan dan menolak jalan kalau
kunci itu masih ada. Ini bukan kerewelan: dua runner bersamaan akan saling
menimpa backup database dan berebut port yang sama, dan database kerja bisa
dikembalikan dari backup yang sudah basi. Kalau ada proses yang mati mendadak
dan kuncinya tertinggal, hapus berkasnya atau jalankan dengan `--force`.

Tiap berkas `test-*.js` bisa juga dijalankan sendiri: `node tests/test-disk.js`.
Semuanya mencetak `N pass, M fail` di akhir dan keluar dengan kode 1 bila ada
yang gagal; `run.js` mengandalkan dua hal itu.

## Yang dibutuhkan

- **ffmpeg & ffprobe di PATH** — sebagian besar fixture (video H.264, MKV, AVI,
  FLV, MPEG-TS, berkas tanpa audio) dibuat sungguhan saat tes berjalan, bukan
  disimpan di repo. Tes siaran juga benar-benar menjalankan FFmpeg.
- **Port 7588–7599** bebas. Tiap tes integrasi mem-boot app di portnya sendiri; yang
  memakai sink RTMP lokal juga memakai port yang sama + 100.
- **Database kerja `db/livemanager.db`** — baca bagian berikut sebelum menjalankan.

## Database: backup, jalankan, kembalikan

`config.paths.db` tidak punya override lewat env, jadi tes integrasi menyentuh
database kerja sungguhan. Polanya:

1. `pragma('wal_checkpoint(TRUNCATE)')` — **wajib, jangan dilewati**. `db/index.js`
   memakai `journal_mode = WAL`, jadi tulisan terbaru (termasuk migrasi) awalnya
   hanya ada di `livemanager.db-wal`. Menyalin `.db` tanpa checkpoint akan
   membuang apa pun yang belum tercatat — migrasi v4 pernah hilang diam-diam
   karena ini, dan `user_version` mundur ke 3.
2. Salin `.db` ke berkas backup.
3. Jalankan tes; data uji dibuat lewat model, bukan SQL mentah.
4. Kembalikan `.db` dari backup **dan hapus `-wal`/`-shm`** yang tertinggal.

Karena itu `run.js` menjalankan berkas satu per satu, tidak paralel: dua tes
bersamaan akan saling menimpa backup. Kalau nanti tes makin sering dijalankan,
pertimbangkan menambah env `DB_PATH` supaya tes berjalan di database sendiri.

## Mem-boot app di dalam tes

`app.js` hanya listen kalau menjadi main module, jadi dari skrip lain:
`require('../app.js').boot()`. Berkas `boot-*.js` memanfaatkan itu untuk
menambal modul sebelum boot, supaya cabang yang sulit dibuat nyata tetap teruji:

| Berkas | Yang ditambal | Untuk menguji |
| --- | --- | --- |
| `boot-fulldisk.js` | `system.snapshot` | banner peringatan disk ≥90% |
| `boot-egress.js` | `streamManager.egress` | tampilan bandwidth saat ada siaran |
| `boot-drive.js` | `drive.listVideos/fileInfo/download` | impor Drive tanpa OAuth |

Tes yang butuh siaran sungguhan (`test-playlist-e2e.js`, `test-concat-cleanup.js`,
`test-single-video-regression.js`) menjalankan sink RTMP dari FFmpeg sendiri
(`-listen 1`) supaya siaran benar-benar mengalir, bukan disimulasikan.

## Catatan yang mudah terlupa

- `fetch()` mengirim `Accept: */*`, sedangkan `wantsJson()` (`middleware/auth.js`)
  menentukan format balasan dari header itu. Tes yang memanggil endpoint JSON
  harus menyertakan `Accept: application/json`, atau error datang sebagai
  redirect HTML dan pesannya hilang.
- `.mpg`/`.mpeg` tidak bisa dibuat dengan `rate=10` — encoder MPEG-1/2 menolak
  framerate itu. Pakai `rate=25`.
