const { cmd } = require("../../command");
const { sendBtn, btn, navButtons } = require("../../utils/sendBtn");

/**
 * PLUGIN TEMPLATE — Owner Category
 * ─────────────────────────────────
 * Duplicate this file, rename it, and fill in your logic.
 * Set `edit: false` (or remove the field) when the command is ready to publish.
 */
cmd({
  pattern: "ownertemplate",
  alias: [],
  react: "👑",
  desc: "Template plugin for the owner category",
  category: "owner",
  edit: true,          // ← hidden from public until set to false
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply, isOwner }) => {

  // ── Your logic goes here ──────────────────────────────────────────────────
  // Tip: guard owner-only commands like this:
  // if (!isOwner) return reply("❌ Owner only command.");

  const text =
    `╭─────────────────────────╮\n` +
    `│  👑 *Owner Template*\n` +
    `│\n` +
    `│  Edit this file to build\n` +
    `│  your owner command.\n` +
    `│\n` +
    `│  Is Owner: ${isOwner ? 'Yes ✅' : 'No ❌'}\n` +
    `╰─────────────────────────╯`;

  await sendBtn(sock, from, {
    text,
    buttons: [
      btn('example_action', '👑 Example Button'),
      ...navButtons,
    ],
  }, { quoted: mek });
});
