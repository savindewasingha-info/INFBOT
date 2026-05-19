module.exports = {
  name: 'setname',
  aliases: ['setgroupname', 'setsubject'],
  category: 'admin',
  description: 'Set group name',
  usage: '.setname <new name>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      const name = args.join(' ');
      if (!name) {
        return extra.reply('❌ Please provide a new group name!\n\nExample: .setname My Cool Group');
      }

      if (name.length > 100) {
        return extra.reply('❌ Group name must be 100 characters or less!');
      }

      await sock.groupUpdateSubject(extra.from, name);
      await extra.reply(`✅ Group name updated to: ${name}`);

    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
