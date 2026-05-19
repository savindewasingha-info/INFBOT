const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — Converter Category
 * ─────────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "convertertemplate",
  alias: [],
  react: "🔄",
  desc: "Template plugin for the converter category",
  category: "converter",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply, quoted }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────
  // `quoted` contains the replied-to message (e.g. an image/video/audio)

  const text =
    `╭─────────────────────────╮\n` +
    `│  🔄 *Converter Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your converter command.\n` +
    `│\n` +
    `│  Reply to media and run\n` +
    `│  this command to convert.\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '🔄 Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
