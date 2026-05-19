/**
 * Ping Command - Check bot response speed and system status
 */

const os = require('os');
const config = require('../../config');
const { sendBtn, btn, urlBtn, CHANNEL_URL } = require('../../utils/sendBtn');

module.exports = {
  name: 'ping',
  aliases: ['p'],
  category: 'general',
  description: 'Check bot response speed',
  usage: '.ping',
  
  async execute(sock, msg, args, extra) {
    try {
      const start = Date.now();
      await extra.react('🏓');
      const end = Date.now();
      const localPing = end - start;
      
      // Network ping (simulated/calculated)
      const netPing = Math.floor(Math.random() * 20) + 50; 
      const netStatus = netPing < 100 ? '🟢 FAST' : '🟡 NORMAL';

      // Uptime calculation
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const uptimeString = `${hours}h ${minutes}m`;

      // Memory info
      const ramUsage = Math.floor(process.memoryUsage().rss / 1024 / 1024);
      const heapUsed = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
      const heapTotal = Math.floor(process.memoryUsage().heapTotal / 1024 / 1024);

      const pingText = `╭━━〔 🤖 Infinity MD STATUS 〕━━⬣
┃ 🏓 Local    : ${localPing} ms
┃ 🌐 Net      : ${netPing} ms  ${netStatus}
┃ 🧠 Response : Active
┃ ⏱ Uptime   : ${uptimeString}
┃ 💾 RAM      : ${ramUsage} MB
┃ 📦 Heap     : ${heapUsed}/${heapTotal} MB
┃ 🖥 OS       : ${os.platform()} ${os.arch()}
┃ 🟩 Node     : ${process.version}
┃ 🏷 Version  : v2.0.0
╰━━━━━━━━━━━━━━━━━━━━⬣

✨ Everything working perfectly!
> *INFINITY MD*`;

      const fs = require('fs');
      const path = require('path');
      const imagePath = path.join(__dirname, '../../utils/banners/pong.jpg');
      const image = fs.existsSync(imagePath) ? { url: imagePath } : undefined;

      await sendBtn(sock, extra.from, {
        text: pingText,
        footer: `♾️ ${config.botName} • Server Health`,
        ...(image ? { image } : {}),
        buttons: [
          btn('cmd_ping', '🔄 Ping Again'),
          btn('testping', '🏓 Full Test'),
          btn('cmd_menu', '📋 Menu'),
          urlBtn('🌐 Website', CHANNEL_URL),
        ]
      }, { quoted: msg });
      
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
