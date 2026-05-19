/**
 * AI Chat Command - ChatGPT-style responses
 */

const APIs = require('../../utils/api');
const config = require('../../config');

module.exports = {
  name: 'ai',
  aliases: ['gpt', 'chatgpt', 'ask'],
  category: 'ai',
  description: 'Chat with AI (ChatGPT-style)',
  usage: '.ai <question>',
  
  async execute(sock, msg, args, extra) {
    try {
      if (args.length === 0) {
        return extra.reply(`╭───〔 🤖 AI ASSISTANT 〕───\n│ ❌ Usage: ${config.prefix}ai <question>\n╰────────────────────`);
      }
      
      const question = args.join(' ');
      await extra.react('🤖');
      
      const response = await APIs.chatAI(question);
      const answer = response.response || response.msg || response.data?.msg || response;
      
      const aiText = `╭───〔 🤖 AI RESPONSE 〕───\n│ 👤 *Question*: ${question}\n│ 🧠 *Answer*: ${answer}\n╰────────────────────\n\n> 💫 *INFINITY MD AI*`;
      
      await extra.reply(aiText);
      
    } catch (error) {
      await extra.reply(`╭───〔 🤖 AI ERROR 〕───\n│ ❌ Error: ${error.message}\n╰────────────────────`);
    }
  }
};
