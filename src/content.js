// Content script: walks every rendered element on the page, describes each one,
// ships the descriptions to the worker (which asks jev), and removes the
// elements jev is confident are ads. Runs once at page load, then keeps
// watching the DOM so elements the site adds later (refreshing ad slots,
// lazy-loaded units) get classified too. The popup can trigger a full rescan
// or restore what was removed.
(() => {
  if (window.__jevAdBlocker) return;
  window.__jevAdBlocker = true;

  const SKIP_TAGS = new Set([
    "html", "head", "body", "script", "style", "noscript", "template", "meta", "link",
    "title", "base", "br", "wbr", "option", "optgroup", "colgroup", "col", "param",
    "source", "track", "area", "map", "datalist", "slot",
  ]);
  const HINT_RE = /\b(ad|ads|advert|advertis|adsbygoogle|sponsor|promo|promoted|banner|doubleclick|googlesyndication|taboola|outbrain|adnxs|criteo|amazon-adsystem|mgid|revcontent|native)\b|_ad_|-ad-|\bad[-_]?(slot|unit|wrapper|container|box|frame)/i;
  // Tags that count as "real content" when deciding whether a wrapper is empty.
  const MEDIA_TAGS = new Set(["img", "iframe", "video", "audio", "canvas", "picture", "object", "embed", "input", "select", "textarea"]);
  const MAX_TEXT = 200;
  const MAX_ATTR = 120;
  const WATCH_DEBOUNCE_MS = 600;

  const state = {
    status: "idle",
    startedAt: 0,
    finishedAt: 0,
    site: location.hostname,
    totalElements: 0,
    scanned: 0,
    late: 0,       // elements classified after the initial pass (added by the site later)
    cached: 0,
    requests: 0,
    removed: [],   // { id, summary, p, action }  (p is null for a collapsed wrapper)
    skipped: [],   // confident verdicts we refused to act on, with reason
    errors: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const records = [];            // { el, parent, next, prevDisplay, action }
  const takenOut = new Set();    // elements we removed or hid (for the empty-wrapper check)
  let seen = new WeakSet();      // elements already classified in this page's lifetime
  let running = false;
  let paused = false;            // after "restore": leave the page alone until a rescan
  let nextId = 0;
  let observer = null;
  let pendingRoots = new Set();
  let watchTimer = 0;

  // ---------- messaging ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.type === "getStats") { sendResponse({ ok: true, stats: snapshot() }); return false; }
    if (msg.type === "restore") { restoreAll(); sendResponse({ ok: true, stats: snapshot() }); return false; }
    if (msg.type === "rescan") {
      run("rescan").catch(() => {});
      sendResponse({ ok: true, stats: snapshot() });
      return false;
    }
    return false;
  });

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error("No response from the extension worker"));
          if (!res.ok) return reject(new Error(res.error || "Unknown worker error"));
          resolve(res);
        });
      } catch (err) { reject(err); }
    });
  }

  function snapshot() {
    return {
      ...state,
      removed: state.removed.slice(-200),
      skipped: state.skipped.slice(-50),
      errors: state.errors.slice(-10),
    };
  }

  async function report() {
    try { await send({ type: "report", stats: snapshot() }); } catch { /* worker unavailable */ }
  }

  // ---------- passes ----------

  // Fetch settings and decide whether we should do anything on this page.
  async function prepare() {
    const cfg = await send({ type: "getConfig" });
    const settings = cfg.settings;
    if (!settings.enabled || settings.disabledSites.includes(location.hostname)) {
      state.status = "disabled";
      stopWatching();
      return null;
    }
    if (!cfg.hasKey) {
      state.status = "no-key";
      state.errors.push("No jev API key configured");
      return null;
    }
    const page = { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight } };
    return { settings, page };
  }

  // Full pass over the whole page (page load, or "Rescan" from the popup).
  async function run(reason) {
    if (running) return;
    running = true;
    paused = false;
    seen = new WeakSet();
    state.status = "scanning";
    state.startedAt = Date.now();
    state.finishedAt = 0;
    state.errors = [];
    state.scanned = 0;
    state.late = 0;
    state.cached = 0;
    state.requests = 0;
    state.usage = { input_tokens: 0, output_tokens: 0 };
    try {
      const ctx = await prepare();
      if (!ctx) return;
      // Watch from the start so nodes the site adds during the pass are queued
      // (they run as an incremental pass once this one finishes).
      if (ctx.settings.watchDom) startWatching(); else stopWatching();
      const candidates = collect(ctx.settings, [document.body]);
      state.totalElements = candidates.total;
      if (ctx.settings.debug) console.log(`[jev-ad] ${reason}: ${candidates.items.length} of ${candidates.total} elements to classify`, candidates.items);
      await classifyAll(ctx, candidates);
      state.status = "done";
    } catch (err) {
      state.status = "error";
      state.errors.push(err.message || String(err));
    } finally {
      state.finishedAt = Date.now();
      running = false;
      await report();
      if (pendingRoots.size) scheduleIncremental();
    }
  }

  // Incremental pass over subtrees the site added after the initial pass.
  async function runIncremental() {
    if (running || paused) return;
    const roots = [...pendingRoots].filter((el) => el.isConnected && !seen.has(el));
    pendingRoots = new Set();
    if (!roots.length) return;
    running = true;
    state.status = "scanning";
    try {
      const ctx = await prepare();
      if (!ctx) return;
      const candidates = collect(ctx.settings, roots);
      state.totalElements = candidates.total;
      state.late += candidates.items.length;
      if (ctx.settings.debug) console.log(`[jev-ad] dom change: ${candidates.items.length} new elements to classify`, candidates.items);
      await classifyAll(ctx, candidates);
      state.status = "done";
    } catch (err) {
      state.status = "error";
      state.errors.push(err.message || String(err));
    } finally {
      state.finishedAt = Date.now();
      running = false;
      await report();
      if (pendingRoots.size) scheduleIncremental();
    }
  }

  async function classifyAll({ settings, page }, candidates) {
    const items = candidates.items;
    const batches = [];
    for (let i = 0; i < items.length; i += settings.batchSize) batches.push(items.slice(i, i + settings.batchSize));

    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        // Elements inside something already removed are gone; don't pay to classify them.
        const batch = batches[cursor++].filter((it) => it.el.isConnected);
        if (!batch.length) continue;
        try {
          const res = await send({
            type: "classify",
            page,
            elements: batch.map((it) => ({ id: it.id, desc: it.desc, sig: it.sig })),
          });
          state.requests += 1;
          state.cached += res.cached || 0;
          state.scanned += batch.length;
          if (res.usage) {
            state.usage.input_tokens += res.usage.input_tokens || 0;
            state.usage.output_tokens += res.usage.output_tokens || 0;
          }
          for (const it of batch) {
            const p = res.probabilities[it.id] ?? 0;
            if (settings.debug) console.log(`[jev-ad] ${p.toFixed(3)} ${it.summary}`, it.el);
            if (p >= settings.threshold) act(it, p, settings, candidates.textTotal);
          }
        } catch (err) {
          state.errors.push(err.message || String(err));
          if (settings.debug) console.warn("[jev-ad] batch failed", err);
          if (/API key|401/.test(err.message || "")) cursor = batches.length; // no point continuing
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, settings.concurrency) }, worker));
  }

  // ---------- watching for elements added after load ----------

  function startWatching() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (paused) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && !seen.has(node) && !takenOut.has(node)) pendingRoots.add(node);
        }
      }
      if (pendingRoots.size) scheduleIncremental();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopWatching() {
    if (observer) observer.disconnect();
    observer = null;
    pendingRoots = new Set();
    clearTimeout(watchTimer);
    watchTimer = 0;
  }

  // Sites often add an ad in several steps (wrapper, then iframe, then its
  // contents); wait for the burst to settle before classifying.
  function scheduleIncremental() {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => { watchTimer = 0; runIncremental().catch(() => {}); }, WATCH_DEBOUNCE_MS);
  }

  // ---------- element collection ----------

  function collect(settings, roots) {
    const total = document.body ? document.body.querySelectorAll("*").length : 0;
    const textTotal = document.body ? normText(document.body.textContent).length : 0;
    const items = [];
    for (const root of roots) {
      if (!root || !root.isConnected) continue;
      const list = root === document.body ? root.querySelectorAll("*") : [root, ...root.querySelectorAll("*")];
      for (const el of list) {
        if (settings.maxElements > 0 && items.length >= settings.maxElements) break;
        if (seen.has(el)) continue;
        seen.add(el);
        if (shouldSkip(el)) continue;
        const desc = describe(el);
        const id = `e${nextId++}`;
        items.push({ el, id, desc, sig: signature(desc), summary: summarize(el, desc) });
      }
    }
    return { items, total, textTotal };
  }

  function shouldSkip(el) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml" && tag !== "svg") return true; // svg internals, MathML
    if (tag !== "svg" && el.closest("svg")) return true;
    if (takenOut.has(el)) return true;
    if (!el.isConnected) return true;
    if (el.getClientRects().length === 0) return true; // display:none or otherwise not rendered
    return false;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const d = {
      tag,
      size: { w: Math.round(rect.width), h: Math.round(rect.height) },
      position: { top: Math.round(rect.top + scrollY), left: Math.round(rect.left + scrollX) },
    };
    const attr = (name) => {
      const v = el.getAttribute(name);
      return v ? v.slice(0, MAX_ATTR) : "";
    };
    if (el.id) d.id = el.id.slice(0, MAX_ATTR);
    if (el.className && typeof el.className === "string") d.class = el.className.trim().replace(/\s+/g, " ").slice(0, MAX_ATTR);
    for (const name of ["role", "aria-label", "title", "alt", "name"]) {
      const v = attr(name);
      if (v) d[name] = v;
    }
    if (tag === "a") d.href = hostOf(el.href);
    if (tag === "img" || tag === "iframe" || tag === "video") d.src = hostOf(el.currentSrc || el.src || attr("data-src"));
    const dataAd = attr("data-ad-client") || attr("data-ad-slot") || attr("data-google-query-id");
    if (dataAd) d.dataAd = dataAd;

    // Attribute names/values that smell like ad markup.
    const hints = [];
    for (const a of el.attributes) {
      if (hints.length >= 6) break;
      if (HINT_RE.test(a.name) || HINT_RE.test(a.value)) hints.push(`${a.name}=${a.value.slice(0, 60)}`);
    }
    if (hints.length) d.attrHints = hints;

    // Where descendant links, images and frames point (skipped for huge wrappers).
    const descendants = el.getElementsByTagName("*").length;
    d.descendants = descendants;
    if (descendants > 0 && descendants <= 200) {
      const hosts = { link: new Set(), img: new Set(), iframe: new Set() };
      for (const c of el.querySelectorAll("a[href], img, iframe[src]")) {
        const ct = c.tagName.toLowerCase();
        const h = hostOf(ct === "a" ? c.href : c.currentSrc || c.src);
        if (!h) continue;
        const set = ct === "a" ? hosts.link : ct === "img" ? hosts.img : hosts.iframe;
        if (set.size < 5) set.add(h);
      }
      if (hosts.link.size) d.linkHosts = [...hosts.link];
      if (hosts.img.size) d.imgHosts = [...hosts.img];
      if (hosts.iframe.size) d.iframeHosts = [...hosts.iframe];
    }

    const text = normText(el.textContent);
    if (text) {
      d.text = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "..." : text;
      d.textLength = text.length;
    }

    const chain = [];
    let p = el.parentElement;
    while (p && chain.length < 4 && p !== document.body && p !== document.documentElement) {
      chain.push(shortName(p));
      p = p.parentElement;
    }
    if (chain.length) d.ancestors = chain;
    return d;
  }

  // Cache key: what the element is, not where it sits or how big it rendered
  // (sizes shift while images load), so the verdict survives reloads.
  function signature(d) {
    const parts = [
      location.hostname, d.tag, d.id || "", d.class || "", d.role || "", d.href || "", d.src || "",
      d.dataAd || "", (d.attrHints || []).join("|"), (d.linkHosts || []).join(","),
      (d.imgHosts || []).join(","), (d.iframeHosts || []).join(","), (d.text || "").slice(0, 100),
      (d.ancestors || []).join(">"),
    ];
    return fnv1a(parts.join("|"));
  }

  function summarize(el, d) {
    const bits = [shortName(el)];
    if (d.src) bits.push(`src=${d.src}`);
    if (d.text) bits.push(JSON.stringify(d.text.slice(0, 60)));
    return bits.join(" ");
  }

  // ---------- acting on verdicts ----------

  function act(item, p, settings, textTotal) {
    const el = item.el;
    if (!el.isConnected) return;
    if (el === document.body || el === document.documentElement) return;
    const ownText = normText(el.textContent).length;
    if (textTotal > 200 && ownText / textTotal > settings.maxTextShare) {
      state.skipped.push({ id: item.id, summary: item.summary, p, reason: `holds ${Math.round((ownText / textTotal) * 100)}% of the page text` });
      return;
    }
    const parent = el.parentElement;
    takeOut(el, settings.action);
    state.removed.push({ id: item.id, summary: item.summary, p: Number(p.toFixed(3)), action: settings.action });
    if (settings.collapseEmptyWrappers) collapseEmptyAncestors(parent, settings.action);
  }

  // Remove or hide one element, remembering enough to put it back.
  function takeOut(el, action) {
    const rec = { el, parent: el.parentNode, next: el.nextSibling, prevDisplay: el.style.display, action };
    if (action === "hide") {
      el.style.setProperty("display", "none", "important");
    } else {
      el.remove();
    }
    records.push(rec);
    takenOut.add(el);
  }

  // An ad usually sits in a wrapper the site styled (fixed bar, grey box,
  // reserved height). Once the ad is gone, a wrapper with no text or media of
  // its own is just that empty box, so take it out too, walking upward until
  // we hit something that still has content. A removed wrapper also stops a
  // refreshing ad slot: the site's script re-inserts into a detached node.
  function collapseEmptyAncestors(start, action) {
    let p = start;
    while (p && p !== document.body && p !== document.documentElement && p.isConnected) {
      if (hasContent(p)) break;
      const next = p.parentElement;
      takeOut(p, action);
      state.removed.push({ id: "", summary: `${shortName(p)} (empty wrapper)`, p: null, action });
      p = next;
    }
  }

  // True if the node still holds visible text or media, ignoring what we hid.
  function hasContent(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.nodeValue.trim()) return true;
        continue;
      }
      if (child.nodeType !== 1 || takenOut.has(child)) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "template" || tag === "noscript") continue;
      if (MEDIA_TAGS.has(tag) && child.getClientRects().length > 0) return true;
      if (hasContent(child)) return true;
    }
    return false;
  }

  function restoreAll() {
    // Pause watching first, so the elements we put back aren't classified again
    // (the cache would just remove them a second later).
    paused = true;
    if (observer) observer.disconnect();
    for (const rec of records.reverse()) {
      try {
        if (rec.action === "hide") {
          rec.el.style.display = rec.prevDisplay;
        } else if (rec.parent && rec.parent.isConnected) {
          if (rec.next && rec.next.parentNode === rec.parent) rec.parent.insertBefore(rec.el, rec.next);
          else rec.parent.appendChild(rec.el);
        }
      } catch { /* node is gone for good */ }
    }
    records.length = 0;
    takenOut.clear();
    pendingRoots = new Set();
    state.removed = [];
    state.skipped = [];
    if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true });
    report();
  }

  // ---------- helpers ----------

  function hostOf(url) {
    if (!url) return "";
    try { return new URL(url, location.href).hostname; } catch { return ""; }
  }
  function normText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function shortName(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id.slice(0, 40)}`;
    if (typeof el.className === "string" && el.className.trim()) s += "." + el.className.trim().split(/\s+/).slice(0, 3).join(".").slice(0, 60);
    return s;
  }
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // ---------- go ----------

  if (document.readyState === "complete") run("load");
  else window.addEventListener("load", () => run("load"), { once: true });
})();
