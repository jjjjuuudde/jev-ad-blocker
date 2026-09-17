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

Each element becomes one [noul](https://docs.typesafe.ai/primitives/noul) question ("is `state.elements.e12` an advertisement an ad blocker should remove?") with explicit true/false criteria, and 25 of them ride in a single request as a [fan-out](https://docs.typesafe.ai/patterns/fan-out). A noul answer is the probability the answer is yes; by default an element is removed when that probability is at least **0.9**, jev's suggested line for acting without a human in the loop. Verdicts are cached per site for a week so reloads don't re-spend tokens.

Defaults (all adjustable on the options page):

| Setting | Default | Why |
| --- | --- | --- |
| Threshold | 0.9 | jev's "proceed automatically" band |
| Max elements per load | 600 | keeps a big page to ~24 requests; set 0 for truly every element |
| Elements per request | 25 | one request, 25 questions |
| Requests in flight | 3 | |
| Action | remove (restorable) | "hide" is available |
| Text-share safety rail | 50% | never removes an element holding more than half the page's text |

Elements are taken in document order. Anything not rendered (`display: none`, zero rects), `script`/`style`/`head` and SVG internals are skipped. When a parent is removed, its children are dropped from later batches instead of being classified.

## Popup

The toolbar icon shows what happened on the current tab: how many elements were classified, how many came from cache, what was removed (with jev's probability), and anything the safety rail refused to remove. **Restore removed** puts everything back; **Rescan page** runs the pass again; the checkbox disables the extension for that site.

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
