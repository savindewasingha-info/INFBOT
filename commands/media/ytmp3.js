const axios = require('axios');
const { withHealth } = require('../../utils/apiHealth');

const YT_REGEX = /(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|v\/|embed\/|shorts\/)?)([a-zA-Z0-9_-]{11})/;

module.exports = {
  name: 'ytmp3',
  aliases: ['yta', 'ytaudio'],
  category: 'media',
  description: 'Download YouTube video as MP3 audio',
  usage: '.ytmp3 <youtube URL>',

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;

    try {
      const url = args[0]?.trim();
      if (!url) {
        return sock.sendMessage(chatId, {
          text: '❌ Please provide a YouTube URL.\n\nUsage: .ytmp3 <youtube URL>'
        }, { quoted: msg });
      }
      if (!YT_REGEX.test(url)) {
        return sock.sendMessage(chatId, { text: '❌ Invalid YouTube URL.' }, { quoted: msg });
      }

      await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } });
      await sock.sendMessage(chatId, { text: '🎵 _Downloading audio from YouTube..._' }, { quoted: msg });

      let downloadUrl = null;
      let title = null;

      // Source 1: QasimDev mp3 (working ✅)
      try {
        const r = await withHealth('qasimdev_mp3_ytmp3', () =>
          axios.get('https://api.qasimdev.dpdns.org/api/youtube/download', {
            params: { apiKey: 'qasim-dev', url, format: 'mp3' },
            timeout: 25000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
          })
        );
        const dl = r.data?.data?.download || r.data?.download;
        if (dl) { downloadUrl = dl; title = r.data?.data?.title; }
      } catch (_) {}

      // Source 2: QasimDev loader
      if (!downloadUrl) {
        try {
          const apiKey = process.env.SONG_DOWNLOAD_API_KEY || 'xbps-install-Syu';
          const r = await withHealth('qasimdev_loader_ytmp3', () =>
            axios.get('https://api.qasimdev.dpdns.org/api/loaderto/download', {
              params: { apiKey, format: 'mp3', url },
              timeout: 30000,
              headers: { 'User-Agent': 'Mozilla/5.0' }
            })
          );
          const dl = r.data?.data?.downloadUrl || r.data?.data?.download || r.data?.downloadUrl;
          if (dl) { downloadUrl = dl; title = r.data?.data?.title; }
        } catch (_) {}
      }

      // Source 3: Yupra
      if (!downloadUrl) {
        try {
          const r = await withHealth('yupra_ytmp3', () =>
            axios.get(`https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(url)}`, {
              timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
            })
          );
          const dl = r.data?.data?.download_url;
          if (dl) { downloadUrl = dl; title = r.data?.data?.title; }
        } catch (_) {}
      }

      // Source 4: EliteProTech
      if (!downloadUrl) {
        try {
          const r = await withHealth('eliteprotech_ytmp3', () =>
            axios.get(`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(url)}&format=mp3`, {
              timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }
            })
          );
          if (r.data?.success && r.data?.downloadURL) {
            downloadUrl = r.data.downloadURL;
            title = r.data.title;
          }
        } catch (_) {}
      }

      // Source 5: Siputzx
      if (!downloadUrl) {
        try {
          const r = await withHealth('siputzx_ytmp3', () =>
            axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`, {
              timeout: 15000
            })
          );
          if (r.data?.data?.dl) { downloadUrl = r.data.data.dl; title = r.data.data.title; }
        } catch (_) {}
      }

      if (!downloadUrl) {
        await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
        return sock.sendMessage(chatId, { text: '❌ Failed to download audio. All sources unavailable.' }, { quoted: msg });
      }

      await sock.sendMessage(chatId, {
        audio: { url: downloadUrl },
        mimetype: 'audio/mpeg',
        fileName: `${(title || 'audio').replace(/[^\w\s-]/g, '')}.mp3`
      }, { quoted: msg });

      await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });

    } catch (error) {
      console.error('[YTMP3] Error:', error?.message || error);
      await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
      await sock.sendMessage(chatId, {
        text: '❌ Download failed: ' + (error?.message || 'Unknown error')
      }, { quoted: msg });
    }
  }
};
