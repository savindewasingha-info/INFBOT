/**
 * Connect Manual — Mobile Friendly + Sinhala Optimized + Welcome Message
 */

function buildManual({ botName, botNum, prefix }) {
  const p = prefix || '.';
  const bn = (botName || 'Infinity MD Mini').toUpperCase();
  const num = botNum ? `+${botNum.replace('+', '')}` : 'N/A';

  return `
⚡ *${bn} CONNECTION SUCCESS* ⚡

╭━━━━〔 🎉 WELCOME 〕━━━━╮
  👋 Hello! Welcome to *${bn}*
  🇱🇰 ඔබව සාදරයෙන් පිළිගනිමු!
╰━━━━━━━━━━━━━━━━━━━━━━━╯

┌───〔 🤖 SYSTEM INFO 〕───┐
  ✨ *Bot:* ${bn}
  📱 *Num:* ${num}
  ⌨️ *Prefix:* [ ${p} ]
└───────────────────────┘

🚀 *QUICK COMMANDS | ඉක්මන් භාවිතය*
╭───────────────────────╮
  📋 *Menu* : ${p}menu | ප‍්‍රධාන මෙනුව
  🌐 *Lang* : ${p}lang | භාෂාව
╰───────────────────────╯

💎 *TOP FEATURES | විශේෂාංග*
────────────────────────
🎵 *Media:* ${p}song, ${p}video, ${p}tiktok
🛡️ *Admin:* ${p}kick, ${p}mute, ${p}hidetag
🛠️ *Tools:* ${p}ai, ${p}sticker, ${p}img
👑 *Owner:* ${p}mode, ${p}setprefix, ${p}restart
────────────────────────

💡 *PRO TIP:*
Reply to an image with *${p}sticker* to create one!
ඕනෑම පින්තූරයකට *${p}sticker* ලෙස Reply කර ස්ටිකර් සාදන්න.

♾️ *Powered by ${bn}*
🌐 _visit: infinitymd.online_
`.trim();
}

/**
 * Sends the manual with an optional Link Preview/Thumbnail
 */
async function sendConnectManual(sock, ownerJid, { botName, botNum, prefix } = {}) {
  try {
    const text = buildManual({ botName, botNum, prefix });

    await sock.sendMessage(ownerJid, { 
      text,
      contextInfo: {
        externalAdReply: {
          title: `${botName || 'Infinity MD'} Online`,
          body: "Deployment Successful",
          mediaType: 1,
          thumbnailUrl: "https://i.imgur.com/your-image.png", // Replace with your bot logo
          sourceUrl: "https://infinitymd.online"
        }
      }
    });
  } catch (e) {
    console.error('⚠️ connectManual send error:', e.message);
  }
}

module.exports = { sendConnectManual };