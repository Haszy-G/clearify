import assert from 'node:assert';
import { base64url, generateCodeVerifier, computeCodeChallenge } from '../utils/oauth.js';

assert.strictEqual(base64url(new Uint8Array([0, 0, 0])), 'AAAA');
assert.strictEqual(base64url(new TextEncoder().encode('hello')), 'aGVsbG8');

const verifier = generateCodeVerifier();
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(verifier), 'verifier should be 43-char base64url');

const challenge = await computeCodeChallenge(verifier);
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(challenge), 'challenge should be 43-char base64url');

const known = await computeCodeChallenge('hello');
assert.strictEqual(known, 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');

console.log('oauth.test.js: all checks passed');
