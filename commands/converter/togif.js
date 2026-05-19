const { downloadMediaMessage } = require('../../utils/baileys');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');

module.exports = {
  name: 'togif',
  aliases: ['videotogif', 'stickertogif', 'mp4togif'],
  category: 'converter',
  description: 'Convert video or animated sticker to GIF',
  usage: '.togif (reply to video/sticker)',

  async execute(sock, msg, args, extra) {
    try {
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
      let targetMessage = msg;

      if (ctxInfo?.quotedMessage) {
        targetMessage = {
          key: {
            remoteJid: extra.from,
            id: ctxInfo.stanzaId,
            participant: ctxInfo.participant,
          },
          message: ctxInfo.quotedMessage,
        };
      }

      const mediaMessage =
        targetMessage.message?.videoMessage ||
        targetMessage.message?.stickerMessage ||
        targetMessage.message?.imageMessage;

      if (!mediaMessage) {
        return await extra.reply('📎 Reply to a video or animated sticker to convert to GIF!');
      }

      const mediaBuffer = await downloadMediaMessage(
        targetMessage,
        'buffer',
        {},
        { logger: undefined, reuploadRequest: sock.updateMediaMessage },
      );

      if (!mediaBuffer) {
        return await extra.reply('❌ Failed to download media.');
      }

      const tempDir = getTempDir();
      const timestamp = Date.now();
      const tempInput = path.join(tempDir, `togif_in_${timestamp}`);
      const tempOutput = path.join(tempDir, `togif_out_${timestamp}.mp4`);

      fs.writeFileSync(tempInput, mediaBuffer);

      const cmd = `"${ffmpegPath}" -i "${tempInput}" -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -t 10 "${tempOutput}"`;

      await new Promise((resolve, reject) => exec(cmd, (err) => err ? reject(err) : resolve()));

      const outputBuffer = fs.readFileSync(tempOutput);

      await sock.sendMessage(extra.from, {
        video: outputBuffer,
        gifPlayback: true,
        mimetype: 'video/mp4'
      }, { quoted: msg });

      deleteTempFile(tempInput);
      deleteTempFile(tempOutput);
    } catch (error) {
      console.error('togif error:', error);
      await extra.reply(`❌ Failed to convert to GIF.\n\nError: ${error.message}`);
    }
  }
};
