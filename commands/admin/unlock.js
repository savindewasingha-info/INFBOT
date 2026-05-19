module.exports = {
  name: 'unlock',
  aliases: ['unlockgroup'],
  category: 'admin',
  description: 'Unlock group settings (everyone can edit group info)',
  usage: '.unlock',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,

  async execute(sock, msg, args, extra) {
    try {
      await sock.groupSettingUpdate(extra.from, 'unlocked');
      await extra.reply('🔓 Group has been unlocked!\n\nAll members can edit group info now.');

    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
