// Settings shared by the worker, popup and options page. Stored in chrome.storage.local.

export const DEFAULT_SETTINGS = {
  enabled: true,
  // A noul answer is P(yes). jev suggests 0.9+ for acting without a human in
  // the loop (https://docs.typesafe.ai/confidence); 0.85 trades a little of
  // that margin for catching more ads, since a removal is restorable.
  threshold: 0.85,
  // Elements are walked in document order; scanning stops after this many
  // rendered elements per page load. 0 = no cap: every rendered element goes to jev.
  maxElements: 0,
  // How many elements ride in one jev request (one noul question each). jev
  // answers 400 questions in about a second, no slower than 100, and the rate
  // limit is per request (1,200/min), so big batches are the main lever.
  batchSize: 200,
  // Requests in flight at once (jev allows 1,200 requests a minute).
  concurrency: 6,
  // "remove" detaches the node (restorable from the popup), "hide" sets
  // display:none, "outline" leaves it in place with a red border and jev's
  // score in its tooltip (for checking what would be removed).
  action: "remove",
  // Before removing an element, grab a screenshot of it (cropped from a capture
  // of the visible tab) so the popup can show what went.
  screenshots: true,
  // Only classify elements that intersect the viewport (plus a margin); the
  // rest are classified as they scroll into view. Saves tokens on long pages.
  viewportOnly: true,
  // Reuse a verdict for this many days instead of asking jev again. 0 means
  // every page load classifies fresh: a load costs a fraction of a cent, and
  // fresh verdicts follow the page as it changes.
  cacheDays: 0,
  // Independently of cacheDays, reuse a confident "not an ad" verdict (p below
  // 0.2) for this many minutes. A clean nav bar is still clean a minute later,
  // and most of a repeat page is exactly that. 0 turns it off.
  cleanCacheMinutes: 60,
  // Keep watching the page after the first pass and classify elements the site
  // adds later (ad slots that refresh every few seconds, lazy-loaded units).
  watchDom: true,
  // After removing an ad, also remove any ancestor left with no text or media
  // of its own, so an ad wrapper doesn't stay behind as an empty grey box.
  collapseEmptyWrappers: true,
  // Safety rail: never remove an element holding more than this share of the
  // page's visible text, so a wrongly-flagged wrapper can't blank the page.
  maxTextShare: 0.5,
  // Hostnames where the extension stays idle.
  disabledSites: [],
  // Never touch anything inside these elements, per site ("hostname selector"
  // per line on the options page). YouTube's video player is protected because
  // the in-video ad UI (skip button, countdown) got classified as an ad and
  // removed, which left the ad unskippable.
  protectedSelectors: [
    "youtube.com #movie_player",
    "youtube.com .html5-video-player",
    "youtube.com ytd-player",
    "youtube.com .ytp-ad-module",
  ],
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
