const express = require("express");
const router = express.Router();
const analytics = require("../lib/analytics");
const { getProducts } = require("../lib/store");
const { getAllBookings } = require("../lib/booking");
const { getBroadcastHistory } = require("../lib/broadcast");

router.get("/dashboard", (req, res) => {
  res.send(getDashboardHTML());
});

router.get("/api/stats", async (req, res) => {
  const stats = await analytics.getStats();
  const topCommands = await analytics.getTopCommands(10);
  const hourly = await analytics.getHourlyChart();
  res.json({ stats, topCommands, hourly });
});

router.get("/api/products", (req, res) => {
  res.json(getProducts());
});

router.get("/api/bookings", (req, res) => {
  res.json(getAllBookings().slice(0, 20));
});

router.get("/api/broadcasts", (req, res) => {
  res.json(getBroadcastHistory());
});

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IgniteBot Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 32px;display:flex;align-items:center;gap:12px}
.header h1{font-size:1.4rem;color:#58a6ff}
.header .status{font-size:0.8rem;background:#1f6feb;color:#fff;border-radius:12px;padding:3px 10px}
.container{max-width:1200px;margin:0 auto;padding:24px 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px}
.card h3{font-size:0.78rem;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.card .value{font-size:2rem;font-weight:700;color:#58a6ff}
.card .sub{font-size:0.8rem;color:#8b949e;margin-top:4px}
.section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:20px}
.section h2{font-size:1rem;color:#e6edf3;margin-bottom:16px;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:0.78rem;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;padding:8px 12px;border-bottom:1px solid #30363d}
td{padding:10px 12px;border-bottom:1px solid #21262d;font-size:0.9rem}
tr:last-child td{border-bottom:none}
.bar{height:8px;background:#1f6feb;border-radius:4px;margin-top:4px}
.badge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:0.75rem;font-weight:600}
.badge.confirmed{background:#1a3a2a;color:#3fb950}
.badge.pending{background:#3a2f0b;color:#d29922}
.badge.cancelled{background:#3a1a1a;color:#f85149}
.refresh{font-size:0.8rem;color:#8b949e;float:right}
</style>
</head>
<body>
<div class="header">
  <span style="font-size:1.5rem">⚡</span>
  <h1>IgniteBot Dashboard</h1>
  <span class="status">LIVE</span>
  <span class="refresh" id="lastUpdate"></span>
</div>
<div class="container">
  <div class="grid" id="statsGrid">
    <div class="card"><h3>📨 Total Messages</h3><div class="value" id="totalMessages">-</div><div class="sub">All time</div></div>
    <div class="card"><h3>⚙️ Commands Used</h3><div class="value" id="totalCommands">-</div><div class="sub">All time</div></div>
    <div class="card"><h3>👥 Unique Users</h3><div class="value" id="uniqueUsers">-</div><div class="sub">Distinct contacts</div></div>
    <div class="card"><h3>⏱ Uptime</h3><div class="value" id="uptime">-</div><div class="sub">Minutes running</div></div>
  </div>

  <div class="section">
    <h2>📈 Activity (Last 24 Hours)</h2>
    <canvas id="chart" height="60" style="width:100%"></canvas>
    <div id="chartBars" style="display:flex;gap:4px;align-items:flex-end;height:60px;margin-top:8px"></div>
    <div id="chartLabels" style="display:flex;gap:4px;margin-top:4px;font-size:0.7rem;color:#8b949e"></div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
    <div class="section">
      <h2>🏆 Top Commands</h2>
      <table>
        <thead><tr><th>Command</th><th>Uses</th><th>Bar</th></tr></thead>
        <tbody id="commandTable"></tbody>
      </table>
    </div>
    <div class="section">
      <h2>🕐 Recent Activity</h2>
      <table>
        <thead><tr><th>Time</th><th>User</th><th>Action</th></tr></thead>
        <tbody id="activityTable"></tbody>
      </table>
    </div>
  </div>

  <div class="section" style="margin-top:20px">
    <h2>📅 Recent Bookings</h2>
    <table>
      <thead><tr><th>#</th><th>Service</th><th>Date</th><th>Time</th><th>Status</th></tr></thead>
      <tbody id="bookingsTable"></tbody>
    </table>
  </div>

  <div class="section" style="margin-top:20px">
    <h2>📢 Broadcast History</h2>
    <table>
      <thead><tr><th>Message</th><th>Sent</th><th>Failed</th><th>Time</th></tr></thead>
      <tbody id="broadcastTable"></tbody>
    </table>
  </div>
</div>

<script>
async function load() {
  try {
    const [stats, bookings, broadcasts] = await Promise.all([
      fetch('/api/stats').then(r=>r.json()),
      fetch('/api/bookings').then(r=>r.json()),
      fetch('/api/broadcasts').then(r=>r.json()),
    ]);

    const s = stats.stats;
    const uptime = Math.floor((Date.now() - new Date(s.startTime).getTime()) / 60000);
    document.getElementById('totalMessages').textContent = s.totalMessages || 0;
    document.getElementById('totalCommands').textContent = s.totalCommands || 0;
    document.getElementById('uniqueUsers').textContent = (s.uniqueUsers||[]).length;
    document.getElementById('uptime').textContent = uptime;
    document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date().toLocaleTimeString();

    const topCmds = stats.topCommands;
    const maxVal = topCmds.length ? topCmds[0][1] : 1;
    const cmdHtml = topCmds.map(([cmd,count]) =>
      \`<tr><td>\${cmd}</td><td><b>\${count}</b></td><td><div class="bar" style="width:\${(count/maxVal*100)}%"></div></td></tr>\`
    ).join('');
    document.getElementById('commandTable').innerHTML = cmdHtml || '<tr><td colspan="3" style="color:#8b949e">No commands yet</td></tr>';

    const recent = (s.recentActivity||[]).slice(0,10);
    const actHtml = recent.map(a =>
      \`<tr><td style="color:#8b949e">\${new Date(a.time).toLocaleTimeString()}</td><td>\${a.user}</td><td>\${a.action}</td></tr>\`
    ).join('');
    document.getElementById('activityTable').innerHTML = actHtml || '<tr><td colspan="3" style="color:#8b949e">No activity yet</td></tr>';

    const hourly = stats.hourly;
    const maxH = hourly.length ? Math.max(...hourly.map(h=>h[1]),1) : 1;
    const bars = document.getElementById('chartBars');
    const labels = document.getElementById('chartLabels');
    bars.innerHTML = hourly.map(([h,c]) =>
      \`<div style="flex:1;background:#1f6feb;height:\${Math.max(4,(c/maxH)*56)}px;border-radius:4px 4px 0 0;title='\${h}:\${c}'"></div>\`
    ).join('');
    labels.innerHTML = hourly.map(([h]) =>
      \`<div style="flex:1;text-align:center">\${h.slice(11)}h</div>\`
    ).join('');

    const bkHtml = bookings.slice(0,10).map(b =>
      \`<tr><td>#\${b.id}</td><td>\${b.service}</td><td>\${b.date}</td><td>\${b.time}</td><td><span class="badge \${b.status}">\${b.status}</span></td></tr>\`
    ).join('');
    document.getElementById('bookingsTable').innerHTML = bkHtml || '<tr><td colspan="5" style="color:#8b949e">No bookings yet</td></tr>';

    const brHtml = broadcasts.slice(0,5).map(b =>
      \`<tr><td>\${b.message}...</td><td style="color:#3fb950">\${b.sent}</td><td style="color:#f85149">\${b.failed}</td><td style="color:#8b949e">\${new Date(b.time).toLocaleString()}</td></tr>\`
    ).join('');
    document.getElementById('broadcastTable').innerHTML = brHtml || '<tr><td colspan="4" style="color:#8b949e">No broadcasts yet</td></tr>';
  } catch(e) { console.error(e); }
}
load();
setInterval(load, 10000);
</script>
</body>
</html>`;
}

module.exports = router;
