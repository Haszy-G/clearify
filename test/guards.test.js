import assert from 'node:assert';
import { fetchWithGuards } from '../utils/api.js';

const realFetch = globalThis.fetch;

// 1. 429 → one retry after backoff → success
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) return { ok: false, status: 429 };
  return { ok: true, status: 200 };
};
const retried = await fetchWithGuards('https://x.test/v1', { method: 'POST' }, { backoffMs: 10 });
assert.equal(retried.status, 200, 'retry should succeed');
assert.equal(calls, 2, 'exactly one retry');

// 2. 429 twice → still returns the last response (caller maps the error)
calls = 0;
globalThis.fetch = async () => { calls++; return { ok: false, status: 429 }; };
const still429 = await fetchWithGuards('https://x.test/v1', {}, { backoffMs: 10 });
assert.equal(still429.status, 429, 'second 429 surfaces to caller');
assert.equal(calls, 2, 'no more than one retry');

// 2b. 429 with a sane Retry-After hint → the hint is used, not the backoff
calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) return { ok: false, status: 429, headers: { get: () => '1' } };
  return { ok: true, status: 200 };
};
const hintStart = Date.now();
const withHint = await fetchWithGuards('https://x.test/v1', {}, { backoffMs: 20000 });
const hintElapsed = Date.now() - hintStart;
assert.equal(withHint.status, 200, 'retry after hint succeeds');
assert.ok(hintElapsed >= 900 && hintElapsed < 20000, `Retry-After hint (1s) used instead of the 20s backoff (took ${hintElapsed}ms)`);

// 2c. 429 with a hostile Retry-After hint → capped at 8s, never longer
calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) return { ok: false, status: 429, headers: { get: () => '3600' } };
  return { ok: true, status: 200 };
};
const capStart = Date.now();
const withCap = await fetchWithGuards('https://x.test/v1', {}, { timeoutMs: 30000 });
const capElapsed = Date.now() - capStart;
assert.equal(withCap.status, 200, 'retry after capped hint succeeds');
assert.ok(capElapsed < 9000, `hostile Retry-After capped at 8s (took ${capElapsed}ms)`);

// 2d. transient network error → one retry, then success
calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) throw new TypeError('fetch failed');
  return { ok: true, status: 200 };
};
const retriedNet = await fetchWithGuards('https://x.test/v1', {}, { backoffMs: 10 });
assert.equal(retriedNet.status, 200, 'network blip retried successfully');
assert.equal(calls, 2, 'exactly one retry on a network error');

// 2e. persistent network error → surfaces after the single retry
calls = 0;
globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
await assert.rejects(
  fetchWithGuards('https://x.test/v1', {}, { backoffMs: 10 }),
  (e) => e.message === 'fetch failed',
  'persistent network error surfaces to caller'
);
assert.equal(calls, 2, 'network errors also get exactly one retry');

// 3. provider hang → timeout error, distinct from user cancel
globalThis.fetch = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
await assert.rejects(
  fetchWithGuards('https://x.test/v1', {}, { timeoutMs: 40 }),
  /timed out/,
  'timeout must throw the friendly timed-out message'
);

// 4. user abort propagates as an abort, not a timeout
const ac = new AbortController();
globalThis.fetch = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
ac.abort();
await assert.rejects(
  fetchWithGuards('https://x.test/v1', {}, { signal: ac.signal }),
  (e) => e.name === 'AbortError',
  'pre-aborted signal must reject with AbortError'
);

globalThis.fetch = realFetch;
console.log('guards.test.js: all checks passed');
