const database = require('../../database');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

module.exports = {
  name: 'antidelete',
  aliases: ['ad'],
  category: 'owner',
  description: 'Configure anti-delete settings',
  usage: '.antidelete <on/off/private/group>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const action = args[0]?.toLowerCase();
      const settings = database.getGlobalSettingsSync();

      const navBtns = [
        btn('ownermenu', '👑 Owner Menu'),
        btn('menu', '🔙 Main Menu'),
        urlBtn('🌐 Website', CHANNEL_URL),
      ];

      if (!action || action === 'status') {
        return sendBtn(sock, extra.from, {
          text:
            `╭━━〔 🛡️ *ANTI-DELETE* 〕━━⬣\n` +
            `┃\n` +
            `┃  🌐 *Global:*  ${settings.antidelete ? '✅ ON' : '❌ OFF'}\n` +
            `┃  💬 *Private:* ${settings.antideletePrivate ? '✅ ON' : '❌ OFF'}\n` +
            `┃  👥 *Groups:*  ${settings.antideleteGroup ? '✅ ON' : '❌ OFF'}\n` +
            `┃\n` +
            `┃  Usage: .antidelete on/off/private/group\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━⬣`,
          footer: `♾️ Infinity MD • Tap to configure`,
          buttons: [
            btn(settings.antidelete ? 'antidelete_off' : 'antidelete_on',
                settings.antidelete ? '❌ Turn OFF (Global)' : '✅ Turn ON (Global)'),
            btn('ownermenu', '👑 Owner Menu'),
            urlBtn('🌐 Website', CHANNEL_URL),
          ],
        }, { quoted: msg });
      }

      if (action === 'on')  { database.updateGlobalSettings({ antidelete: true });  return sendBtn(sock, extra.from, { text: `✅ *Anti-Delete ON* (Global)`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg }); }
      if (action === 'off') { database.updateGlobalSettings({ antidelete: false }); return sendBtn(sock, extra.from, { text: `❌ *Anti-Delete OFF* (Global)`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg }); }
      if (action === 'private' || action === 'chat') {
        const newState = !settings.antideletePrivate;
        database.updateGlobalSettings({ antideletePrivate: newState });
        return sendBtn(sock, extra.from, { text: `💬 *Anti-Delete Private:* ${newState ? '✅ ON' : '❌ OFF'}`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      }
      if (action === 'group' || action === 'groups') {
        const newState = !settings.antideleteGroup;
        database.updateGlobalSettings({ antideleteGroup: newState });
        return sendBtn(sock, extra.from, { text: `👥 *Anti-Delete Groups:* ${newState ? '✅ ON' : '❌ OFF'}`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      }

      extra.reply('❌ Invalid option. Use: on | off | private | group');
    } catch (err) {
      console.error('[antidelete cmd] error:', err);
      extra.reply('❌ Error configuring anti-delete.');
    }
  }
};
