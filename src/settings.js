// Settings shared by the worker, popup and options page. Stored in chrome.storage.local.

export const DEFAULT_SETTINGS = {
  enabled: true,
  // A noul answer is P(yes). "Confident" per jev's guidance is 0.9+ for actions
  // that are costly to get wrong (https://docs.typesafe.ai/confidence).
  threshold: 0.9,
  // Elements are walked in document order; scanning stops after this many
  // rendered elements per page load. 0 = no cap: every rendered element goes to jev.
  maxElements: 0,
  // How many elements ride in one jev request (one noul question each).
  batchSize: 25,
  // Requests in flight at once.
  concurrency: 3,
  // "remove" detaches the node (restorable from the popup), "hide" sets display:none.
  action: "remove",
  // Safety rail: never remove an element holding more than this share of the
  // page's visible text, so a wrongly-flagged wrapper can't blank the page.
  maxTextShare: 0.5,
  // Hostnames where the extension stays idle.
  disabledSites: [],
  model: "jev-latest",
  // jev's System One endpoint; only change this to point at a proxy or a test double.
  apiUrl: "https://api.typesafe.ai/v1/systemone",
  // Log every element and verdict to the page console.
  debug: false,
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/**
 * The key `npm run sync-key` wrote to src/config.local.js, or "" if it hasn't
 * been synced. Read with fetch rather than import(): Chrome forbids dynamic
 * import() inside the MV3 service worker, and fetch works in every context.
 */
export async function getSyncedKey() {
  try {
    const res = await fetch(chrome.runtime.getURL("src/config.local.js"));
    if (!res.ok) return "";
    const match = (await res.text()).match(/TYPESAFE_API_KEY\s*=\s*("(?:[^"\\]|\\.)*")/);
    return match ? JSON.parse(match[1]) : "";
  } catch {
    return "";
  }
}

/** Key precedence: the one saved from the options page, else the one synced from .env. */
export async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (apiKey) return apiKey;
  return getSyncedKey();
}
