const APIs = require('../../utils/api');
const config = require('../../config');

module.exports = {
  name: 'gpt',
  aliases: ['chatgpt', 'openai'],
  category: 'ai',
  description: 'Chat with GPT AI assistant',
  usage: '.gpt <question>',

  async execute(sock, msg, args, extra) {
    try {
      if (args.length === 0) {
        return extra.reply(`╭───〔 🤖 GPT AI 〕───\n│ ❌ Usage: ${config.prefix}gpt <question>\n│ Example: ${config.prefix}gpt What is quantum physics?\n╰────────────────────`);
      }

      const question = args.join(' ');
      await extra.react('🤖');

      const response = await APIs.chatAI(question);
      const answer = response.response || response.msg || response.data?.msg || response;

      const text = `╭───〔 🤖 GPT RESPONSE 〕───\n│ 👤 *Question*: ${question}\n│\n│ 🧠 *Answer*:\n│ ${answer}\n╰────────────────────\n\n> 💫 *INFINITY MD GPT*`;

      await extra.reply(text);
    } catch (error) {
      await extra.reply(`╭───〔 🤖 GPT ERROR 〕───\n│ ❌ Error: ${error.message}\n╰────────────────────`);
    }
  }
};
