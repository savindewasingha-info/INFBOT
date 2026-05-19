const config = require('../../config');
const { sendBtn, urlBtn, btn, FTGM_CHANNEL_URL } = require('../../utils/sendBtn');

module.exports = {
  name: 'owner',
  aliases: ['dev'],
  category: 'general',
  description: 'Get owner info',
  usage: '.owner',
  
  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    const ownerText = `╭───〔 👑 OWNER INFO 〕───
│ 👤 *Name* : ${config.ownerName[0]}
│ 📱 *Number* : ${config.ownerNumber[0]}
│ 🌐 *Github* : ${config.social.github}
╰────────────────────

> 💫 *INFINITY MD* - Powered by AI`;
    return sendBtn(sock, chatId, {
      text: ownerText,
      footer: '♾️ Infinity MD Mini',
      buttons: [
        btn('cmd_menu', '📋 Main Menu'),
        urlBtn('Follow the 𝗙𝗧𝗚𝗠 𝗛𝗔𝗖𝗞𝗦© channel on WhatsApp', FTGM_CHANNEL_URL),
      ],
    }, { quoted: msg });
  }
};
