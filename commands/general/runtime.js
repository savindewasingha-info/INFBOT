const os = require('os');

module.exports = {
  name: 'runtime',
  aliases: ['detaileduptime', 'sysinfo'],
  category: 'general',
  description: 'Show detailed runtime and system information',
  usage: '.runtime',

  async execute(sock, msg, args, extra) {
    try {
      const uptime = process.uptime();
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);

      const osUptime = os.uptime();
      const osDays = Math.floor(osUptime / 86400);
      const osHours = Math.floor((osUptime % 86400) / 3600);
      const osMinutes = Math.floor((osUptime % 3600) / 60);

      const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
      const freeMem = (os.freemem() / 1024 / 1024).toFixed(0);
      const usedMem = (totalMem - freeMem).toFixed(0);

      const ramUsed = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
      const heapUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
      const heapTotal = (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2);
      const external = (process.memoryUsage().external / 1024 / 1024).toFixed(2);

      const cpus = os.cpus();
      const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
      const cpuCores = cpus.length;

      let text = `╭━━〔 ⏱ RUNTIME INFO 〕━━╮\n`;
      text += `┃\n`;
      text += `┃ ⏱ *Bot Uptime*\n`;
      text += `┃ ${days}d ${hours}h ${minutes}m ${seconds}s\n`;
      text += `┃\n`;
      text += `┃ 🖥 *System Uptime*\n`;
      text += `┃ ${osDays}d ${osHours}h ${osMinutes}m\n`;
      text += `┃\n`;
      text += `┃ 💾 *Bot Memory*\n`;
      text += `┃ RSS: ${ramUsed} MB\n`;
      text += `┃ Heap: ${heapUsed}/${heapTotal} MB\n`;
      text += `┃ External: ${external} MB\n`;
      text += `┃\n`;
      text += `┃ 🧮 *System Memory*\n`;
      text += `┃ Used: ${usedMem}/${totalMem} MB\n`;
      text += `┃ Free: ${freeMem} MB\n`;
      text += `┃\n`;
      text += `┃ 🔧 *CPU*\n`;
      text += `┃ ${cpuModel}\n`;
      text += `┃ Cores: ${cpuCores}\n`;
      text += `┃\n`;
      text += `┃ 🟩 *Node* : ${process.version}\n`;
      text += `┃ 🖥 *OS* : ${os.platform()} ${os.arch()}\n`;
      text += `┃ 📂 *Hostname* : ${os.hostname()}\n`;
      text += `┃\n`;
      text += `╰━━━━━━━━━━━━━━━━━━━━╯`;

      await extra.reply(text);
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
