/**
 * Infinity MD — Button Utility
 * Wraps gifted-btns sendButtons for easy reuse across commands.
 */

const { sendButtons } = require('gifted-btns');
const config = require('../config');

const CHANNEL_URL      = 'https://infinitymd.online';
const FTGM_CHANNEL_URL = 'https://whatsapp.com/channel/0029VbAVaylCnA7pF6IP0R46';
const NEW_CHANNEL_URL  = 'https://whatsapp.com/channel/0029VbBsHC3CMY0GEudWpg1m';
const FTGM_TOOLS_URL   = 'https://ftgmtools.pages.dev';
const GITHUB_URL       = config.social?.github || 'https://github.com/mruniquehacker';
const YT_URL           = config.social?.youtube || 'https://youtube.com/@mr_unique_hacker';

/** Quick-reply button */
function btn(id, text) {
  return { id, text };
}

/** URL button */
function urlBtn(displayText, url) {
  return {
    name: 'cta_url',
    buttonParamsJson: JSON.stringify({ display_text: displayText, url })
  };
}

/** Copy-to-clipboard button */
function copyBtn(displayText, copyCode) {
  return {
    name: 'cta_copy',
    buttonParamsJson: JSON.stringify({ display_text: displayText, copy_code: copyCode })
  };
}

/** Call button */
function callBtn(displayText, phoneNumber) {
  return {
    name: 'cta_call',
    buttonParamsJson: JSON.stringify({ display_text: displayText, phone_number: phoneNumber })
  };
}

/** Standard nav buttons: Menu + Website */
const navButtons = [
  btn('cmd_menu', '📋 Main Menu'),
  urlBtn('🌐 Website', CHANNEL_URL),
];

/** Standard nav buttons with GitHub */
const devButtons = [
  btn('cmd_menu', '📋 Main Menu'),
  urlBtn('📂 Source Code', GITHUB_URL),
  urlBtn('🌐 Website', CHANNEL_URL),
];

/**
 * Send a button message.
 * @param {object} sock - Baileys socket
 * @param {string} jid - Chat JID
 * @param {object} opts - { title?, text, footer?, image?, buttons }
 * @param {object} sendOpts - { quoted?, ... }
 */
async function sendBtn(sock, jid, opts, sendOpts = {}) {
  return sendButtons(sock, jid, {
    footer: opts.footer || `> ♾️ *${config.botName}*`,
    ...opts,
  }, sendOpts);
}

module.exports = { btn, urlBtn, callBtn, copyBtn, sendBtn, navButtons, devButtons, CHANNEL_URL, FTGM_CHANNEL_URL, NEW_CHANNEL_URL, FTGM_TOOLS_URL, GITHUB_URL, YT_URL };
