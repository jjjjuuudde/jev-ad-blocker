// Service worker: owns the API key, talks to jev, caches verdicts, keeps per-tab stats.
import { classifyBatch, hashString } from "./jev.js";
import { getSettings, getApiKey } from "./settings.js";

const CACHE_KEY = "verdictCache";
const USAGE_KEY = "usageTotal"; // lifetime token counts, so the popup can show total spend
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 3000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true; // keep the channel open for the async response
});

const handlers = {
  async getConfig() {
    const settings = await getSettings();
    const apiKey = await getApiKey();
    return { settings, hasKey: Boolean(apiKey) };
  },

  // { page, elements: [{ id, desc, sig }] } -> { probabilities: { id: p }, cached: n, usage }
  async classify(msg) {
    const settings = await getSettings();
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error("No jev API key. Paste it into .env and run `npm run sync-key`, or set it on the options page.");

    // Verdicts are only reused when the user opted in (cacheDays > 0); by
    // default every page load asks jev fresh.
    const ttl = (Number(settings.cacheDays) || 0) * DAY_MS;
    const cache = ttl > 0 ? await loadCache() : null;
    const now = Date.now();
    const probabilities = {};
    const pending = [];
    for (const el of msg.elements) {
      const hit = cache && cache[el.sig];
      if (hit && now - hit.t < ttl) probabilities[el.id] = hit.p;
      else pending.push(el);
    }
    const cachedCount = msg.elements.length - pending.length;

    let usage = null;
    if (pending.length) {
      const res = await classifyBatch({ apiKey, page: msg.page, elements: pending, model: settings.model, apiUrl: settings.apiUrl });
      usage = res.usage;
      await addUsage(usage);
      for (const el of pending) {
        const p = res.probabilities[el.id];
        probabilities[el.id] = p;
        if (cache) cache[el.sig] = { p, t: now };
      }
      if (cache) await saveCache(cache);
    }
    return { probabilities, cached: cachedCount, usage };
  },

  // Content script reports what happened on this tab so the popup can show it.
  async report(msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return {};
    await chrome.storage.session.set({ [`tab:${tabId}`]: { ...msg.stats, at: Date.now() } });
    return {};
  },

  async getTabStats(msg) {
    const key = `tab:${msg.tabId}`;
    const data = await chrome.storage.session.get(key);
    return { stats: data[key] || null };
  },

  async getUsageTotal() {
    return { total: await loadUsage() };
  },

  async resetUsageTotal() {
    await chrome.storage.local.set({ [USAGE_KEY]: emptyUsage() });
    return {};
  },

  async clearCache() {
    const cache = await loadCache();
    for (const k of Object.keys(cache)) delete cache[k];
    await saveCache(cache);
    return {};
  },

  // Options page: one tiny request to confirm the key works.
  async testKey(msg) {
    const apiKey = msg.apiKey || (await getApiKey());
    const settings = await getSettings();
    const res = await classifyBatch({
      apiKey,
      page: { url: "about:blank", title: "key test" },
      elements: [{ id: "e0", desc: { tag: "div", text: "Buy now! 50% off widgets, limited time. Sponsored." } }],
      model: settings.model,
      apiUrl: settings.apiUrl,
    });
    return { probability: res.probabilities.e0, model: res.model, usage: res.usage };
  },
};

function emptyUsage() { return { input_tokens: 0, output_tokens: 0, requests: 0, since: Date.now() }; }

async function loadUsage() {
  const data = await chrome.storage.local.get(USAGE_KEY);
  return { ...emptyUsage(), ...(data[USAGE_KEY] || {}) };
}

let usageWriting = Promise.resolve();
function addUsage(usage) {
  usageWriting = usageWriting.then(async () => {
    const total = await loadUsage();
    total.input_tokens += (usage && usage.input_tokens) || 0;
    total.output_tokens += (usage && usage.output_tokens) || 0;
    total.requests += 1;
    await chrome.storage.local.set({ [USAGE_KEY]: total });
  }).catch(() => {});
  return usageWriting;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});

// One in-memory copy per worker lifetime, with serialized writes, so concurrent
// batches don't clobber each other's verdicts with a read-modify-write race.
let cacheLoading = null;
let cacheSaving = Promise.resolve();

function loadCache() {
  if (!cacheLoading) {
    cacheLoading = chrome.storage.local.get(CACHE_KEY).then((data) => data[CACHE_KEY] || {});
  }
  return cacheLoading;
}

function saveCache(cache) {
  cacheSaving = cacheSaving.then(async () => {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a].t - cache[b].t);
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
    }
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  }).catch(() => {});
  return cacheSaving;
}

export { hashString };
