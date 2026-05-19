const database = require('../../database');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

function parseToggle(input = '') {
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'status') return { type: 'status' };
  if (['on', 'enable', '1', 'true', 'yes'].includes(s)) return { type: 'set', value: true };
  if (['off', 'disable', '0', 'false', 'no'].includes(s)) return { type: 'set', value: false };
  return { type: 'status' };
}

const DEFAULT_CALL_REJECT_MSG =
  `📵 *Sorry, I cannot receive calls!*\n\n` +
  `I am a WhatsApp bot and calls are not supported.\n` +
  `Please send a text message instead. 🤖\n\n` +
  `_Powered by Infinity MD_`;

async function onCall(sock, callUpdate) {
  try {
    const globalSettings = database.getGlobalSettingsSync();
    const sessionSettings = sock._customConfig?.settings || {};
    const enabled = sessionSettings.anticall !== undefined
      ? sessionSettings.anticall
      : (globalSettings.anticall || false);

    if (!enabled) return;
    const from = callUpdate?.from || callUpdate?.chatId || callUpdate?.callerId;
    if (!['offer', 'ringing'].includes(callUpdate?.status) || !from) return;

    try { if (typeof sock.rejectCall === 'function') await sock.rejectCall(callUpdate.id || callUpdate.callId, from); } catch {}

    const rejectMsg = sessionSettings.callRejectMsg || globalSettings.callRejectMsg || DEFAULT_CALL_REJECT_MSG;
    try { await sock.sendMessage(from, { text: rejectMsg }); } catch {}

    try { if (typeof sock.updateBlockStatus === 'function') await sock.updateBlockStatus(from, 'block'); } catch {}
  } catch (e) { console.error('AntiCall onCall error:', e); }
}

module.exports = {
  name: 'anticall',
  aliases: ['acall', 'callblock'],
  category: 'owner',
  description: 'Enable/disable auto-reject + auto-block incoming calls',
  usage: '.anticall <on|off|status>',
  ownerOnly: true,

  async execute(sock, message, args, extra) {
    const parsed = parseToggle(args.join(' ').trim());
    const globalSettings = database.getGlobalSettingsSync();
    const currentState = globalSettings.anticall || false;

    const navBtns = [
      btn('ownermenu', '👑 Owner Menu'),
      btn('menu', '🔙 Main Menu'),
      urlBtn('🌐 Website', CHANNEL_URL),
    ];

    if (parsed.type === 'status') {
      return sendBtn(sock, extra.from, {
        text:
          `╭━━〔 📵 *ANTI-CALL* 〕━━⬣\n` +
          `┃\n` +
          `┃  🔒 *Status:* ${currentState ? '✅ ENABLED' : '❌ DISABLED'}\n` +
          `┃  📞 Auto-reject & block callers\n` +
          `┃\n` +
          `┃  Usage: .anticall on/off\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━⬣`,
        footer: `♾️ Infinity MD`,
        buttons: [
          btn(currentState ? 'anticall_off' : 'anticall_on', currentState ? '❌ Turn OFF' : '✅ Turn ON'),
          btn('ownermenu', '👑 Owner Menu'),
          urlBtn('🌐 Website', CHANNEL_URL),
        ],
      }, { quoted: message });
    }

    await database.updateGlobalSettings({ anticall: parsed.value });
    const newState = parsed.value;
    return sendBtn(sock, extra.from, {
      text:
        `╭━━〔 📵 *ANTI-CALL* 〕━━⬣\n` +
        `┃\n` +
        `┃  ${newState ? '✅ *ENABLED*' : '❌ *DISABLED*'}\n` +
        `┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━⬣`,
      footer: `♾️ Infinity MD`, buttons: navBtns,
    }, { quoted: message });
  },

  onCall,
};
