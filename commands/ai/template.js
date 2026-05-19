const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — AI Category
 * ─────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "aitemplate",
  alias: [],
  react: "🤖",
  desc: "Template plugin for the AI category",
  category: "ai",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────
  if (!q) return reply(`💡 Usage: \`.aitemplate <your prompt>\``);

  const text =
    `╭─────────────────────────╮\n` +
    `│  🤖 *AI Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your AI command.\n` +
    `│\n` +
    `│  Prompt: ${q.slice(0, 60)}\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '🤖 Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
