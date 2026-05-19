const ALLOWED_NUMBER = '94770612011';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse a channel or channel-post URL.
// Returns { inviteCode, serverId } where serverId is non-null only when the
// URL contains a numeric post server-id segment (e.g. /channel/CODE/123456).
function parseChannelUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('http')) return { inviteCode: null, serverId: null };

  const m = trimmed.match(/channel\/([a-zA-Z0-9_\-]+)(?:\/(\d+))?/i);
  if (!m) return { inviteCode: null, serverId: null };

  return {
    inviteCode: m[1],
    serverId: m[2] || null   // only set when the URL segment is purely numeric
  };
}

// Resolve a channel arg (URL, invite code, or @newsletter JID) → { jid, serverId }
async function resolveChannel(raw, sock) {
  const trimmed = raw.trim();

  if (trimmed.includes('@newsletter')) return { jid: trimmed, serverId: null };

  if (trimmed.startsWith('http')) {
    const { inviteCode, serverId } = parseChannelUrl(trimmed);
    if (!inviteCode) return { jid: null, serverId: null };
    try {
      const info = await sock.newsletterMetadata('invite', inviteCode);
      return { jid: info?.id || (inviteCode + '@newsletter'), serverId };
    } catch {
      return { jid: inviteCode + '@newsletter', serverId };
    }
  }

  // bare invite code
  try {
    const info = await sock.newsletterMetadata('invite', trimmed);
    return { jid: info?.id || (trimmed + '@newsletter'), serverId: null };
  } catch {
    return { jid: trimmed + '@newsletter', serverId: null };
  }
}

// Extract the server_id of the most-recent post from a raw newsletterFetchMessages result.
// Baileys returns a raw binary IQ node, not parsed WAMessages, so we traverse it manually.
function extractServerId(rawResult) {
  if (!rawResult) return null;
  try {
    const { getBinaryNodeChild, getAllBinaryNodeChildren } = require('@whiskeysockets/baileys');
    // result → <iq> → <message_updates> → <message server_id="123" ...>
    const updatesNode = getBinaryNodeChild(rawResult, 'message_updates');
    if (!updatesNode) return null;
    const msgNodes = getAllBinaryNodeChildren(updatesNode).filter(n => n.tag === 'message');
    if (!msgNodes.length) return null;
    // Messages come newest-first; take the first one
    return msgNodes[0].attrs?.server_id || null;
  } catch {
    return null;
  }
}

function extractEmojis(text) {
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;

  if (segmenter) {
    const segs = [...segmenter.segment(text)].map(s => s.segment);
    const re = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u;
    const emojis = segs.filter(s => re.test(s));
    if (emojis.length) return emojis;
  }

  const fallback = text.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu);
  return fallback || [text.trim()];
}

module.exports = {
  name: 'creact',
  aliases: ['channelreact', 'chnlreact'],
  description: 'React to a WhatsApp channel post with all bots',
  usage: '.creact <channel_or_post_link> <emoji(s)>',
  category: 'owner',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const reply = extra?.reply || (t => sock.sendMessage(extra?.from || msg.key.remoteJid, { text: t }, { quoted: msg }));
    const sender = extra?.sender || msg.key.participant || msg.key.remoteJid;
    const senderNum = sender.split('@')[0].split(':')[0];

    if (senderNum !== ALLOWED_NUMBER) return;

    if (!args[0]) {
      return reply(
        `╭━━━〔 📢 *CHANNEL REACT* 〕━━━⬣\n` +
        `┃\n` +
        `┃  Usage:\n` +
        `┃  .creact <channel_link> <emoji(s)>\n` +
        `┃  .creact <post_link> <emoji(s)>\n` +
        `┃\n` +
        `┃  Post link = channel URL ending with\n` +
        `┃  the numeric post ID e.g:\n` +
        `┃  …/channel/CODE/123456789\n` +
        `┃\n` +
        `┃  ℹ️ Reacts with every connected bot.\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━⬣`
      );
    }

    const channelArg = args[0];
    const emojiRaw   = args.slice(1).join(' ').trim();
    const emojis     = emojiRaw ? extractEmojis(emojiRaw) : ['❤️'];

    const bots = [...(global.activeSessions || new Map()).entries()];
    if (!bots.length) return reply('❌ No bots are currently online.');

    await reply('⏳ Resolving channel...');

    const [, firstSock] = bots[0];
    const { jid: newsletterJid, serverId: urlServerId } = await resolveChannel(channelArg, firstSock);

    if (!newsletterJid) return reply('❌ Could not resolve channel. Use a valid WhatsApp channel URL.');

    // If the post URL already contained the numeric server_id, use it directly.
    // Otherwise follow the channel and fetch the latest post to get its server_id.
    let serverId = urlServerId;

    if (!serverId) {
      await reply('⏳ Fetching latest post...');
      // Ensure the bot follows the channel — required for newsletterFetchMessages to work
      try { await firstSock.newsletterFollow(newsletterJid); } catch (_) {}

      try {
        const raw = await firstSock.newsletterFetchMessages(newsletterJid, 1);
        serverId = extractServerId(raw);
      } catch (err) {
        console.error('[creact] fetch messages error:', err.message);
      }
    }

    if (!serverId) {
      return reply(
        `❌ Could not get the post server ID.\n\n` +
        `Share the specific post and copy its link — it should end with a number:\n` +
        `https://whatsapp.com/channel/INVITECODE/123456789`
      );
    }

    console.log(`[creact] Reacting to newsletter ${newsletterJid} post server_id=${serverId}`);

    let reacted = 0, failed = 0;

    for (const emoji of emojis) {
      for (const [sessionId, s] of bots) {
        try {
          // newsletterReactMessage is the CORRECT API for channel post reactions.
          // sendMessage({react:...}) silently does nothing for newsletter posts.
          await s.newsletterReactMessage(newsletterJid, serverId, emoji);
          reacted++;
        } catch (err) {
          console.error(`[creact] session ${sessionId} emoji ${emoji} failed:`, err.message);
          failed++;
        }
        await sleep(400);
      }
    }

    return reply(
      `╭━━━〔 📢 *CHANNEL REACT* 〕━━━⬣\n` +
      `┃\n` +
      `┃  ✅ Done!\n` +
      `┃  📌 Server ID : ${serverId}\n` +
      `┃  😀 Emojis   : ${emojis.join(' ')}\n` +
      `┃  🤖 Bots     : ${bots.length}\n` +
      `┃  ✅ Reacted  : ${reacted}\n` +
      `┃  ❌ Failed   : ${failed}\n` +
      `╰━━━━━━━━━━━━━━━━━━━━━⬣`
    );
  }
};
