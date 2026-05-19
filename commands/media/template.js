const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — Media Category
 * ─────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "mediatemplate",
  alias: [],
  react: "🎬",
  desc: "Template plugin for the media category",
  category: "media",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────

  const text =
    `╭─────────────────────────╮\n` +
    `│  🎬 *Media Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your media command.\n` +
    `│\n` +
    `│  Query: ${q || '(none)'}\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '▶️ Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
