const toggle = document.getElementById("toggle-enabled");
const statusText = document.getElementById("status-text");

const curValEl = document.getElementById("popup-current-value");
const curBarEl = document.getElementById("popup-current-bar");
const curResetEl = document.getElementById("popup-current-reset");

const wkValEl = document.getElementById("popup-weekly-value");
const wkBarEl = document.getElementById("popup-weekly-bar");
const wkResetEl = document.getElementById("popup-weekly-reset");

const updatedAtEl = document.getElementById("popup-updated-at");
const usageLinkEl = document.getElementById("popup-usage-link");

let targetAccountKey = null;

function getAccountFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "gemini.google.com") return null;
    const match = parsed.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
    return match ? `u_${match[1]}` : "u_0";
  } catch {
    return null;
  }
}

function getUsageUrlForAccount(accountKey) {
  if (accountKey && accountKey !== "u_0") {
    const idx = accountKey.replace("u_", "");
    return `https://gemini.google.com/u/${idx}/usage`;
  }
  return "https://gemini.google.com/usage";
}

function updateStatusLabel(enabled) {
  statusText.textContent = enabled ? "Actif sur gemini.google.com" : "Désactivé";
}

function getLevelClass(percent) {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return "";
  if (percent >= 90) return "level-danger";
  if (percent >= 70) return "level-warn";
  return "";
}

function renderQuota(quotaData) {
  if (!quotaData) return;

  const curPct = quotaData.current?.percent;
  const wkPct = quotaData.weekly?.percent;

  curValEl.textContent = quotaData.current?.rawPercentText || "--";
  curResetEl.textContent = quotaData.current?.resetText || "—";
  curBarEl.style.width = `${Math.min(100, Math.max(0, curPct || 0))}%`;
  curBarEl.className = `progress-fill ${getLevelClass(curPct)}`;

  wkValEl.textContent = quotaData.weekly?.rawPercentText || "--";
  wkResetEl.textContent = quotaData.weekly?.resetText || "—";
  wkBarEl.style.width = `${Math.min(100, Math.max(0, wkPct || 0))}%`;
  wkBarEl.className = `progress-fill ${getLevelClass(wkPct)}`;

  if (quotaData.updatedAt) {
    const timeStr = new Date(quotaData.updatedAt).toLocaleTimeString("fr-FR");
    updatedAtEl.textContent = `Mis à jour à ${timeStr}`;
  }
}

async function initPopup() {
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    targetAccountKey = getAccountFromUrl(activeTab?.url);
  } catch {
    targetAccountKey = null;
  }

  const {
    enabled = true,
    quotaByAccount = {},
    activeAccountKey,
    quotaData
  } = await browser.storage.local.get([
    "enabled",
    "quotaByAccount",
    "activeAccountKey",
    "quotaData"
  ]);

  const effectiveKey = targetAccountKey || activeAccountKey || "u_0";
  targetAccountKey = effectiveKey;
  if (usageLinkEl) {
    usageLinkEl.href = getUsageUrlForAccount(effectiveKey);
  }

  toggle.checked = enabled;
  updateStatusLabel(enabled);
  renderQuota(quotaByAccount[effectiveKey] || quotaData);
}

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  await browser.storage.local.set({ enabled });
  updateStatusLabel(enabled);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.quotaByAccount?.newValue && targetAccountKey && changes.quotaByAccount.newValue[targetAccountKey]) {
    renderQuota(changes.quotaByAccount.newValue[targetAccountKey]);
  } else if (changes.quotaData && changes.quotaData.newValue) {
    renderQuota(changes.quotaData.newValue);
  }
});

initPopup();
