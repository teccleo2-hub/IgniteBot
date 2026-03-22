const fs   = require("fs");
const path = require("path");

const cache = new Map();
let pool = null;
let ready = false;
let dbAvailable = false;

// ── Local-file fallback (panels / VPS with no DATABASE_URL) ──────────────────
// When no PostgreSQL is configured we persist the key-value store to a JSON
// file so settings, session metadata, and other state survive process restarts
// on platforms with a persistent filesystem (Pterodactyl, cPanel, VPS, …).
const LOCAL_STORE_PATH = path.join(process.cwd(), "data", "botstore.json");
let localPersistEnabled = false;
let localSaveTimer = null;

function _loadLocalStore() {
  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, "utf8"));
      for (const [k, v] of Object.entries(raw)) cache.set(k, v);
      console.log(`🗄️  Local store loaded — ${Object.keys(raw).length} records from botstore.json`);
    }
  } catch (e) {
    console.log("⚠️  Could not load local store:", e.message);
  }
}

function _scheduleSave() {
  if (localSaveTimer) return;
  localSaveTimer = setTimeout(() => {
    localSaveTimer = null;
    const obj = {};
    // Skip binary blobs (base64 > 200 KB) — menu video lives in data/ as a file anyway
    for (const [k, v] of cache.entries()) {
      const str = JSON.stringify(v);
      if (str.length < 200_000) obj[k] = v;
    }
    try {
      fs.mkdirSync(path.dirname(LOCAL_STORE_PATH), { recursive: true });
      fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(obj));
    } catch {}
  }, 300); // batch writes — flush 300 ms after last change
}

async function init() {
  if (ready) return;

  if (!process.env.DATABASE_URL) {
    localPersistEnabled = true;
    _loadLocalStore();
    console.log("🗄️  No DATABASE_URL — using local file storage (data/botstore.json)");
    ready = true;
    return;
  }

  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: !process.env.DATABASE_URL.includes("localhost") && !process.env.DATABASE_URL.includes("127.0.0.1")
        ? { rejectUnauthorized: false }
        : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 4000,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_data (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bot_analytics (
        id SERIAL PRIMARY KEY,
        jid TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bot_messages (
        id         SERIAL PRIMARY KEY,
        sender_jid TEXT NOT NULL,
        group_jid  TEXT,
        msg_type   TEXT NOT NULL DEFAULT 'text',
        body       TEXT,
        is_command BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_created  ON bot_analytics(created_at);
      CREATE INDEX IF NOT EXISTS idx_analytics_jid      ON bot_analytics(jid);
      CREATE INDEX IF NOT EXISTS idx_analytics_command  ON bot_analytics(command) WHERE command IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_sender    ON bot_messages(sender_jid);
      CREATE INDEX IF NOT EXISTS idx_messages_group     ON bot_messages(group_jid);
      CREATE INDEX IF NOT EXISTS idx_messages_created   ON bot_messages(created_at);
    `);

    const { rows } = await pool.query("SELECT key, value FROM bot_data");
    for (const row of rows) {
      cache.set(row.key, row.value);
    }

    dbAvailable = true;
    ready = true;
    console.log(`🗄️  PostgreSQL connected — loaded ${rows.length} data records`);
  } catch (err) {
    console.log(`🗄️  PostgreSQL unavailable (${err.message.split("\n")[0]}) — using in-memory storage`);
    pool = null;
    dbAvailable = false;
    ready = true;
  }
}

function _persist(name, data) {
  if (!dbAvailable || !pool) return;
  pool.query(
    `INSERT INTO bot_data (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [name, JSON.stringify(data)]
  ).catch(() => {});
}

// Awaitable version of _persist — use in SIGTERM/shutdown paths where you need
// to guarantee the write completes before process.exit().
async function persistNow(name, data) {
  cache.set(name, data);
  if (localPersistEnabled) {
    const obj = {};
    for (const [k, v] of cache.entries()) {
      const str = JSON.stringify(v);
      if (str.length < 200_000) obj[k] = v;
    }
    try {
      fs.mkdirSync(path.dirname(LOCAL_STORE_PATH), { recursive: true });
      fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(obj));
    } catch {}
    return;
  }
  if (!dbAvailable || !pool) return;
  try {
    await pool.query(
      `INSERT INTO bot_data (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [name, JSON.stringify(data)]
    );
  } catch {}
}

function read(name, defaults = {}) {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(JSON.stringify(defaults)));
  }
  return cache.get(name);
}

function write(name, data) {
  cache.set(name, data);
  if (localPersistEnabled) _scheduleSave();
  else _persist(name, data);
}

function update(name, defaults, updater) {
  const data = read(name, defaults);
  updater(data);
  write(name, data);
}

async function trackEvent(jid, action, command = null) {
  if (!dbAvailable || !pool) return;
  pool.query(
    "INSERT INTO bot_analytics (jid, action, command) VALUES ($1, $2, $3)",
    [jid, action, command]
  ).catch(() => {});
}

function logMessage(senderJid, groupJid, msgType, body, isCommand) {
  if (!dbAvailable || !pool) return;
  const safeBody = body ? body.slice(0, 2000) : null;
  pool.query(
    `INSERT INTO bot_messages (sender_jid, group_jid, msg_type, body, is_command)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      senderJid || "unknown",
      groupJid  || null,
      msgType   || "text",
      safeBody,
      isCommand === true,
    ]
  ).catch(() => {});
}

async function getMessageStats() {
  if (!dbAvailable || !pool) return null;
  try {
    const [totals, topSenders, byType, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_command) AS commands,
                         COUNT(DISTINCT sender_jid) AS unique_users,
                         COUNT(DISTINCT group_jid) FILTER (WHERE group_jid IS NOT NULL) AS active_groups
                  FROM bot_messages`),
      pool.query(`SELECT sender_jid, COUNT(*) AS cnt FROM bot_messages
                  GROUP BY sender_jid ORDER BY cnt DESC LIMIT 10`),
      pool.query(`SELECT msg_type, COUNT(*) AS cnt FROM bot_messages
                  GROUP BY msg_type ORDER BY cnt DESC`),
      pool.query(`SELECT sender_jid, group_jid, msg_type, body, is_command, created_at
                  FROM bot_messages ORDER BY created_at DESC LIMIT 20`),
    ]);
    return {
      total:        parseInt(totals.rows[0].total),
      commands:     parseInt(totals.rows[0].commands),
      uniqueUsers:  parseInt(totals.rows[0].unique_users),
      activeGroups: parseInt(totals.rows[0].active_groups),
      topSenders:   topSenders.rows.map(r => ({ jid: r.sender_jid.split("@")[0], count: parseInt(r.cnt) })),
      byType:       byType.rows.map(r => ({ type: r.msg_type, count: parseInt(r.cnt) })),
      recent:       recent.rows,
    };
  } catch {
    return null;
  }
}

async function getAnalyticsStats() {
  if (!dbAvailable || !pool) return null;
  try {
    const [totals, topCmds, uniqueUsers, hourly, recent] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total_messages, COUNT(command) AS total_commands FROM bot_analytics"),
      pool.query(`SELECT command, COUNT(*) AS cnt FROM bot_analytics WHERE command IS NOT NULL GROUP BY command ORDER BY cnt DESC LIMIT 10`),
      pool.query("SELECT COUNT(DISTINCT jid) AS unique_users FROM bot_analytics"),
      pool.query(`SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24') AS hour, COUNT(*) AS cnt FROM bot_analytics WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY hour ORDER BY hour`),
      pool.query(`SELECT jid, action, command, created_at FROM bot_analytics ORDER BY created_at DESC LIMIT 50`),
    ]);
    return {
      totalMessages: parseInt(totals.rows[0].total_messages),
      totalCommands: parseInt(totals.rows[0].total_commands),
      uniqueUsers: parseInt(uniqueUsers.rows[0].unique_users),
      topCommands: topCmds.rows.map((r) => [r.command, parseInt(r.cnt)]),
      hourlyStats: hourly.rows.map((r) => [r.hour, parseInt(r.cnt)]),
      recentActivity: recent.rows.map((r) => ({
        time: r.created_at,
        user: r.jid.split("@")[0],
        action: r.command || r.action,
      })),
    };
  } catch {
    return null;
  }
}

module.exports = { init, read, write, update, persistNow, trackEvent, logMessage, getMessageStats, getAnalyticsStats };
