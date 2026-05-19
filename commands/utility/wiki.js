const APIs = require('../../utils/api');

module.exports = {
  name: 'wiki',
  aliases: ['wikipedia', 'wp'],
  category: 'utility',
  description: 'Search Wikipedia for any topic',
  usage: '.wiki <query>',

  async execute(sock, msg, args, extra) {
    try {
      if (args.length === 0) {
        return extra.reply('❌ Usage: .wiki <topic>\n\nExample: .wiki Albert Einstein');
      }

      const query = args.join(' ');
      await extra.react('🔍');

      const data = await APIs.wikiSearch(query);

      if (!data || data.type === 'disambiguation') {
        return extra.reply(`📚 *${query}* has multiple meanings on Wikipedia. Try being more specific.`);
      }

      if (!data.extract) {
        return extra.reply(`❌ No Wikipedia article found for "${query}".`);
      }

      const text = `╭━━〔 📖 WIKIPEDIA 〕━━⬣
┃ 📌 *${data.title}*
┃
┃ ${data.extract}
╰━━━━━━━━━━━━━━━━━━━━⬣

🔗 ${data.content_urls?.desktop?.page || ''}

> *INFINITY MD*`;

      if (data.thumbnail?.source) {
        await sock.sendMessage(extra.from, {
          image: { url: data.thumbnail.source },
          caption: text
        }, { quoted: msg });
      } else {
        await extra.reply(text);
      }
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
