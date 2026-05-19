const { downloadMediaMessage } = require('../../utils/baileys');
const { toAudio } = require('../../utils/converter');

module.exports = {
  name: 'tomp3',
  aliases: ['toaudio', 'mp3', 'extractaudio'],
  category: 'converter',
  description: 'Convert video to MP3 audio',
  usage: '.tomp3 (reply to video/audio)',

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
        targetMessage.message?.audioMessage ||
        targetMessage.message?.documentMessage;

      if (!mediaMessage) {
        return await extra.reply('📎 Reply to a video or audio to convert to MP3!');
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

      await extra.reply('🔄 Converting to MP3...');

      const ext = mediaMessage.mimetype?.split('/')[1] || 'mp4';
      const audioBuffer = await toAudio(mediaBuffer, ext);

      await sock.sendMessage(extra.from, {
        audio: audioBuffer,
        mimetype: 'audio/mpeg',
      }, { quoted: msg });
    } catch (error) {
      console.error('tomp3 error:', error);
      await extra.reply(`❌ Failed to convert to MP3.\n\nError: ${error.message}`);
    }
  }
};
