const statusStore = require('../../utils/statusStore');
const config      = require('../../config');
const database    = require('../../database');

module.exports = {
  name: 'save',
  aliases: ['savestatus', 'statussave', 'svs'],
  category: 'general',
  description: 'Save a WhatsApp status by replying to it',
  usage: '.save (reply to a status)',

  async execute(sock, msg, args, extra) {
    try {
      const chatId   = extra?.from   || msg?.key?.remoteJid;
      const sender   = extra?.sender || msg?.key?.participant || chatId;
      const prefix   = sock?._customConfig?.settings?.prefix || config.prefix || '.';
      const settings = database.getGlobalSettings?.() || {};

      // Helper to silently delete the .save command message
      const deleteSaveMsg = async () => {
        try { await sock.sendMessage(chatId, { delete: msg.key }); } catch (_) {}
      };

      // ── Find quoted context ──────────────────────────────────────────────────
      const ctx = msg?.message?.extendedTextMessage?.contextInfo
               || msg?.message?.imageMessage?.contextInfo
               || msg?.message?.videoMessage?.contextInfo
               || msg?.message?.audioMessage?.contextInfo
               || msg?.message?.documentMessage?.contextInfo
               || null;

      if (!ctx) {
        return sock.sendMessage(chatId, {
          text:
            `📌 *How to use .save*\n\n` +
            `1️⃣ Open WhatsApp *Status* tab\n` +
            `2️⃣ View a contact's status\n` +
            `3️⃣ *Reply* to that status with \`${prefix}save\`\n\n` +
            `> ♾️ _Infinity MD — Status Saver_`,
        }, { quoted: msg });
      }

      const quotedId     = ctx.stanzaId || ctx.id;
      const statusSender = ctx.participant || ctx.remoteJid || '';

      // ── Look up in memory cache ──────────────────────────────────────────────
      const cached = quotedId ? statusStore.getCache(quotedId) : null;

      if (cached) {
        const ownerNum = (sock?._customConfig?.ownerNumber || config.ownerNumber?.[0] || '').replace(/[^0-9]/g, '');
        const ownerJid = ownerNum + '@s.whatsapp.net';
        const senderNum = (cached.sender || statusSender).replace(/@s\.whatsapp\.net$/, '');
        const timeStr   = new Date(cached.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        const caption =
          `💾 *Status Saved*\n\n` +
          `👤 *From:* @${senderNum}\n` +
          `🕐 *Time:* ${timeStr}\n` +
          (cached.caption ? `💬 *Caption:* ${cached.caption}\n` : '') +
          `\n> ♾️ _Infinity MD — Saved by ${sender.split('@')[0]}_`;

        const mediaType = cached.mediaType?.replace('Message', '') || 'image';

        await sock.sendMessage(ownerJid, {
          [mediaType]: cached.buffer,
          mimetype:    cached.mimetype,
          caption,
          mentions:    [cached.sender || statusSender].filter(Boolean),
        });

        if (statusStore.markSaved) statusStore.markSaved(quotedId);

        // Delete the .save command message to clear evidence
        await deleteSaveMsg();
        return;
      }

      // ── Try downloading via sock (if bot viewed the status live) ─────────────
      const from = ctx.remoteJid || 'status@broadcast';

      if (ctx.quotedMessage) {
        const content = ctx.quotedMessage;
        const mediaKey = Object.keys(content).find(k =>
          ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(k)
        );

        if (mediaKey) {
          const mediaMsg = content[mediaKey];
          try {
            const { downloadContentFromMessage } = require('../../utils/baileys');
            const stream = await downloadContentFromMessage(mediaMsg, mediaKey.replace('Message', ''));
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);

            const mimetype  = mediaMsg.mimetype || 'image/jpeg';
            const caption   = mediaMsg.caption  || '';
            const mediaType = mediaKey.replace('Message', '');
            const senderNum = statusSender.replace(/@s\.whatsapp\.net$/, '');

            const ownerNum = (sock?._customConfig?.ownerNumber || config.ownerNumber?.[0] || '').replace(/[^0-9]/g, '');
            const ownerJid = ownerNum + '@s.whatsapp.net';

            const capText =
              `💾 *Status Saved*\n\n` +
              `👤 *From:* @${senderNum}\n` +
              (caption ? `💬 *Caption:* ${caption}\n` : '') +
              `\n> ♾️ _Infinity MD — Saved by ${sender.split('@')[0]}_`;

            await sock.sendMessage(ownerJid, {
              [mediaType]: buffer,
              mimetype,
              caption: capText,
              mentions: [statusSender].filter(Boolean),
            });

            // Delete the .save command message to clear evidence
            await deleteSaveMsg();
            return;
          } catch (dlErr) {
            console.error('[save] download error:', dlErr.message);
          }
        }
      }

      // ── Not found ─────────────────────────────────────────────────────────────
      return sock.sendMessage(chatId, {
        text:
          `❌ *Could not retrieve the status media.*\n\n` +
          `This can happen if:\n` +
          `• The status was posted before the bot started\n` +
          `• Auto-Status view is disabled\n\n` +
          `💡 Make sure \`${prefix}autostatus on\` is enabled so the bot caches statuses as they come in.\n` +
          `Then view the status again and reply with \`${prefix}save\`.`,
      }, { quoted: msg });

    } catch (err) {
      console.error('[save] error:', err.message);
      return sock.sendMessage(
        extra?.from || msg?.key?.remoteJid,
        { text: `❌ Error saving status: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
