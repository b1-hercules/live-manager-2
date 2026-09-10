FROM node:22-bookworm-slim

# FFmpeg wajib ada; liquidsoap hanya dipakai siaran ala radio (tanpanya siaran
# video tetap jalan). python3/make/g++ dibutuhkan sebagai cadangan kalau
# better-sqlite3 harus dikompilasi dari sumber.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg liquidsoap python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY scripts/ensure-native.js ./scripts/
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p storage/videos storage/thumbnails storage/tmp db logs

ENV NODE_ENV=production \
    PORT=7575 \
    HOST=0.0.0.0

EXPOSE 7575

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7575)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
