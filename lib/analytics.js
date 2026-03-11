const db = require("./db");

async function trackMessage(jid, command = null) {
  await db.trackEvent(jid, command ? "command" : "message", command);
}

async function getStats() {
  const pgStats = await db.getAnalyticsStats();
  if (pgStats) return pgStats;
  return {
    totalMessages: 0,
    totalCommands: 0,
    uniqueUsers: 0,
    topCommands: [],
    hourlyStats: [],
    recentActivity: [],
  };
}

async function getTopCommands(n = 10) {
  const stats = await getStats();
  return (stats.topCommands || []).slice(0, n);
}

async function getHourlyChart() {
  const stats = await getStats();
  return stats.hourlyStats || [];
}

async function formatStatsMessage() {
  const stats = await getStats();
  const uptimeMs = process.uptime() * 1000;
  const uptime = Math.floor(uptimeMs / 1000 / 60);
  const topCmds = (stats.topCommands || []).slice(0, 5);

  let msg = `📊 *Bot Analytics*\n\n`;
  msg += `📨 Total Messages: *${stats.totalMessages}*\n`;
  msg += `⚙️ Commands Used: *${stats.totalCommands}*\n`;
  msg += `👥 Unique Users: *${stats.uniqueUsers}*\n`;
  msg += `⏱ Uptime: *${uptime} minutes*\n\n`;

  if (topCmds.length > 0) {
    msg += `🏆 *Top Commands:*\n`;
    topCmds.forEach(([cmd, count], i) => {
      msg += `${i + 1}. ${cmd}: ${count} uses\n`;
    });
  }

  return msg;
}

module.exports = { trackMessage, getStats, getTopCommands, getHourlyChart, formatStatsMessage };
