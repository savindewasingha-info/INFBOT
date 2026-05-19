const database = require('../../database');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

const DEFAULT_EMOJIS = [
  '❤️','🔥','👌','💀','😁','✨','👍','🤨','😎','😂','🤝','💫',
  '🌙','⚡','🎯','💯','🤩','😍','🥳','🎉','💪','🙌','👏','🤣',
  '😜','🥴','🫡','💥','🌟','🏆','🫶','😏','🤙','🙏','😤','🤯',
  '😈','🥶','🫠','💎','🚀','🦋','🌈','🍀','🎵','👀','🤫','😇'
];

const MODE_LABELS = {
  'all': '🌟 All Messages',
  'cmd-only': '🤖 Bot Commands Only',
  'groups-only': '👥 Groups Only',
  'private-only': '💬 Private Only',
};

async function updateSetting(sock, patch) {
  const sessionId = sock._customConfig?.sessionId;
  if (sessionId) {
    if (!sock._customConfig.settings) sock._customConfig.settings = {};
    Object.assign(sock._customConfig.settings, patch);
    await database.updateSessionSettings(sessionId, patch);
  } else {
    await database.updateGlobalSettings(patch);
  }
}

module.exports = {
  name: 'autoreact',
  aliases: ['reactmode'],
  category: 'owner',
  description: 'Configure automatic reactions to messages',
  usage: '.autoreact <on/off/mode/emoji/reset>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const sessionSettings = sock._customConfig?.settings || {};
      const globalSettings = database.getGlobalSettingsSync();
      const effectiveSettings = { ...globalSettings, ...sessionSettings };

      const enabled = effectiveSettings.autoReact || false;
      const mode    = effectiveSettings.autoReactMode || 'all';
      const customEmojis = effectiveSettings.autoReactEmojis;
      const currentPool = (customEmojis && customEmojis.length > 0) ? customEmojis : DEFAULT_EMOJIS;

      const navBtns = [
        btn('ownermenu', '👑 Owner Menu'),
        btn('menu', '🔙 Main Menu'),
        urlBtn('🌐 Website', CHANNEL_URL),
      ];

      if (!args[0]) {
        return sendBtn(sock, extra.from, {
          text:
            `╭━━〔 ⚡ *AUTO-REACT* 〕━━⬣\n` +
            `┃\n` +
            `┃  🔒 *Status:* ${enabled ? '✅ ON' : '❌ OFF'}\n` +
            `┃  🎯 *Mode:* ${MODE_LABELS[mode] || mode}\n` +
            `┃  😀 *Emojis:* ${currentPool.slice(0, 8).join(' ')}${currentPool.length > 8 ? ' ...' : ''}\n` +
            `┃  📊 *Pool size:* ${currentPool.length} emojis\n` +
            `┃  ⚙️  *Per-session settings*\n` +
            `┃\n` +
            `┃  *Commands:*\n` +
            `┃  .autoreact on/off\n` +
            `┃  .autoreact mode all\n` +
            `┃  .autoreact mode cmd-only\n` +
            `┃  .autoreact mode groups-only\n` +
            `┃  .autoreact mode private-only\n` +
            `┃  .autoreact emoji add 🔥 💯\n` +
            `┃  .autoreact emoji remove 🔥\n` +
            `┃  .autoreact emoji set 😎 🔥 💀\n` +
            `┃  .autoreact emoji list\n` +
            `┃  .autoreact emoji reset\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━⬣`,
          footer: `♾️ Infinity MD`,
          buttons: [
            btn(enabled ? 'autoreact_off' : 'autoreact_on', enabled ? '❌ Turn OFF' : '✅ Turn ON'),
            btn('ownermenu', '👑 Owner Menu'),
            urlBtn('🌐 Website', CHANNEL_URL),
          ],
        }, { quoted: msg });
      }

      const opt = args[0].toLowerCase();

      // ── on/off ──
      if (opt === 'on') {
        await updateSetting(sock, { autoReact: true });
        return sendBtn(sock, extra.from, { text: `✅ *Auto-React ON*\n\n_Applied to this session._`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      }
      if (opt === 'off') {
        await updateSetting(sock, { autoReact: false });
        return sendBtn(sock, extra.from, { text: `❌ *Auto-React OFF*\n\n_Applied to this session._`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      }

      // ── mode <name> ──
      if (opt === 'mode') {
        const newMode = args[1]?.toLowerCase();
        if (!MODE_LABELS[newMode]) {
          return extra.reply(
            `❌ Invalid mode.\n\nAvailable modes:\n` +
            Object.entries(MODE_LABELS).map(([k, v]) => `• \`${k}\` — ${v}`).join('\n') +
            `\n\nUsage: .autoreact mode all`
          );
        }
        await updateSetting(sock, { autoReactMode: newMode });
        return sendBtn(sock, extra.from, {
          text: `🎯 *Mode → ${MODE_LABELS[newMode]}*\n\n_Applied to this session._`,
          footer: `♾️ Infinity MD`, buttons: navBtns,
        }, { quoted: msg });
      }

      // ── emoji subcommands ──
      if (opt === 'emoji') {
        const sub = args[1]?.toLowerCase();

        if (sub === 'list') {
          const pool = (effectiveSettings.autoReactEmojis?.length > 0) ? effectiveSettings.autoReactEmojis : DEFAULT_EMOJIS;
          const isCustom = effectiveSettings.autoReactEmojis?.length > 0;
          return extra.reply(
            `😀 *Auto-React Emoji Pool*\n` +
            `Type: ${isCustom ? '✏️ Custom' : '🎲 Default'}\n` +
            `Count: ${pool.length}\n\n` +
            pool.join('  ')
          );
        }

        if (sub === 'reset') {
          await updateSetting(sock, { autoReactEmojis: [] });
          return sendBtn(sock, extra.from, {
            text: `🔄 *Emoji pool reset to default* (${DEFAULT_EMOJIS.length} emojis)\n\n_Applied to this session._`,
            footer: `♾️ Infinity MD`, buttons: navBtns,
          }, { quoted: msg });
        }

        if (sub === 'set') {
          const newEmojis = args.slice(2);
          if (!newEmojis.length) return extra.reply('❌ Provide at least one emoji.\nUsage: .autoreact emoji set 😎 🔥 💀');
          await updateSetting(sock, { autoReactEmojis: newEmojis });
          return sendBtn(sock, extra.from, {
            text: `✅ *Emoji pool set!*\n\n${newEmojis.join('  ')}\n\n_Applied to this session._`,
            footer: `♾️ Infinity MD`, buttons: navBtns,
          }, { quoted: msg });
        }

        if (sub === 'add') {
          const toAdd = args.slice(2);
          if (!toAdd.length) return extra.reply('❌ Provide at least one emoji.\nUsage: .autoreact emoji add 🔥 💯');
          const current = effectiveSettings.autoReactEmojis?.length > 0 ? [...effectiveSettings.autoReactEmojis] : [...DEFAULT_EMOJIS];
          const updated = [...new Set([...current, ...toAdd])];
          await updateSetting(sock, { autoReactEmojis: updated });
          return sendBtn(sock, extra.from, {
            text: `➕ *Added ${toAdd.length} emoji(s)!*\n\n${toAdd.join('  ')}\n\nPool now has ${updated.length} emojis.\n\n_Applied to this session._`,
            footer: `♾️ Infinity MD`, buttons: navBtns,
          }, { quoted: msg });
        }

        if (sub === 'remove') {
          const toRemove = args.slice(2);
          if (!toRemove.length) return extra.reply('❌ Provide at least one emoji.\nUsage: .autoreact emoji remove 🔥');
          const current = effectiveSettings.autoReactEmojis?.length > 0 ? [...effectiveSettings.autoReactEmojis] : [...DEFAULT_EMOJIS];
          const updated = current.filter(e => !toRemove.includes(e));
          if (updated.length === 0) return extra.reply('❌ Cannot remove all emojis — use `.autoreact emoji reset` to reset to default instead.');
          await updateSetting(sock, { autoReactEmojis: updated });
          return sendBtn(sock, extra.from, {
            text: `➖ *Removed ${toRemove.length} emoji(s)!*\n\n${toRemove.join('  ')}\n\nPool now has ${updated.length} emojis.\n\n_Applied to this session._`,
            footer: `♾️ Infinity MD`, buttons: navBtns,
          }, { quoted: msg });
        }

        return extra.reply(
          `❌ Unknown emoji sub-command.\n\nAvailable:\n` +
          `• \`.autoreact emoji list\` — show current pool\n` +
          `• \`.autoreact emoji set 😎 🔥\` — replace pool\n` +
          `• \`.autoreact emoji add 🔥\` — add emojis\n` +
          `• \`.autoreact emoji remove 🔥\` — remove emoji\n` +
          `• \`.autoreact emoji reset\` — reset to default`
        );
      }

      // Legacy shortcuts for backward compatibility
      if (opt === 'set' && args[1]?.toLowerCase() === 'bot') {
        await updateSetting(sock, { autoReactMode: 'cmd-only' });
        return sendBtn(sock, extra.from, { text: `🤖 *Mode → Bot commands only*`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      }
      if (opt === 'set' && args[1]?.toLowerCase() === 'all') {
        await updateSetting(sock, { autoReactMode: 'all' });
        return sendBtn(sock, extra.from, { text: `🌟 *Mode → All messages*`, footer: `♾️ Infinity MD`, buttons: navBtns }, { quoted: msg });
      }

      return extra.reply(
        `❌ Unknown option.\n\nUsage:\n` +
        `\`.autoreact on\` / \`.autoreact off\`\n` +
        `\`.autoreact mode all\` / \`cmd-only\` / \`groups-only\` / \`private-only\`\n` +
        `\`.autoreact emoji set/add/remove/list/reset\``
      );
    } catch (err) {
      console.error('[autoreact cmd] error:', err);
      extra.reply('❌ Error configuring auto-react.');
    }
  }
};
