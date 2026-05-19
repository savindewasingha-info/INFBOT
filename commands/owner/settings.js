const config = require('../../config');
const database = require('../../database');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

// Write a setting to the session (per-session) with in-memory update + DB persist
async function writeSessionSetting(sock, key, value) {
  if (!sock._customConfig.settings) sock._customConfig.settings = {};
  sock._customConfig.settings[key] = value;
  const sessionId = sock._customConfig?.sessionId;
  if (sessionId) {
    await database.updateSessionSettings(sessionId, { [key]: value });
  }
}

// Write a global setting (maintenance, forceBot) — affects all sessions
async function writeGlobalSetting(sock, key, value) {
  await database.updateGlobalSettings({ [key]: value });
}

// Settings that are per-session (each bot instance controls independently)
const SESSION_SETTINGS = {
  'antiviewonce' : 'antiviewonce',
  'antidelete'   : 'antidelete',
  'anticall'     : 'anticall',
  'autoreact'    : 'autoReact',
  'autostatus'   : 'autoStatus',
  'autotyping'   : 'autoTyping',
  'autovoice'    : 'autoVoice',
};

// Settings that are global (affect all sessions / the entire bot service)
const GLOBAL_SETTINGS = {
  'maintenance'  : 'maintenance',
  'privatemode'  : 'forceBot',
  'forcebot'     : 'forceBot',
};

async function showSettingsPanel(sock, msg, extra) {
  const gs = database.getGlobalSettingsSync();
  const ss = sock._customConfig?.settings || {};
  const eff = { ...gs, ...ss };
  const on = '✅', off = '❌';
  const s = (v) => v ? on : off;
  const src = (key, sessionKey) => ss[sessionKey] !== undefined ? '🔑' : '🌐';

  let text = `⚙️ *BOT SETTINGS*\n`;
  text += `╭───〔 🤖 Bot Info 〕───\n`;
  text += `│ 📛 *Name* : ${config.botName || 'Infinity MD'}\n`;
  text += `│ ⌨️ *Prefix* : ${config.prefix || '.'}\n`;
  text += `│ ⏱ *Uptime* : ${formatUptime(process.uptime())}\n`;
  text += `╰────────────────────\n\n`;

  text += `╭───〔 🔐 Global Mode 〕───\n`;
  text += `│ ${s(gs.forceBot)} *Private Mode* 🌐\n`;
  text += `│ ${s(gs.maintenance)} *Maintenance Mode* 🌐\n`;
  text += `╰────────────────────\n\n`;

  text += `╭───〔 🛡️ Protection (per-session) 〕───\n`;
  text += `│ ${s(eff.antidelete)} *Anti-Delete* ${src('antidelete','antidelete')}\n`;
  text += `│ ${s(eff.antiviewonce)} *Anti-ViewOnce* ${src('antiviewonce','antiviewonce')}\n`;
  text += `│ ${s(eff.anticall)} *Anti-Call* ${src('anticall','anticall')}\n`;
  text += `╰────────────────────\n\n`;

  text += `╭───〔 🤖 Auto Features (per-session) 〕───\n`;
  text += `│ ${s(eff.autoReact)} *Auto-React* ${src('autoReact','autoReact')}\n`;
  text += `│ ${s(eff.autoStatus)} *Auto-Status View* ${src('autoStatus','autoStatus')}\n`;
  text += `│ ${s(eff.autoTyping)} *Auto-Typing* ${src('autoTyping','autoTyping')}\n`;
  text += `│ ${s(eff.autoVoice)} *Auto-Voice* ${src('autoVoice','autoVoice')}\n`;
  text += `╰────────────────────\n\n`;

  text += `╭───〔 ℹ️ Legend 〕───\n`;
  text += `│ 🔑 = session setting  🌐 = global\n`;
  text += `╰────────────────────`;

  return sendBtn(sock, extra.from, {
    text,
    footer: `⚙️ Per-session settings apply to this bot only`,
    buttons: [
      btn(eff.antidelete    ? 'settings_antidelete_off'    : 'settings_antidelete_on',
          `🛡️ AntiDelete: ${eff.antidelete    ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(eff.antiviewonce  ? 'settings_antiviewonce_off'  : 'settings_antiviewonce_on',
          `👁️ AntiViewOnce: ${eff.antiviewonce  ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(eff.anticall      ? 'settings_anticall_off'      : 'settings_anticall_on',
          `📵 AntiCall: ${eff.anticall      ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(eff.autoReact     ? 'settings_autoreact_off'     : 'settings_autoreact_on',
          `⚡ AutoReact: ${eff.autoReact     ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(eff.autoStatus    ? 'settings_autostatus_off'    : 'settings_autostatus_on',
          `👀 AutoStatus: ${eff.autoStatus    ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(eff.autoTyping    ? 'settings_autotyping_off'    : 'settings_autotyping_on',
          `⌨️ AutoTyping: ${eff.autoTyping    ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(eff.autoVoice     ? 'settings_autovoice_off'     : 'settings_autovoice_on',
          `🎙️ AutoVoice: ${eff.autoVoice     ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(gs.maintenance    ? 'settings_maintenance_off'   : 'settings_maintenance_on',
          `🔧 Maintenance: ${gs.maintenance   ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
      btn(gs.forceBot       ? 'settings_privatemode_off'   : 'settings_privatemode_on',
          `🔒 PrivateMode: ${gs.forceBot      ? '✅ ON  →  Turn OFF' : '❌ OFF  →  Turn ON'}`),
    ]
  }, { quoted: msg });
}

module.exports = {
  name: 'settings',
  aliases: ['botsettings', 'botconfig'],
  description: 'View and manage all bot settings (per-session)',
  usage: '.settings [setting] [on/off]',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      if (!extra.isOwner) {
        return extra.reply('👑 Only the bot owner can access settings.');
      }

      if (!args[0]) {
        return showSettingsPanel(sock, msg, extra);
      }

      const setting = args[0].toLowerCase();
      const value   = args[1] ? args[1].toLowerCase() : null;

      const allSettings = { ...SESSION_SETTINGS, ...GLOBAL_SETTINGS };
      const settingKey = allSettings[setting];

      if (!settingKey) {
        return extra.reply(
          `❌ Unknown setting: *${setting}*\n\n` +
          `*Per-session settings:*\n` +
          Object.keys(SESSION_SETTINGS).map(k => `• ${k}`).join('\n') +
          `\n\n*Global settings:*\n` +
          Object.keys(GLOBAL_SETTINGS).map(k => `• ${k}`).join('\n') +
          `\n\nUsage: .settings <name> on/off`
        );
      }

      const isGlobal = !!GLOBAL_SETTINGS[setting];
      const gs = database.getGlobalSettingsSync();
      const ss = sock._customConfig?.settings || {};
      const eff = { ...gs, ...ss };

      if (!value || (value !== 'on' && value !== 'off')) {
        const current = eff[settingKey] ? 'ON' : 'OFF';
        return extra.reply(
          `⚙️ *${setting}* is currently: *${current}*\n` +
          `Scope: ${isGlobal ? '🌐 Global' : '🔑 Per-session'}\n\n` +
          `Usage: .settings ${setting} on/off`
        );
      }

      const newValue = value === 'on';

      if (isGlobal) {
        await writeGlobalSetting(sock, settingKey, newValue);
      } else {
        await writeSessionSetting(sock, settingKey, newValue);
      }

      const emoji = newValue ? '✅' : '❌';
      const scope = isGlobal ? '🌐 Global' : '🔑 This session';
      await extra.reply(`${emoji} *${setting}* turned *${value.toUpperCase()}*\nScope: ${scope}`);

      return showSettingsPanel(sock, msg, extra);

    } catch (error) {
      console.error('Settings command error:', error);
      await extra.reply('❌ Error managing settings.');
    }
  }
};
