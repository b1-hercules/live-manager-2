#!/usr/bin/env bash
# =============================================================================
# Pemasang LiveManager: pilih Docker atau npm (Node + PM2), sisanya otomatis.
#
# Aman dijalankan ulang. .env yang sudah terisi dipertahankan — SESSION_SECRET
# dan ENCRYPTION_KEY TIDAK pernah diganti, karena ENCRYPTION_KEY mengunci stream
# key dan token Google. Paket sistem dipasang lewat apt (Ubuntu/Debian), dan
# setiap langkah yang memakai sudo ditanyakan lebih dulu (kecuali dengan -y).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

ASSUME_YES=0
MODE=""
DOCKER_PORT=7575   # tetap, sesuai "ports" di docker-compose.yml
DOCKER=(docker)
SUDO=()
(( EUID == 0 )) || SUDO=(sudo)

if [[ -t 1 ]]; then
  C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_DIM=$'\e[2m'; C_B=$'\e[1m'; C_0=$'\e[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_B=''; C_0=''
fi

info() { printf '%s\n' "${C_DIM}•${C_0} $*"; }
ok()   { printf '%s\n' "${C_OK}✓${C_0} $*"; }
warn() { printf '%s\n' "${C_WARN}! $*${C_0}" >&2; }
die()  { printf '%s\n' "${C_ERR}✗ $*${C_0}" >&2; exit 1; }
step() { printf '\n%s\n' "${C_B}== $* ==${C_0}"; }

usage() {
  cat <<'EOF'
Pemakaian:
  ./install.sh              menu pilihan
  ./install.sh docker       pasang & jalankan lewat Docker (disarankan untuk VPS)
  ./install.sh npm          pasang & jalankan langsung di host: Node + FFmpeg + PM2
  ./install.sh docker -y    jawab "ya" untuk semua pertanyaan (tanpa interaksi)
EOF
}

# Tanya ya/tidak, bawaannya "tidak". -y menjawab "ya" otomatis; tanpa terminal
# (mis. lewat pipa) jawabannya "tidak".
confirm() {
  local answer=""
  if (( ASSUME_YES )); then info "$1 → ya (-y)"; return 0; fi
  [[ -t 0 ]] || return 1
  read -r -p "$1 [y/N] " answer || true
  [[ $answer =~ ^[Yy] ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

apt_install() {
  have apt-get || die "apt-get tidak ada di sistem ini. Pasang manual: $*"
  info "apt-get install $*"
  "${SUDO[@]}" apt-get update -qq
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

port_busy() {  # $1 = port
  have ss || return 1
  [[ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]]
}

wait_health() {  # $1 = port
  have curl || { warn "curl tidak ada — pemeriksaan /health dilewati."; return 0; }
  local i
  for (( i = 0; i < 60; i++ )); do
    curl -fsS -o /dev/null "http://127.0.0.1:$1/health" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

# ---- .env --------------------------------------------------------------------

env_get() {  # nilai terakhir KEY di .env, tanpa tanda kutip
  local line
  line=$(grep -E "^$1=" .env | tail -n 1) || true
  line=${line#*=}
  line=${line%\"}; line=${line#\"}
  printf '%s' "$line"
}

env_set() {  # ganti baris KEY=..., atau tambahkan kalau belum ada
  local key=$1 value=$2 escaped
  if grep -qE "^$key=" .env; then
    escaped=$(printf '%s' "$value" | sed -e 's/[\\|&]/\\&/g')
    sed -i "s|^$key=.*|$key=$escaped|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

random_hex() {  # $1 = jumlah byte
  if have openssl; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

app_port() {
  local port
  port=$(env_get PORT)
  printf '%s' "${port:-7575}"
}

setup_env() {
  step "Konfigurasi .env"
  if [[ ! -f .env ]]; then
    cp .env.example .env
    ok ".env dibuat dari .env.example"
  fi

  # Nilai bawaan .env.example ("ganti-dengan-...") diterima aplikasi maupun
  # docker compose apa adanya, jadi harus diganti di sini — bukan hanya yang kosong.
  local pair key bytes value
  for pair in SESSION_SECRET:48 ENCRYPTION_KEY:32; do
    key=${pair%%:*}; bytes=${pair#*:}
    value=$(env_get "$key")
    if [[ -z $value || $value == ganti-dengan-* ]]; then
      env_set "$key" "$(random_hex "$bytes")"
      ok "$key dibuat"
    else
      info "$key sudah terisi — dipertahankan"
    fi
  done

  local url input=""
  url=$(env_get APP_URL)
  url=${url:-http://localhost:7575}
  cat <<EOF
${C_DIM}APP_URL harus sama persis dengan alamat yang kamu ketik di browser. Google OAuth hanya
menerima http://localhost:... atau https://domain — BUKAN http://IP-VPS:7575. VPS tanpa domain:
biarkan http://localhost:7575 dan buka dashboard lewat SSH tunnel (lihat README).${C_0}
EOF
  if (( ! ASSUME_YES )) && [[ -t 0 ]]; then
    read -r -p "APP_URL [$url]: " input || true
    url=${input:-$url}
  fi
  url=${url%/}
  env_set APP_URL "$url"
  ok "APP_URL = $url"
}

# ---- Docker ------------------------------------------------------------------

install_docker() {
  step "Docker"
  if ! have docker; then
    confirm "Docker belum terpasang. Pasang docker.io + docker-compose-v2 lewat apt (sudo)?" \
      || die "Batal. Pasang Docker dulu, lalu jalankan ulang: ./install.sh docker"
    apt_install docker.io docker-compose-v2
    "${SUDO[@]}" systemctl enable --now docker
  fi

  # Belum punya hak ke docker.sock (belum di grup docker, atau belum login
  # ulang setelah dimasukkan) → sesi ini memakai sudo.
  if ! docker info >/dev/null 2>&1 && (( EUID != 0 )); then
    DOCKER=(sudo docker)
    warn "$ME belum bisa memakai docker tanpa sudo — sesi ini memakai sudo."
    if ! id -nG "$ME" | tr ' ' '\n' | grep -qx docker \
       && confirm "Tambahkan $ME ke grup docker (berlaku setelah logout lalu login lagi)?"; then
      sudo usermod -aG docker "$ME"
      ok "$ME masuk grup docker — logout lalu login lagi supaya tidak perlu sudo"
    fi
  fi
  "${DOCKER[@]}" info >/dev/null 2>&1 || die "Docker daemon tidak menjawab. Coba: sudo systemctl start docker"
  ok "docker siap"

  if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    local pkg=docker-compose-v2
    # Docker dari repo docker.com memakai nama paket lain untuk plugin yang sama.
    dpkg -s docker-ce >/dev/null 2>&1 && pkg=docker-compose-plugin
    confirm "Plugin 'docker compose' belum ada. Pasang $pkg lewat apt (sudo)?" \
      || die "Batal. Pasang dulu: sudo apt install -y $pkg"
    apt_install "$pkg"
    "${DOCKER[@]}" compose version >/dev/null 2>&1 \
      || die "'docker compose' masih belum bisa dipakai setelah $pkg dipasang."
  fi
  ok "$("${DOCKER[@]}" compose version | head -n 1)"

  # Port dipegang proses lain (biasanya npm start / PM2) → dua instance akan
  # berbagi database yang sama. Container kita sendiri boleh; akan diganti.
  if port_busy "$DOCKER_PORT" \
     && [[ -z "$("${DOCKER[@]}" ps -q --filter 'name=^livemanager$' 2>/dev/null)" ]]; then
    die "Port $DOCKER_PORT sudah dipakai proses lain (npm start / PM2?). Hentikan dulu — README bagian \"Menghentikan aplikasi\" — lalu jalankan ulang."
  fi

  step "Build & jalankan container"
  "${DOCKER[@]}" compose up -d --build

  info "Menunggu aplikasi siap..."
  if wait_health "$DOCKER_PORT"; then
    ok "Aplikasi menjawab di port $DOCKER_PORT"
  else
    warn "Aplikasi belum menjawab setelah 2 menit. Cek log: ${DOCKER[*]} compose logs --tail 50"
  fi

  cat <<EOF

${C_B}Selesai — LiveManager berjalan di Docker.${C_0}
  Buka          : $(env_get APP_URL)
  Log           : ${DOCKER[*]} compose logs -f
  Hentikan      : ${DOCKER[*]} compose stop
  Nyalakan lagi : ${DOCKER[*]} compose start
  Perbarui      : git pull && ${DOCKER[*]} compose up -d --build
Container menyala sendiri setelah server reboot.
EOF
}

# ---- npm (Node + PM2) --------------------------------------------------------

install_npm() {
  step "Node.js"
  have node || die "Node.js belum terpasang. Pasang Node 22 (mis. lewat nodesource atau mise), lalu jalankan ulang: ./install.sh npm"
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  (( major >= 18 )) || die "Node $(node -v) terlalu lama — butuh 18 ke atas (disarankan 22)."
  ok "node $(node -v)"
  (( major == 22 )) || warn "Aplikasi diuji di Node 22 (sama dengan image Docker); kamu memakai Node $major."
  # better-sqlite3 belum tentu punya binary siap pakai untuk Node yang lebih
  # baru dari 22 (untuk Node 24 terbukti tidak ada), dan kompilasinya butuh
  # make, g++, dan python3.
  if (( major > 22 )) && ! { have make && have g++ && have python3; }; then
    confirm "Node $major mungkin harus mengompilasi better-sqlite3. Pasang build-essential + python3 (sudo)?" \
      && apt_install build-essential python3 \
      || warn "Tanpa build tools, npm install bisa gagal di better-sqlite3."
  fi

  step "FFmpeg & liquidsoap"
  if ! have ffmpeg || ! have ffprobe; then
    confirm "FFmpeg belum terpasang (wajib untuk siaran). Pasang lewat apt (sudo)?" \
      || die "Batal. Pasang dulu: sudo apt install -y ffmpeg"
    apt_install ffmpeg
  fi
  local ffver
  ffver=$(ffmpeg -version 2>/dev/null | head -n 1 | cut -d' ' -f3) || true
  ok "ffmpeg $ffver"
  if [[ $ffver =~ ^([0-9]+)\.([0-9]+) ]] \
     && (( BASH_REMATCH[1] > 6 || (BASH_REMATCH[1] == 6 && BASH_REMATCH[2] >= 1) )); then
    warn "FFmpeg $ffver tidak mencetak frame=/fps= pada mode Copy: angka FPS, bitrate, dan bandwidth di dashboard akan kosong walau siarannya jalan. Image Docker (FFmpeg 5.1) tidak kena."
  fi
  if ! have liquidsoap; then
    if confirm "liquidsoap belum ada (hanya untuk siaran ala radio, opsional). Pasang lewat apt (sudo)?"; then
      apt_install liquidsoap
    else
      info "liquidsoap dilewati — siaran video tetap jalan normal."
    fi
  fi

  # Container Docker menulis sebagai root; sisa berkasnya membuat aplikasi
  # yang dijalankan user biasa gagal dengan EACCES.
  local foreign
  foreign=$(find storage db logs -maxdepth 3 ! -user "$(id -u)" -print -quit 2>/dev/null) || true
  if [[ -n $foreign ]]; then
    warn "Ada berkas bukan milik $ME (contoh: $foreign) — biasanya sisa Docker."
    confirm "Kembalikan kepemilikan storage/ db/ logs/ ke $ME (sudo chown)?" \
      && "${SUDO[@]}" chown -R "$ME:$(id -gn)" storage db logs \
      || warn "Tanpa itu aplikasi bisa gagal dengan EACCES."
  fi

  step "Dependency npm"
  npm install --no-audit --no-fund

  step "PM2"
  local port
  port=$(app_port)
  if ! have pm2; then
    if confirm "Pasang PM2 (menjaga aplikasi tetap hidup dan menyala lagi setelah reboot)?"; then
      local prefix
      prefix=$(npm prefix -g)
      if [[ -w $prefix/lib || -w $prefix ]]; then
        npm install -g pm2
      else
        "${SUDO[@]}" env PATH="$PATH" npm install -g pm2
      fi
    else
      port_busy "$port" && die "Port $port sudah dipakai proses lain. Hentikan dulu, lalu jalankan ulang."
      warn "Tanpa PM2 — aplikasi berjalan di terminal ini. Ctrl+C untuk berhenti."
      exec npm start
    fi
  fi
  ok "pm2 $(pm2 -v)"

  if [[ $(pm2 jlist 2>/dev/null) == *'"name":"livemanager"'* ]]; then
    step "Restart aplikasi (PM2)"
    pm2 restart livemanager --update-env
  else
    port_busy "$port" \
      && die "Port $port sudah dipakai proses lain (container Docker? npm start?). Hentikan dulu — 'docker compose stop', atau README bagian \"Menghentikan aplikasi\"."
    step "Jalankan aplikasi (PM2)"
    pm2 start ecosystem.config.js
  fi
  pm2 save

  if confirm "Nyalakan otomatis setelah server reboot (pm2 startup, butuh sudo)?"; then
    "${SUDO[@]}" env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$ME" --hp "$HOME"
  else
    info "Dilewati. Nanti bisa: pm2 startup, lalu jalankan perintah yang dicetaknya."
  fi

  info "Menunggu aplikasi siap..."
  if wait_health "$port"; then
    ok "Aplikasi menjawab di port $port"
  else
    warn "Aplikasi belum menjawab setelah 2 menit. Cek log: pm2 logs livemanager --lines 50"
  fi

  cat <<EOF

${C_B}Selesai — LiveManager berjalan lewat PM2.${C_0}
  Buka          : $(env_get APP_URL)
  Log           : pm2 logs livemanager
  Hentikan      : pm2 stop livemanager
  Nyalakan lagi : pm2 start livemanager
  Perbarui      : git pull && npm install && pm2 restart livemanager
EOF
}

# ---- main --------------------------------------------------------------------

while (( $# )); do
  case $1 in
    docker|npm) MODE=$1 ;;
    -y|--yes)   ASSUME_YES=1 ;;
    -h|--help)  usage; exit 0 ;;
    *)          usage >&2; die "Argumen tidak dikenal: $1" ;;
  esac
  shift
done

[[ -f .env.example && -f docker-compose.yml && -f ecosystem.config.js ]] \
  || die "install.sh harus berada di folder proyek LiveManager (di sebelah docker-compose.yml)."

ME=$(id -un)

if [[ -z $MODE ]]; then
  [[ -t 0 ]] || die "Tidak ada terminal untuk menu. Pakai: ./install.sh docker   atau   ./install.sh npm"
  cat <<EOF
${C_B}Pemasang LiveManager${C_0}
  1) Docker      — disarankan untuk VPS. FFmpeg & liquidsoap sudah di dalam image,
                   dan container menyala sendiri setelah reboot.
  2) npm + PM2   — langsung di host. FFmpeg (dan liquidsoap) dipasang lewat apt.
  q) Batal
Pilih salah satu saja — keduanya memakai database yang sama.
EOF
  choice=""
  read -r -p "Pilihan [1]: " choice || true
  case ${choice:-1} in
    1|docker) MODE=docker ;;
    2|npm)    MODE=npm ;;
    *)        info "Batal."; exit 0 ;;
  esac
fi

setup_env
case $MODE in
  docker) install_docker ;;
  npm)    install_npm ;;
esac
echo
info "Berikutnya: buka dashboard, buat akun admin, lalu ikuti \"Mulai cepat: urutan persiapan\" di README."
