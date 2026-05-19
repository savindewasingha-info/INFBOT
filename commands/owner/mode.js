const config = require('../../config');
const database = require('../../database');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

async function safeSend(sock, from, payload, opts, fallbackFn) {
  try {
    await sendBtn(sock, from, payload, opts);
  } catch {
    await fallbackFn(payload.text);
  }
}

const MODE_INFO = {
  public:  { icon: '🌐', label: 'PUBLIC',  desc: 'Everyone can use commands anywhere' },
  private: { icon: '🔒', label: 'PRIVATE', desc: 'Only the owner can use commands (DMs & groups)' },
  group:   { icon: '👥', label: 'GROUP',   desc: 'Commands only work inside groups, DMs ignored' },
};

module.exports = {
  name: 'mode',
  aliases: ['botmode', 'privatemode', 'publicmode'],
  description: 'Set bot mode: public / private / group',
  usage: '.mode <public/private/group>',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const globalSettings = database.getGlobalSettingsSync();
      const current = globalSettings.botMode || (globalSettings.forceBot ? 'private' : 'public');
      const info = MODE_INFO[current] || MODE_INFO.public;

      const navBtns = [
        btn('ownermenu', '👑 Owner Menu'),
        btn('menu', '🔙 Main Menu'),
        urlBtn('🌐 Website', CHANNEL_URL),
      ];

      if (!args[0]) {
        return safeSend(sock, extra.from, {
          text:
            `╭━━〔 🤖 *BOT MODE* 〕━━⬣\n` +
            `┃\n` +
            `┃  ${info.icon} *Current Mode:* ${info.label}\n` +
            `┃  📝 ${info.desc}\n` +
            `┃\n` +
            `┃  ─── Available Modes ───\n` +
            `┃  🌐 *public*  — Anyone, anywhere\n` +
            `┃  🔒 *private* — Owner only (DMs & groups)\n` +
            `┃  👥 *group*   — Inside groups only\n` +
            `┃\n` +
            `┃  Usage: .mode public / private / group\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━⬣`,
          footer: `♾️ Infinity MD`,
          buttons: [
            btn('mode_public',  `🌐 PUBLIC${current === 'public'  ? ' ✓' : ''}`),
            btn('mode_private', `🔒 PRIVATE${current === 'private' ? ' ✓' : ''}`),
            btn('mode_group',   `👥 GROUP${current === 'group'   ? ' ✓' : ''}`),
          ],
        }, { quoted: msg }, extra.reply);
      }

      const raw = args[0].toLowerCase();
      const resolved = raw === 'pub' ? 'public'
                     : raw === 'priv' ? 'private'
                     : raw === 'grp' ? 'group'
                     : raw;

      if (!['public', 'private', 'group'].includes(resolved)) {
        return extra.reply('❌ Invalid mode!\nUsage: .mode public / .mode private / .mode group');
      }

      if (resolved === current) {
        const i = MODE_INFO[resolved];
        return safeSend(sock, extra.from, {
          text: `${i.icon} Already in *${i.label}* mode.`,
          footer: `♾️ Infinity MD`,
          buttons: navBtns
        }, { quoted: msg }, extra.reply);
      }

      await database.updateGlobalSettings({
        botMode: resolved,
        forceBot: resolved === 'private',
      });

      const descriptions = {
        public:  `🌐 *Bot mode → PUBLIC*\n\nEveryone can use commands anywhere now.`,
        private: `🔒 *Bot mode → PRIVATE*\n\nOnly the bot owner can use commands.\nWorks in DMs and groups for the owner only.`,
        group:   `👥 *Bot mode → GROUP*\n\nCommands now work inside groups only.\nPrivate/DM chats from non-owners are fully ignored.`,
      };

      return safeSend(sock, extra.from, {
        text: descriptions[resolved],
        footer: `♾️ Infinity MD`,
        buttons: navBtns
      }, { quoted: msg }, extra.reply);

    } catch (error) {
      console.error('Mode command error:', error);
      await extra.reply('❌ Error changing bot mode.');
    }
  }
};
