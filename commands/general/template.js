const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — General Category
 * ─────────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "generaltemplate",
  alias: [],
  react: "💡",
  desc: "Template plugin for the general category",
  category: "general",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────

  const text =
    `╭─────────────────────────╮\n` +
    `│  💡 *General Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your general command.\n` +
    `│\n` +
    `│  Sender: ${String(sender).split('@')[0]}\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '💡 Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
