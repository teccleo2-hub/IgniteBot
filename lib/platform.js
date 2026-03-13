/**
 * Platform detector for NEXUS-MD
 * Detects the deployment environment and returns platform-specific settings.
 */

const os = require("os");

function detect() {
  if (process.env.DYNO && process.env.HEROKU_APP_NAME)
    return { name: "Heroku",   icon: "🟣", isSleepy: true,  fastMode: true };
  if (process.env.DYNO)
    return { name: "Heroku",   icon: "🟣", isSleepy: true,  fastMode: true };
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL)
    return { name: "Railway",  icon: "🚄", isSleepy: false, fastMode: true };
  if (process.env.RENDER_SERVICE_NAME || process.env.RENDER)
    return { name: "Render",   icon: "🔵", isSleepy: true,  fastMode: true };
  if (process.env.KOYEB_APP || process.env.KOYEB)
    return { name: "Koyeb",    icon: "🟤", isSleepy: false, fastMode: true };
  if (process.env.FLY_APP_NAME)
    return { name: "Fly.io",   icon: "🪰", isSleepy: false, fastMode: true };
  if (process.env.REPL_ID || process.env.REPLIT_DB_URL)
    return { name: "Replit",   icon: "🔶", isSleepy: true,  fastMode: false };
  if (process.env.CODESPACE_NAME || process.env.GITPOD_WORKSPACE_ID)
    return { name: "Dev Cloud", icon: "☁️", isSleepy: true, fastMode: false };
  return { name: "VPS/Local", icon: "🖥️", isSleepy: false, fastMode: false };
}

let _platform = null;

function get() {
  if (!_platform) _platform = detect();
  return _platform;
}

function logStartup() {
  const p = get();
  const mem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  console.log(`🌍 Platform  : ${p.icon} ${p.name}`);
  console.log(`⚡ Fast mode : ${p.fastMode ? "ON (commands fire without delay)" : "OFF"}`);
  console.log(`💾 System RAM: ${mem} GB | Node ${process.version}`);
}

module.exports = { get, detect, logStartup };
