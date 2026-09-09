'use strict';

// Fondasi playlist: regresi argumen video tunggal (WAJIB tidak berubah),
// pembentukan daftar concat, validasi kecocokan, dan siaran nyata ke file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ffmpeg = require(path.join(ROOT, 'services/ffmpeg'));
const config = require(path.join(ROOT, 'config'));

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(actual)}\n        want=${JSON.stringify(expected)}`);
}

const baseStream = {
  id: 4242, encode_mode: 'copy', resolution: 'source', orientation: 'landscape',
  bitrate: 4500, audio_bitrate: 128, fps: 30, preset: 'veryfast', loop_video: 1,
};
const vid = (over = {}) => ({
  filepath: 'C:/media/a.mp4', has_audio: 1, audio_codec: 'aac', video_codec: 'h264',
  width: 1280, height: 720, fps: 30, duration: 60, title: 'A', ...over,
});

// ------------------------------------------- regresi: video tunggal
console.log('--- regresi jalur video tunggal (harus persis seperti sebelumnya) ---');
const single = ffmpeg.buildArgs(baseStream, vid(), ['rtmp://x/live/key']);
const expected = [
  '-hide_banner', '-loglevel', 'warning', '-stats', '-nostdin',
  '-fflags', '+genpts', '-re', '-stream_loop', '-1', '-i', 'C:/media/a.mp4',
  '-map', '0:v:0', '-map', '0:a:0',
  '-c:v', 'copy', '-c:a', 'copy',
  '-max_muxing_queue_size', '1024',
  '-f', 'flv', '-flvflags', 'no_duration_filesize', 'rtmp://x/live/key',
];
check('argumen video tunggal tidak berubah sama sekali', single, expected);
check('tidak menyelipkan -f concat', single.includes('concat'), false);

const noLoop = ffmpeg.buildArgs({ ...baseStream, loop_video: 0 }, vid(), ['rtmp://x/k']);
check('loop mati tetap dihormati', noLoop.includes('-stream_loop'), false);

const noAudio = ffmpeg.buildArgs(baseStream, vid({ has_audio: 0 }), ['rtmp://x/k']);
check('video tanpa audio tetap dapat anullsrc', noAudio.includes('anullsrc=channel_layout=stereo:sample_rate=44100'), true);
check('video tanpa audio tetap dapat -shortest', noAudio.includes('-shortest'), true);

// -------------------------------------------------- daftar concat
console.log('\n--- pembentukan daftar concat ---');
const items = [
  { filepath: 'C:/media/satu.mp4', has_audio: 1, audio_codec: 'aac', duration: 30 },
  { filepath: "C:/media/pu'nya kutip.mp4", has_audio: 1, audio_codec: 'aac', duration: 20 },
];
const src = ffmpeg.buildConcatSource(4242, items);
const listText = fs.readFileSync(src.concatPath, 'utf8');
console.log(listText.trim().split('\n').map((l) => '        ' + l).join('\n'));

check('daftar berisi satu baris per video', listText.trim().split('\n').length, 2);
// Baris pertama tidak mengandung kutip, jadi backslash apa pun di situ berarti
// pemisah direktori — itulah yang tidak boleh ada.
check('path memakai garis miring maju', listText.split('\n')[0].includes('\\'), false);
check("kutip tunggal di-escape sebagai '\\''", listText.includes("pu'\\''nya kutip.mp4"), true);
check('durasi dijumlahkan', src.duration, 50);
check('codec diambil dari item pertama', src.audio_codec, 'aac');

const plArgs = ffmpeg.buildArgs(baseStream, src, ['rtmp://x/k']);
const i = plArgs.indexOf('-i');
check('-f concat -safe 0 tepat sebelum -i', plArgs.slice(i - 4, i), ['-f', 'concat', '-safe', '0']);
check('-stream_loop mendahului -f concat', plArgs.indexOf('-stream_loop') < plArgs.indexOf('concat'), true);
check('-safe 0 terpasang', plArgs.includes('-safe') && plArgs[plArgs.indexOf('-safe') + 1] === '0', true);
check('input menunjuk daftar concat', plArgs[i + 1], src.concatPath);
check('loop playlist memakai -stream_loop -1', plArgs.includes('-stream_loop'), true);

ffmpeg.cleanupConcatFile(4242);
check('cleanup menghapus daftar', fs.existsSync(src.concatPath), false);
check('cleanup dua kali tidak melempar error', (() => { ffmpeg.cleanupConcatFile(4242); return true; })(), true);

// ------------------------------------------------ validasi kecocokan
console.log('\n--- validasi kecocokan spesifikasi ---');
const seragam = [vid(), vid({ title: 'B' })];
check('playlist seragam: tidak ada peringatan', ffmpeg.playlistWarnings(baseStream, seragam), []);
check('playlist seragam: tidak ada penghalang', ffmpeg.playlistBlockers(baseStream, seragam), []);

const bedaResolusi = [vid(), vid({ width: 640, height: 480, title: 'B' })];
const wRes = ffmpeg.playlistWarnings(baseStream, bedaResolusi);
check('beda resolusi + copy: diperingatkan', wRes.length, 1);
check('peringatan menyebut siaran rusak', /rusak/.test(wRes[0]), true);
check('beda resolusi + copy: DIHALANGI', ffmpeg.playlistBlockers(baseStream, bedaResolusi).length, 1);

const reencode = { ...baseStream, encode_mode: 'reencode' };
const wReenc = ffmpeg.playlistWarnings(reencode, bedaResolusi);
check('beda resolusi + reencode: tetap diperingatkan', wReenc.length, 1);
check('peringatan reencode tidak bilang rusak', /rusak/.test(wReenc[0]), false);
check('beda resolusi + reencode: TIDAK dihalangi', ffmpeg.playlistBlockers(reencode, bedaResolusi), []);

const bedaCodec = [vid(), vid({ video_codec: 'hevc', title: 'B' })];
check('beda codec video + copy: dihalangi', ffmpeg.playlistBlockers(baseStream, bedaCodec).length, 1);

const bedaAudio = [vid(), vid({ has_audio: 0, title: 'B' })];
check('sebagian tanpa audio: dihalangi walau reencode', ffmpeg.playlistBlockers(reencode, bedaAudio).length, 1);

const bedaFps = [vid(), vid({ fps: 60, title: 'B' })];
check('beda fps + copy: diperingatkan tapi tidak dihalangi',
  [ffmpeg.playlistWarnings(baseStream, bedaFps).length, ffmpeg.playlistBlockers(baseStream, bedaFps).length], [1, 0]);

check('playlist kosong: diperingatkan', ffmpeg.playlistWarnings(baseStream, []).length, 1);
check('playlist kosong: dihalangi', ffmpeg.playlistBlockers(baseStream, []).length, 1);

// --------------------------------- siaran nyata: concat benar-benar jalan
console.log('\n--- siaran nyata dengan FFmpeg (2 video → 1 keluaran) ---');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
const files = [];
for (let n = 1; n <= 2; n++) {
  const p = path.join(dir, `v${n}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `testsrc=duration=3:size=640x480:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p], { stdio: 'pipe' });
  files.push(p);
}

const realItems = files.map((p, n) => ({
  filepath: p, has_audio: 1, audio_codec: 'aac', video_codec: 'h264',
  width: 640, height: 480, fps: 25, duration: 3, title: `v${n + 1}`,
}));
const realSrc = ffmpeg.buildConcatSource(9999, realItems);

// Tanpa loop, keluaran ke file: dua video harus tersambung jadi ~6 detik.
const outPath = path.join(dir, 'out.mp4');
const args = ffmpeg.buildArgs({ ...baseStream, id: 9999, loop_video: 0 }, realSrc, ['rtmp://placeholder/k']);
const fileArgs = args.slice(0, args.indexOf('-f', args.indexOf('-max_muxing_queue_size')));
execFileSync('ffmpeg', [...fileArgs, '-y', outPath], { stdio: 'pipe' });

const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', outPath], { encoding: 'utf8' }).trim());
console.log(`        durasi keluaran: ${dur.toFixed(2)}s (2 video × 3s)`);
check('dua video benar-benar tersambung (~6 detik)', dur > 5.8 && dur < 6.3, true);

const sizes = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
  'frame=width,height', '-of', 'csv=p=0', outPath], { encoding: 'utf8' });
// ffprobe di Windows mengakhiri baris dengan CRLF dan kadang menyisakan koma.
const frameSizes = [...new Set(sizes.trim().split(/\r?\n/).map((s) => s.replace(/[,\s]+$/, '')))];
check('semua frame berukuran sama (tidak tercampur)', frameSizes, ['640,480']);

ffmpeg.cleanupConcatFile(9999);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
