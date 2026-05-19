module.exports = {
  name: 'join',
  aliases: ['joingroup', 'groupjoin'],
  category: 'owner',
  description: 'Join a group using invite link',
  usage: '.join <group_link>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      if (!args.length) {
        return extra.reply('❌ Please provide a group invite link!\nUsage: .join <group_link>');
      }

      const link = args[0];
      const match = link.match(/chat\.whatsapp\.com\/([a-zA-Z0-9_-]+)/);

      if (!match) {
        return extra.reply('❌ Invalid group invite link!\nExample: https://chat.whatsapp.com/XXXXX');
      }

      const inviteCode = match[1];
      await extra.reply('⏳ Joining group...');

      const result = await sock.groupAcceptInvite(inviteCode);
      await extra.reply(`✅ Successfully joined group!\nGroup ID: ${result}`);
    } catch (error) {
      console.error('Join command error:', error);
      if (error.message?.includes('conflict')) {
        await extra.reply('❌ Bot is already in this group!');
      } else if (error.message?.includes('not-authorized')) {
        await extra.reply('❌ The invite link is invalid or has expired!');
      } else {
        await extra.reply(`❌ Error joining group: ${error.message}`);
      }
    }
  }
};
