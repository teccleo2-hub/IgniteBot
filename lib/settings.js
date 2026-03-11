const db = require("./datastore");
const fs = require("fs");
const path = require("path");

const config = require("../config");

const DEFAULTS = {
  mode:             "public",
  prefix:           config.prefix,
  prefixless:       false,
  autoTyping:       true,
  typingDelay:      true,
  autoRecording:    true,
  autoViewStatus:   false,
  autoLikeStatus:   false,
  alwaysOnline:     false,
  antiCall:         false,
  antiDeleteStatus: false,
  autoReadMessages: true,
  voReveal:         false,
  menuVideoPath:    null,
  language:         "en",
};

// Bootstrap — write every default key into the DB if it isn't already there.
// Called once after DB is ready so all settings are always persisted.
function initSettings() {
  db.update("settings", DEFAULTS, (data) => {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (!(k in data)) data[k] = v;
    }
  });
}

function get(key) {
  const data = db.read("settings", DEFAULTS);
  return key in data ? data[key] : DEFAULTS[key];
}

function set(key, value) {
  db.update("settings", DEFAULTS, (data) => {
    data[key] = value;
  });
}

function getAll() {
  return db.read("settings", DEFAULTS);
}

function toggle(key) {
  const current = get(key);
  set(key, !current);
  return !current;
}

function setMenuVideo(buffer) {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "menu_video.mp4");
  fs.writeFileSync(filePath, buffer);
  set("menuVideoPath", filePath);
  return filePath;
}

function getMenuVideo() {
  const filePath = get("menuVideoPath");
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function clearMenuVideo() {
  const filePath = get("menuVideoPath");
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
  set("menuVideoPath", null);
}

function setMenuImage(buffer) {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "menu_image.jpg");
  fs.writeFileSync(filePath, buffer);
  set("menuImagePath", filePath);
  return filePath;
}

function getMenuImage() {
  const customPath = get("menuImagePath");
  if (customPath && fs.existsSync(customPath)) return fs.readFileSync(customPath);
  const defaultPath = path.join(process.cwd(), "data", "menu_image.jpg");
  if (fs.existsSync(defaultPath)) return fs.readFileSync(defaultPath);
  return null;
}

function clearMenuImage() {
  const filePath = get("menuImagePath");
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
  set("menuImagePath", null);
}

function setMenuSong(buffer) {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "menu_song.mp3");
  fs.writeFileSync(filePath, buffer);
  set("menuSongPath", filePath);
  return filePath;
}

function getMenuSong() {
  const customPath = get("menuSongPath");
  if (customPath && fs.existsSync(customPath)) return fs.readFileSync(customPath);
  return null;
}

function clearMenuSong() {
  const filePath = get("menuSongPath");
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
  set("menuSongPath", null);
}

function formatSettingsMessage() {
  const s = getAll();
  const on  = (v) => v ? "✅ ON" : "❌ OFF";
  const modeIcon = s.mode === "public" ? "🌍" : s.mode === "private" ? "🔒" : "👥";

  return (
    `⚙️ *Bot Settings — Nexus V2*\n\n` +
    `${modeIcon} *Mode:* ${s.mode.toUpperCase()}\n` +
    `🤖 *Prefix:* \`${s.prefix || "."}\`\n` +
    `🌐 *Language:* ${s.language || "en"}\n\n` +
    `⌨️ *Auto Typing:* ${on(s.autoTyping)}\n` +
    `🎤 *Auto Recording:* ${on(s.autoRecording)}\n` +
    `⏱ *Typing Delay:* ${on(s.typingDelay)}\n` +
    `📌 *Prefixless:* ${on(s.prefixless)}\n\n` +
    `👁 *Auto View Status:* ${on(s.autoViewStatus)}\n` +
    `❤️ *Auto Like Status:* ${on(s.autoLikeStatus)}\n` +
    `🟢 *Always Online:* ${on(s.alwaysOnline)}\n` +
    `📖 *Auto Read Messages:* ${on(s.autoReadMessages)}\n` +
    `📵 *Anti Call:* ${on(s.antiCall)}\n` +
    `🗑 *Anti Delete Status:* ${on(s.antiDeleteStatus)}\n` +
    `👁 *Auto Reveal View-Once:* ${on(s.voReveal)}\n` +
    `🎬 *Menu Video:* ${s.menuVideoPath ? "✅ Set" : "❌ Not set"}\n\n` +
    `_Use \`${s.prefix || "."}feature [name] on/off\` to toggle_`
  );
}

module.exports = { get, set, toggle, getAll, initSettings, setMenuVideo, getMenuVideo, clearMenuVideo, setMenuImage, getMenuImage, clearMenuImage, setMenuSong, getMenuSong, clearMenuSong, formatSettingsMessage };
