const axios = require('axios');
const yts = require('yt-search');
const { withHealth } = require('../../utils/apiHealth');

const YT_REGEX = /(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/;
const wait = ms => new Promise(r => setTimeout(r, ms));

function normalizeYouTubeUrl(input) {
  const match = String(input || '').match(YT_REGEX);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : input;
}

function extractAudio(data) {
  const item = data?.data || data?.result || data;
  const url =
    item?.downloadUrl || item?.download || item?.download_url ||
    item?.dl || item?.url || item?.mp3;
  if (!url) return null;
  return {
    downloadUrl: url,
    title: item?.title || item?.name || 'song',
    thumbnail: item?.thumbnail || item?.thumb
  };
}

// ─── Individual API callers ────────────────────────────────────────────────────
async function tryQasimDevMp3(url) {
  return withHealth('qasimdev_mp3', async () => {
    const { data } = await axios.get('https://api.qasimdev.dpdns.org/api/youtube/download', {
      params: { apiKey: 'qasim-dev', url, format: 'mp3' },
      timeout: 25000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const dl = data?.data?.download || data?.download;
    if (!dl) throw new Error('QasimDev mp3: no download URL');
    return { downloadUrl: dl, title: data?.data?.title || 'song', thumbnail: data?.data?.thumbnail };
  });
}

async function tryQasimDevLoader(url) {
  return withHealth('qasimdev_loader_mp3', async () => {
    const apiKey = process.env.SONG_DOWNLOAD_API_KEY || 'xbps-install-Syu';
    const { data } = await axios.get('https://api.qasimdev.dpdns.org/api/loaderto/download', {
      params: { apiKey, format: 'mp3', url },
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const audio = extractAudio(data);
    if (!audio) throw new Error('QasimDev loader: no download URL');
    return audio;
  });
}

async function tryYupra(url) {
  return withHealth('yupra_mp3', async () => {
    const { data } = await axios.get(
      `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(url)}`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const dl = data?.data?.download_url;
    if (!dl) throw new Error('Yupra: no download URL');
    return { downloadUrl: dl, title: data?.data?.title || 'song', thumbnail: data?.data?.thumbnail };
  });
}

async function tryOkatsu(url) {
  return withHealth('okatsu_mp3', async () => {
    const { data } = await axios.get(
      `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(url)}`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!data?.dl) throw new Error('Okatsu: no dl');
    return { downloadUrl: data.dl, title: data.title || 'song', thumbnail: data.thumb };
  });
}

async function tryEliteProTech(url) {
  return withHealth('eliteprotech_mp3', async () => {
    const { data } = await axios.get(
      `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(url)}&format=mp3`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!data?.success || !data?.downloadURL) throw new Error('EliteProTech: no URL');
    return { downloadUrl: data.downloadURL, title: data.title || 'song' };
  });
}

async function tryIzumi(url) {
  return withHealth('izumi_mp3', async () => {
    const { data } = await axios.get(
      `https://izumiiiiiiii.dpdns.org/downloader/youtube?url=${encodeURIComponent(url)}&format=mp3`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const dl = data?.result?.download;
    if (!dl) throw new Error('Izumi: no download');
    return { downloadUrl: dl, title: data.result.title || 'song', thumbnail: data.result.thumbnail };
  });
}

// ─── Ordered fallback chain ────────────────────────────────────────────────────
async function downloadWithFallbacks(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  const sources = [
    () => tryQasimDevMp3(normalizedUrl),
    () => tryQasimDevLoader(normalizedUrl),
    () => tryYupra(normalizedUrl),
    () => tryEliteProTech(normalizedUrl),
    () => tryOkatsu(normalizedUrl),
    () => tryIzumi(normalizedUrl),
  ];

  const errors = [];
  for (const source of sources) {
    try {
      const audio = await source();
      if (audio?.downloadUrl) return audio;
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(errors.find(e => !e.includes('down (retrying')) || errors[0] || 'All sources failed');
}

// ─── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  name: 'song',
  command: 'song',
  aliases: ['music', 'audio', 'mp3'],
  category: 'music',
  description: 'Download song from YouTube (MP3)',
  usage: '.song <song name | youtube link>',

  async handler(sock, message, args, context) {
    const chatId = context.chatId || message.key.remoteJid;
    const query = args.join(' ').trim();

    if (!query) {
      return sock.sendMessage(chatId, {
        text: '🎵 *Song Downloader*\n\nUsage: .song <song name | YouTube link>\nExample: .song shape of you'
      }, { quoted: message });
    }

    try {
      let video;
      if (YT_REGEX.test(query)) {
        video = { url: normalizeYouTubeUrl(query), title: query };
      } else {
        const { videos } = await yts(query);
        if (!videos?.length) return sock.sendMessage(chatId, { text: '❌ No results found for that query.' }, { quoted: message });
        video = videos[0];
      }

      if (video.thumbnail) {
        await sock.sendMessage(chatId, {
          image: { url: video.thumbnail },
          caption: `🎶 *${video.title || query}*\n⏱ ${video.timestamp || ''}\n\n⏳ Downloading... *(may take up to 30s)*`
        }, { quoted: message }).catch(() => {});
      } else {
        await sock.sendMessage(chatId, {
          text: `🎵 *${video.title || query}*\n⏳ Downloading...`
        }, { quoted: message });
      }

      const audio = await downloadWithFallbacks(video.url);

      await sock.sendMessage(chatId, {
        audio: { url: audio.downloadUrl },
        mimetype: 'audio/mpeg',
        fileName: `${(audio.title || video.title || 'song').replace(/[^\w\s-]/g, '').trim()}.mp3`,
        ptt: false
      }, { quoted: message });

    } catch (err) {
      console.error('[song] Error:', err.message);
      const reason = err.message?.includes('timeout') ? 'Download timed out. Try again.' : err.message;
      await sock.sendMessage(chatId, { text: `❌ Failed: ${reason}` }, { quoted: message });
    }
  }
};
