const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — Utility Category
 * ─────────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "utilitytemplate",
  alias: [],
  react: "🛠️",
  desc: "Template plugin for the utility category",
  category: "utility",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────
  if (!q) return reply(`🛠️ Usage: \`.utilitytemplate <input>\``);

  const text =
    `╭─────────────────────────╮\n` +
    `│  🛠️ *Utility Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your utility command.\n` +
    `│\n` +
    `│  Input: ${q.slice(0, 60)}\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '🛠️ Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
