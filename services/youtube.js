'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('../config');
const settings = require('../models/settings');
const accounts = require('../models/account');
const { createLogger } = require('../utils/logger');
const { limitTags } = require('../utils/helpers');

const log = createLogger('youtube');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.force-ssl', // baca + tulis metadata & thumbnail
  'https://www.googleapis.com/auth/youtube.readonly',
];

/** Error yang membawa informasi cukup untuk diputuskan oleh rotation engine. */
class YouTubeError extends Error {
  constructor(message, { reason = 'unknown', fatal = false, quota = false, status = null } = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.reason = reason;
    this.fatal = fatal;   // akun perlu dihubungkan ulang
    this.quota = quota;   // kuota harian habis
    this.status = status;
  }
}

// ------------------------------------------------------------------ OAuth

function oauthClient() {
  const { clientId, clientSecret } = settings.googleCredentials();
  if (!clientId || !clientSecret) {
    throw new YouTubeError(
      'Google OAuth Client ID/Secret belum diisi. Buka Pengaturan untuk mengisinya.',
      { reason: 'no_credentials', fatal: true }
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, config.googleRedirectUri);
}

function getAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state,
    // 'consent' memaksa Google mengirim refresh_token lagi; tanpa ini akun yang
    // pernah diizinkan hanya mengembalikan access token berumur pendek.
    prompt: 'consent',
    include_granted_scopes: true,
  });
}

/** Tukar authorization code jadi token, lalu ambil identitas channel. */
async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const youtube = google.youtube({ version: 'v3', auth: client });
  const res = await youtube.channels.list({ part: ['snippet', 'contentDetails'], mine: true });
  const channel = res.data.items?.[0];
  if (!channel) {
    throw new YouTubeError(
      'Akun Google ini tidak punya channel YouTube. Buat channel dulu, lalu hubungkan ulang.',
      { reason: 'no_channel', fatal: true }
    );
  }

  return {
    tokens,
    channel: {
      id: channel.id,
      title: channel.snippet?.title || 'Channel YouTube',
      avatar: channel.snippet?.thumbnails?.default?.url || null,
    },
  };
}

/**
 * Bangun client terautentikasi untuk sebuah akun. Token hasil refresh langsung
 * disimpan kembali supaya siaran 24/7 tidak pernah kehabisan access token.
 */
function clientForAccount(account) {
  if (!account?.refresh_token) {
    throw new YouTubeError(
      `Akun "${account?.name || 'YouTube'}" tidak punya refresh token. Hubungkan ulang akunnya.`,
      { reason: 'no_refresh_token', fatal: true }
    );
  }

  const client = oauthClient();
  client.setCredentials({
    access_token: account.access_token || undefined,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expires_at ? new Date(account.token_expires_at).getTime() : undefined,
  });

  client.on('tokens', (tokens) => {
    try {
      accounts.updateTokens(account.id, {
        access_token: tokens.access_token || account.access_token,
        refresh_token: tokens.refresh_token || null,
        expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      });
      log.debug('Token diperbarui', { accountId: account.id });
    } catch (err) {
      log.error('Gagal menyimpan token baru', err);
    }
  });

  return google.youtube({ version: 'v3', auth: client });
}

// ------------------------------------------------------------ operasi API

/**
 * Cari video ID dari siaran yang sedang aktif di channel.
 * Kalau tidak ada yang aktif, coba yang berstatus "upcoming" — berguna saat
 * FFmpeg baru mulai mengirim data dan YouTube belum menandainya live.
 */
async function detectActiveBroadcast(account) {
  const youtube = clientForAccount(account);
  try {
    for (const status of ['active', 'upcoming']) {
      const res = await youtube.liveBroadcasts.list({
        part: ['id', 'snippet', 'status'],
        broadcastStatus: status,
        broadcastType: 'all',
        maxResults: 5,
      });
      accounts.addQuota(account.id, accounts.QUOTA_COST['liveBroadcasts.list']);

      const item = res.data.items?.[0];
      if (item) {
        return {
          videoId: item.id,
          title: item.snippet?.title || null,
          status,
          scheduledStart: item.snippet?.scheduledStartTime || null,
        };
      }
    }
    return null;
  } catch (err) {
    throw wrapError(err, account);
  }
}

/**
 * Ganti judul/deskripsi/tags. videos.update MENIMPA seluruh snippet, jadi kita
 * wajib membaca snippet lama dulu dan menggabungkannya — kalau tidak,
 * categoryId dan bahasa video akan hilang.
 */
async function updateMetadata(account, videoId, { title, description, tags }) {
  const youtube = clientForAccount(account);
  const changed = {};

  try {
    const current = await youtube.videos.list({ part: ['snippet'], id: [videoId] });
    accounts.addQuota(account.id, accounts.QUOTA_COST['videos.list']);

    const video = current.data.items?.[0];
    if (!video) {
      throw new YouTubeError(`Video ${videoId} tidak ditemukan di channel ini.`, { reason: 'video_not_found' });
    }

    const snippet = { ...video.snippet };

    if (title !== undefined && title !== null && title !== '') {
      snippet.title = String(title).slice(0, 100);
      changed.title = snippet.title;
    }
    if (description !== undefined && description !== null) {
      snippet.description = String(description).slice(0, 5000);
      changed.description = snippet.description;
    }
    if (Array.isArray(tags)) {
      snippet.tags = limitTags(tags);
      changed.tags = snippet.tags;
    }

    // categoryId wajib ada di request update. Kalau video lama tidak punya,
    // pakai 24 (Entertainment) sebagai nilai aman.
    if (!snippet.categoryId) snippet.categoryId = '24';

    if (!Object.keys(changed).length) return { changed: {}, quotaCost: accounts.QUOTA_COST['videos.list'] };

    await youtube.videos.update({
      part: ['snippet'],
      requestBody: { id: videoId, snippet },
    });
    accounts.addQuota(account.id, accounts.QUOTA_COST['videos.update']);

    return {
      changed,
      quotaCost: accounts.QUOTA_COST['videos.list'] + accounts.QUOTA_COST['videos.update'],
    };
  } catch (err) {
    throw wrapError(err, account);
  }
}

/** Unggah thumbnail kustom. Butuh channel terverifikasi di sisi YouTube. */
async function setThumbnail(account, videoId, filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(config.root, filePath);
  if (!fs.existsSync(abs)) {
    throw new YouTubeError(`File thumbnail tidak ditemukan: ${filePath}`, { reason: 'thumbnail_missing' });
  }

  const size = fs.statSync(abs).size;
  if (size > 2 * 1024 * 1024) {
    throw new YouTubeError(
      `Thumbnail ${(size / 1024 / 1024).toFixed(1)} MB melebihi batas YouTube (2 MB).`,
      { reason: 'thumbnail_too_large' }
    );
  }

  const youtube = clientForAccount(account);
  try {
    await youtube.thumbnails.set({
      videoId,
      media: { body: fs.createReadStream(abs) },
    });
    accounts.addQuota(account.id, accounts.QUOTA_COST['thumbnails.set']);
    return { quotaCost: accounts.QUOTA_COST['thumbnails.set'] };
  } catch (err) {
    throw wrapError(err, account);
  }
}

/** Ambil judul/status video saat ini, untuk ditampilkan di panel monitoring. */
async function getVideoSnapshot(account, videoId) {
  const youtube = clientForAccount(account);
  try {
    const res = await youtube.videos.list({ part: ['snippet', 'liveStreamingDetails', 'statistics'], id: [videoId] });
    accounts.addQuota(account.id, accounts.QUOTA_COST['videos.list']);
    const item = res.data.items?.[0];
    if (!item) return null;
    return {
      id: item.id,
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      tags: item.snippet?.tags || [],
      thumbnail: item.snippet?.thumbnails?.medium?.url || null,
      concurrentViewers: item.liveStreamingDetails?.concurrentViewers || null,
      viewCount: item.statistics?.viewCount || null,
      likeCount: item.statistics?.likeCount || null,
    };
  } catch (err) {
    throw wrapError(err, account);
  }
}

// ----------------------------------------------------------- error mapping

/** Terjemahkan error googleapis jadi YouTubeError yang bisa ditindaklanjuti. */
function wrapError(err, account) {
  if (err instanceof YouTubeError) return err;

  const status = err?.response?.status || err?.code || null;
  const apiError = err?.response?.data?.error;
  const reason = apiError?.errors?.[0]?.reason || err?.errors?.[0]?.reason || '';
  const message = apiError?.message || err?.message || 'Kesalahan tidak diketahui';

  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') {
    return new YouTubeError(
      'Kuota harian YouTube Data API habis. Rotasi dilanjutkan setelah kuota reset (00:00 Pacific Time).',
      { reason, quota: true, status }
    );
  }

  if (err?.message === 'invalid_grant' || reason === 'authError' || status === 401) {
    if (account) accounts.markError(account.id, 'Token tidak berlaku, perlu dihubungkan ulang');
    return new YouTubeError(
      'Otorisasi YouTube tidak berlaku lagi. Hubungkan ulang akunnya di halaman Akun.',
      { reason: 'invalid_grant', fatal: true, status }
    );
  }

  if (reason === 'forbidden' || status === 403) {
    return new YouTubeError(
      `Ditolak YouTube: ${message}. Untuk thumbnail kustom, channel harus terverifikasi terlebih dahulu.`,
      { reason: reason || 'forbidden', status }
    );
  }

  if (status === 404 || reason === 'videoNotFound') {
    return new YouTubeError(`Video tidak ditemukan: ${message}`, { reason: 'video_not_found', status });
  }

  return new YouTubeError(message, { reason: reason || 'unknown', status });
}

module.exports = {
  SCOPES, YouTubeError,
  getAuthUrl, exchangeCode, clientForAccount,
  detectActiveBroadcast, updateMetadata, setThumbnail, getVideoSnapshot,
};
