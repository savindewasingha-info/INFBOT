const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — Fun Category
 * ─────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "funtemplate",
  alias: [],
  react: "🎮",
  desc: "Template plugin for the fun category",
  category: "fun",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────

  const text =
    `╭─────────────────────────╮\n` +
    `│  🎮 *Fun Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your fun command.\n` +
    `│\n` +
    `│  Make it entertaining! 🎉\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '🎮 Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
