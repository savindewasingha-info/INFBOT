const config  = require('../../config');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { sendBtn, btn, urlBtn, FTGM_CHANNEL_URL, NEW_CHANNEL_URL, FTGM_TOOLS_URL } = require('../../utils/sendBtn');
const { getLang, t } = require('../../utils/lang');

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function ramBar(usedMB, totalMB) {
  const pct = Math.min(100, Math.round((usedMB / totalMB) * 100));
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}

/* =========================
   BANNER  (ratio: new 5x, old 1x)
========================= */
function pickMenuImage() {
  const bannersDir  = path.join(__dirname, '../../utils/banners');
  const newImageName = 'banner_new.jpg';
  const fallback    = path.join(__dirname, '../../utils/bot_image.jpg');

  try {
    if (fs.existsSync(bannersDir)) {
      const allFiles = fs.readdirSync(bannersDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      const newImage = path.join(bannersDir, newImageName);
      const hasNew   = allFiles.includes(newImageName) && fs.existsSync(newImage);
      const oldFiles = allFiles.filter(f => f !== newImageName);

      if (hasNew && oldFiles.length > 0) {
        // weighted pool: 5 slots for new, 1 slot for a random old image
        const pool = [
          ...Array(5).fill(newImage),
          path.join(bannersDir, oldFiles[Math.floor(Math.random() * oldFiles.length)])
        ];
        return pool[Math.floor(Math.random() * pool.length)];
      }

      if (hasNew) return newImage;

      if (oldFiles.length) {
        return path.join(bannersDir, oldFiles[Math.floor(Math.random() * oldFiles.length)]);
      }
    }
  } catch (_) {}

  return fs.existsSync(fallback) ? fallback : null;
}

/* =========================
   CATEGORIES
========================= */
const CATEGORIES = {
  media: {
    icon: '📥',
    cmds: [
      { name: 'movie' },
      { name: 'song' },
      { name: 'yt' },
      { name: 'ytmp3' },
      { name: 'ytmp4' },
      { name: 'play' },
      { name: 'tiktok' },
      { name: 'lyrics' },
    ],
  },

  admin: {
    icon: '🛡️',
    cmds: [
      { name: 'antilink' },
      { name: 'tagall' },
      { name: 'kick' },
      { name: 'promote' },
      { name: 'demote' },
      { name: 'mute' },
      { name: 'unmute' },
    ],
  },

  owner: {
    icon: '👑',
    cmds: [
      { name: 'mode' },
      { name: 'broadcast' },
      { name: 'block' },
      { name: 'unblock' },
    ],
  },

  tools: {
    icon: '🛠️',
    cmds: [
      { name: 'ai' },
      { name: 'gpt' },
      { name: 'calc' },
      { name: 'translate' },
      { name: 'weather' },
    ],
  },

  fun: {
    icon: '🎮',
    cmds: [
      { name: 'fact' },
      { name: 'joke' },
      { name: 'meme' },
      { name: 'ping' },
    ],
  },
};

/* =========================
   ALIASES (IMPORTANT FIX)
========================= */
const ALIAS_MAP = {
  mediamenu: 'media',
  adminmenu: 'admin',
  ownermenu: 'owner',
  toolsmenu: 'tools',
  funmenu: 'fun',
};

/* =========================
   MAIN MENU (BOX STYLE)
========================= */
function buildMainMenu({ botName, ownerName, senderNum, uptimeStr, ramMB, prefix }) {
  const totalCmds = Object.values(CATEGORIES).reduce((n, c) => n + c.cmds.length, 0);
  const totalMB = Math.round(os.totalmem() / 1024 / 1024);
  const bar = ramBar(Number(ramMB), totalMB);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? '🌅 Good Morning' : hour < 17 ? '☀️ Good Afternoon' : '🌙 Good Evening';

  return `
╭━━━〔 ✨ ${botName} 🚀 〕━━━⬣
┃ 👑 Owner : ${ownerName}
┃ ⌨️ Prefix: ${prefix}
┃ ⏱️ Uptime: ${uptimeStr}
┃ 💾 RAM   : ${bar}
┃ 📦 Cmds  : ${totalCmds}
╰━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 📚 MENU 〕━━━⬣
┃ 📥 mediamenu
┃ 🛡️ adminmenu
┃ 👑 ownermenu
┃ 🛠️ toolsmenu
┃ 🎮 funmenu
╰━━━━━━━━━━━━━━━━━━⬣

╭━━━〔 ⚡ QUICK 〕━━━⬣
┃ ${prefix}ai
┃ ${prefix}song
┃ ${prefix}ping
┃ ${prefix}antiviewonce
╰━━━━━━━━━━━━━━━━━━⬣

> ${greeting}, @${senderNum} 👋
> _Tap buttons below 👇_
`;
}

/* =========================
   SUBMENU (FIXED)
========================= */
function buildSubmenu(catKey, prefix) {
  const cat = CATEGORIES[catKey];
  if (!cat) return null;

  let tx = `
╭━━━〔 ${cat.icon} ${catKey.toUpperCase()} 〕━━━⬣
`;

  cat.cmds.forEach(cmd => {
    tx += `┃ ${prefix}${cmd.name}\n`;
  });

  tx += `╰━━━━━━━━━━━━━━━━━━⬣\n📌 ${cat.cmds.length} commands`;

  return tx;
}

/* =========================
   EXECUTE
========================= */
module.exports = {
  name: 'menu',
  aliases: ['help', 'commands', 'mediamenu', 'adminmenu', 'toolsmenu', 'funmenu', 'ownermenu'],

  async execute(sock, msg, args = [], extra = {}) {
    const chatId = extra?.from || msg?.key?.remoteJid;
    const sender = extra?.sender || msg?.key?.participant || chatId;

    const prefix = config.prefix || '.';
    const botName = config.botName || 'Infinity MD';
    const ownerName = config.ownerName || 'Owner';

    const senderNum = String(sender).split('@')[0];
    const uptimeStr = formatUptime(process.uptime());
    const ramMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);

    const usedCmd = String(extra?.commandName || '').toLowerCase().replace(prefix, '');
    const subArg  = args[0] ? String(args[0]).toLowerCase() : null;

    const submenuKey =
      ALIAS_MAP[usedCmd] ||
      ALIAS_MAP[subArg] ||
      (CATEGORIES[usedCmd] ? usedCmd : null) ||
      (CATEGORIES[subArg] ? subArg : null);

    /* =========================
       🔥 SUBMENU FIX (IMPORTANT)
    ========================= */
    if (submenuKey) {
      const text = buildSubmenu(submenuKey, prefix);

      return sendBtn(sock, chatId, {
        text,
        footer: `♾️ ${submenuKey.toUpperCase()} MENU`,
        buttons: [
          btn('menu', '🏠 Back Menu'),
        ],
        mentions: [sender],
      }, { quoted: msg });
    }

    /* =========================
       MAIN MENU
    ========================= */
    const image = pickMenuImage() ? { url: pickMenuImage() } : undefined;

    const text = buildMainMenu({
      botName,
      ownerName,
      senderNum,
      uptimeStr,
      ramMB,
      prefix
    });

    return sendBtn(sock, chatId, {
      text,
      footer: `♾️ ${botName}`,
      ...(image ? { image } : {}),
      buttons: [
        btn('mediamenu', '📥 Media'),
        btn('adminmenu', '🛡️ Admin'),
        btn('toolsmenu', '🛠️ Tools'),
        btn('funmenu', '🎮 Fun'),
        urlBtn('📢 Infinity Updates Channel', NEW_CHANNEL_URL),
        urlBtn('💎 FTGM Hacks', FTGM_CHANNEL_URL),
      ],
      mentions: [sender],
    }, { quoted: msg });
  }
};
