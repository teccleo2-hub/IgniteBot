const db = require("./db");

const TILL_NUMBER = process.env.MPESA_TILL || "7894520";
const BINGWA_URL  = process.env.BINGWA_URL  || "https://bingwa-sigma.vercel.app";

const DEFAULT_PACKAGES = {
  safaricom: {
    bingwaData: [
      { code: "BWA-1", name: "250MBs",       price: 20,  validity: "24 Hours",      label: "Bingwa 250MB" },
      { code: "BWA-2", name: "1GB",           price: 19,  validity: "1 Hour",        label: "Bingwa 1GB" },
      { code: "BWA-3", name: "1.5GB",         price: 49,  validity: "3 Hours",       label: "Bingwa 1.5GB" },
      { code: "BWA-4", name: "350MBs",        price: 50,  validity: "7 Days",        label: "Bingwa 350MB Weekly" },
      { code: "BWA-5", name: "2.5GB",         price: 300, validity: "7 Days",        label: "Bingwa 2.5GB Weekly" },
      { code: "BWA-6", name: "6GB",           price: 700, validity: "7 Days",        label: "Bingwa 6GB Weekly" },
    ],
    minutes: [
      { code: "MIN-1", name: "45 Mins",       price: 23,  validity: "3 Hours",       label: "45 Minutes" },
      { code: "MIN-2", name: "50 Mins",       price: 51,  validity: "Till Midnight", label: "50 Minutes" },
      { code: "MIN-3", name: "1.25GB Special",price: 55,  validity: "Till Midnight", label: "1.25GB Special" },
    ],
    sms: [
      { code: "SMS-1", name: "20 SMS",        price: 5,   validity: "1 Day",         label: "20 SMS" },
      { code: "SMS-2", name: "100 SMS",       price: 10,  validity: "7 Days",        label: "100 SMS" },
      { code: "SMS-3", name: "300 SMS",       price: 30,  validity: "7 Days",        label: "300 SMS" },
      { code: "SMS-4", name: "1500 SMS",      price: 101, validity: "30 Days",       label: "1500 SMS" },
    ],
    tunukiwa: [
      { code: "TUN-1", name: "1GB",           price: 22,  validity: "1 Hour",        label: "Tunukiwa 1GB" },
      { code: "TUN-2", name: "1.5GB",         price: 52,  validity: "3 Hours",       label: "Tunukiwa 1.5GB" },
      { code: "TUN-3", name: "2GB",           price: 110, validity: "24 Hours",      label: "Tunukiwa 2GB" },
    ],
  },
};

const PROVIDERS = {
  safaricom: { emoji: "🟢", full: "SAFARICOM", short: "saf" },
};

const CATEGORY_ICONS = {
  bingwaData: { icon: "📡", label: "BINGWA DATA BUNDLES" },
  minutes:    { icon: "📞", label: "MINUTES DEALS" },
  sms:        { icon: "💬", label: "SMS DEALS" },
  tunukiwa:   { icon: "🎁", label: "TUNUKIWA DEALS" },
};

function getPackages() {
  return db.read("_dataPackages", null) || DEFAULT_PACKAGES;
}

function savePackages(pkgs) {
  db.write("_dataPackages", pkgs);
}

function getPackageByCode(code) {
  const pkgs = getPackages();
  for (const [provider, cats] of Object.entries(pkgs)) {
    for (const [cat, list] of Object.entries(cats)) {
      const found = list.find(p => p.code.toLowerCase() === code.toLowerCase());
      if (found) return { ...found, provider, category: cat };
    }
  }
  return null;
}

function addPackage(provider, category, pkg) {
  const pkgs = getPackages();
  if (!pkgs[provider]) pkgs[provider] = {};
  if (!pkgs[provider][category]) pkgs[provider][category] = [];
  pkgs[provider][category] = pkgs[provider][category].filter(p => p.code !== pkg.code);
  pkgs[provider][category].push(pkg);
  savePackages(pkgs);
}

function removePackage(code) {
  const pkgs = getPackages();
  let removed = false;
  for (const provider of Object.keys(pkgs)) {
    for (const cat of Object.keys(pkgs[provider])) {
      const before = pkgs[provider][cat].length;
      pkgs[provider][cat] = pkgs[provider][cat].filter(p => p.code.toLowerCase() !== code.toLowerCase());
      if (pkgs[provider][cat].length < before) removed = true;
    }
  }
  if (removed) savePackages(pkgs);
  return removed;
}

function resetToDefault() {
  savePackages(DEFAULT_PACKAGES);
}

function buildAllMenu(websiteUrl) {
  const pkgs = getPackages();
  const url  = websiteUrl || BINGWA_URL;
  let lines  = [];

  lines.push(`╔══════════════════════════════╗`);
  lines.push(`║  🔥 *IGNATIUS' DATA HUBS*    ║`);
  lines.push(`╚══════════════════════════════╝`);
  lines.push(`> PATA DATA HATA UKIWA NA OKOA`);
  lines.push(``);
  lines.push(`💳 *M-Pesa Till No:* *${TILL_NUMBER}*`);
  lines.push(`🌐 *Website:* ${url}`);
  lines.push(`━`.repeat(32));

  const saf = pkgs.safaricom || {};
  for (const [catKey, items] of Object.entries(saf)) {
    if (!items || !items.length) continue;
    const catInfo = CATEGORY_ICONS[catKey] || { icon: "📦", label: catKey.toUpperCase() };
    lines.push(``);
    lines.push(`${catInfo.icon} *${catInfo.label}*`);
    lines.push(`┄`.repeat(30));
    for (const pkg of items) {
      lines.push(`  • *${pkg.code}* — ${pkg.name} / _${pkg.validity}_ — *KES ${pkg.price.toLocaleString()}*`);
    }
  }

  lines.push(``);
  lines.push(`━`.repeat(32));
  lines.push(`💬 *To order:* _.data buy <code>_`);
  lines.push(`> Example: _.data buy BWA-3_`);
  return lines.join("\n");
}

function buildProviderMenu(provider, websiteUrl) {
  return buildAllMenu(websiteUrl);
}

function buildOrderSummary(pkg, phone, websiteUrl) {
  const url     = websiteUrl || BINGWA_URL;
  const catInfo = CATEGORY_ICONS[pkg.category] || { icon: "📦", label: pkg.category.toUpperCase() };
  const sep     = `━`.repeat(30);

  return [
    `╔════════════════════════════════╗`,
    `║     🛒 *ORDER CONFIRMATION*    ║`,
    `╚════════════════════════════════╝`,
    ``,
    `${catInfo.icon} *${catInfo.label}*`,
    `📦 *Package:*  ${pkg.name}`,
    `⏱ *Validity:*  ${pkg.validity}`,
    `💰 *Price:*    *KES ${pkg.price.toLocaleString()}*`,
    `📱 *For:*       ${phone}`,
    ``,
    sep,
    `💳 *TAB 1 — PAY VIA TILL NUMBER*`,
    sep,
    `1️⃣ Open *M-Pesa* menu on your phone`,
    `2️⃣ Select *Lipa na M-Pesa*`,
    `3️⃣ Select *Buy Goods & Services*`,
    `4️⃣ Enter Till No: *${TILL_NUMBER}*`,
    `5️⃣ Enter Amount: *KES ${pkg.price.toLocaleString()}*`,
    `6️⃣ Enter your PIN & confirm`,
    ``,
    sep,
    `🌐 *TAB 2 — PAY NOW ONLINE*`,
    sep,
    `Pay instantly via *M-Pesa STK Push:*`,
    `👉 ${url}`,
    ``,
    sep,
    `✅ Reply *CONFIRM* once you have paid`,
    `❌ Reply *CANCEL* to abort the order`,
  ].join("\n");
}

module.exports = {
  getPackages,
  savePackages,
  getPackageByCode,
  addPackage,
  removePackage,
  resetToDefault,
  buildAllMenu,
  buildProviderMenu,
  buildOrderSummary,
  PROVIDERS,
  CATEGORY_ICONS,
  DEFAULT_PACKAGES,
  TILL_NUMBER,
  BINGWA_URL,
};
