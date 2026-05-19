const database = require('../../database');

function getAR(settings) {
    const ar = settings.autoReply;
    if (ar && typeof ar === 'object') return ar;
    return {
        enabled: false,
        mode: 'smart',
        message: "Hi! How can I assist you today? 😊",
        messages: [
            "Hi! How can I assist you today? 😊",
            "Thanks for reaching out! How can I help you?",
            "Hello! What can I do for you? 😊",
            "Hey there! I'll get back to you shortly. How can I help?"
        ],
        keywords: [],
        timeStart: '09:00',
        timeEnd: '18:00'
    };
}

module.exports = {
    name: 'autoreply',
    aliases: ['ar'],
    description: 'Smart Auto-Reply — AI or custom keyword responses',
    usage: '.autoreply on|off|status|mode|message|keyword|time|clearkw',
    category: 'owner',
    ownerOnly: true,

    async execute(sock, msg, args, extra) {
        try {
            const settings = database.getGlobalSettingsSync();
            const ar = getAR(settings);
            const chatId = extra.from;
            const action = (args[0] || '').toLowerCase();

            const save = async (updated) => {
                await database.updateGlobalSettings({ autoReply: updated });
            };

            if (!action || action === 'status') {
                const modeLabels = {
                    'ai-always':  '🤖 AI — All the time',
                    'ai-offline': '🌙 AI — When offline',
                    'ai-time':    '⏰ AI — Custom time window',
                    'custom':     '🔑 Custom keywords only'
                };
                const kwList = (ar.keywords || []).slice(0, 5)
                    .map(k => `    • *${k.keyword}* → ${k.response.slice(0, 30)}${k.response.length > 30 ? '…' : ''}`)
                    .join('\n');
                return sock.sendMessage(chatId, {
                    text:
                        `╭━━〔 💬 *AUTO-REPLY* 〕━━⬣\n` +
                        `┃\n` +
                        `┃  🔒 *Status:* ${ar.enabled ? '✅ ON' : '❌ OFF'}\n` +
                        `┃  🤖 *Mode:* ${modeLabels[ar.mode] || ar.mode}\n` +
                        `┃  💬 *Message:*\n` +
                        `┃    _${(ar.message || '').slice(0, 60)}${ar.message?.length > 60 ? '…' : ''}_\n` +
                        `┃  ⏰ *Time window:* ${ar.timeStart || '09:00'} – ${ar.timeEnd || '18:00'}\n` +
                        `┃  🔑 *Keywords:* ${(ar.keywords || []).length}\n` +
                        (kwList ? `┃\n${kwList}\n` : '') +
                        `┃\n` +
                        `┃  *Commands:*\n` +
                        `┃  .autoreply on / off\n` +
                        `┃  .autoreply mode ai-always\n` +
                        `┃  .autoreply mode ai-offline\n` +
                        `┃  .autoreply mode ai-time\n` +
                        `┃  .autoreply mode custom\n` +
                        `┃  .autoreply message <text>\n` +
                        `┃  .autoreply keyword word=reply\n` +
                        `┃  .autoreply time 09:00-18:00\n` +
                        `┃  .autoreply clearkw\n` +
                        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━⬣`
                }, { quoted: msg });
            }

            if (action === 'on') {
                ar.enabled = true;
                await save(ar);
                return extra.reply(
                    `✅ *Auto-Reply ENABLED*\n\n` +
                    `Mode: *${ar.mode}*\n` +
                    `Configure via dashboard or *.autoreply mode*`
                );
            }

            if (action === 'off') {
                ar.enabled = false;
                await save(ar);
                return extra.reply('❌ *Auto-Reply DISABLED*');
            }

            if (action === 'mode') {
                const mode = (args[1] || '').toLowerCase();
                const valid = ['smart', 'ai-always', 'ai-offline', 'ai-time', 'custom'];
                if (!valid.includes(mode)) {
                    return extra.reply(
                        `❌ *Invalid mode.*\n\nValid modes:\n` +
                        `• \`smart\` — Natural replies (no AI needed)\n` +
                        `• \`ai-always\` — AI replies all the time\n` +
                        `• \`ai-offline\` — Reply when you're offline\n` +
                        `• \`ai-time\` — Reply during set time window\n` +
                        `• \`custom\` — Custom keywords only`
                    );
                }
                ar.mode = mode;
                await save(ar);
                return extra.reply(`✅ Auto-Reply mode → *${mode}*`);
            }

            if (action === 'message' || action === 'msg') {
                const text = args.slice(1).join(' ').trim();
                if (!text) return extra.reply('❌ Usage: `.autoreply message <your reply text>`');
                ar.message = text;
                await save(ar);
                return extra.reply(`✅ *Auto-Reply message updated:*\n\n_${text}_`);
            }

            if (action === 'keyword' || action === 'kw') {
                const pair = args.slice(1).join(' ');
                const eqIdx = pair.indexOf('=');
                if (eqIdx < 0) {
                    return extra.reply('❌ Usage: `.autoreply keyword hello=Hi there! How can I help?`');
                }
                const keyword = pair.slice(0, eqIdx).trim().toLowerCase();
                const response = pair.slice(eqIdx + 1).trim();
                if (!keyword || !response) return extra.reply('❌ Both keyword and reply are required.');
                ar.keywords = ar.keywords || [];
                const idx = ar.keywords.findIndex(k => k.keyword === keyword);
                if (idx >= 0) ar.keywords[idx].response = response;
                else ar.keywords.push({ keyword, response });
                await save(ar);
                return extra.reply(`✅ *Keyword saved:*\n*${keyword}* → ${response}`);
            }

            if (action === 'time') {
                const range = args[1] || '';
                const match = range.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
                if (!match) return extra.reply('❌ Usage: `.autoreply time 09:00-18:00`');
                ar.timeStart = match[1];
                ar.timeEnd   = match[2];
                await save(ar);
                return extra.reply(`✅ *Time window set:* ${ar.timeStart} – ${ar.timeEnd}`);
            }

            if (action === 'clearkw' || action === 'clearkeywords') {
                ar.keywords = [];
                await save(ar);
                return extra.reply('✅ All auto-reply keywords cleared.');
            }

            extra.reply('❌ Unknown option. Send `.autoreply` for help.');
        } catch (err) {
            console.error('AutoReply command error:', err);
            extra.reply('❌ Error updating auto-reply settings.');
        }
    },

    getAR
};
