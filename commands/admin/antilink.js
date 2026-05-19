/**
 * Antilink Command - Toggle antilink protection with delete/kick options
 */

const database = require('../../database');
const { sendBtn, btn } = require('../../utils/sendBtn');

module.exports = {
  name: 'antilink',
  aliases: [],
  category: 'admin',
  description: 'Configure antilink protection (delete/kick)',
  usage: '.antilink <on/off/set/get>',
  groupOnly: true,
  adminOnly: true,
  botAdminNeeded: true,
  
  async execute(sock, msg, args, extra) {
    try {
      if (!args[0]) {
        const settings = database.getGroupSettings(extra.from);
        const status = settings.antilink ? '✅ ON' : '❌ OFF';
        const action = settings.antilinkAction || 'delete';
        const text =
          `╭━━〔 🔗 *ANTI-LINK* 〕━━⬣\n` +
          `┃\n` +
          `┃  🔒 *Status:* ${status}\n` +
          `┃  ⚙️ *Action:* ${action}\n` +
          `┃\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━⬣`;
        return sendBtn(sock, extra.from, {
          text,
          footer: `♾️ Infinity MD • Tap to configure`,
          buttons: [
            btn(settings.antilink ? 'antilink_off' : 'antilink_on',
                settings.antilink ? '❌ Turn OFF' : '✅ Turn ON'),
            btn('antilink_delete', `🗑️ Action: Delete${action === 'delete' ? ' ✓' : ''}`),
            btn('antilink_kick', `🚫 Action: Kick${action === 'kick' ? ' ✓' : ''}`),
          ]
        }, { quoted: msg });
      }
      
      const opt = args[0].toLowerCase();
      
      if (opt === 'on') {
        if (database.getGroupSettings(extra.from).antilink) {
          return extra.reply('*Antilink is already on*');
        }
        database.updateGroupSettings(extra.from, { antilink: true });
        return extra.reply('*Antilink has been turned ON*');
      }
      
      if (opt === 'off') {
        database.updateGroupSettings(extra.from, { antilink: false });
        return extra.reply('*Antilink has been turned OFF*');
      }
      
      if (opt === 'set') {
        if (args.length < 2) {
          return extra.reply('*Please specify an action: .antilink set delete | kick*');
        }
        
        const setAction = args[1].toLowerCase();
        if (!['delete', 'kick'].includes(setAction)) {
          return extra.reply('*Invalid action. Choose delete or kick.*');
        }
        
        database.updateGroupSettings(extra.from, { 
          antilinkAction: setAction,
          antilink: true // Auto-enable when setting action
        });
        return extra.reply(`*Antilink action set to ${setAction}*`);
      }
      
      if (opt === 'get') {
        const settings = database.getGroupSettings(extra.from);
        const status = settings.antilink ? 'ON' : 'OFF';
        const action = settings.antilinkAction || 'delete';
        return extra.reply(`*Antilink Configuration:*\nStatus: ${status}\nAction: ${action}`);
      }
      
      return extra.reply('*Use .antilink for usage.*');
      
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
