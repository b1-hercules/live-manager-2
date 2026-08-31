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
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
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
