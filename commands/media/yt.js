const axios = require('axios');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const { sendBtn, btn } = require('../../utils/sendBtn');
const { withHealth } = require('../../utils/apiHealth');

const YT_REGEX = /(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/;

// Pending search results per sender (5-min TTL)
const pendingSearches = new Map();
const PENDING_TTL = 5 * 60 * 1000;

function storePending(jid, videos) {
  pendingSearches.set(jid, { videos, ts: Date.now() });
}
function getPending(jid) {
  const entry = pendingSearches.get(jid);
  if (!entry) return null;
  if (Date.now() - entry.ts > PENDING_TTL) { pendingSearches.delete(jid); return null; }
  return entry.videos;
}
function normalizeYouTubeUrl(input) {
  const match = String(input || '').match(YT_REGEX);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : input;
}

// ─── Download source functions ────────────────────────────────────────────────

async function tryQasimDevVideo(videoUrl, format = '360') {
  return withHealth(`qasimdev_${format}`, async () => {
    const { data } = await axios.get('https://api.qasimdev.dpdns.org/api/youtube/download', {
      params: { apiKey: 'qasim-dev', url: normalizeYouTubeUrl(videoUrl), format },
      timeout: 25000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const dl = data?.data?.download || data?.download;
    const title = data?.data?.title || data?.title;
    if (!dl) throw new Error('QasimDev: no download URL');
    return { download: dl, title };
  });
}

async function tryYtdlVideo(videoUrl) {
  return withHealth('ytdl_video', async () => {
    const url = normalizeYouTubeUrl(videoUrl);
    const info = await ytdl.getInfo(url, {
      requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
    });
    const title = info.videoDetails?.title || 'YouTube Video';
    const formats = ytdl.filterFormats(info.formats, f => f.container === 'mp4' && f.hasVideo && f.hasAudio && f.url);
    formats.sort((a, b) => (parseInt(b.height) || 0) - (parseInt(a.height) || 0));
    const best = formats.find(f => (f.height || 0) <= 720) || formats[0];
    if (!best?.url) throw new Error('No suitable ytdl format');
    return { download: best.url, title };
  });
}

async function tryEliteProTech(videoUrl) {
  return withHealth('eliteprotech_video', async () => {
    const { data } = await axios.get(
      `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(videoUrl)}&format=mp4`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!data?.success || !data?.downloadURL) throw new Error('EliteProTech: no URL');
    return { download: data.downloadURL, title: data.title };
  });
}

async function tryYupra(videoUrl) {
  return withHealth('yupra_video', async () => {
    const { data } = await axios.get(
      `https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(videoUrl)}`,
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const dl = data?.data?.download_url;
    if (!dl) throw new Error('Yupra: no URL');
    return { download: dl, title: data?.data?.title };
  });
}

// ─── Ordered fallback chain ────────────────────────────────────────────────────
async function downloadVideoByUrl(videoUrl, videoTitle, sock, msg, chatId, react, reply) {
  await react('⏳');
  const url = normalizeYouTubeUrl(videoUrl);
  const ytId = url.match(YT_REGEX)?.[1];
  const thumb = ytId ? `https://i.ytimg.com/vi/${ytId}/sddefault.jpg` : null;

  if (thumb) {
    try {
      await sock.sendMessage(chatId, {
        image: { url: thumb },
        caption: `🎬 *${videoTitle || 'YouTube Video'}*\n⏳ _Downloading..._\n\n> 💫 *INFINITY MD*`
      }, { quoted: msg });
    } catch (_) {}
  }

  let downloadUrl = null;
  let finalTitle = videoTitle || 'YouTube Video';

  const sources = [
    () => tryQasimDevVideo(url, '360'),
    () => tryYtdlVideo(url),
    () => tryQasimDevVideo(url, '480'),
    () => tryEliteProTech(url),
    () => tryYupra(url),
  ];

  for (const source of sources) {
    try {
      const result = await source();
      if (result?.download) {
        downloadUrl = result.download;
        finalTitle = result.title || finalTitle;
        break;
      }
    } catch (_) {}
  }

  if (!downloadUrl) {
    await react('❌');
    return reply('❌ Failed to get video download link. All sources failed — please try again later.');
  }

  const safeTitle = finalTitle.replace(/[^\w\s-]/g, '').trim() || 'video';

  try {
    await sock.sendMessage(chatId, {
      video: { url: downloadUrl },
      mimetype: 'video/mp4',
      fileName: `${safeTitle}.mp4`,
      caption: `🎬 *${finalTitle}*\n\n> 💫 *INFINITY MD*`
    }, { quoted: msg });
    await react('✅');
  } catch (urlErr) {
    console.log('[YT] URL send failed, trying buffer:', urlErr.message);
    try {
      const res = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 120000, maxRedirects: 10 });
      await sock.sendMessage(chatId, {
        video: Buffer.from(res.data),
        mimetype: 'video/mp4',
        fileName: `${safeTitle}.mp4`,
        caption: `🎬 *${finalTitle}*\n\n> 💫 *INFINITY MD*`
      }, { quoted: msg });
      await react('✅');
    } catch (bufErr) {
      await react('❌');
      return reply('❌ Failed to send video. File may be too large or the link expired.');
    }
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  name: 'yt',
  aliases: ['youtube', 'ytsearch'],
  category: 'media',
  description: 'Search YouTube and download video (or pass a direct link)',
  usage: '.yt <search query or YouTube URL>',

  async execute(sock, msg, args, extra) {
    const { from, reply, react } = extra;
    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    try {
      // Handle pick selection
      if (args[0] === 'pick') {
        const index = parseInt(args[1], 10);
        const videos = getPending(sender);
        if (!videos || isNaN(index) || index < 0 || index >= videos.length) {
          return reply('❌ Selection expired or invalid. Search again with .yt <query>');
        }
        return downloadVideoByUrl(videos[index].url, videos[index].title, sock, msg, chatId, react, reply);
      }

      const query = args.join(' ').trim();
      if (!query) return reply('❌ Please provide a search query or YouTube link.\n\nUsage: .yt <search query>');

      // Direct URL
      if (YT_REGEX.test(query)) {
        return downloadVideoByUrl(query, '', sock, msg, chatId, react, reply);
      }

      // Search
      await react('⏳');
      const { videos } = await yts(query);
      if (!videos?.length) { await react('❌'); return reply('❌ No YouTube videos found for that search.'); }

      const results = videos.slice(0, 5);
      storePending(sender, results);

      await react('✅');
      await sendBtn(sock, from, {
        title: '🎬 YouTube Search Results',
        text:
          `🔍 *Query:* ${query}\n` +
          `📊 Found *${results.length}* videos\n\n` +
          `👇 Tap a title to download it:`,
        footer: '♾️ Infinity MD • Results expire in 5 min',
        buttons: results.map((v, i) => btn(`yt_pick_${i}`, `${i + 1}. ${(v.title || `Video ${i + 1}`).substring(0, 50)}`)),
      }, { quoted: msg });

    } catch (err) {
      console.error('[YT] Error:', err?.message || err);
      await react('❌');
      reply('❌ Failed. Please try again later.');
    }
  }
};
