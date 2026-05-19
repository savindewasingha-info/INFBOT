const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_KEY = 'qasim-dev';
const API_URL = 'https://api.qasimdev.dpdns.org/api/stickers/pack';

// Try to use your bot’s sticker converters (Mega-MD style)
let imageToWebp = null;
let writeExifImg = null;

try {
  // Common in Baileys bots
  ({ imageToWebp, writeExifImg } = require('../lib/exif'));
} catch (e) {
  // If your project doesn't have it, we'll fallback to raw webp send (still works on many clients)
  imageToWebp = null;
  writeExifImg = null;
}

// download helper
async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

function safeText(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
  command: 'sticker',
  aliases: ['stpack', 'stickers'],
  category: 'utility',
  description: 'Search sticker packs and send stickers (from API).',
  usage: '.sticker <query> [startIndex]',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    const query = (args[0] && !/^\d+$/.test(args[0])) ? args.join(' ') : args.slice(0, -1).join(' ');
    const maybeIndex = args[args.length - 1];
    const startIndex = /^\d+$/.test(maybeIndex) ? Math.max(1, parseInt(maybeIndex, 10)) : 1;

    if (!query || !query.trim()) {
      return await sock.sendMessage(
        chatId,
        { text: '❌ Usage: .sticker <query> [startIndex]\nExample: .sticker trump\nExample: .sticker trump 11' },
        { quoted: message }
      );
    }

    await sock.sendMessage(chatId, { text: '🔎 Searching sticker pack...' }, { quoted: message });

    let data;
    try {
      const res = await axios.get(API_URL, {
        timeout: 25000,
        params: { query, apiKey: API_KEY },
        validateStatus: () => true
      });

      if (res.status !== 200 || !res.data?.success) {
        return await sock.sendMessage(chatId, { text: '❌ Sticker API failed.' }, { quoted: message });
      }

      data = res.data?.data?.result;
      if (!data?.sticker || !Array.isArray(data.sticker) || data.sticker.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No stickers found for this query.' }, { quoted: message });
      }
    } catch (e) {
      console.error('Sticker API error:', e?.message || e);
      return await sock.sendMessage(chatId, { text: '❌ Error contacting sticker API.' }, { quoted: message });
    }

    const title = safeText(data.title || 'Sticker Pack');
    const author = safeText(data.author || 'Unknown');
    const total = data.sticker.length;

    // send info message
    await sock.sendMessage(
      chatId,
      {
        text:
          `🧩 *Sticker Pack Found*\n` +
          `📛 Title: *${title}*\n` +
          `👤 Author: *${author}*\n` +
          `🧷 Total stickers: *${total}*\n\n` +
          `📤 Sending from #${startIndex} (max 10 per command)...`
      },
      { quoted: message }
    );

    // Pagination: send 10 stickers per command
    const start = startIndex - 1;
    const end = Math.min(start + 10, total);
    const chunk = data.sticker.slice(start, end);

    let sent = 0;

    for (let i = 0; i < chunk.length; i++) {
      const url = chunk[i];

      try {
        const buf = await fetchBuffer(url);

        // If your bot has exif sticker tools, use them for proper WA stickers
        if (imageToWebp && writeExifImg) {
          const webp = await imageToWebp(buf);
          const sticker = await writeExifImg(webp, {
            packname: title,
            author: author
          });

          await sock.sendMessage(chatId, { sticker }, { quoted: message });
        } else {
          // fallback: direct webp as sticker (works for many WhatsApp clients)
          // If it fails on your client, you MUST add ../lib/exif tools.
          await sock.sendMessage(chatId, { sticker: buf }, { quoted: message });
        }

        sent++;
      } catch (e) {
        console.error('Sticker send error:', e?.message || e);
        // Continue sending others, don't stop the whole pack
      }
    }

    const remaining = total - end;

    let finalMsg =
      `✅ Sent *${sent}* sticker(s).\n` +
      `📌 Pack: *${title}*`;

    if (remaining > 0) {
      finalMsg += `\n\n➡️ More available: *${remaining}*\nReply/Run: *.sticker ${query} ${end + 1}*`;
    }

    return await sock.sendMessage(chatId, { text: finalMsg }, { quoted: message });
  }
};
