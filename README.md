# jev ad blocker

A personal Chrome extension. On every page load it walks the rendered elements on the page, describes each one (tag, classes, size, where its links and images point, a snippet of text, and so on), sends them to [jev](https://docs.typesafe.ai/introduction) in batches, and removes the elements jev is confident are ads.

## Setup

1. Paste your jev API key into `.env`:

   ```
   TYPESAFE_API_KEY=your-key-here
   ```

   Keys live at https://console.typesafe.ai/settings/keys.

2. Generate the file the extension reads the key from (Chrome can't read `.env` itself):

   ```
   npm run sync-key
   ```

   This writes `src/config.local.js` (git-ignored) and marks `.env` `skip-worktree` so your key doesn't get committed by accident.

   No Node handy? Skip this step and paste the key on the extension's options page instead.

3. Load it in Chrome:
   - open `chrome://extensions`
   - turn on **Developer mode** (top right)
   - click **Load unpacked** and pick this folder (the one with `manifest.json`)

4. Open the options page (click the extension icon, then **Options**) and hit **Test key** to confirm jev answers.

Whenever you change the key, run `npm run sync-key` again and click the reload icon on the extension's card in `chrome://extensions`.

## How it decides

Each element becomes one [noul](https://docs.typesafe.ai/primitives/noul) question ("is `state.elements.e12` an advertisement an ad blocker should remove?") with explicit true/false criteria, and 25 of them ride in a single request as a [fan-out](https://docs.typesafe.ai/patterns/fan-out). A noul answer is the probability the answer is yes; by default an element is removed when that probability is at least **0.85** (jev's own suggested line for acting without a human in the loop is 0.9; the default sits a little below it because a removal is restorable). Every page load classifies fresh by default; set **Reuse verdicts** to a number of days on the options page to cache verdicts across reloads instead.

Defaults (all adjustable on the options page):

| Setting | Default | Why |
| --- | --- | --- |
| Threshold | 0.85 | a little under jev's 0.9 "proceed automatically" line |
| Reuse verdicts | 0 days | every load asks jev fresh; a load costs a fraction of a cent |
| Keep watching after load | on | classifies elements the site adds later (refreshing ad slots) |
| Remove empty wrappers | on | takes out the ad's container once it has no text or media left |
| Max elements per load | 0 (no cap) | every rendered element goes to jev; set a number to stop early on huge pages |
| Elements per request | 25 | one request, 25 questions |
| Requests in flight | 3 | |
| Action | remove (restorable) | "hide" is available |
| Text-share safety rail | 50% | never removes an element holding more than half the page's text |

Elements are taken in document order, all of them by default (a busy news page is a few thousand elements, so roughly 100 requests per load; the popup shows tokens and cost). Anything not rendered (`display: none`, zero rects), `script`/`style`/`head` and SVG internals are skipped. When a parent is removed, its children are dropped from later batches instead of being classified.

## After load

Sites keep adding elements after the page has loaded: ad slots that refresh every few seconds, lazy-loaded units, sticky bars injected by an ad script. A MutationObserver watches for added nodes, waits for the burst to settle (600 ms), and classifies just the new elements.

When an ad is removed, its wrapper is checked too: if the wrapper now has no text or media of its own it is removed as well, walking upward until something with content is reached. That is what stops a sticky ad bar from leaving an empty grey strip behind, and it also ends the refresh loop, because the ad script keeps re-inserting into a container that is no longer on the page.

## Cost

jev lists [$0.042 per million input tokens, output free](https://docs.typesafe.ai/models). The API returns token counts, so the popup computes dollars from that price: this page's spend, and a running total across all pages (reset it on the options page). A few-thousand-element page is roughly half a million input tokens, about two cents.

## Popup

The toolbar icon shows what happened on the current tab: how many elements were classified (and how many were added after load), what was removed (with jev's probability, or `wrap` for an emptied wrapper), the cost, and anything the safety rail refused to remove. **Restore removed** puts everything back; **Rescan page** runs the pass again; the checkbox disables the extension for that site.

## Development

```
npm run check   # syntax-check every script
npm test        # unit tests for the jev client (request shape, retries, parsing)
npm run e2e     # loads the extension into headless Chromium against a stand-in jev (needs playwright)
npm run zip     # jev-ad.zip with just the loadable extension
```

Layout:

- `manifest.json` MV3 manifest
- `src/content.js` walks the DOM, describes elements, removes/restores
- `src/background.js` service worker: holds the key, calls jev, caches verdicts, tracks per-tab stats
- `src/jev.js` the API client (request building, retries, answer parsing)
- `src/settings.js` defaults and storage helpers
- `src/popup.*`, `src/options.*` UI
- `scripts/sync-key.mjs` `.env` to `src/config.local.js`
