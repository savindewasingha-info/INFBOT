const database = require('../../database');
const config = require('../../config');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

async function updateSetting(sock, key, value) {
  const sessionId = sock._customConfig?.sessionId;
  if (sessionId) {
    if (!sock._customConfig.settings) sock._customConfig.settings = {};
    sock._customConfig.settings[key] = value;
    await database.updateSessionSettings(sessionId, { [key]: value });
  } else {
    await database.updateGlobalSettings({ [key]: value });
  }
}

module.exports = {
  name: 'antiviewonce',
  aliases: ['antivo', 'viewonceguard'],
  description: 'Toggle anti-viewonce — intercepts view-once media and saves it to owner chat',
  usage: '.antiviewonce [on/off/emoji <emoji>]',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const sessionSettings = sock._customConfig?.settings || {};
      const globalSettings = database.getGlobalSettingsSync();
      const effectiveSettings = { ...globalSettings, ...sessionSettings };
      const current = effectiveSettings.antiviewonce || false;
      const currentEmoji = effectiveSettings.antiviewonceEmoji || '👁️';
      const ownerNum = (sock._customConfig?.ownerNumber || config.ownerNumber[0] || '').replace(/[^0-9]/g, '');

      const navBtns = [
        btn('ownermenu', '👑 Owner Menu'),
        btn('menu', '🔙 Main Menu'),
        urlBtn('🌐 Website', CHANNEL_URL),
      ];

      if (!args[0]) {
        return sendBtn(sock, extra.from, {
          text:
            `╭━━〔 👁️ *ANTI-VIEWONCE* 〕━━⬣\n` +
            `┃\n` +
            `┃  🔒 *Status:* ${current ? '✅ ON' : '❌ OFF'}\n` +
            `┃  😀 *React Emoji:* ${currentEmoji}\n` +
            `┃  👤 *Owner:* +${ownerNum}\n` +
            `┃\n` +
            `┃  📌 When ON, view-once media is\n` +
            `┃  silently forwarded to your chat.\n` +
            `┃  Settings are *per-session*.\n` +
            `┃\n` +
            `┃  Usage:\n` +
            `┃  .antiviewonce on/off\n` +
            `┃  .antiviewonce emoji 🔥\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━⬣`,
          footer: `♾️ Infinity MD`,
          buttons: [
            btn(current ? 'settings_antiviewonce_off' : 'settings_antiviewonce_on',
                current ? '❌ Turn OFF' : '✅ Turn ON'),
            btn('ownermenu', '👑 Owner Menu'),
            urlBtn('🌐 Website', CHANNEL_URL),
          ],
        }, { quoted: msg });
      }

      // .antiviewonce emoji <emoji>
      if (args[0].toLowerCase() === 'emoji') {
        const emoji = args[1];
        if (!emoji) return extra.reply('❌ Provide an emoji.\nUsage: .antiviewonce emoji 🔥');
        await updateSetting(sock, 'antiviewonceEmoji', emoji);
        return sendBtn(sock, extra.from, {
          text: `${emoji} *Reaction emoji updated!*\n\nView-once messages will now be reacted with: ${emoji}`,
          footer: `♾️ Infinity MD`, buttons: navBtns,
        }, { quoted: msg });
      }

      const value = args[0].toLowerCase();
      if (value !== 'on' && value !== 'off') return extra.reply('❌ Invalid option!\nUsage: .antiviewonce on/off');

      const newValue = value === 'on';
      if (newValue === current) {
        return sendBtn(sock, extra.from, {
          text: `👁️ Anti-ViewOnce is already *${value.toUpperCase()}*`,
          footer: `♾️ Infinity MD`, buttons: navBtns,
        }, { quoted: msg });
      }

      await updateSetting(sock, 'antiviewonce', newValue);
      return sendBtn(sock, extra.from, {
        text: newValue
          ? `✅ *Anti-ViewOnce ON*\n\n👁️ View-once media will be secretly saved to your chat (+${ownerNum}).\n\n_Setting applies to this session only._`
          : `❌ *Anti-ViewOnce OFF*\n\nView-once media is no longer intercepted.\n\n_Setting applies to this session only._`,
        footer: `♾️ Infinity MD`, buttons: navBtns,
      }, { quoted: msg });

    } catch (error) {
      console.error('AntiViewOnce command error:', error);
      await extra.reply('❌ Error toggling anti-viewonce.');
    }
  }
};
