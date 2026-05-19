const axios = require('axios');
const { withHealth } = require('../../utils/apiHealth');

const YT_REGEX = /(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|v\/|embed\/|shorts\/)?)([a-zA-Z0-9_-]{11})/;

module.exports = {
  name: 'ytmp4',
  aliases: ['ytdlv', 'ytdownload'],
  category: 'media',
  description: 'Download YouTube video as MP4',
  usage: '.ytmp4 <youtube URL>',

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;

    try {
      const url = args[0]?.trim();
      if (!url) {
        return sock.sendMessage(chatId, {
          text: '❌ Please provide a YouTube URL.\n\nUsage: .ytmp4 <youtube URL>'
        }, { quoted: msg });
      }
      if (!YT_REGEX.test(url)) {
        return sock.sendMessage(chatId, {
          text: '❌ Invalid YouTube URL.\n\nExample: .ytmp4 https://youtube.com/watch?v=...'
        }, { quoted: msg });
      }

      await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } });
      await sock.sendMessage(chatId, { text: '🎬 _Downloading video from YouTube..._' }, { quoted: msg });

      let downloadUrl = null;
      let title = null;

      // Source 1: QasimDev 360 (working ✅)
      try {
        const r = await withHealth('qasimdev_360_ytmp4', () =>
          axios.get('https://api.qasimdev.dpdns.org/api/youtube/download', {
            params: { apiKey: 'qasim-dev', url, format: '360' },
            timeout: 25000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
          })
        );
        const dl = r.data?.data?.download || r.data?.download;
        if (dl) { downloadUrl = dl; title = r.data?.data?.title; }
      } catch (_) {}

      // Source 2: QasimDev 480
      if (!downloadUrl) {
        try {
          const r = await withHealth('qasimdev_480_ytmp4', () =>
            axios.get('https://api.qasimdev.dpdns.org/api/youtube/download', {
              params: { apiKey: 'qasim-dev', url, format: '480' },
              timeout: 25000,
              headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
            })
          );
          const dl = r.data?.data?.download || r.data?.download;
          if (dl) { downloadUrl = dl; title = r.data?.data?.title; }
        } catch (_) {}
      }

      // Source 3: EliteProTech
      if (!downloadUrl) {
        try {
          const r = await withHealth('eliteprotech_ytmp4', () =>
            axios.get(`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(url)}&format=mp4`, {
              timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
            })
          );
          if (r.data?.success && r.data?.downloadURL) { downloadUrl = r.data.downloadURL; title = r.data.title; }
        } catch (_) {}
      }

      // Source 4: Yupra
      if (!downloadUrl) {
        try {
          const r = await withHealth('yupra_ytmp4', () =>
            axios.get(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(url)}`, {
              timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
            })
          );
          const dl = r.data?.data?.download_url;
          if (dl) { downloadUrl = dl; title = r.data?.data?.title; }
        } catch (_) {}
      }

      // Source 5: Okatsu
      if (!downloadUrl) {
        try {
          const r = await withHealth('okatsu_ytmp4', () =>
            axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(url)}`, {
              timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
            })
          );
          const dl = r.data?.result?.mp4;
          if (dl) { downloadUrl = dl; title = r.data?.result?.title; }
        } catch (_) {}
      }

      // Source 6: Siputzx
      if (!downloadUrl) {
        try {
          const r = await withHealth('siputzx_ytmp4', () =>
            axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(url)}`, {
              timeout: 15000
            })
          );
          if (r.data?.data?.dl) { downloadUrl = r.data.data.dl; title = r.data.data.title; }
        } catch (_) {}
      }

      if (!downloadUrl) {
        await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
        return sock.sendMessage(chatId, {
          text: '❌ Failed to download video. All sources are currently unavailable.'
        }, { quoted: msg });
      }

      await sock.sendMessage(chatId, {
        video: { url: downloadUrl },
        mimetype: 'video/mp4',
        fileName: `${(title || 'video').replace(/[^\w\s-]/g, '')}.mp4`,
        caption: `🎬 *${title || 'Video'}*\n\n> 💫 *INFINITY MD*`
      }, { quoted: msg });

      await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });

    } catch (error) {
      console.error('[YTMP4] Error:', error?.message || error);
      await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
      await sock.sendMessage(chatId, {
        text: '❌ Download failed: ' + (error?.message || 'Unknown error')
      }, { quoted: msg });
    }
  }
};
