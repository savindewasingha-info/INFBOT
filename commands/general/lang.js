const { sendBtn, btn } = require('../../utils/sendBtn');
const { getLang, setLang, t, LANGUAGES } = require('../../utils/lang');

module.exports = {
  name: 'lang',
  aliases: ['language', 'setlang'],
  category: 'general',
  description: 'Select bot language (English / Sinhala)',
  usage: '.lang  |  .lang en  |  .lang si',

  async execute(sock, msg, args = [], extra = {}) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    const lang   = getLang(chatId);
    const arg    = args[0] ? String(args[0]).toLowerCase().trim() : null;

    // ── Set language directly if arg given ──────────────────────────────────
    if (arg) {
      if (!LANGUAGES[arg]) {
        return sock.sendMessage(chatId,
          { text: `❌  ${t('langInvalid', lang)}` },
          { quoted: msg }
        );
      }
      setLang(chatId, arg);
      const newLang = LANGUAGES[arg];
      return sock.sendMessage(chatId,
        { text: `✅  ${t('langChanged', arg)}  *${newLang.flag} ${newLang.name}*` },
        { quoted: msg }
      );
    }

    // ── Show picker with buttons ─────────────────────────────────────────────
    const current = LANGUAGES[lang];
    let text = '';
    text += `🌐  *${t('selectLang', lang)}*\n`;
    text += `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n`;
    text += `${t('currentLang', lang)}: ${current.flag} *${current.name}*\n`;
    text += `\n`;
    text += `\`1.\` 🇬🇧  *English*   · .lang en\n`;
    text += `\`2.\` 🇱🇰  *සිංහල*    · .lang si\n`;
    text += `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔`;

    return sendBtn(sock, chatId, {
      text,
      footer: `🌐 Language / භාෂාව`,
      buttons: [
        btn('lang en', '🇬🇧 English'),
        btn('lang si', '🇱🇰 සිංහල'),
        btn('menu',    '🔙 Menu'),
      ],
    }, { quoted: msg });
  },
};
