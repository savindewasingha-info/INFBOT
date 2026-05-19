const { cmd } = require("../../command");
const { getStatus, getLog } = require("../../utils/apiHealth");

cmd({
  pattern: "apistatus",
  alias: ["apihealth", "checkapis"],
  react: "🔍",
  desc: "Show live status of all download APIs (circuit breaker health)",
  category: "admin",
  filename: __filename
}, async (sock, mek, m, { from, reply, sender, isOwner }) => {
  const status = getStatus();

  if (!status.length) {
    return reply(
      `╭─────────────────────────╮\n` +
      `│  📊 *API Health Status*\n` +
      `│\n` +
      `│  ℹ️ No API calls tracked yet.\n` +
      `│  Use .song, .yt, .play etc to\n` +
      `│  populate health data.\n` +
      `╰─────────────────────────╯`
    );
  }

  const alive = status.filter(s => s.icon === '✅');
  const dead  = status.filter(s => s.icon === '❌');
  const recov = status.filter(s => s.icon === '🔄');

  let msg =
    `╭─────────────────────────╮\n` +
    `│  📊 *API Health Status*\n` +
    `│\n` +
    `│  ✅ Live: ${alive.length}  ❌ Dead: ${dead.length}  🔄 Recovering: ${recov.length}\n` +
    `│\n`;

  for (const s of status) {
    const name = s.name.replace(/_/g, ' ').padEnd(22);
    msg += `│  ${s.icon} ${name}  ${s.since}\n`;
  }

  msg += `│\n`;

  const recentLog = getLog().slice(0, 5);
  if (recentLog.length) {
    msg += `│  📋 *Recent Events:*\n`;
    for (const entry of recentLog) {
      const t = new Date(entry.ts).toTimeString().slice(0, 8);
      msg += `│  ${t} ${entry.msg.slice(0, 40)}\n`;
    }
    msg += `│\n`;
  }

  msg += `╰─────────────────────────╯`;
  await reply(msg);
});
