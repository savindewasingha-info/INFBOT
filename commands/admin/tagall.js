const config = require('../../config');

module.exports = {
  name: 'tagall',
  aliases: ['all', 'everyone'],
  category: 'admin',
  description: 'Tag all members in the group',
  usage: '.tagall [message]',
  adminOnly: true,
  groupOnly: true,
  
  async execute(sock, msg, args, extra) {
    const participants = extra.groupMetadata.participants;
    const message = args.join(' ') || 'Hello everyone!';
    let text = `╭───〔 📣 TAG ALL 〕───\n│ 📝 *Message*: ${message}\n╰────────────────────\n\n`;
    
    for (let mem of participants) {
      text += `│ ➜ @${mem.id.split('@')[0]}\n`;
    }
    
    await sock.sendMessage(extra.from, { 
      text: text, 
      mentions: participants.map(a => a.id) 
    }, { quoted: msg });
  }
};
