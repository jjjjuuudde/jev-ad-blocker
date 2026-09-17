// Service worker: owns the API key, talks to jev, caches verdicts, keeps per-tab stats.
import { classifyBatch, hashString, makeLimiter } from "./jev.js";
import { getSettings, getApiKey, getSyncedKey } from "./settings.js";

const CACHE_KEY = "verdictCache";
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 20000; // entries; ~50 bytes each, well under storage.local's 10 MB
const MINUTE_MS = 60 * 1000;
// A verdict below CLEAN_P, or at/above the user's removal threshold, counts as
// confident either way for the short cache.
const CLEAN_P = 0.2;

// jev allows 1,200 requests/minute. Fifteen a second across every tab keeps a
// margin for retries; jev's Retry-After (on 429) pauses the bucket.
const limiter = makeLimiter({ perSecond: 15, burst: 15 });
const limitedFetch = limiter.limited(globalThis.fetch.bind(globalThis));

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
    // Which key is in use, so the popup can show it (an override saved on the
    // options page wins over the one synced from .env).
    const { apiKey: saved } = await chrome.storage.local.get("apiKey");
    const keySource = !apiKey ? "" : saved ? "options page" : (await getSyncedKey()) === apiKey ? ".env" : "";
    return { settings, hasKey: Boolean(apiKey), keyTail: apiKey ? apiKey.slice(-4) : "", keySource };
  },

  // { page, elements: [{ id, desc, sig }] } -> { probabilities: { id: p }, cached: n, usage }
  async classify(msg) {
    const settings = await getSettings();
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error("No jev API key. Paste it into .env and run `npm run sync-key`, or set it on the options page.");

    // Two reuse windows: any verdict for cacheDays (off by default), and a
    // confident verdict either way for confidentCacheMinutes (on by default).
    const anyTtl = (Number(settings.cacheDays) || 0) * DAY_MS;
    const cleanTtl = (Number(settings.confidentCacheMinutes) || 0) * MINUTE_MS;
    const cache = anyTtl > 0 || cleanTtl > 0 ? await loadCache() : null;
    const now = Date.now();
    const probabilities = {};
    const pending = [];
    for (const el of msg.elements) {
      const hit = cache && cache[el.sig];
      const age = hit ? now - hit.t : Infinity;
      if (hit && (age < anyTtl || ((hit.p < CLEAN_P || hit.p >= settings.threshold) && age < cleanTtl))) probabilities[el.id] = hit.p;
      else pending.push(el);
    }
    const cachedCount = msg.elements.length - pending.length;

    let usage = null;
    if (pending.length) {
      const res = await classifySplitting({ apiKey, page: msg.page, elements: pending, model: settings.model, apiUrl: settings.apiUrl });
      usage = res.usage;
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

  // Stylesheet behind the hide attribute, injected per tab (survives page CSP).
  async insertCss(msg, sender) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return {};
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: false }, css: "[data-jev-ad=\"hidden\"]{display:none !important}" }).catch(() => {});
    return {};
  },

  // Content script, at the start of a pass: capture the visible tab and keep
  // it, so removed elements can be cropped out of it afterwards.
  async capture(msg, sender) {
    const tab = sender.tab;
    if (!tab || !tab.active) return { ok: false }; // captureVisibleTab only sees the active tab
    await captureTab(tab);
    return {};
  },

  // Crop rects (CSS px, viewport-relative, measured when the capture was
  // requested) out of that tab's last capture -> small JPEG data URLs.
  async cropRegions(msg, sender) {
    const tab = sender.tab;
    if (!tab || lastCapture.tabId !== tab.id || !lastCapture.bitmap) return { shots: null };
    if (Date.now() - lastCapture.at > CAPTURE_MAX_AGE_MS) return { shots: null };
    const dpr = Number(msg.dpr) || 1;
    const bitmap = lastCapture.bitmap;
    const shots = await Promise.all((msg.rects || []).map((r) => (r ? crop(bitmap, r, dpr) : null)));
    return { shots };
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

// The content script sizes batches by an estimate; if jev still says a
// request is over its token ceiling, halve it and try both halves.
async function classifySplitting(req) {
  try {
    return await classifyBatch(req, { fetchImpl: limitedFetch });
  } catch (err) {
    if (!(err && err.tooBig) || req.elements.length < 2) throw err;
    const mid = Math.ceil(req.elements.length / 2);
    const a = await classifySplitting({ ...req, elements: req.elements.slice(0, mid) });
    const b = await classifySplitting({ ...req, elements: req.elements.slice(mid) });
    const usage = a.usage || b.usage ? {
      input_tokens: ((a.usage && a.usage.input_tokens) || 0) + ((b.usage && b.usage.input_tokens) || 0),
      output_tokens: ((a.usage && a.usage.output_tokens) || 0) + ((b.usage && b.usage.output_tokens) || 0),
    } : null;
    return { probabilities: { ...a.probabilities, ...b.probabilities }, usage, model: a.model || b.model };
  }
}

// Chrome allows about two captureVisibleTab calls per second, so captures are
// spaced out, and batches that finish together share one capture.
const CAPTURE_MIN_GAP_MS = 600;
const CAPTURE_FRESH_MS = 400;
const CAPTURE_MAX_AGE_MS = 30000; // crops older than this would show a page that has since changed
const SHOT_MAX_PX = 400;
let lastCapture = { tabId: null, at: 0, bitmap: null, promise: null };

async function captureTab(tab) {
  if (lastCapture.promise) {
    await lastCapture.promise.catch(() => {});
    return captureTab(tab);
  }
  const now = Date.now();
  if (lastCapture.tabId === tab.id && lastCapture.bitmap && now - lastCapture.at < CAPTURE_FRESH_MS) return lastCapture.bitmap;
  const wait = Math.max(0, lastCapture.at + CAPTURE_MIN_GAP_MS - now);
  lastCapture.promise = (async () => {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 75 });
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      lastCapture = { tabId: tab.id, at: Date.now(), bitmap, promise: null };
      return bitmap;
    } catch {
      lastCapture = { tabId: null, at: Date.now(), bitmap: null, promise: null };
      return null;
    }
  })();
  return lastCapture.promise;
}

async function crop(bitmap, r, dpr) {
  const sx = Math.max(0, Math.round(r.left * dpr));
  const sy = Math.max(0, Math.round(r.top * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round(r.width * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(r.height * dpr));
  if (sw < 8 || sh < 8) return null;
  const scale = Math.min(1, SHOT_MAX_PX / Math.max(sw, sh));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

// Chrome only injects content scripts into pages loaded after the extension
// was (re)loaded; tabs already open keep running the old script until they're
// reloaded. Inject into them here so a reload at chrome://extensions is enough.
chrome.runtime.onInstalled.addListener(async () => {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }); } catch { return; }
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, files: ["src/content.js"] }).catch(() => {});
  }
});

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
