const { downloadMediaMessage } = require('../../utils/baileys');

module.exports = {
  name: 'toimg',
  aliases: ['stickertoimg', 'sticker2img', 'stoimg'],
  category: 'converter',
  description: 'Convert sticker to image',
  usage: '.toimg (reply to sticker)',

  async execute(sock, msg, args, extra) {
    try {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      if (!ctxInfo?.quotedMessage) {
        return await extra.reply('📎 Reply to a sticker to convert it to image!');
      }

      const targetMessage = {
        key: {
          remoteJid: extra.from,
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant,
        },
        message: ctxInfo.quotedMessage,
      };

      const stickerMessage = targetMessage.message?.stickerMessage;
      if (!stickerMessage) {
        return await extra.reply('📎 Reply to a sticker to convert it to image!');
      }

      const stickerBuffer = await downloadMediaMessage(
        targetMessage,
        'buffer',
        {},
        { logger: undefined, reuploadRequest: sock.updateMediaMessage },
      );

      if (!stickerBuffer) {
        return await extra.reply('❌ Failed to download sticker.');
      }

      const isAnimated = stickerMessage.isAnimated || stickerMessage.mimetype?.includes('animated');

      if (isAnimated) {
        const { webp2mp4 } = require('../../utils/webp2mp4');
        const mp4Buffer = await webp2mp4(stickerBuffer);
        if (!mp4Buffer || mp4Buffer.length === 0) {
          throw new Error('Conversion failed');
        }
        await sock.sendMessage(extra.from, {
          video: mp4Buffer,
          mimetype: 'video/mp4',
          gifPlayback: true
        }, { quoted: msg });
      } else {
        const { webp2png } = require('../../utils/webp2mp4');
        const imageBuffer = await webp2png(stickerBuffer);
        await sock.sendMessage(extra.from, {
          image: imageBuffer
        }, { quoted: msg });
      }
    } catch (error) {
      console.error('toimg error:', error);
      await extra.reply(`❌ Failed to convert sticker to image.\n\nError: ${error.message}`);
    }
  }
};
