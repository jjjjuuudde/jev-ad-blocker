// Thin client for jev's System One endpoint.
// Docs: https://docs.typesafe.ai/api  (POST https://api.typesafe.ai/v1/systemone)
//
// One request carries the page state plus one noul ("yes/no") question per
// element, so a whole batch of elements is classified in a single round trip
// (https://docs.typesafe.ai/patterns/fan-out). A noul answer is the probability
// that the answer is "yes"; it has no separate confidence field, so the
// probability itself is what we threshold on.

export const API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

// List price from https://docs.typesafe.ai/models: $0.042 per million input
// tokens, output tokens free. The API reports token counts, not dollars, so
// cost is computed client-side from these.
export const PRICING = { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 };

/** Dollars for a usage object ({ input_tokens, output_tokens }); 0 for null. */
export function costUsd(usage, pricing = PRICING) {
  if (!usage) return 0;
  const inp = Number(usage.input_tokens) || 0;
  const out = Number(usage.output_tokens) || 0;
  return (inp * pricing.inputUsdPerMTok + out * pricing.outputUsdPerMTok) / 1e6;
}

/** "$0.0021" style string; very small amounts show as "<$0.0001". */
export function formatUsd(usd) {
  if (!(usd > 0)) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

export const AD_CRITERIA = {
  true:
    "The element is, or is the dedicated container of, a paid advertisement: " +
    "a display/banner ad, a sponsored or promoted placement, an ad slot or ad " +
    "iframe (Google Ads, DoubleClick, Taboola, Outbrain, Amazon ads, etc.), a " +
    "native ad or 'recommended for you' promo widget from an advertiser, an " +
    "affiliate promo box, or a 'sponsored' label plus its promoted content. Its " +
    "purpose is to promote an advertiser's product, service, or offer, not to " +
    "deliver the page's own content.",
  false:
    "The element is part of the page's own content, navigation, layout, or UI: " +
    "article text, headings, images that illustrate the content, menus, search " +
    "boxes, comments, footers, cookie or login banners, a shop's own product " +
    "listings, related-articles links from the same site, or a large wrapper " +
    "(page, main column, sidebar) whose main job is layout even if an ad sits " +
    "somewhere inside it.",
};

export function questionFor(elementId) {
  return {
    type: "noul",
    instructions:
      `Look at state.elements.${elementId} (a description of one DOM element on ` +
      `the page described by state.page). Is this element an advertisement that ` +
      `an ad blocker should remove?`,
    criteria: AD_CRITERIA,
  };
}

/** Build the request body for one batch of described elements. */
export function buildRequest({ page, elements, model = DEFAULT_MODEL }) {
  const state = { page, elements: {} };
  const questions = {};
  for (const el of elements) {
    state.elements[el.id] = el.desc;
    questions[el.id] = questionFor(el.id);
  }
  return { model, state, questions };
}

/** Map a response body to { [elementId]: probabilityItIsAnAd }. Missing/null answers become 0. */
export function parseAnswers(body, elementIds) {
  const out = {};
  const answers = (body && body.answers) || {};
  for (const id of elementIds) {
    const a = answers[id];
    const p = a && a.type === "noul" ? Number(a.noul) : NaN;
    out[id] = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  }
  return out;
}

export class JevError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.body = body;
  }
  /** jev's 400 for a request over its input-token ceiling; the caller should split the batch. */
  get tooBig() { return this.status === 400 && /max_tokens_exceeded/.test(String(this.body || "")); }
}

const RETRYABLE = new Set([429, 529, 500, 502, 503, 504]);

/**
 * POST one batch and return { [elementId]: probability, usage }.
 * Retries 429/529 (and transient 5xx) with exponential backoff, as the docs ask.
 */
export async function classifyBatch(
  { apiKey, page, elements, model, apiUrl = API_URL, signal },
  { fetchImpl = globalThis.fetch, maxRetries = 4, baseDelayMs = 500, sleep = defaultSleep } = {}
) {
  if (!apiKey) throw new JevError(0, "No jev API key configured");
  const body = JSON.stringify(buildRequest({ page, elements, model }));
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal,
      });
    } catch (err) {
      if (attempt >= maxRetries || (signal && signal.aborted)) throw err;
      await sleep(backoff(baseDelayMs, attempt++));
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      return { probabilities: parseAnswers(json, elements.map((e) => e.id)), usage: json.usage || null, model: json.model };
    }
    const text = await safeText(res);
    if (RETRYABLE.has(res.status) && attempt < maxRetries) {
      await sleep(backoff(baseDelayMs, attempt++, res.headers && res.headers.get && res.headers.get("retry-after")));
      continue;
    }
    throw new JevError(res.status, describeStatus(res.status, text), text);
  }
}

function backoff(base, attempt, retryAfter) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  const exp = base * 2 ** attempt;
  return exp + Math.random() * exp * 0.25;
}

function describeStatus(status, text) {
  switch (status) {
    case 400: return /max_tokens_exceeded/.test(text) ? "jev request too large (400 max_tokens_exceeded); lower the token budget per request in options." : `jev rejected the request (400): ${trim(text)}`;
    case 401: return "jev rejected the API key (401). Check the key in .env or the options page.";
    case 422: return `jev rejected the request (422): ${trim(text)}`;
    case 429: return "jev rate limit hit (429) and retries were exhausted.";
    case 529: return "jev is overloaded (529) and retries were exhausted.";
    default: return `jev request failed (${status}): ${trim(text)}`;
  }
}

function trim(s) { return String(s || "").slice(0, 300); }
async function safeText(res) { try { return await res.text(); } catch { return ""; } }
function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Token-bucket rate limiter shared by every request the worker sends, so many
 * tabs together stay under jev's 1,200 requests/minute. `acquire()` resolves
 * when a request may go; `pause(ms)` holds everything (used on 429 with
 * Retry-After). Wrap fetch with `limited(fetchImpl)` to apply it to retries too.
 */
export function makeLimiter({ perSecond = 15, burst = perSecond, now = Date.now, sleep = defaultSleep } = {}) {
  let tokens = burst;
  let last = now();
  let pausedUntil = 0;
  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
    last = t;
  };
  const limiter = {
    async acquire() {
      for (;;) {
        const t = now();
        if (t < pausedUntil) { await sleep(pausedUntil - t); continue; }
        refill();
        if (tokens >= 1) { tokens -= 1; return; }
        await sleep(Math.ceil(((1 - tokens) / perSecond) * 1000));
      }
    },
    pause(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); },
    limited(fetchImpl) {
      return async (url, init) => {
        await limiter.acquire();
        const res = await fetchImpl(url, init);
        if (res && res.status === 429) {
          const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
          limiter.pause(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000);
        }
        return res;
      };
    },
  };
  return limiter;
}

/** Cheap, stable string hash for the verdict cache (FNV-1a, 32-bit, hex). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
