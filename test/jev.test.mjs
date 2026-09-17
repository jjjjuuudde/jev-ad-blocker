import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, parseAnswers, classifyBatch, hashString, costUsd, formatUsd, API_URL, JevError } from "../src/jev.js";

const page = { url: "https://example.com/a", title: "Example" };
const elements = [
  { id: "e0", desc: { tag: "div", text: "Sponsored: buy widgets" } },
  { id: "e1", desc: { tag: "p", text: "Article paragraph" } },
];

test("buildRequest matches the documented System One shape", () => {
  const req = buildRequest({ page, elements });
  assert.equal(req.model, "jev-latest");
  assert.deepEqual(req.state.page, page);
  assert.deepEqual(Object.keys(req.state.elements), ["e0", "e1"]);
  assert.deepEqual(Object.keys(req.questions), ["e0", "e1"]);
  for (const q of Object.values(req.questions)) {
    assert.equal(q.type, "noul");
    assert.ok(q.instructions.length > 20);
    assert.ok(q.criteria.true && q.criteria.false);
  }
  assert.match(req.questions.e1.instructions, /state\.elements\.e1/);
  // Must be plain JSON.
  assert.doesNotThrow(() => JSON.stringify(req));
});

test("parseAnswers reads noul probabilities and defaults the rest to 0", () => {
  const body = {
    model: "jev-1.13",
    answers: { e0: { type: "noul", noul: 0.97 }, e1: null, e2: { type: "choice", choice: "x" } },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  assert.deepEqual(parseAnswers(body, ["e0", "e1", "e2", "e3"]), { e0: 0.97, e1: 0, e2: 0, e3: 0 });
});

test("classifyBatch posts with bearer auth and returns probabilities", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ model: "jev-1.13", answers: { e0: { type: "noul", noul: 0.93 }, e1: { type: "noul", noul: 0.02 } }, usage: { input_tokens: 5, output_tokens: 1 } }) };
  };
  const res = await classifyBatch({ apiKey: "ts-test", page, elements }, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer ts-test");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, "jev-latest");
  assert.deepEqual(res.probabilities, { e0: 0.93, e1: 0.02 });
  assert.equal(res.model, "jev-1.13");
});

test("classifyBatch retries 429/529 with backoff, then succeeds", async () => {
  let n = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, headers: { get: () => null }, text: async () => "slow down" };
    if (n === 2) return { ok: false, status: 529, headers: { get: () => "1" }, text: async () => "overloaded" };
    return { ok: true, status: 200, json: async () => ({ answers: { e0: { type: "noul", noul: 0.5 }, e1: { type: "noul", noul: 0.5 } } }) };
  };
  const res = await classifyBatch({ apiKey: "k", page, elements }, { fetchImpl, sleep: async (ms) => sleeps.push(ms), baseDelayMs: 100 });
  assert.equal(n, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] >= 100 && sleeps[0] < 200);
  assert.equal(sleeps[1], 1000); // honoured Retry-After: 1
  assert.deepEqual(res.probabilities, { e0: 0.5, e1: 0.5 });
});

test("classifyBatch surfaces 401 without retrying", async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 401, headers: { get: () => null }, text: async () => "bad key" }; };
  await assert.rejects(
    classifyBatch({ apiKey: "k", page, elements }, { fetchImpl, sleep: async () => {} }),
    (err) => err instanceof JevError && err.status === 401 && /API key/.test(err.message)
  );
  assert.equal(n, 1);
});

test("classifyBatch refuses to run without a key", async () => {
  await assert.rejects(classifyBatch({ apiKey: "", page, elements }), /No jev API key/);
});

test("hashString is stable and hex", () => {
  assert.equal(hashString("abc"), hashString("abc"));
  assert.notEqual(hashString("abc"), hashString("abd"));
  assert.match(hashString("anything"), /^[0-9a-f]{8}$/);
});

test("costUsd and formatUsd follow jev's list price ($0.042/MTok in, output free)", () => {
  assert.equal(costUsd(null), 0);
  assert.equal(costUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0.042);
  assert.equal(costUsd({ input_tokens: 500_000 }), 0.021);
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(0.00001), "<$0.0001");
  assert.equal(formatUsd(0.0021), "$0.0021");
  assert.equal(formatUsd(0.021), "$0.021");
  assert.equal(formatUsd(1.5), "$1.50");
});
