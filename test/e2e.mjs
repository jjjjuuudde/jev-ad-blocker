// End-to-end smoke test: loads the unpacked extension into Chromium, points it
// at a local stand-in for jev, opens a page with ads and content, and checks
// that only the ads disappear (and come back on restore).
//
//   npm run e2e      (needs Playwright + Chromium; uses the global install)
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

// Use a local playwright if installed, else the global one (`npm i -g playwright`).
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch {
  playwright = require(join(execSync("npm root -g").toString().trim(), "playwright"));
}
const { chromium } = playwright;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PAGE = `<!doctype html><html><head><title>Test page</title></head><body>
<header id="site-header"><nav><a href="/">Home</a> <a href="/news">News</a></nav></header>
<main>
  <article class="article">
    <h1>Real headline about something</h1>
    <p class="body">First paragraph of real content, long enough to matter for the text-share guard. It keeps going and going.</p>
    <p class="body">Second paragraph. Still real content. Nothing to sell here.</p>
    <img src="/photo.jpg" alt="Illustrative photo">
  </article>
  <aside class="sidebar">
    <div id="ad-banner" class="ad-slot" data-ad-slot="123">Sponsored: Buy widgets now, 50% off!</div>
    <iframe id="ad-frame" src="/ads/frame.html" width="300" height="250"></iframe>
    <div class="related"><a href="/other">Another article from this site</a></div>
  </aside>
</main>
<footer id="site-footer">Copyright</footer>
</body></html>`;

const seen = { requests: 0, questions: 0 };
const server = http.createServer((req, res) => {
  // The extension only has host permission for api.typesafe.ai, so the stand-in must speak CORS.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "POST" && req.url === "/v1/systemone") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = req.headers.authorization;
      if (auth !== "Bearer test-key") { res.writeHead(401); return res.end("bad key"); }
      const json = JSON.parse(body);
      seen.requests++;
      if (process.env.DUMP) require("node:fs").appendFileSync(process.env.DUMP, JSON.stringify(json.state.elements, null, 1) + "\n");
      const answers = {};
      for (const [id, q] of Object.entries(json.questions)) {
        assert.equal(q.type, "noul");
        const d = json.state.elements[id];
        seen.questions++;
        const adLike = /sponsored/i.test(d.text || "") || d.dataAd || (d.attrHints || []).length > 0;
        // The sidebar wrapper contains the ads but isn't one; a wrapper of everything is definitely not.
        const wrapper = d.descendants > 3;
        answers[id] = { type: "noul", noul: adLike && !wrapper ? 0.98 : 0.03 };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 100, output_tokens: 10 } }));
    });
    return;
  }
  if (req.url === "/page.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
  if (req.url.startsWith("/ads/")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<body>ad</body>"); }
  res.writeHead(200, { "content-type": "image/gif" });
  res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "jev-ad-")), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  // Find the extension's worker and wait until its chrome.* APIs are live.
  let sw = context.serviceWorkers().find((w) => w.url().endsWith("/src/background.js"));
  while (!sw) {
    const w = await context.waitForEvent("serviceworker");
    if (w.url().endsWith("/src/background.js")) sw = w;
  }
  for (let i = 0; i < 50; i++) {
    const ready = await sw.evaluate(() => Boolean(globalThis.chrome && chrome.storage && chrome.storage.local)).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await sw.evaluate(async (apiUrl) => {
    await chrome.storage.local.set({
      apiKey: "test-key",
      settings: { apiUrl, batchSize: 10, concurrency: 2, debug: true },
    });
  }, `${base}/v1/systemone`);

  const page = await context.newPage();
  page.on("console", (m) => { if (process.env.VERBOSE) console.log("[page]", m.text()); });
  await page.goto(`${base}/page.html`);

  // Wait for the content script to report "done" for this tab.
  const stats = await sw.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const all = await chrome.storage.session.get(null);
      const s = Object.entries(all).find(([k]) => k.startsWith("tab:"));
      if (s && s[1].status === "done") return s[1];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("content script never reported done: " + JSON.stringify(await chrome.storage.session.get(null)));
  });

  assert.equal(stats.errors.length, 0, `errors: ${stats.errors.join("; ")}`);
  assert.ok(seen.requests >= 1, "no requests reached the mock jev");
  assert.ok(stats.scanned >= 10, `only ${stats.scanned} scanned`);
  assert.equal(await page.locator("#ad-banner").count(), 0, "banner ad should be removed");
  assert.equal(await page.locator("#ad-frame").count(), 0, "ad iframe should be removed");
  assert.equal(await page.locator("article.article p.body").count(), 2, "content paragraphs must survive");
  assert.equal(await page.locator("#site-header").count(), 1);
  assert.equal(await page.locator("#site-footer").count(), 1);
  assert.equal(await page.locator(".related").count(), 1);
  assert.equal(stats.removed.length, 2, `removed: ${JSON.stringify(stats.removed)}`);

  // Cache: a reload should classify from cache without new requests.
  const before = seen.requests;
  await page.reload();
  const stats2 = await sw.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const all = await chrome.storage.session.get(null);
      const s = Object.entries(all).find(([k]) => k.startsWith("tab:"));
      if (s && s[1].status === "done" && s[1].cached > 0) return s[1];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("reload never reported cached verdicts");
  });
  assert.equal(seen.requests, before, "reload should hit the verdict cache, not jev");
  assert.equal(stats2.cached, stats2.scanned, "every element should come from cache on reload");
  assert.equal(await page.locator("#ad-banner").count(), 0);

  // Restore puts the ads back.
  const restored = await sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    const tabId = Number(Object.keys(all).find((k) => k.startsWith("tab:")).slice(4));
    return chrome.tabs.sendMessage(tabId, { type: "restore" });
  });
  assert.equal(restored.stats.removed.length, 0);
  assert.equal(await page.locator("#ad-banner").count(), 1, "restore should bring the banner back");
  assert.equal(await page.locator("#ad-frame").count(), 1);

  console.log(`e2e ok: ${stats.scanned} elements over ${stats.requests} requests (${seen.questions} questions), removed ${stats2.removed.length}, reload served ${stats2.cached} from cache, restore worked.`);
} finally {
  await context.close();
  server.close();
}
