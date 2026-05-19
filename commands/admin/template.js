const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — Admin Category
 * ─────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "admintemplate",
  alias: [],
  react: "🛡️",
  desc: "Template plugin for the admin category",
  category: "admin",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply, isGroup, isAdmin, isBotAdmin }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────
  // isGroup    — true when sent in a group
  // isAdmin    — true when sender is group admin
  // isBotAdmin — true when bot is group admin

  const text =
    `╭─────────────────────────╮\n` +
    `│  🛡️ *Admin Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your admin command.\n` +
    `│\n` +
    `│  Group:    ${isGroup ? 'Yes' : 'No'}\n` +
    `│  Is Admin: ${isAdmin ? 'Yes' : 'No'}\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '🛡️ Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
