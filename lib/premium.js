const db = require("./db");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── In-memory message buffer: chatId → [{sender, text, ts}] ─────────────────
const MESSAGE_BUFFER_MAX = 100;
const messageBuffers = new Map();

function bufferMessage(chatId, senderPhone, text) {
  if (!text || !text.trim()) return;
  if (!messageBuffers.has(chatId)) messageBuffers.set(chatId, []);
  const buf = messageBuffers.get(chatId);
  buf.push({ sender: senderPhone, text: text.trim(), ts: Date.now() });
  if (buf.length > MESSAGE_BUFFER_MAX) buf.shift();
}

function getBuffer(chatId) {
  return messageBuffers.get(chatId) || [];
}

// ── 1. Voice Note Transcription ─────────────────────────────────────────────
// Uses OpenAI Whisper (whisper-1) if OPENAI_API_KEY is set,
// otherwise Groq (which also supports whisper-large-v3).
async function transcribeAudio(audioBuffer, mimeType) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;

  const tmpFile = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
  fs.writeFileSync(tmpFile, audioBuffer);

  try {
    if (openaiKey) {
      const FormData = require("form-data");
      const form = new FormData();
      form.append("file", fs.createReadStream(tmpFile), { filename: "audio.ogg", contentType: mimeType || "audio/ogg" });
      form.append("model", "whisper-1");
      const res = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${openaiKey}` },
        timeout: 60000,
      });
      return res.data?.text || null;
    }

    if (groqKey) {
      const FormData = require("form-data");
      const form = new FormData();
      form.append("file", fs.createReadStream(tmpFile), { filename: "audio.ogg", contentType: mimeType || "audio/ogg" });
      form.append("model", "whisper-large-v3");
      form.append("response_format", "text");
      const res = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${groqKey}` },
        timeout: 60000,
      });
      return typeof res.data === "string" ? res.data.trim() : (res.data?.text || null);
    }

    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Auto-transcribe group toggle
const AUTOTRANSCRIBE_KEY = "premium_autotranscribe";

function isAutoTranscribeEnabled(groupJid) {
  const data = db.read(AUTOTRANSCRIBE_KEY, { groups: {} });
  return !!data.groups[groupJid];
}

function setAutoTranscribe(groupJid, enabled) {
  db.update(AUTOTRANSCRIBE_KEY, { groups: {} }, (data) => {
    if (enabled) data.groups[groupJid] = true;
    else delete data.groups[groupJid];
  });
}

// ── 2. Smart Reminders ───────────────────────────────────────────────────────
const REMINDERS_KEY = "premium_reminders";

function _loadReminders() {
  return db.read(REMINDERS_KEY, { list: [] }).list;
}

function _saveReminders(list) {
  db.write(REMINDERS_KEY, { list });
}

let _reminderIdCounter = Date.now();
function _nextId() { return String(++_reminderIdCounter); }

// Parse natural language time expression like "2h", "30m", "1h30m", "45s"
function parseDuration(expr) {
  expr = expr.trim().toLowerCase();
  let ms = 0;
  const hMatch = expr.match(/(\d+)\s*h/);
  const mMatch = expr.match(/(\d+)\s*m(?!s)/);
  const sMatch = expr.match(/(\d+)\s*s/);
  if (hMatch) ms += parseInt(hMatch[1]) * 3600000;
  if (mMatch) ms += parseInt(mMatch[1]) * 60000;
  if (sMatch) ms += parseInt(sMatch[1]) * 1000;
  return ms > 0 ? ms : null;
}

function addReminder(userJid, timeExpr, message) {
  const ms = parseDuration(timeExpr);
  if (!ms) return { error: `❌ Could not parse time: *${timeExpr}*\n\nExamples: \`2h\`, \`30m\`, \`1h30m\``, ms: null };
  const fireAt = Date.now() + ms;
  const id     = _nextId();
  const list   = _loadReminders();
  list.push({ id, userJid, message, fireAt, created: Date.now() });
  _saveReminders(list);
  return { id, fireAt, ms };
}

function getReminders(userJid) {
  return _loadReminders().filter(r => r.userJid === userJid);
}

function cancelReminder(userJid, id) {
  const list    = _loadReminders();
  const before  = list.length;
  const updated = list.filter(r => !(r.id === id && r.userJid === userJid));
  if (updated.length === before) return false;
  _saveReminders(updated);
  return true;
}

// Poll every 30 s — returns fired reminders (caller must send DMs and remove them)
let _reminderSock   = null;
let _reminderTimer  = null;

function startReminderScheduler(sock) {
  _reminderSock = sock;
  if (_reminderTimer) clearInterval(_reminderTimer);
  _reminderTimer = setInterval(async () => {
    const now  = Date.now();
    const list = _loadReminders();
    const due  = list.filter(r => r.fireAt <= now);
    if (!due.length) return;
    const remaining = list.filter(r => r.fireAt > now);
    _saveReminders(remaining);
    for (const r of due) {
      try {
        await _reminderSock.sendMessage(r.userJid, {
          text: `⏰ *Reminder!*\n\n${r.message}\n\n_Set via NEXUS-MD_`,
        });
      } catch (e) {
        console.error("[REMINDER] Could not send:", e.message);
      }
    }
  }, 30000);
}

function stopReminderScheduler() {
  if (_reminderTimer) { clearInterval(_reminderTimer); _reminderTimer = null; }
}

// ── 3. Catch-Up Summary ──────────────────────────────────────────────────────
async function catchUpSummary(chatId, n = 50) {
  const buf = getBuffer(chatId);
  if (!buf.length) return "📭 No recent messages buffered yet. Messages are captured as they arrive.";
  const slice = buf.slice(-Math.min(n, buf.length));
  const text  = slice.map(m => `${m.sender}: ${m.text}`).join("\n");
  const { client, provider } = _getAiClient();
  if (!client) return "⚠️ AI not configured. Add GROQ_API_KEY or OPENAI_API_KEY to enable catch-up summaries.";

  const model = _getModel(provider);
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Summarise this group chat conversation in a concise, plain-English paragraph. Focus on the main topics discussed, decisions made, and any action items. Use WhatsApp formatting: *bold* for key names/topics." },
        { role: "user",   content: `Last ${slice.length} messages:\n\n${text}` },
      ],
      max_tokens: 600,
    });
    return res.choices[0].message.content;
  } catch (err) {
    return `❌ Catch-up summary error: ${err.message}`;
  }
}

// ── 4. Image OCR ─────────────────────────────────────────────────────────────
// Uses OpenAI Vision if OPENAI_API_KEY is available, otherwise tesseract.js.
async function extractTextFromImage(imageBuffer) {
  const openaiKey = process.env.OPENAI_API_KEY;

  if (openaiKey) {
    try {
      const { OpenAI } = require("openai");
      const client = new OpenAI({ apiKey: openaiKey });
      const b64    = imageBuffer.toString("base64");
      const res    = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Extract ALL readable text from this image. Return only the text, preserving layout as much as possible. If there is no text, say 'No text found'." },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            ],
          },
        ],
        max_tokens: 1000,
      });
      return res.choices[0].message.content;
    } catch (err) {
      console.error("[OCR] OpenAI vision error:", err.message);
    }
  }

  // Fallback: tesseract.js
  try {
    const Tesseract = require("tesseract.js");
    const tmpImg = path.join(os.tmpdir(), `ocr_${Date.now()}.jpg`);
    fs.writeFileSync(tmpImg, imageBuffer);
    const { data: { text } } = await Tesseract.recognize(tmpImg, "eng", { logger: () => {} });
    fs.unlinkSync(tmpImg);
    return text.trim() || "No text found";
  } catch (err) {
    return `❌ OCR error: ${err.message}`;
  }
}

// ── 5. Group Mood Report ─────────────────────────────────────────────────────
async function groupMoodReport(groupJid, n = 50) {
  const buf   = getBuffer(groupJid);
  if (!buf.length) return { error: "📭 No recent messages buffered. Mood analysis needs some chat history." };
  const slice = buf.slice(-Math.min(n, buf.length));
  const text  = slice.map(m => `${m.sender}: ${m.text}`).join("\n");
  const { client, provider } = _getAiClient();
  if (!client) return { error: "⚠️ AI not configured. Add GROQ_API_KEY or OPENAI_API_KEY." };

  const model = _getModel(provider);
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: `Analyse the mood/sentiment of this group chat. Respond in JSON with keys: "sentiment" (one of: Positive, Neutral, Negative), "emoji" (a single fitting emoji), "reason" (one concise sentence explaining the mood). Return ONLY valid JSON, no markdown.` },
        { role: "user",   content: `Last ${slice.length} messages:\n\n${text}` },
      ],
      max_tokens: 200,
    });
    const raw = res.choices[0].message.content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return { sentiment: parsed.sentiment, emoji: parsed.emoji, reason: parsed.reason };
  } catch (err) {
    return { error: `❌ Mood analysis error: ${err.message}` };
  }
}

// ── 6. Welcome Cards (canvas-generated image) ────────────────────────────────
// Group toggle for image-based welcome
const WELCOME_CARD_KEY = "premium_welcomecards";

function isWelcomeCardEnabled(groupJid) {
  const data = db.read(WELCOME_CARD_KEY, { groups: {} });
  return !!data.groups[groupJid];
}

function setWelcomeCard(groupJid, enabled) {
  db.update(WELCOME_CARD_KEY, { groups: {} }, (data) => {
    if (enabled) data.groups[groupJid] = true;
    else delete data.groups[groupJid];
  });
}

async function generateWelcomeCard(name, groupName) {
  try {
    const sharp = require("sharp");
    const safeName  = (name  || "Friend").replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`).slice(0, 20);
    const safeGroup = (groupName || "Group").replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`).slice(0, 32);

    const svg = `
<svg width="800" height="300" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#1a1a2e"/>
      <stop offset="50%"  stop-color="#16213e"/>
      <stop offset="100%" stop-color="#0f3460"/>
    </linearGradient>
  </defs>
  <rect width="800" height="300" fill="url(#bg)" rx="16"/>
  <rect x="10" y="10" width="780" height="280" fill="none" stroke="#e94560" stroke-width="5" rx="12"/>
  <rect x="20" y="20" width="760" height="260" fill="none" stroke="rgba(233,69,96,0.25)" stroke-width="2" rx="10"/>
  <text x="60" y="120" font-family="Arial,sans-serif" font-size="64" fill="#e94560">🎉</text>
  <text x="160" y="95"  font-family="Arial Black,sans-serif" font-size="28" font-weight="900" fill="#e94560" letter-spacing="3">WELCOME</text>
  <text x="160" y="150" font-family="Arial,sans-serif" font-size="34" font-weight="bold" fill="#ffffff">${safeName}</text>
  <text x="160" y="195" font-family="Arial,sans-serif" font-size="20" fill="rgba(255,255,255,0.75)">to ${safeGroup}</text>
  <text x="160" y="255" font-family="Arial,sans-serif" font-size="15" fill="#e94560">Powered by NEXUS-MD &#x26A1;</text>
</svg>`;

    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return buf;
  } catch (err) {
    console.log("[WelcomeCard] sharp error:", err.message);
    return null;
  }
}

// ── 7. Daily Digest ──────────────────────────────────────────────────────────
const DIGEST_KEY = "premium_digest";

function _loadDigest() {
  return db.read(DIGEST_KEY, { groups: {} });
}

function isDigestEnabled(groupJid) {
  return !!_loadDigest().groups[groupJid]?.enabled;
}

function getDigestTime(groupJid) {
  return _loadDigest().groups[groupJid]?.time || "07:00";
}

function setDigest(groupJid, enabled, time) {
  db.update(DIGEST_KEY, { groups: {} }, (data) => {
    if (!data.groups[groupJid]) data.groups[groupJid] = {};
    data.groups[groupJid].enabled = enabled;
    if (time) data.groups[groupJid].time = time;
  });
}

function getAllDigestGroups() {
  const data = _loadDigest();
  return Object.entries(data.groups)
    .filter(([, v]) => v?.enabled)
    .map(([jid, v]) => ({ jid, time: v.time || "07:00" }));
}

async function fetchWeather(location) {
  try {
    const loc = location || "Nairobi";
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(loc)}?format=3`, { timeout: 10000 });
    return String(res.data).trim();
  } catch {
    return "🌤 Weather unavailable";
  }
}

async function fetchMotivationalQuote() {
  try {
    const res = await axios.get("https://api.quotable.io/random?tags=inspirational,success,wisdom", { timeout: 8000 });
    const q = res.data;
    return `"${q.content}" — _${q.author}_`;
  } catch {
    const fallback = [
      `"The secret of getting ahead is getting started." — _Mark Twain_`,
      `"Your only limit is your mind." — _Anonymous_`,
      `"Dream big, work hard, stay focused." — _Anonymous_`,
      `"Success is not final, failure is not fatal." — _Winston Churchill_`,
    ];
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
}

async function fetchNewsHeadline() {
  try {
    // GNews free public API (no key required for basic access)
    const res = await axios.get(
      "https://gnews.io/api/v4/top-headlines?category=general&lang=en&max=1" +
      (process.env.GNEWS_API_KEY ? `&apikey=${process.env.GNEWS_API_KEY}` : ""),
      { timeout: 8000 }
    );
    const article = res.data?.articles?.[0];
    if (article) return `📰 *${article.title}*\n_${article.source?.name || "News"}_`;
  } catch {}

  try {
    // Fallback: BBC News RSS (public, no key)
    const rssRes = await axios.get("https://feeds.bbci.co.uk/news/rss.xml", { timeout: 8000, responseType: "text" });
    const titleMatch = rssRes.data.match(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>/);
    if (titleMatch) return `📰 *${titleMatch[1].trim()}*\n_BBC News_`;
  } catch {}

  return "📰 News unavailable today";
}

async function buildDailyDigest(groupJid) {
  const [weather, quote, fixtures, headline] = await Promise.all([
    fetchWeather(null),
    fetchMotivationalQuote(),
    _fetchFixtureSnippet(),
    fetchNewsHeadline(),
  ]);

  const now = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

  return (
    `🌅 *Good Morning! — Daily Digest*\n` +
    `${"─".repeat(32)}\n` +
    `📅 ${now}\n\n` +
    `🌤 *Weather*\n${weather}\n\n` +
    `${headline}\n\n` +
    `⚽ *Football Today*\n${fixtures}\n\n` +
    `💡 *Quote of the Day*\n${quote}\n\n` +
    `_Stay awesome! — NEXUS-MD ⚡_`
  );
}

async function _fetchFixtureSnippet() {
  try {
    const { getFixtures } = require("./sports");
    const full = await getFixtures();
    const lines = full.split("\n").filter(l => l.trim()).slice(0, 8);
    return lines.join("\n");
  } catch {
    return "Could not fetch fixtures today.";
  }
}

// Cron scheduler for digest
let _digestCron = null;

function startDigestScheduler(sock) {
  try {
    const cron = require("node-cron");
    // Run every minute to check if any group's digest time has arrived
    if (_digestCron) _digestCron.destroy();
    _digestCron = cron.schedule("* * * * *", async () => {
      const groups = getAllDigestGroups();
      if (!groups.length) return;
      const now = new Date();
      const hh  = String(now.getHours()).padStart(2, "0");
      const mm  = String(now.getMinutes()).padStart(2, "0");
      const cur = `${hh}:${mm}`;

      for (const g of groups) {
        if (g.time !== cur) continue;
        try {
          const msg = await buildDailyDigest(g.jid);
          await sock.sendMessage(g.jid, { text: msg });
        } catch (e) {
          console.error("[DIGEST] Send error:", e.message);
        }
      }
    });
    console.log("📰 Daily Digest scheduler started.");
  } catch (e) {
    console.error("[DIGEST] node-cron not available:", e.message);
  }
}

function stopDigestScheduler() {
  if (_digestCron) { _digestCron.destroy(); _digestCron = null; }
}

// ── Internal AI client helpers (avoid re-importing full ai module's internals) ─
function _getAiClient() {
  if (process.env.XAI_API_KEY) {
    const { OpenAI } = require("openai");
    return { client: new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: "https://api.x.ai/v1" }), provider: "xai" };
  }
  if (process.env.GROQ_API_KEY) {
    const Groq = require("groq-sdk");
    return { client: new Groq({ apiKey: process.env.GROQ_API_KEY }), provider: "groq" };
  }
  if (process.env.OPENAI_API_KEY) {
    const { OpenAI } = require("openai");
    return { client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), provider: "openai" };
  }
  return { client: null, provider: null };
}

function _getModel(provider) {
  if (provider === "xai")    return "grok-3-mini";
  if (provider === "groq")   return "llama3-70b-8192";
  if (provider === "openai") return "gpt-4o-mini";
  return "grok-3-mini";
}

module.exports = {
  bufferMessage,
  getBuffer,
  transcribeAudio,
  isAutoTranscribeEnabled,
  setAutoTranscribe,
  addReminder,
  getReminders,
  cancelReminder,
  startReminderScheduler,
  stopReminderScheduler,
  catchUpSummary,
  extractTextFromImage,
  groupMoodReport,
  isWelcomeCardEnabled,
  setWelcomeCard,
  generateWelcomeCard,
  isDigestEnabled,
  getDigestTime,
  setDigest,
  buildDailyDigest,
  startDigestScheduler,
  stopDigestScheduler,
};
