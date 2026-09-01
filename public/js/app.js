/* LiveManager — helper sisi klien. Tanpa framework, tanpa build step. */
(function () {
  'use strict';

  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

  const LM = {
    csrf,

    /** POST JSON dengan CSRF token terpasang otomatis. */
    async post(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Tanpa Accept, error server kembali sebagai redirect HTML, bukan JSON.
          Accept: 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify(body || {}),
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* respons kosong */ }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },

    async get(url) {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },

    /**
     * Polling yang berhenti sendiri saat tab disembunyikan, supaya tidak
     * membebani server oleh tab yang ditinggal terbuka berjam-jam.
     */
    poll(url, intervalMs, onData) {
      let timer = null;
      let stopped = false;

      const run = async () => {
        if (stopped || document.hidden) return;
        try {
          onData(await LM.get(url));
        } catch (err) {
          console.warn('[LM] polling gagal:', err.message);
        }
      };

      const startTimer = () => {
        if (timer) clearInterval(timer);
        timer = setInterval(run, intervalMs);
      };

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (timer) clearInterval(timer);
          timer = null;
        } else {
          run();
          startTimer();
        }
      });

      run();
      startTimer();
      return { stop() { stopped = true; if (timer) clearInterval(timer); } };
    },

    toast(message, type) {
      const stack = document.getElementById('toastStack');
      if (!stack) return alert(message);
      const el = document.createElement('div');
      el.className = 'toast ' + (type === 'error' ? 'err' : type === 'success' ? 'ok' : '');
      el.textContent = message;
      stack.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity .25s';
        setTimeout(() => el.remove(), 260);
      }, type === 'error' ? 7000 : 4200);
    },

    async copy(text, label) {
      try {
        await navigator.clipboard.writeText(text);
        LM.toast((label || 'Teks') + ' disalin.', 'success');
      } catch (_) {
        LM.toast('Browser menolak akses clipboard. Salin manual.', 'error');
      }
    },

    /**
     * Unggah berkas besar dalam potongan, supaya koneksi yang putus di tengah
     * tidak memaksa mengulang dari nol. Id unggahan disimpan di localStorage,
     * jadi berkas yang sama masih bisa disambung setelah halaman dimuat ulang.
     *
     * Mengembalikan { promise, cancel }. Kemajuan dilaporkan lewat
     * onProgress(byteTerkirim, total).
     */
    resumableUpload(file, options) {
      const opts = options || {};
      const chunkSize = opts.chunkSize || 8 * 1024 * 1024;
      const onProgress = opts.onProgress || function () {};
      const key = `lm-upload:${file.name}:${file.size}:${file.lastModified}`;
      let cancelled = false;
      let id = null;

      // localStorage bisa ditolak browser (mode privat); itu hanya membuat
      // unggahan tidak bisa disambung, bukan alasan untuk gagal.
      const remember = (value) => {
        try {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        } catch (_) { /* penyimpanan tidak tersedia */ }
      };
      const recall = () => {
        try { return localStorage.getItem(key); } catch (_) { return null; }
      };

      const call = async (url, init) => {
        const res = await fetch(url, {
          ...init,
          // Accept wajib: tanpa itu penanganan error server mengubah kegagalan
          // jadi redirect HTML (lihat wantsJson di middleware/auth.js), dan
          // pesan aslinya tidak pernah sampai ke sini.
          headers: { Accept: 'application/json', 'X-CSRF-Token': csrf, ...((init && init.headers) || {}) },
        });
        let data = {};
        try { data = await res.json(); } catch (_) { /* respons tanpa isi */ }
        return { res, data };
      };

      /** Tanya server sudah sampai byte ke berapa; null bila tidak terjawab. */
      const serverOffset = async () => {
        try {
          const { res, data } = await call('/videos/upload/' + id);
          return res.ok ? data.offset : null;
        } catch (_) {
          return null;
        }
      };

      const promise = (async () => {
        let offset = 0;

        const previous = recall();
        if (previous) {
          const { res, data } = await call('/videos/upload/' + previous);
          // Ukuran harus sama persis; kalau tidak, ini berkas lain bernama sama.
          if (res.ok && data.size === file.size) {
            id = previous;
            offset = data.offset;
          } else {
            remember(null);
          }
        }

        if (!id) {
          const { res, data } = await call('/videos/upload/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name, size: file.size }),
          });
          if (!res.ok) throw new Error(data.error || 'Gagal memulai unggahan.');
          id = data.id;
          remember(id);
        }
        onProgress(offset, file.size);

        let attempts = 0;
        while (offset < file.size) {
          if (cancelled) throw new Error('Unggahan dibatalkan.');
          const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));

          try {
            const { res, data } = await call('/videos/upload/' + id, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset) },
              body: slice,
            });
            if (res.ok) {
              offset = data.offset;
              attempts = 0;
            } else if (typeof data.offset === 'number') {
              // Server yang memegang posisi sebenarnya — ikuti, lalu ulangi.
              offset = data.offset;
            } else {
              throw new Error(data.error || `Potongan ditolak (HTTP ${res.status}).`);
            }
          } catch (err) {
            attempts += 1;
            if (cancelled || attempts > 5) throw err;
            // Mundur bertahap, lalu sambung dari posisi yang diakui server.
            await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempts - 1), 15000)));
            const at = await serverOffset();
            if (at !== null) offset = at;
          }
          onProgress(offset, file.size);
        }

        const { res, data } = await call(`/videos/upload/${id}/finish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: opts.title || '' }),
        });
        if (!res.ok) throw new Error(data.error || 'Unggahan gagal diselesaikan.');
        remember(null);
        return data;
      })();

      return {
        promise,
        cancel() {
          cancelled = true;
          if (id) call('/videos/upload/' + id, { method: 'DELETE' }).catch(() => {});
          remember(null);
        },
      };
    },

    /**
     * Modal pratinjau video memakai elemen <video> bawaan browser — kontrolnya
     * sudah punya scrub, volume, kecepatan, dan fullscreen, jadi tidak ada
     * library yang perlu diunduh.
     */
    preview(src, title) {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';

      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      const head = document.createElement('div');
      head.className = 'modal-head';
      const heading = document.createElement('strong');
      heading.className = 'truncate';
      heading.textContent = title || 'Pratinjau';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn btn-sm btn-ghost';
      close.textContent = 'Tutup';
      head.append(heading, close);

      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = src;

      const note = document.createElement('div');
      note.className = 'preview-note';
      note.hidden = true;

      // mkv, avi, flv, ts, dan mpg tidak bisa diputar browser mana pun — itu
      // batas codec browser, bukan tanda file rusak. FFmpeg tetap menyiarkannya.
      video.addEventListener('error', () => {
        video.hidden = true;
        note.hidden = false;
        const text = document.createElement('p');
        text.className = 'mb-1';
        text.textContent = 'Browser tidak bisa memutar format ini. File tetap sah dan tetap bisa disiarkan FFmpeg.';
        const link = document.createElement('a');
        link.href = src;
        link.className = 'btn btn-sm';
        link.setAttribute('download', '');
        link.textContent = 'Unduh untuk memeriksa sendiri';
        note.append(text, link);
      });

      box.append(head, video, note);
      backdrop.appendChild(box);

      const dismiss = () => {
        video.pause();
        // src dikosongkan supaya unduhan benar-benar berhenti, bukan cuma jeda.
        video.removeAttribute('src');
        video.load();
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (e) => { if (e.key === 'Escape') dismiss(); };

      close.addEventListener('click', dismiss);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
      document.addEventListener('keydown', onKey);

      document.body.appendChild(backdrop);
      return { close: dismiss };
    },

    /** Format ISO jadi "dalam 12 menit" / "3 menit lalu". */
    relative(iso) {
      if (!iso) return '—';
      const diff = new Date(iso).getTime() - Date.now();
      const abs = Math.abs(diff);
      const mins = Math.round(abs / 60000);
      if (abs < 60000) return diff > 0 ? 'sebentar lagi' : 'baru saja';
      if (mins < 60) return diff > 0 ? `dalam ${mins} menit` : `${mins} menit lalu`;
      const hours = Math.floor(mins / 60);
      const rem = mins % 60;
      const text = rem ? `${hours}j ${rem}m` : `${hours} jam`;
      return diff > 0 ? `dalam ${text}` : `${text} lalu`;
    },
  };

  window.LM = LM;

  // ---------------------------------------------------------- interaksi

  document.addEventListener('DOMContentLoaded', () => {
    // Sidebar di layar sempit
    const toggle = document.getElementById('navToggle');
    const sidebar = document.getElementById('sidebar');
    if (toggle && sidebar) {
      toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        if (sidebar.classList.contains('open')) {
          const scrim = document.createElement('div');
          scrim.className = 'scrim';
          scrim.addEventListener('click', () => {
            sidebar.classList.remove('open');
            scrim.remove();
          });
          document.body.appendChild(scrim);
        } else {
          document.querySelector('.scrim')?.remove();
        }
      });
    }

    // Konfirmasi untuk aksi merusak. data-confirm berisi teksnya.
    document.body.addEventListener('submit', (e) => {
      const form = e.target;
      const message = form.dataset.confirm;
      if (message && !window.confirm(message)) e.preventDefault();
    });

    // Tombol salin: <button data-copy="teks" data-copy-label="Stream key">
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      e.preventDefault();
      LM.copy(btn.dataset.copy, btn.dataset.copyLabel);
    });

    // Pratinjau video: <button data-preview-src="/media/..." data-preview-title="...">
    document.body.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-preview-src]');
      if (!trigger) return;
      e.preventDefault();
      LM.preview(trigger.dataset.previewSrc, trigger.dataset.previewTitle);
    });

    // Tab sederhana: <button class="tab" data-tab="id"> + <div id="id">
    document.querySelectorAll('[data-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const group = tab.closest('.tabs');
        if (!group) return;
        group.querySelectorAll('[data-tab]').forEach((t) => {
          t.classList.toggle('active', t === tab);
          const panel = document.getElementById(t.dataset.tab);
          if (panel) panel.hidden = t !== tab;
        });
      });
    });

    // Hitung sisa karakter untuk field yang punya batas platform.
    document.querySelectorAll('[data-counter]').forEach((input) => {
      const target = document.getElementById(input.dataset.counter);
      if (!target) return;
      const max = parseInt(input.getAttribute('maxlength'), 10) || 100;
      const update = () => {
        const used = input.value.length;
        target.textContent = `${used}/${max}`;
        target.style.color = used > max * 0.92 ? 'var(--warn)' : 'var(--text-mute)';
      };
      input.addEventListener('input', update);
      update();
    });

    // Isi URL RTMP otomatis saat platform dipilih.
    document.querySelectorAll('[data-platform-select]').forEach((select) => {
      const urlInput = document.getElementById(select.dataset.platformSelect);
      if (!urlInput) return;
      select.addEventListener('change', () => {
        const preset = select.selectedOptions[0]?.dataset.rtmp || '';
        // Jangan timpa URL yang sudah diketik pengguna.
        if (preset && (!urlInput.value.trim() || urlInput.dataset.autofilled === '1')) {
          urlInput.value = preset;
          urlInput.dataset.autofilled = '1';
        }
      });
      urlInput.addEventListener('input', () => { urlInput.dataset.autofilled = '0'; });
    });

    // Urutkan ulang baris dengan seret-lepas. Wadah: [data-sortable="<url>"],
    // baris: [data-sort-id], pegangan: [data-sort-handle], nomor: [data-sort-index].
    document.querySelectorAll('[data-sortable]').forEach((list) => {
      const url = list.dataset.sortable;
      let dragged = null;
      let orderBefore = [];

      const rows = () => Array.from(list.querySelectorAll('[data-sort-id]'));
      const ids = () => rows().map((row) => row.dataset.sortId);
      const renumber = () => {
        list.querySelectorAll('[data-sort-index]').forEach((el, i) => { el.textContent = i + 1; });
      };

      // Baris hanya bisa diseret bila penekanan dimulai dari pegangannya, supaya
      // teks dan kontrol di dalam baris tetap bisa dipakai seperti biasa.
      list.addEventListener('mousedown', (e) => {
        const row = e.target.closest('[data-sort-id]');
        if (row) row.draggable = Boolean(e.target.closest('[data-sort-handle]'));
      });
      list.addEventListener('mouseup', () => {
        rows().forEach((row) => { row.draggable = false; });
      });

      list.addEventListener('dragstart', (e) => {
        const row = e.target.closest('[data-sort-id]');
        if (!row || !row.draggable) return;
        dragged = row;
        orderBefore = ids();
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox tidak memulai drag sama sekali tanpa data yang terpasang.
        e.dataTransfer.setData('text/plain', row.dataset.sortId);
      });

      list.addEventListener('dragover', (e) => {
        if (!dragged) return;
        e.preventDefault();
        const over = e.target.closest('[data-sort-id]');
        if (!over || over === dragged) return;
        const box = over.getBoundingClientRect();
        const below = e.clientY > box.top + box.height / 2;
        list.insertBefore(dragged, below ? over.nextSibling : over);
      });

      // dragend juga menyala saat drag dibatalkan (Esc), dan urutan di layar
      // sudah terlanjur berubah — jadi keadaan akhir itulah yang disimpan.
      list.addEventListener('dragend', async () => {
        const row = dragged;
        dragged = null;
        if (!row) return;
        row.classList.remove('dragging');
        row.draggable = false;
        renumber();

        const order = ids();
        if (order.join() === orderBefore.join()) return;
        try {
          await LM.post(url, { order: order.map(Number) });
          LM.toast('Urutan varian disimpan.', 'success');
        } catch (err) {
          LM.toast('Urutan gagal disimpan: ' + err.message + ' — muat ulang halaman.', 'error');
        }
      });
    });

    // Tampilkan/sembunyikan blok pengaturan berdasarkan checkbox/select.
    document.querySelectorAll('[data-toggles]').forEach((control) => {
      const targets = control.dataset.toggles.split(',').map((s) => document.getElementById(s.trim())).filter(Boolean);
      const value = control.dataset.togglesValue;
      const apply = () => {
        const on = control.type === 'checkbox' ? control.checked : (value ? control.value === value : Boolean(control.value));
        targets.forEach((t) => { t.hidden = !on; });
      };
      control.addEventListener('change', apply);
      apply();
    });
  });
})();
