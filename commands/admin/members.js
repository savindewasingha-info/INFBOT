module.exports = {
  name: 'members',
  aliases: ['listmembers', 'memberlist', 'membercount'],
  category: 'admin',
  description: 'List or count group members',
  usage: '.members [list]',
  groupOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const metadata = await sock.groupMetadata(extra.from);
      const participants = metadata.participants;
      const admins = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
      const regular = participants.filter(p => !p.admin);

      if (args[0] === 'list') {
        let text = `👥 *Group Members* (${participants.length})\n\n`;
        text += `👑 *Admins* (${admins.length}):\n`;
        admins.forEach((p, i) => {
          text += `  ${i + 1}. @${p.id.split('@')[0]}\n`;
        });

        text += `\n👤 *Members* (${regular.length}):\n`;
        regular.forEach((p, i) => {
          text += `  ${i + 1}. @${p.id.split('@')[0]}\n`;
        });

        await sock.sendMessage(extra.from, {
          text,
          mentions: participants.map(p => p.id)
        }, { quoted: msg });
      } else {
        const text = `👥 *Group Members Info*\n\n` +
          `📊 Total Members: ${participants.length}\n` +
          `👑 Admins: ${admins.length}\n` +
          `👤 Regular Members: ${regular.length}\n\n` +
          `_Use .members list to see all members_`;

        await extra.reply(text);
      }

    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
