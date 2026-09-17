import { DEFAULT_SETTINGS, getSettings, saveSettings, getSyncedKey } from "./settings.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["threshold", "maxElements", "batchSize", "concurrency", "model", "action", "maxTextShare", "debug", "enabled"];

async function load() {
  const s = await getSettings();
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === "checkbox") el.checked = Boolean(s[f]);
    else el.value = s[f];
  }
  $("disabledSites").value = s.disabledSites.join("\n");
  await describeKey();
}

async function describeKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  const envKey = await getSyncedKey();
  if (apiKey) $("keySource").textContent = `Using the key saved here (ends in ...${apiKey.slice(-4)}).`;
  else if (envKey) $("keySource").textContent = `Using the key synced from .env (ends in ...${envKey.slice(-4)}).`;
  else $("keySource").textContent = "No key found. Paste it into .env and run `npm run sync-key`, then reload the extension, or save one below.";
}

function read() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === "checkbox") s[f] = el.checked;
    else if (el.type === "number") s[f] = Number(el.value);
    else s[f] = el.value.trim();
  }
  s.disabledSites = $("disabledSites").value.split(/\n/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!(s.threshold >= 0 && s.threshold <= 1)) s.threshold = DEFAULT_SETTINGS.threshold;
  if (!(s.batchSize >= 1)) s.batchSize = DEFAULT_SETTINGS.batchSize;
  if (!(s.concurrency >= 1)) s.concurrency = DEFAULT_SETTINGS.concurrency;
  if (!(s.maxElements >= 0)) s.maxElements = DEFAULT_SETTINGS.maxElements;
  if (!(s.maxTextShare > 0 && s.maxTextShare <= 1)) s.maxTextShare = DEFAULT_SETTINGS.maxTextShare;
  if (!s.model) s.model = DEFAULT_SETTINGS.model;
  return s;
}

$("save").addEventListener("click", async () => {
  await saveSettings(read());
  flash("msg", "Saved.", true);
  await load();
});
$("reset").addEventListener("click", async () => {
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  flash("msg", "Reset to defaults.", true);
  await load();
});
$("clearCache").addEventListener("click", async () => {
  await ask({ type: "clearCache" });
  flash("msg", "Verdict cache cleared.", true);
});
$("saveKey").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) return flash("keyMsg", "Paste a key first.", false);
  await chrome.storage.local.set({ apiKey: key });
  $("apiKey").value = "";
  flash("keyMsg", "Key saved.", true);
  await describeKey();
});
$("clearKey").addEventListener("click", async () => {
  await chrome.storage.local.remove("apiKey");
  flash("keyMsg", "Saved key removed; the .env key (if synced) is used.", true);
  await describeKey();
});
$("testKey").addEventListener("click", async () => {
  flash("keyMsg", "Testing...", true);
  const res = await ask({ type: "testKey", apiKey: $("apiKey").value.trim() || undefined });
  if (!res || !res.ok) return flash("keyMsg", `Failed: ${res ? res.error : "no response"}`, false);
  flash("keyMsg", `Works. ${res.model} says a "Buy now! 50% off" div is an ad with p=${res.probability.toFixed(2)}.`, true);
});

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)));
}
function flash(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${ok ? "ok" : "err"}`;
}

load();
