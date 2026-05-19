module.exports = {
  name: 'lock',
  aliases: ['lockgroup'],
  category: 'admin',
  description: 'Lock group settings (only admins can edit group info)',
  usage: '.lock',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      await sock.groupSettingUpdate(extra.from, 'locked');
      await extra.reply('🔒 Group has been locked!\n\nOnly admins can edit group info now.');

    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
