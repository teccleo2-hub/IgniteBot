/**
 * Platform detector for NEXUS-MD
 * Detects the deployment environment and returns platform-specific settings.
 */

const os = require("os");

function detect() {
  if (process.env.DYNO && process.env.HEROKU_APP_NAME)
    return { name: "Heroku",      icon: "🟣", isSleepy: true,  fastMode: true,  isPanel: false, printQR: false };
  if (process.env.DYNO)
    return { name: "Heroku",      icon: "🟣", isSleepy: true,  fastMode: true,  isPanel: false, printQR: false };
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL)
    return { name: "Railway",     icon: "🚄", isSleepy: false, fastMode: true,  isPanel: false, printQR: false };
  if (process.env.RENDER_SERVICE_NAME || process.env.RENDER)
    return { name: "Render",      icon: "🔵", isSleepy: true,  fastMode: true,  isPanel: false, printQR: false };
  if (process.env.KOYEB_APP || process.env.KOYEB)
    return { name: "Koyeb",       icon: "🟤", isSleepy: false, fastMode: true,  isPanel: false, printQR: false };
  if (process.env.FLY_APP_NAME)
    return { name: "Fly.io",      icon: "🪰", isSleepy: false, fastMode: true,  isPanel: false, printQR: false };
  if (process.env.REPL_ID || process.env.REPLIT_DB_URL)
    return { name: "Replit",      icon: "🔶", isSleepy: true,  fastMode: true,  isPanel: false, printQR: false };
  if (process.env.CODESPACE_NAME || process.env.GITPOD_WORKSPACE_ID)
    return { name: "Dev Cloud",   icon: "☁️", isSleepy: true,  fastMode: false, isPanel: false, printQR: true  };
  // Pterodactyl Panel (most popular bot hosting panel)
  if (process.env.P_SERVER_UUID || process.env.SERVER_UUID)
    return { name: "Pterodactyl", icon: "🦅", isSleepy: false, fastMode: true,  isPanel: true,  printQR: true  };
  // VPS / bare-metal / cPanel / other panels
  return   { name: "VPS/Panel",   icon: "🖥️", isSleepy: false, fastMode: true,  isPanel: true,  printQR: true  };
}

let _platform = null;

function get() {
  if (!_platform) _platform = detect();
  return _platform;
}

function logStartup() {
  const p = get();
  const mem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  console.log(`🌍 Platform  : ${p.icon} ${p.name}${p.isPanel ? " (panel mode)" : ""}`);
  console.log(`⚡ Fast mode : ${p.fastMode ? "ON" : "OFF"} | QR in terminal: ${p.printQR ? "YES" : "NO"}`);
  console.log(`💾 System RAM: ${mem} GB | Node ${process.version}`);
}

module.exports = { get, detect, logStartup };
