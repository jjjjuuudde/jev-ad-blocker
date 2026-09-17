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
  const MAX_HTML = 800;            // outerHTML snippet kept per removed element, for the popup
  const WATCH_DEBOUNCE_MS = 250;   // let a burst of DOM insertions settle before classifying
  const SCROLL_DEBOUNCE_MS = 150;
  const VIEWPORT_MARGIN = 0.1;     // classify a little beyond the visible area (fraction of viewport size)
  const PEEK_MS = 3000;
  const NAV_DEBOUNCE_MS = 800;     // single-page apps change the URL, then fill the page in
  const SETTLE_DELAYS_MS = [0, 1000, 3000]; // extra in-view sweeps after the load event
  const SHOTS_KEPT = 40;           // screenshots kept in the stats (they go through storage.session)

  const state = {
    status: "idle",
    startedAt: 0,
    finishedAt: 0,
    site: location.hostname,
    totalElements: 0,
    capped: false, // the per-load element cap stopped the pass early
    scanned: 0,
    late: 0,       // elements classified after the initial pass (added by the site later)
    cached: 0,
    requests: 0,
    removed: [],   // { key, id, summary, p, action, html, shot }  (p is null for a collapsed wrapper; key indexes records)
    skipped: [],   // confident verdicts we refused to act on, with reason
    errors: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const records = [];            // { el, parent, next, prevDisplay, prevOutline, prevTitle, action }
  const takenOut = new Set();    // elements we removed or hid (for the empty-wrapper check)
  let seen = new WeakSet();      // elements already classified in this page's lifetime
  let running = false;
  let paused = false;            // after "restore": leave the page alone until a rescan
  let nextId = 0;
  let observer = null;
  let pendingRoots = new Set();
  let watchTimer = 0;
  let scrollTimer = 0;
  let scrollHooked = false;
  let resizeObserver = null;
  let peeking = null;            // { rec, timer } while an element is temporarily shown
  let queuedRun = false;         // a full pass was asked for while one was running
  let lastHref = location.href;
  let navTimer = 0;

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
    if (msg.type === "peek") { sendResponse({ ok: peek(msg.key) }); return false; }
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
    const removed = state.removed.slice(-200);
    const cut = removed.length - SHOTS_KEPT;
    return {
      ...state,
      removed: removed.map((r, i) => (i < cut && r.shot ? { ...r, shot: null } : r)),
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
      unhookScroll();
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

  // Full pass over the whole page (page load, URL change, or "Rescan" from the popup).
  async function run(reason) {
    if (running) { queuedRun = true; return; }
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
      if (ctx.settings.viewportOnly) hookScroll(); else unhookScroll();
      requestCapture(ctx.settings);
      const candidates = collect(ctx.settings, [document.body]);
      state.totalElements = candidates.total;
      state.capped = candidates.capped;
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
      if (queuedRun) {
        queuedRun = false;
        run("queued").catch(() => {});
      } else if (pendingRoots.size) scheduleIncremental();
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
      requestCapture(ctx.settings);
      const candidates = collect(ctx.settings, roots);
      state.totalElements = candidates.total;
      state.capped = state.capped || candidates.capped;
      state.late += candidates.items.length;
      if (ctx.settings.debug) console.log(`[jev-ad] incremental: ${candidates.items.length} new elements to classify`, candidates.items);
      await classifyAll(ctx, candidates);
      state.status = "done";
    } catch (err) {
      state.status = "error";
      state.errors.push(err.message || String(err));
    } finally {
      state.finishedAt = Date.now();
      running = false;
      await report();
      if (queuedRun) {
        queuedRun = false;
        run("queued").catch(() => {});
      } else if (pendingRoots.size) scheduleIncremental();
    }
  }

  async function classifyAll({ settings, page }, candidates) {
    // Likely ads first, so they go in the first round trip instead of waiting
    // behind hundreds of ordinary elements.
    const items = candidates.items.map((it, i) => ({ it, i })).sort((a, b) => (b.it.priority - a.it.priority) || (a.i - b.i)).map((x) => x.it);
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
          const hits = [];
          for (const it of batch) {
            const p = res.probabilities[it.id] ?? 0;
            if (settings.debug) console.log(`[jev-ad] ${p.toFixed(3)} ${it.summary}`, it.el);
            if (p >= settings.threshold && it.el.isConnected) hits.push({ it, p });
          }
          if (!hits.length) continue;
          const entries = hits.map((h) => act(h.it, h.p, settings, candidates.textTotal));
          // The thumbnails come from the capture taken at pass start, cropped to
          // where each element was; removal doesn't wait for them.
          if (settings.screenshots && settings.action !== "outline") cropShots(hits, entries).catch(() => {});
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

  // Viewport-only mode: as the user scrolls, elements that come into view are
  // classified in an incremental pass (anything already classified is skipped).
  // Capture phase: scroll events don't bubble, and many sites scroll an inner
  // container rather than the window. A ResizeObserver on <body> catches
  // layout changes that happen without a DOM change (an ad slot growing once
  // its iframe loads, a lazy image getting its size).
  function hookScroll() {
    if (scrollHooked) return;
    scrollHooked = true;
    addEventListener("scroll", onScroll, { passive: true, capture: true });
    addEventListener("resize", onScroll, { passive: true });
    if (typeof ResizeObserver === "function" && document.body) {
      resizeObserver = new ResizeObserver(onScroll);
      resizeObserver.observe(document.body);
    }
  }

  function unhookScroll() {
    if (!scrollHooked) return;
    scrollHooked = false;
    removeEventListener("scroll", onScroll, { capture: true });
    removeEventListener("resize", onScroll);
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    clearTimeout(scrollTimer);
    scrollTimer = 0;
  }

  function onScroll() {
    if (paused) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = 0;
      if (document.body) pendingRoots.add(document.body);
      scheduleIncremental();
    }, SCROLL_DEBOUNCE_MS);
  }

  // Sites often add an ad in several steps (wrapper, then iframe, then its
  // contents); wait for the burst to settle before classifying.
  function scheduleIncremental() {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => { watchTimer = 0; runIncremental().catch(() => {}); }, WATCH_DEBOUNCE_MS);
  }

  // ---------- single-page navigation ----------

  // Sites like YouTube swap the page without a load event. Watch the URL
  // (popstate/hashchange, plus a poll for pushState, which content scripts
  // can't hook) and treat a change as a new page: full rescan.
  function watchUrl() {
    const check = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      clearTimeout(navTimer);
      navTimer = setTimeout(() => { navTimer = 0; run("navigate").catch(() => {}); }, NAV_DEBOUNCE_MS);
    };
    addEventListener("popstate", check);
    addEventListener("hashchange", check);
    setInterval(check, 500);
  }

  // ---------- screenshots ----------

  // The worker captures the visible tab once at the start of a pass (not
  // awaited: removal must not wait on it). Each removed element is later
  // cropped out of that capture at the rect it had when collected, which is
  // the same moment the capture was taken.
  function requestCapture(settings) {
    if (!settings.screenshots || settings.action === "outline") return;
    send({ type: "capture" }).catch(() => {});
  }

  function visibleRect(r) {
    const left = Math.max(0, r.left), top = Math.max(0, r.top);
    const right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    if (right - left < 8 || bottom - top < 8) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  async function cropShots(hits, entries) {
    const rects = hits.map((h) => h.it.rect);
    if (!rects.some(Boolean)) return;
    const res = await send({ type: "cropRegions", rects, dpr: devicePixelRatio || 1 });
    const shots = res.shots || [];
    entries.forEach((entry, i) => { if (entry && shots[i]) entry.shot = shots[i]; });
    report();
  }

  // ---------- element collection ----------

  function collect(settings, roots) {
    const total = document.body ? document.body.querySelectorAll("*").length : 0;
    const textTotal = document.body ? normText(document.body.textContent).length : 0;
    const items = [];
    let capped = false;
    const view = settings.viewportOnly ? viewportBox() : null;
    for (const root of roots) {
      if (!root || !root.isConnected) continue;
      const list = root === document.body ? root.querySelectorAll("*") : [root, ...root.querySelectorAll("*")];
      for (const el of list) {
        if (settings.maxElements > 0 && items.length >= settings.maxElements) { capped = true; break; }
        if (seen.has(el)) continue;
        if (shouldSkip(el)) continue;
        if (view && !inView(el, view)) continue; // not marked seen: it gets its turn when scrolled to
        seen.add(el);
        const desc = describe(el);
        const id = `e${nextId++}`;
        items.push({ el, id, desc, sig: signature(desc), summary: summarize(el, desc), rect: visibleRect(el.getBoundingClientRect()), priority: adPriority(desc) });
      }
    }
    return { items, total, textTotal, capped };
  }

  // Rough "how much does this smell like an ad" score used only to order the
  // queue; jev still makes the call.
  function adPriority(d) {
    if (d.dataAd || (d.attrHints && d.attrHints.length)) return 3;
    if (d.tag === "iframe") return 3;
    const here = location.hostname;
    const offSite = (hosts) => (hosts || []).some((h) => h && h !== here && !here.endsWith(`.${h}`) && !h.endsWith(`.${here}`));
    if (d.iframeHosts && d.iframeHosts.length) return 2;
    if (offSite(d.linkHosts) || offSite(d.imgHosts)) return 1;
    return 0;
  }

  function viewportBox() {
    const mx = innerWidth * VIEWPORT_MARGIN;
    const my = innerHeight * VIEWPORT_MARGIN;
    return { left: -mx, top: -my, right: innerWidth + mx, bottom: innerHeight + my };
  }

  // getBoundingClientRect is viewport-relative, so fixed/sticky elements count as in view.
  function inView(el, box) {
    const r = el.getBoundingClientRect();
    return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
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

  // Returns the popup entry for the removed element (null if nothing was done).
  function act(item, p, settings, textTotal) {
    const el = item.el;
    if (!el.isConnected) return null;
    if (el === document.body || el === document.documentElement) return null;
    const ownText = normText(el.textContent).length;
    if (textTotal > 200 && ownText / textTotal > settings.maxTextShare) {
      state.skipped.push({ id: item.id, summary: item.summary, p, reason: `holds ${Math.round((ownText / textTotal) * 100)}% of the page text` });
      return null;
    }
    const parent = el.parentElement;
    const key = takeOut(el, settings.action, `jev ad blocker: ad, p=${p.toFixed(2)}`);
    const entry = { key, id: item.id, summary: item.summary, p: Number(p.toFixed(3)), action: settings.action, html: htmlSnippet(el), shot: null };
    state.removed.push(entry);
    // In outline mode the ad stays on the page, so its wrapper is never empty.
    if (settings.collapseEmptyWrappers && settings.action !== "outline") collapseEmptyAncestors(parent, settings.action);
    return entry;
  }

  // Remove, hide, or (for testing) outline one element, remembering enough to
  // put it back. Returns the record index, which the popup uses for "Show".
  function takeOut(el, action, label) {
    const rec = { el, parent: el.parentNode, next: el.nextSibling, prevDisplay: el.style.display, prevOutline: el.style.outline, prevOutlineOffset: el.style.outlineOffset, prevTitle: el.getAttribute("title"), action };
    if (action === "hide") {
      el.style.setProperty("display", "none", "important");
    } else if (action === "outline") {
      outline(el, true);
      if (label) el.title = label;
    } else {
      el.remove();
    }
    records.push(rec);
    takenOut.add(el);
    return records.length - 1;
  }

  function outline(el, on) {
    if (on) {
      el.style.setProperty("outline", "3px solid #e11d48", "important");
      el.style.setProperty("outline-offset", "-3px", "important");
    } else {
      el.style.outline = "";
      el.style.outlineOffset = "";
    }
  }

  function htmlSnippet(el) {
    const html = el.outerHTML.replace(/\s+/g, " ");
    return html.length > MAX_HTML ? html.slice(0, MAX_HTML) + "…" : html;
  }

  // "Show" in the popup: bring a removed element back for a few seconds with a
  // red outline, scrolled into view, then take it out again.
  function peek(key) {
    const rec = records[key];
    if (!rec) return false;
    if (peeking) endPeek();
    // If the ad's wrapper(s) were collapsed as well, they have to come back
    // first (outermost first) or there is nowhere to put the ad.
    const chain = [];
    for (let r = rec; r; r = r.action === "remove" && r.parent && !r.parent.isConnected ? records.find((o) => o.el === r.parent) : null) chain.unshift(r);
    if (chain[0].action === "remove" && (!chain[0].parent || !chain[0].parent.isConnected)) return false;
    try {
      if (observer) observer.disconnect();
      for (const r of chain) {
        if (r.action === "hide") r.el.style.display = r.prevDisplay;
        else if (r.action === "remove") {
          if (r.next && r.next.parentNode === r.parent) r.parent.insertBefore(r.el, r.next);
          else r.parent.appendChild(r.el);
        }
      }
      outline(rec.el, true);
      rec.el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch { return false; } finally {
      if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true });
    }
    peeking = { chain, timer: setTimeout(endPeek, PEEK_MS) };
    return true;
  }

  function endPeek() {
    if (!peeking) return;
    const { chain, timer } = peeking;
    clearTimeout(timer);
    peeking = null;
    if (!records.includes(chain[chain.length - 1])) return; // restored meanwhile; leave it as it is
    try {
      if (observer) observer.disconnect();
      for (const r of [...chain].reverse()) { // innermost first
        if (r.action === "outline") continue;   // outline is its normal state
        outline(r.el, false);
        if (r.action === "hide") r.el.style.setProperty("display", "none", "important");
        else if (r.el.isConnected) r.el.remove();
      }
    } catch { /* gone */ } finally {
      if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true });
    }
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
      const html = htmlSnippet(p);
      const key = takeOut(p, action);
      state.removed.push({ key, id: "", summary: `${shortName(p)} (empty wrapper)`, p: null, action, html });
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
      if (child.nodeType !== 1) continue;
      if (takenOut.has(child) && !child.isConnected) continue;       // removed
      if (takenOut.has(child) && child.style.display === "none") continue; // hidden
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
    if (peeking) { clearTimeout(peeking.timer); peeking = null; }
    if (observer) observer.disconnect();
    for (const rec of records.reverse()) {
      try {
        rec.el.style.outline = rec.prevOutline || "";
        rec.el.style.outlineOffset = rec.prevOutlineOffset || "";
        if (rec.action === "outline") {
          if (rec.prevTitle == null) rec.el.removeAttribute("title"); else rec.el.setAttribute("title", rec.prevTitle);
        } else if (rec.action === "hide") {
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

  // Sweep the page for rendered, in-view elements that haven't been classified
  // yet. Cheap (already-classified elements are skipped), so it's safe to run
  // a few times while a page settles.
  function sweep() {
    if (paused || !document.body) return;
    pendingRoots.add(document.body);
    scheduleIncremental();
  }

  function start() {
    watchUrl();
    // Back/forward can restore a page from the cache with no load event.
    addEventListener("pageshow", (e) => { if (e.persisted) run("bfcache").catch(() => {}); });
    // Don't wait for window.load: on heavy pages it can be many seconds away.
    // The DOM is parsed at document_idle, so start now and let the watcher,
    // the scroll handler and the settle sweeps pick up what renders later
    // (ad slots that get their size once an iframe or image lands, etc.).
    run("load").catch(() => {});
    const settle = () => { for (const ms of SETTLE_DELAYS_MS) setTimeout(sweep, ms); };
    if (document.readyState === "complete") settle();
    else addEventListener("load", settle, { once: true });
  }

  // Chrome may prerender a page before the user actually lands on it; nothing
  // is laid out yet, so wait until it becomes the real page.
  if (document.prerendering) addEventListener("prerenderingchange", start, { once: true });
  else start();
})();
