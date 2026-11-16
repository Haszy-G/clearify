import assert from 'node:assert';
import {
  buildAnalysisPrompt,
  parseResponse,
  validatePerspectiveCitations,
  callProvider,
} from '../utils/api.js';

const grounded = buildAnalysisPrompt('text body', { title: 'A', source: 'S', url: 'U', author: 'Z' }, '[1] Real outlet — https://www.theguardian.com/story\nSnippet text');
assert.ok(grounded.includes('text body'), 'prompt includes article text');
assert.ok(grounded.includes('Web Coverage'), 'grounded prompt includes coverage section');
assert.ok(grounded.includes('https://www.theguardian.com/story'), 'coverage URL is embedded');
assert.ok(grounded.includes('EXACT URL'), 'prompt demands exact-URL citation');
assert.ok(grounded.includes('Never invent a URL'), 'prompt forbids invented URLs');

const bare = buildAnalysisPrompt('text body', { title: 'A', source: 'S', url: 'U', author: 'Z' });
assert.ok(!bare.includes('Web Coverage'), 'no coverage section when ungrounded');
assert.ok(bare.includes('A') && bare.includes('S') && bare.includes('U'), 'prompt has metadata');
assert.ok(bare.includes('NO live web coverage'), 'ungrounded prompt states that no coverage exists');
assert.ok(bare.includes('Do NOT invent outlets, URLs, headlines, or coverage claims'), 'ungrounded prompt forbids invention');
assert.ok(bare.includes(`'N/A'`), 'ungrounded prompt demands N/A attribution');

assert.deepStrictEqual(parseResponse('{"credibilityScore": 80}'), { credibilityScore: 80 }, 'parses clean JSON');
assert.deepStrictEqual(parseResponse('```json\n{"credibilityScore": 80}\n```'), { credibilityScore: 80 }, 'strips json fences');
assert.deepStrictEqual(parseResponse('{"credibilityScore": 80}\n```'), { credibilityScore: 80 }, 'strips trailing fence');
assert.deepStrictEqual(
  parseResponse('Here you go:\n{"credibilityScore": 80}\nHope that helps!'),
  { credibilityScore: 80 },
  'extracts JSON from surrounding prose'
);
// first balanced object wins — later stray objects are ignored
assert.deepStrictEqual(
  parseResponse('Sure: {"credibilityScore": 80, "framingAnalysis": "frame } brace"} and {"junk": [1,2]} trailing'),
  { credibilityScore: 80, framingAnalysis: 'frame } brace' },
  'braces inside string literals do not break the scan, trailing objects are dropped'
);
assert.throws(
  () => parseResponse('prefix {"credibilityScore": 80'),
  /Could not parse/,
  'truncated JSON (no closing brace) throws'
);
assert.throws(() => parseResponse('not json'), /Could not parse/, 'throws on non-JSON');

// -- validatePerspectiveCitations (anti-hallucination backstop) --------------

const gathered = [
  { title: 'T1', url: 'https://www.reuters.com/story', source: 'Reuters', outletUrl: 'https://www.reuters.com' },
  { title: 'T2', url: 'https://www.bbc.com/story', source: 'BBC', outletUrl: 'https://www.bbc.com' },
];

// exact citations survive; invented links and unverifiable outlets are blanked
const analysis = {
  perspectives: {
    progressive: { source: 'Reuters', url: 'https://www.reuters.com/story', summary: 'grounded' },
    mainstream: { source: 'CNN', url: 'https://www.cnn.com/made-up-article', summary: 'invented link' },
    conservative: { source: 'The Daily Wire', url: 'N/A', summary: 'invented outlet, no link' },
  },
};
validatePerspectiveCitations(analysis, gathered);
assert.equal(analysis.perspectives.progressive.url, 'https://www.reuters.com/story', 'exactly-copied URL is kept');
assert.equal(analysis.perspectives.progressive.source, 'Reuters', 'grounded card untouched');
assert.equal(analysis.perspectives.mainstream.url, 'N/A', 'invented URL is stripped');
assert.equal(analysis.perspectives.mainstream.source, 'N/A', 'outlet behind an invented URL is stripped too');
assert.equal(analysis.perspectives.conservative.source, 'N/A', 'unvouched outlet with no URL is stripped');

// "The " prefix is tolerated when the outlet matches a gathered hostname
const analysis2 = {
  perspectives: {
    progressive: { source: 'The BBC', url: 'N/A', summary: 'x' },
  },
};
validatePerspectiveCitations(analysis2, gathered);
assert.equal(analysis2.perspectives.progressive.source, 'The BBC', 'article-less outlet name matched against hostname');

// a kept URL vouches for its card even if the outlet string is stylized
const analysis3 = {
  perspectives: {
    mainstream: { source: 'Reuters.com News Desk', url: 'https://www.reuters.com/story', summary: 'x' },
  },
};
validatePerspectiveCitations(analysis3, gathered);
assert.equal(analysis3.perspectives.mainstream.source, 'Reuters.com News Desk', 'valid URL kept → source is trusted');

// no results gathered → validator is a no-op (ungrounded run; prompt guards it)
const analysis4 = { perspectives: { progressive: { source: 'Anyone', url: 'https://x.com/y', summary: 's' } } };
validatePerspectiveCitations(analysis4, []);
assert.equal(analysis4.perspectives.progressive.url, 'https://x.com/y', 'empty results → no stripping');

// -- provider request bodies (mocked fetch) -----------------------------------
// Regression lock for the failure fixes: reasoning models must not be allowed
// to burn the shared max_tokens budget, and models that reject response_format
// must never be sent it. Facts per openrouter.ai/api/v1/models.

const realFetch = globalThis.fetch;
let lastBody = null;
let lastHeaders = null;
let calls = 0;
let nextStatus = 200; // one-shot: returned once, then back to 200
const mockFetch = async (url, init) => {
  calls++;
  lastBody = JSON.parse(init.body);
  lastHeaders = init.headers;
  const status = nextStatus;
  nextStatus = 200;
  if (status !== 200) {
    return { ok: false, status, text: async () => `{"error":{"message":"Bad Request: ${url}"}}` };
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"credibilityScore": 50}' } }] }) };
};
globalThis.fetch = mockFetch;

// 1. default OpenRouter model: reasoning off, no response_format, big budget
let out = await callProvider('openrouter', 'k', null, 'p');
assert.deepEqual(lastBody.reasoning, { effort: 'none' }, 'default (reasoning) model: reasoning effort none sent');
assert.equal(lastBody.response_format, undefined, 'default model does not support response_format — not sent');
assert.equal(lastBody.max_tokens, 8192, 'max_tokens leaves room for reasoning + JSON');
assert.equal(out, '{"credibilityScore": 50}');
assert.equal(lastHeaders['X-Title'], 'Clearify.io');

// 2. non-reasoning json-capable model: response_format sent, no reasoning key
await callProvider('openrouter', 'k', 'google/gemma-4-31b-it:free', 'p');
assert.deepEqual(lastBody.response_format, { type: 'json_object' }, 'json-capable model gets response_format');
assert.equal(lastBody.reasoning, undefined, 'non-reasoning model: no reasoning parameter');

// 3. a 400 on the flagged extras falls back to the bare body
calls = 0;
nextStatus = 400;
out = await callProvider('openrouter', 'k', null, 'p');
assert.equal(calls, 2, 'a 400 retries exactly once');
assert.equal(lastBody.response_format, undefined, 'fallback request carries no extras');
assert.equal(lastBody.reasoning, undefined, 'fallback request carries no reasoning');
nextStatus = 200;

// 4. Gemini: thinking capped at low, JSON mime, no deprecated sampling params
let geminiBody = null;
globalThis.fetch = async (url, init) => {
  geminiBody = JSON.parse(init.body);
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }) };
};
out = await callProvider('gemini', 'k', null, 'p');
assert.deepEqual(geminiBody.generationConfig.thinkingConfig, { thinkingLevel: 'low' }, 'thinking capped at low');
assert.equal(geminiBody.generationConfig.maxOutputTokens, 16384, 'Gemini budget covers thinking + JSON');
assert.equal(geminiBody.generationConfig.responseMimeType, 'application/json', 'Gemini asked for JSON output');
assert.equal(geminiBody.generationConfig.temperature, undefined, 'temperature dropped (deprecated on 3.6+, soon a 400)');
assert.equal(geminiBody.generationConfig.topP, undefined, 'topP dropped (deprecated on 3.6+, soon a 400)');
assert.equal(out, '{"a":1}');

// 5. reasoning-budget exhaustion is diagnosable, not a bare "empty response"
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: null }, finish_reason: 'length' }] }),
});
await assert.rejects(
  callProvider('openrouter', 'k', null, 'p'),
  /finish_reason: length/,
  'empty content must name its finish_reason'
);

globalThis.fetch = realFetch;

console.log('api.test.js: all checks passed');
