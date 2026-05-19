/**
 * Welcome - Enable/disable welcome messages
 */

const db = require('../../database');
const { sendBtn, btn } = require('../../utils/sendBtn');

module.exports = {
  name: 'welcome',
  aliases: ['welcomeon', 'welcomeoff'],
  category: 'admin',
  desc: 'Enable/disable welcome messages',
  usage: 'welcome on/off',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,
  execute: async (sock, msg, args) => {
    try {
      const groupId = msg.key.remoteJid;
      const action = args[0]?.toLowerCase();
      
      if (!action || !['on', 'off'].includes(action)) {
        const groupSettings = db.getGroupSettings(groupId);
        const isOn = groupSettings.welcome;
        const text =
          `╭━━〔 👋 *WELCOME MSG* 〕━━⬣\n` +
          `┃\n` +
          `┃  🔒 *Status:* ${isOn ? '✅ ON' : '❌ OFF'}\n` +
          `┃  📝 Greet new members automatically\n` +
          `┃  💡 Customize: .setwelcome <msg>\n` +
          `┃\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━⬣`;
        return sendBtn(sock, groupId, {
          text,
          footer: `♾️ Infinity MD • Tap to toggle`,
          buttons: [
            btn(isOn ? 'welcome_off' : 'welcome_on',
                isOn ? '❌ Turn OFF' : '✅ Turn ON'),
            btn('cmd_menu', '📋 Main Menu'),
          ]
        }, { quoted: msg });
      }
      
      const enable = action === 'on';
      db.updateGroupSettings(groupId, { welcome: enable });
      
      await sock.sendMessage(groupId, {
        text: `✅ Welcome messages ${enable ? 'enabled' : 'disabled'}!${enable ? '\n\nNew members will now receive welcome messages.' : ''}`
      }, { quoted: msg });
      
    } catch (error) {
      console.error('Welcome Error:', error);
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ Error: ${error.message}`
      }, { quoted: msg });
    }
  }
};
