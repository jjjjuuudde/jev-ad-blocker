import { getSettings, saveSettings } from "./settings.js";
import { costUsd, formatUsd } from "./jev.js";

const $ = (id) => document.getElementById(id);
let tab = null;
let host = "";

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).hostname; } catch { host = ""; }
  $("site").textContent = host || "(no site)";
  $("site").title = tab.url || "";

  settings = await getSettings();
  $("siteToggle").checked = settings.enabled && !settings.disabledSites.includes(host);
  $("siteToggle").disabled = !host;

  const cfg = await ask({ type: "getConfig" });
  if (cfg && !cfg.hasKey) {
    $("errors").textContent = "No jev API key yet. Paste it into .env and run `npm run sync-key`, or set it on the options page.";
  } else if (cfg && cfg.keyTail) {
    $("key").textContent = `key …${cfg.keyTail}${cfg.keySource ? ` (${cfg.keySource})` : ""}`;
    $("key").title = "The API key the worker is sending to jev, and where it came from";
  }
  await refresh();
}

async function refresh() {
  const res = await askTab({ type: "getStats" });
  if (!res) {
    $("status").textContent = "The extension is not running on this page (reload the tab after installing).";
    return;
  }
  render(res.stats);
}

let settings = {};
function render(s) {
  const labels = {
    idle: "Starting...",
    scanning: "Scanning...",
    done: "Done, watching",
    disabled: "Disabled on this site",
    "no-key": "No API key",
    error: "Failed",
  };
  $("status").innerHTML = `<span>${labels[s.status] || s.status}</span><span>${s.requests} request${s.requests === 1 ? "" : "s"}</span>`;
  const capped = Boolean(s.capped);
  $("counts").textContent =
    `${s.scanned} element${s.scanned === 1 ? "" : "s"} classified${settings.viewportOnly ? " in view" : ""}` +
    (s.cached ? ` (${s.cached} from cache)` : "") +
    (s.late ? ` (${s.late} added after load)` : "") +
    ` of ${s.totalElements} on the page` +
    (capped ? " (capped, raise the limit in options)" : "") +
    `. ${s.removed.length} ${s.removed.length && s.removed[0].action === "outline" ? "outlined" : "removed"}.`;
  $("errors").textContent = s.errors.length ? s.errors.join("\n") : "";
  $("hint").textContent = s.removed.length && s.removed[0].action === "outline"
    ? "Outline mode: ads stay on the page with a red border. Switch the action in options to remove them."
    : "";
  renderCost(s.usage);

  const wrap = $("removedWrap");
  wrap.innerHTML = "";
  if (s.removed.length) {
    const ul = document.createElement("ul");
    for (const r of s.removed) {
      const li = document.createElement("li");
      li.innerHTML = r.p == null ? `<b>wrap</b> ` : `<b>${(r.p * 100).toFixed(0)}%</b> `;
      li.append(document.createTextNode(r.summary));
      if (r.shot) {
        const img = document.createElement("img");
        img.src = r.shot;
        img.alt = "screenshot of the removed element";
        img.className = "shot";
        li.append(img);
      }
      if (r.key != null) {
        const show = document.createElement("button");
        show.textContent = "Show";
        show.title = "Put it back on the page for 3 seconds with a red outline, scrolled into view";
        show.addEventListener("click", () => askTab({ type: "peek", key: r.key }));
        li.append(show);
      }
      if (r.html) {
        const det = document.createElement("details");
        const sum = document.createElement("summary");
        sum.textContent = "HTML";
        const pre = document.createElement("pre");
        pre.textContent = r.html;
        det.append(sum, pre);
        li.append(det);
      }
      ul.append(li);
    }
    wrap.append(ul);
  }
  if (s.skipped.length) {
    const p = document.createElement("div");
    p.className = "warn";
    p.textContent = `${s.skipped.length} confident verdict${s.skipped.length === 1 ? "" : "s"} skipped by the safety rail: ` +
      s.skipped.map((k) => `${k.summary} (${k.reason})`).join("; ");
    wrap.append(p);
  }
  $("restore").disabled = !s.removed.length;
  $("rescan").disabled = s.status === "scanning";
  if (s.status === "scanning") setTimeout(refresh, 800);
}

$("siteToggle").addEventListener("change", async (e) => {
  const settings = await getSettings();
  const set = new Set(settings.disabledSites);
  if (e.target.checked) set.delete(host); else set.add(host);
  await saveSettings({ disabledSites: [...set], enabled: true });
  if (e.target.checked) await askTab({ type: "rescan" });
  else await askTab({ type: "restore" });
  setTimeout(refresh, 300);
});
$("rescan").addEventListener("click", async () => { await askTab({ type: "rescan" }); setTimeout(refresh, 300); });
$("restore").addEventListener("click", async () => { await askTab({ type: "restore" }); refresh(); });
$("options").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

function ask(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
  });
}
function askTab(msg) {
  if (!tab) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, msg, (res) => resolve(chrome.runtime.lastError ? null : res));
  });
}
// What this page's classification cost, from the token counts jev returned.
function renderCost(usage) {
  const tokens = usage ? usage.input_tokens || 0 : 0;
  $("cost").textContent = tokens ? `Cost: ${formatUsd(costUsd(usage))} (${fmt(tokens)} input tokens)` : "Cost: $0";
}

function fmt(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

init();
