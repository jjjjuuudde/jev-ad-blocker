# jev ad blocker

A personal Chrome ad blocker extension. On every page load it walks the rendered elements on the page, describes each one (tag, classes, size, where its links and images point, a snippet of text, and so on), sends them to [jev](https://docs.typesafe.ai/introduction) in batches, and removes the elements jev is confident are ads.

## Requirements

- Google Chrome (or another Chromium browser that loads unpacked Manifest V3 extensions). Firefox and Safari are not supported.
- A jev API key from https://console.typesafe.ai/settings/keys. Usage is billed to that key; see [Cost](#cost).
- Node.js, only for `npm run sync-key`. Without it, paste the key on the options page instead.

## Setup

1. Copy `.env.example` to `.env` and paste your jev API key after the `=`:

   ```
   cp .env.example .env
   ```

   Keys live at https://console.typesafe.ai/settings/keys. `.env` is git-ignored, so the key stays on your machine.

2. Generate the file the extension reads the key from (Chrome can't read `.env` itself):

   ```
   npm run sync-key
   ```

   This writes `src/config.local.js` (also git-ignored).

   No Node handy? Skip this step and paste the key on the extension's options page instead.

3. Load it in Chrome:
   - open `chrome://extensions`
   - turn on **Developer mode** (top right)
   - click **Load unpacked** and pick this folder (the one with `manifest.json`)

4. Open the options page (click the extension icon, then **Options**) and hit **Test key** to confirm jev answers.

## How to use it

Once the extension is loaded, it runs on its own:

1. Open any page. Ads near the viewport are hidden within a second or two; the rest are classified as you scroll toward them.
2. Click the toolbar icon to open the popup. It shows what was classified, what was hidden (with a screenshot and jev's probability), and what the page cost.
3. Something disappeared that shouldn't have? Click **Show** next to the entry to see it for three seconds, or **Restore removed** to put everything back. Raise the threshold on the options page if it keeps happening.
4. An ad got through? Click **Rescan page** for a full fresh pass. Lower the threshold in options to block more aggressively.
5. Want it off on one site? Untick **Run on this site** in the popup. Want it off everywhere? Untick **Extension enabled** on the options page.

Whenever you change the key or pull new code, run `npm run sync-key` again and click the reload icon on the extension's card in `chrome://extensions`. The worker then re-injects the content script into every open tab, so you don't have to reload them.

## Limitations

- **Chrome only.** It is a Manifest V3 extension loaded unpacked. It is not on the Chrome Web Store, and it does not run in Firefox or Safari.
- **No video ads.** Ads that play inside a video player (YouTube pre-rolls and mid-rolls, Twitch, etc.) are not touched: they play inside the same `<video>` element as the content, so there is no separate element to hide. YouTube's player is on the protected list so the skip button stays.
- **It costs money.** Every page you visit is sent to jev and billed to your key. A typical page is a fraction of a cent; a heavy news page with **Only classify what is near the screen** turned off is a few cents.
- **It needs a round trip.** An ad is visible until jev answers, usually under a second. Ads inserted right as they scroll into view (Pinterest, X) can flash briefly.
- **It can be wrong.** jev gives a probability, and the threshold decides. Some ads get through; occasionally a piece of real content is hidden. The popup's **Show** and **Restore removed** buttons are the fix, along with the threshold and the protected-elements list.
- **Pages are described to a third party.** See the next section.

## What leaves your browser

Every page you visit with the extension enabled is described to jev: for each rendered element, its tag, classes, size, the hosts its links and images point to, and up to 200 characters of its text, plus the page URL and title. Nothing is stored by the extension beyond verdict hashes in your browser profile. Turn it off per site from the popup, or disable it on the options page, for pages you don't want described to a third party.

## How it decides

Each element becomes one [noul](https://docs.typesafe.ai/primitives/noul) question ("is `state.elements.e12` an advertisement an ad blocker should remove?") with explicit true/false criteria, and 200 of them ride in a single request as a [fan-out](https://docs.typesafe.ai/patterns/fan-out). A noul answer is the probability the answer is yes; by default an element is removed when that probability is at least **0.85** (jev's own suggested line for acting without a human in the loop is 0.9; the default sits a little below it because a removal is restorable). Every page load classifies fresh by default; set **Reuse verdicts** to a number of days on the options page to cache verdicts across reloads instead.

Defaults (all adjustable on the options page):

| Setting | Default | Why |
| --- | --- | --- |
| Threshold | 0.85 | a little under jev's 0.9 "proceed automatically" line |
| Reuse verdicts | 0 days | every load asks jev fresh; a load costs a fraction of a cent |
| Reuse confident verdicts | 60 min | p < 0.2, or p ≥ the threshold, is reused on repeat pages; the unsure middle is re-asked |
| Keep watching after load | on | classifies elements the site adds later (refreshing ad slots) |
| Remove empty wrappers | on | takes out the ad's container once it has no text or media left |
| Max elements per load | 0 (no cap) | every rendered element goes to jev; set a number to stop early on huge pages |
| Elements per request | 200 | a count cap; the token budget below usually closes a batch first |
| Token budget per request | 32k | jev rejects requests above ~40k input tokens (`max_tokens_exceeded`); real elements cost ~250-400 tokens each |
| Requests in flight | 6 | jev allows 1,200 requests a minute |
| Action | hide (restorable) | display:none in place; "remove" detaches the node but blanks React-style sites, "outline" is for testing |
| Only classify what is near the screen | on | elements are classified as they come near the view |
| Look ahead | 2 screens | classified before the user scrolls to them, so nothing shifts under them |
| Text-share safety rail | 50% | never removes an element holding more than half the page's text |
| Protected elements | YouTube's player | `hostname selector` lines; nothing inside a match is classified or removed |

Elements are taken in document order. By default only the ones in a band around the viewport are sent on load: the visible area, half a screen above, and 2 screens below (**Look ahead** in options), so ads are gone before the user scrolls to them and nothing shifts while they read. The rest are classified as they come near, so a long page costs only what you actually get to. Turn **Only classify what is on screen** off to do the whole page at once (a busy news page is a few thousand elements, roughly 100 requests). Anything not rendered (`display: none`, zero rects), `script`/`style`/`head` and SVG internals are skipped. When a parent is removed, its children are dropped from later batches instead of being classified.

## Staying under the rate limit

jev allows 1,200 requests a minute and 250,000 tokens a second; requests are the tight one. Four things keep the count down:

- **Big batches.** Up to 200 questions per request, closed early at an estimated 32k input tokens (jev rejects requests somewhere above 40k with `max_tokens_exceeded`; a real element with its question costs 250-400 tokens, so a batch is usually 80-120 elements). If jev still rejects one, the worker halves it and retries both halves.
- **Candidate filter.** Text-level elements (`span`, `p`, headings, list items, ...), text-only leaves, anything under 20 px, and wrappers with a single element child and no text of their own are never sent; the element with real structure inside (or the container around them) is, and the collapse pass takes the layers out with it. On Pinterest, where every pin sits in a dozen such layers, this cut 397 candidates to 94 for twelve pins. Anything with an ad hint, media, an iframe or a link is always sent. On a YouTube page this cuts the questions by well over half.
- **Rate limiter.** The worker runs one token bucket (15 requests a second) across every tab and honours jev's `Retry-After` on a 429, so retries don't pile up.
- **Confident cache.** A confident verdict either way (p < 0.2, or p at or above the removal threshold) is reused for 60 minutes; navigating within a single-page site only sends the new elements.
- **Page memory.** Within a page, every verdict is also remembered by a loose signature (tag, classes, text, the paths of the first links and images inside, alt text; no ids or positions). If two elements share a key but get verdicts on opposite sides of the threshold, the key is forgotten rather than trusted. Virtualised lists such as Pinterest's grid unmount pins as you scroll away and create fresh nodes when you scroll back; those get their verdict re-applied synchronously in the mutation observer, before the site can paint them, with no request.

## Labelled ads jump the queue

Some sites (Pinterest, X) insert a paid item only as it is about to come into view, so the jev round trip is the whole delay. When the DOM watcher sees an inserted element whose text label is exactly an ad marker ("Sponsored", "Promoted by …", "Ad", "Anzeige", ...), it describes the card around the label right away (the nearest ancestor with two or more children that is much larger than the label and not most of the screen), adds the label to the description as `adLabel` so jev sees it, and sends those cards first, in a small request of their own, ahead of the rest of the pass. Nothing is hidden until jev answers. Incremental passes start within 30 ms of the first change after a quiet spell and may overlap, so a newly inserted ad no longer waits behind a pass that is already running.

## When it runs

The first pass starts as soon as the DOM is parsed (Chrome's `document_idle`), not at the window `load` event, which on heavy pages can be many seconds away. Within a pass, elements that look like ads (ad attributes, iframes, off-site links or images) are sent first, so they usually go in the first round trip. Elements that render later are picked up by the DOM watcher (added nodes, 250 ms debounce), a scroll listener in capture phase (so inner scroll containers count too), a ResizeObserver on `<body>` (layout changes without a DOM change, such as an ad slot growing when its iframe loads), and settle sweeps at 0, 1 and 3 seconds after `load`. Pages Chrome prerendered wait until they become the real page; pages restored from the back/forward cache get a fresh full pass.

## Why hide, not remove

The default action is `display: none` in place, set both as a `data-jev-ad="hidden"` attribute (matched by a stylesheet the worker injects with `chrome.scripting.insertCSS`, immune to the page's CSP and to frameworks rewriting inline style) and as an inline style. Sites built on React, Vue and similar keep their own model of the DOM; if the extension detaches a node they manage, their next update calls `removeChild` on a child that is no longer there, the error propagates, and the framework unmounts the page (Pinterest went blank this way). Hiding leaves the node where the framework expects it. `remove` is still available in options for plain pages.

## Protected elements

Some things jev calls ads must stay: YouTube's in-video ad UI (skip button, countdown, "Ad" badge) is part of the ad, and removing it leaves the ad running with no way to skip it. The **Never touch these elements** list on the options page holds `hostname selector` lines; elements inside a match are neither classified nor removed. The defaults cover YouTube's player (`#movie_player`, `.html5-video-player`, `ytd-player`, `.ytp-ad-module`). Removing the video ad itself is a separate problem for later: it plays inside the same `<video>` element as the content.

## Single-page sites

Sites like YouTube swap the page without a load event. The content script watches the URL (popstate, hashchange, and a poll for pushState) and, 800 ms after it settles, sweeps the viewport for elements not yet classified. It is not a full rescan: the header and sidebar that survive the navigation keep their verdicts, and the new content arrives as added nodes, which the watcher classifies anyway. The popup's **Rescan page** button is the full, from-scratch pass.

## After load

Sites keep adding elements after the page has loaded: ad slots that refresh every few seconds, lazy-loaded units, sticky bars injected by an ad script. A MutationObserver watches for added nodes, waits for the burst to settle (600 ms), and classifies just the new elements.

When an ad is removed, its wrapper is checked too: if the wrapper now has no text or media of its own it is removed as well, walking upward until something with content is reached. That is what stops a sticky ad bar from leaving an empty grey strip behind, and it also ends the refresh loop, because the ad script keeps re-inserting into a container that is no longer on the page.

## Cost

jev lists [$0.042 per million input tokens, output free](https://docs.typesafe.ai/models). The API returns token counts, so the popup computes this page's cost from that price. A few-thousand-element page is roughly half a million input tokens, about two cents. The popup footer shows the last four characters of the key in use and where it came from (`.env` or the options page).

## Popup

The toolbar icon shows what happened on the current tab: how many elements were classified (and how many were added after load), what was removed (with jev's probability, or `wrap` for an emptied wrapper), the cost, and anything the safety rail refused to remove. Each removed entry shows a screenshot of the element (the worker captures the visible tab once at the start of each pass and crops it afterwards, so removal never waits on it; the tab has to be the active one, and the element on screen). Each entry also has a **Show** button that puts the element back for three seconds with a red outline, scrolled into view, and an expandable **HTML** snippet of what was removed. To see every verdict in place, set the action to **Outline** in options: ads then stay on the page with a red border and jev's score in the tooltip. **Restore removed** puts everything back; **Rescan page** runs the pass again; the checkbox disables the extension for that site.

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
- `.env.example` template for `.env`

## License

[MIT](LICENSE).
