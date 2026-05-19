const database = require('../../database');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

module.exports = {
  name: 'autostatus',
  aliases: ['as'],
  description: 'Toggle auto-view status',
  usage: '.autostatus <on/off>',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const settings = database.getGlobalSettings();
      const navBtns = [
        btn('ownermenu', '👑 Owner Menu'),
        btn('menu', '🔙 Main Menu'),
        urlBtn('🌐 Website', CHANNEL_URL),
      ];

      if (!args[0]) {
        return sendBtn(sock, extra.from, {
          text:
            `╭━━〔 👀 *AUTO-STATUS* 〕━━⬣\n` +
            `┃\n` +
            `┃  🔒 *Status:* ${settings.autoStatus ? '✅ ON' : '❌ OFF'}\n` +
            `┃  📸 Auto-view all status updates\n` +
            `┃\n` +
            `┃  Usage: .autostatus on/off\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━⬣`,
          footer: `♾️ Infinity MD`,
          buttons: [
            btn(settings.autoStatus ? 'autostatus_off' : 'autostatus_on', settings.autoStatus ? '❌ Turn OFF' : '✅ Turn ON'),
            btn('ownermenu', '👑 Owner Menu'),
            urlBtn('🌐 Website', CHANNEL_URL),
          ],
        }, { quoted: msg });
      }

      const opt = args[0].toLowerCase();
      if (opt === 'on') {
        settings.autoStatus = true; database.updateGlobalSettings(settings);
        return sendBtn(sock, extra.from, { text: `✅ *Auto-Status ON*`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      } else if (opt === 'off') {
        settings.autoStatus = false; database.updateGlobalSettings(settings);
        return sendBtn(sock, extra.from, { text: `❌ *Auto-Status OFF*`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      } else {
        extra.reply('❌ Invalid option! Use: .autostatus on/off');
      }
    } catch (error) {
      console.error('AutoStatus error:', error);
      extra.reply('❌ Error updating auto status.');
    }
  }
};
