module.exports = {
  name: 'leave',
  aliases: ['leavegroup', 'groupleave'],
  category: 'owner',
  description: 'Leave the current group',
  usage: '.leave',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const isGroup = extra.from.endsWith('@g.us');

      if (!isGroup) {
        return extra.reply('❌ This command can only be used in a group!');
      }

      await extra.reply('👋 Goodbye! Bot is leaving this group...');

      await sock.groupLeave(extra.from);
    } catch (error) {
      console.error('Leave command error:', error);
      await extra.reply('❌ Error leaving group.');
    }
  }
};
