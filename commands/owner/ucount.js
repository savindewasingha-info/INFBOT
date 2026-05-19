const config = require('../../config');

module.exports = {
  name: 'ucount',
  aliases: ['usercount', 'activeusers'],
  description: 'Show the count of unique active users seen since bot started',
  usage: '.ucount',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const reply = extra?.reply || (t => sock.sendMessage(extra?.from || msg.key.remoteJid, { text: t }, { quoted: msg }));
    const sender = extra?.sender || msg.key.participant || msg.key.remoteJid;
    const senderNum = sender.split('@')[0].split(':')[0];

    const isOwner = config.ownerNumber.some(n => n.replace(/\D/g, '') === senderNum.replace(/\D/g, ''));
    if (!isOwner) return;

    const uniqueCount   = global.uniqueUsers?.size   || 0;
    const activeCount   = global.activeSessions?.size || 0;
    const uptimeSec     = Math.floor(process.uptime());
    const hours         = Math.floor(uptimeSec / 3600);
    const minutes       = Math.floor((uptimeSec % 3600) / 60);
    const seconds       = uptimeSec % 60;
    const uptimeStr     = `${hours}h ${minutes}m ${seconds}s`;

    return reply(
      `╭━━━〔 📊 *USER STATS* 〕━━━⬣\n` +
      `┃\n` +
      `┃  👥 Unique Users  : ${uniqueCount}\n` +
      `┃  🤖 Active Bots   : ${activeCount}\n` +
      `┃  ⏱️ Uptime         : ${uptimeStr}\n` +
      `┃\n` +
      `┃  ℹ️ Users counted since last\n` +
      `┃  bot restart.\n` +
      `╰━━━━━━━━━━━━━━━━━━━━━⬣`
    );
  }
};
