/**
 * .tiktok — TikTok Search & Download
 * Races multiple APIs in parallel, streams buffer directly to WhatsApp chat.
 */

const axios = require('axios');
const { sendBtn, btn } = require('../../utils/sendBtn');

const TIKWM_BASE = 'https://tikwm.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
};

// Pending search results per sender (5 min expiry)
const pendingSearches = new Map();
const PENDING_TTL = 5 * 60 * 1000;

function storePending(senderJid, videos) {
  pendingSearches.set(senderJid, { videos, ts: Date.now() });
}
function getPending(senderJid) {
  const entry = pendingSearches.get(senderJid);
  if (!entry) return null;
  if (Date.now() - entry.ts > PENDING_TTL) { pendingSearches.delete(senderJid); return null; }
  return entry.videos;
}

// Stream video bytes from CDN URL into a buffer
async function streamToBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: HEADERS,
    maxRedirects: 10,
  });
  return Buffer.from(res.data);
}

function formPost(url, params) {
  const body = new URLSearchParams(params);
  return axios.post(url, body, {
    timeout: 12000,
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://tikwm.com/',
      'Origin': 'https://tikwm.com',
    },
  });
}

// Race multiple search mirrors
async function searchTikTok(query) {
  const tikwmSearch = formPost(`${TIKWM_BASE}/api/feed/search`, {
    keywords: query, count: '5', cursor: '0', HD: '1', web: '1',
  }).then(r => {
    if (r.data?.code === 0 && r.data?.data?.videos?.length) return r.data;
    throw new Error('tikwm no results');
  });

  const siputzxSearch = axios.get(
    `https://api.siputzx.my.id/api/s/tiktok?q=${encodeURIComponent(query)}`,
    { timeout: 12000, headers: HEADERS }
  ).then(r => {
    if (r.data?.status && Array.isArray(r.data?.data) && r.data.data.length) {
      const videos = r.data.data.slice(0, 5).map(v => ({
        title: v.title || v.desc || 'TikTok Video',
        play: v.play || v.video || v.url || '',
        author: { nickname: v.author || 'Unknown' },
        duration: v.duration || 0,
      }));
      return { code: 0, data: { videos } };
    }
    throw new Error('siputzx no results');
  });

  return Promise.any([tikwmSearch, siputzxSearch]);
}

// Race multiple download mirrors for a direct TikTok URL
async function resolveDownloadUrl(url) {
  const tikwmDl = formPost(`${TIKWM_BASE}/api/`, { url, hd: '1' }).then(r => {
    const v = r.data?.data;
    if (r.data?.code === 0 && v) {
      const videoUrl = v.hdplay || v.play;
      if (!videoUrl) throw new Error('no url');
      return {
        videoUrl: videoUrl.startsWith('http') ? videoUrl : `${TIKWM_BASE}${videoUrl}`,
        title: v.title || 'TikTok Video',
        author: v.author?.nickname || 'Unknown',
        duration: v.duration,
      };
    }
    throw new Error('tikwm dl failed');
  });

  const siputzxDl = axios.get(
    `https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`,
    { timeout: 12000, headers: HEADERS }
  ).then(r => {
    if (r.data?.status && r.data?.data) {
      const d = r.data.data;
      const videoUrl = d.video || d.play || d.nowm || d.url;
      if (!videoUrl) throw new Error('no url');
      return { videoUrl, title: d.title || 'TikTok Video', author: d.author || 'Unknown', duration: d.duration };
    }
    throw new Error('siputzx dl failed');
  });

  return Promise.any([tikwmDl, siputzxDl]);
}

// Download and send a TikTok video from a resolved URL
async function sendTikTokVideo(sock, msg, from, react, reply, videoUrl, title, author, duration) {
  await react('⏳');

  // Stream bytes from CDN
  let buf;
  try {
    buf = await streamToBuffer(videoUrl);
  } catch (e) {
    console.error('[TikTok] Buffer download failed:', e.message);
    await react('❌');
    return reply('❌ Failed to download TikTok video. Please try again.');
  }

  // Send buffer directly to WhatsApp chat
  try {
    await sock.sendMessage(from, {
      video: buf,
      mimetype: 'video/mp4',
      fileName: `${(title || 'tiktok').replace(/[^\w\s-]/g, '').trim() || 'tiktok'}.mp4`,
      caption:
        `🎬 *${(title || 'TikTok Video').substring(0, 100)}*\n` +
        `👤 ${author || 'Unknown'}${duration ? `  ⏱️ ${duration}s` : ''}\n\n` +
        `> *INFINITY MD*`,
    }, { quoted: msg });
    await react('✅');
  } catch (e) {
    console.error('[TikTok] Send error:', e.message);
    await react('❌');
    reply('❌ Failed to send video. Please try again.');
  }
}

module.exports = {
  name: 'tiktok',
  aliases: ['tt', 'ttsearch'],
  category: 'media',
  description: 'Search TikTok and send video',
  usage: '.tiktok <search query or TikTok URL>',

  async execute(sock, msg, args, extra) {
    const { from, reply, react } = extra;
    const sender = msg.key.participant || msg.key.remoteJid;

    try {
      // Button pick: .tiktok pick <index>
      if (args[0] === 'pick') {
        const index = parseInt(args[1], 10);
        const videos = getPending(sender);
        if (!videos || isNaN(index) || index < 0 || index >= videos.length)
          return reply('❌ Selection expired or invalid. Please search again with .tiktok <query>');

        const video = videos[index];
        const videoUrl = video.play?.startsWith('http') ? video.play : `${TIKWM_BASE}${video.play}`;
        const title    = (video.title || 'TikTok Video').substring(0, 100);
        const author   = video.author?.nickname || video.music_info?.author || 'Unknown';
        const duration = video.duration || 0;

        return sendTikTokVideo(sock, msg, from, react, reply, videoUrl, title, author, duration);
      }

      const query = args.join(' ').trim();
      if (!query) return reply('❌ Please provide a search term or TikTok URL.\nUsage: .tiktok <search query>');

      await react('⏳');

      // Direct TikTok URL
      if (query.includes('tiktok.com') || query.includes('vt.tiktok')) {
        const result = await resolveDownloadUrl(query);
        return sendTikTokVideo(sock, msg, from, react, reply,
          result.videoUrl, result.title, result.author, result.duration);
      }

      // Search flow
      const data = await searchTikTok(query);
      const videos = data.data.videos.slice(0, 5);
      storePending(sender, videos);

      const buttons = videos.map((v, i) =>
        btn(`tiktok_pick_${i}`, `${i + 1}. ${(v.title || `Video ${i + 1}`).substring(0, 50)}`)
      );

      await react('✅');
      await sendBtn(sock, from, {
        title: '🎵 TikTok Search Results',
        text:
          `🔍 *Query:* ${query}\n` +
          `📊 Found *${videos.length}* videos\n\n` +
          `👇 Tap a title to download it:`,
        footer: `♾️ Infinity MD • Results expire in 5 min`,
        buttons,
      }, { quoted: msg });

    } catch (err) {
      console.error('[TikTok] Error:', err.message);
      await react('❌');
      reply('❌ Failed to fetch TikTok video. Please try again later.');
    }
  },
};
