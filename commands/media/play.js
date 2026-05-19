const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');
const { withHealth } = require('../../utils/apiHealth');

ffmpeg.setFfmpegPath(ffmpegPath);

const YT_REGEX = /(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/;

// ─── Audio buffer from a direct CDN URL via ffmpeg ────────────────────────────
function audioBufferFromUrl(cdnUrl) {
  return new Promise((resolve, reject) => {
    const passThrough = new PassThrough();
    const chunks = [];
    const timeout = setTimeout(() => reject(new Error('ffmpeg URL convert timeout')), 120000);
    ffmpeg(cdnUrl)
      .setFfmpegPath(ffmpegPath)
      .audioCodec('libmp3lame')
      .audioBitrate(128)
      .format('mp3')
      .inputOptions(['-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'])
      .on('error', err => { clearTimeout(timeout); reject(err); })
      .pipe(passThrough, { end: true });
    passThrough.on('data', chunk => chunks.push(chunk));
    passThrough.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
    passThrough.on('error', err => { clearTimeout(timeout); reject(err); });
  });
}

// ─── Audio buffer from ytdl stream via ffmpeg ─────────────────────────────────
function audioBufferFromYtdl(videoUrl) {
  return new Promise((resolve, reject) => {
    const audioStream = ytdl(videoUrl, {
      quality: 'highestaudio',
      filter: 'audioonly',
      requestOptions: {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }
    });

    const passThrough = new PassThrough();
    const chunks = [];
    const timeout = setTimeout(() => reject(new Error('ytdl conversion timeout')), 90000);

    ffmpeg(audioStream)
      .setFfmpegPath(ffmpegPath)
      .audioCodec('libmp3lame')
      .audioBitrate(128)
      .format('mp3')
      .on('error', err => { clearTimeout(timeout); reject(err); })
      .pipe(passThrough, { end: true });

    passThrough.on('data', chunk => chunks.push(chunk));
    passThrough.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
    passThrough.on('error', err => { clearTimeout(timeout); reject(err); });

    audioStream.on('error', err => { clearTimeout(timeout); reject(err); });
  });
}

// ─── Get audio buffer with fallback chain ─────────────────────────────────────
async function getAudioBuffer(videoUrl) {
  const errors = [];

  // 1️⃣ QasimDev mp3 → ffmpeg URL convert (most reliable right now)
  try {
    const cdnUrl = await withHealth('qasimdev_mp3_play', async () => {
      const { data } = await axios.get('https://api.qasimdev.dpdns.org/api/youtube/download', {
        params: { apiKey: 'qasim-dev', url: videoUrl, format: 'mp3' },
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const dl = data?.data?.download || data?.download;
      if (!dl) throw new Error('no download URL');
      return dl;
    });
    return await audioBufferFromUrl(cdnUrl);
  } catch (e) {
    errors.push('QasimDev: ' + e.message);
  }

  // 2️⃣ ytdl-core stream → ffmpeg
  try {
    return await withHealth('ytdl_play', () => audioBufferFromYtdl(videoUrl));
  } catch (e) {
    errors.push('ytdl: ' + e.message);
  }

  // 3️⃣ QasimDev 360p video URL → ffmpeg extract audio
  try {
    const cdnUrl = await withHealth('qasimdev_360_play', async () => {
      const { data } = await axios.get('https://api.qasimdev.dpdns.org/api/youtube/download', {
        params: { apiKey: 'qasim-dev', url: videoUrl, format: '360' },
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const dl = data?.data?.download;
      if (!dl) throw new Error('no download URL');
      return dl;
    });
    return await audioBufferFromUrl(cdnUrl);
  } catch (e) {
    errors.push('QasimDev 360: ' + e.message);
  }

  throw new Error(errors.join(' | '));
}

// ─── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  name: 'play',
  aliases: ['plays'],
  category: 'media',
  description: 'Search and download a song as MP3 from YouTube',
  usage: '.play <song name or YouTube link>',

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const query = args.join(' ').trim();

    if (!query) {
      return sock.sendMessage(chatId, {
        text: '*Which song do you want to play?*\nUsage: .play <song name or YouTube link>'
      }, { quoted: msg });
    }

    try {
      await sock.sendMessage(chatId, { text: '🔍 *Searching...*' }, { quoted: msg });

      let video;
      if (YT_REGEX.test(query)) {
        const ytId = query.match(YT_REGEX)?.[1];
        let title = query;
        try {
          const info = await ytdl.getInfo(query, { timeout: 10000 });
          title = info.videoDetails?.title || query;
        } catch (_) {}
        video = {
          url: `https://www.youtube.com/watch?v=${ytId}`,
          title,
          timestamp: '',
          author: { name: '' },
          thumbnail: ytId ? `https://i.ytimg.com/vi/${ytId}/sddefault.jpg` : null
        };
      } else {
        const { videos } = await yts(query);
        if (!videos?.length) {
          return sock.sendMessage(chatId, { text: '❌ *No results found!*' }, { quoted: msg });
        }
        const v = videos[0];
        video = { url: v.url, title: v.title, timestamp: v.timestamp, author: v.author, thumbnail: v.thumbnail };
      }

      await sock.sendMessage(chatId, {
        text: `✅ *Found:* ${video.title}\n⏱️ ${video.timestamp || 'N/A'}\n👤 ${video.author?.name || ''}\n\n⏳ *Downloading... (10–30s)*`
      }, { quoted: msg });

      const audioBuffer = await getAudioBuffer(video.url);

      let thumbnailBuffer;
      if (video.thumbnail) {
        try {
          const img = await axios.get(video.thumbnail, { responseType: 'arraybuffer', timeout: 10000 });
          thumbnailBuffer = Buffer.from(img.data);
        } catch (_) {}
      }

      await sock.sendMessage(chatId, {
        audio: audioBuffer,
        mimetype: 'audio/mpeg',
        fileName: `${(video.title || 'song').replace(/[^\w\s-]/g, '').trim()}.mp3`,
        contextInfo: thumbnailBuffer ? {
          externalAdReply: {
            title: video.title,
            body: `${video.author?.name || ''} • ${video.timestamp || ''}`,
            thumbnail: thumbnailBuffer,
            mediaType: 2,
            sourceUrl: video.url
          }
        } : undefined
      }, { quoted: msg });

    } catch (err) {
      console.error('[play] Error:', err.message);
      const isConn = err.message?.includes('Connection Closed') || err.message?.includes('Connection Reset');
      if (isConn) return;
      try {
        await sock.sendMessage(chatId, { text: `❌ *Failed:* ${err.message}` }, { quoted: msg });
      } catch (_) {}
    }
  }
};
