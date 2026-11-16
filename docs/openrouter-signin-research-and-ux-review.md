# Research: OpenRouter Sign-in, System Design Review & UX Recommendations

Date: 2026-10-15 · Scope: `news-bias-extension` (Clearify) — all research verified against live documentation and the repo at commit `6a358c6`.

---

## Part 1 — OpenRouter sign-in with callback, without Chrome/Google blocking it

### 1.1 How OpenRouter's PKCE flow works (verified against openrouter.ai/docs)

1. Send the user to `https://openrouter.ai/auth?callback_url=<URL>&code_challenge=<S256>&code_challenge_method=S256`
2. OpenRouter authenticates the user (email, Google, GitHub — **their** OAuth client, not yours) and redirects back to your `callback_url` with a `?code=` parameter
3. Exchange the code: `POST https://openrouter.ai/api/v1/auth/keys` with `{ code, code_verifier, code_challenge_method }` → returns `{ key }` — a user-controlled API key
4. Codes are single-use and expire after **10 minutes**

Supported optional `/auth` params the extension does not yet use:

| Param | Effect |
|---|---|
| `state` | Returned unchanged on callback; matches response to request, protects against CSRF |
| `key_label` | Prefills the label of the created API key — e.g. `Clearify` |
| `workspace_id` / `required_workspace_id` | Preselect/lock the workspace the key is created in |
| `key_label` | (see above) — with a labeled key, the user can recognize and revoke it in their dashboard |

Also documented: deep links to the user's key via lowercase-hex SHA-256 of the key — `https://openrouter.ai/keys/<hash>` and `https://openrouter.ai/logs?api_key_hash=<hash>`. Great for a "manage this key" link in your settings UI.

Your current implementation (`utils/oauth.js` + `background/service-worker.js` + `callback/`) is **correct per the docs**: S256 PKCE, verifier in `chrome.storage.session`, exchange in the service worker. The gaps are in robustness and UX, not correctness.

### 1.2 What Chrome/Chromium actually blocks — evidence

| Scenario | Blocked? | Evidence |
|---|---|---|
| `chrome.windows.create()` opening `openrouter.ai/auth` | **No.** Extension APIs bypass the popup blocker entirely | Chrome docs; standard behavior |
| Web page (renderer-initiated JS, link click) navigating to `chrome-extension://…` | **Yes**, unless resource is in `web_accessible_resources` | Chromium policy; SO 21169241 |
| **Server-side HTTP 30x redirect** to `chrome-extension://…` | **No — allowed** (non-renderer-initiated navigation) | Chromium issue 380052370: "We allow navigation to extension pages for any non-renderer-initiated navigation, and a server redirect … is considered non-renderer-initiated" |
| Same 30x redirect in **Brave** | **Breaks** — hangs forever as of Brave 1.91.171 (June 2026) | brave/brave-browser#56271 |
| Google sign-in inside a Chrome window you opened | **No.** "This browser or app may not be secure" targets embedded WebViews (WKWebView/Android WebView/Electron) and automation, not real Chrome-profile windows | Google OAuth troubleshooting; `disallowed_useragent` policy targets embedded user agents |
| CWS review of an OAuth redirect flow | **No policy against it.** Review flags broad host permissions, unclear single purpose, remote code — not OAuth itself | CWS program policies |

**Bottom line:** your extension-page callback works on Chrome today because OpenRouter's redirect is server-side. The real risks are (a) Brave, which you explicitly ship a build for, and (b) fragility of the chrome-extension://-scheme approach across Chromium forks.

### 1.3 The two callback strategies compared

**Option A — extension-page callback (current)**

- `callback_url = chrome.runtime.getURL('callback/openrouter-callback.html')`
- Pros: no `identity` permission; **works on Safari** (why you adopted it — commit `96057ef`); branded confirmation page; verifier never leaves the extension
- Cons: depends on redirect semantics per browser (Brave hangs); leaves a window/tab open ("You can close this tab"); not the pattern Google recommends

**Option B — `chrome.identity.launchWebAuthFlow` (recommended for Chromium + Firefox)**

- `callback_url = chrome.identity.getRedirectURL()` → `https://<ext-id>.chromiumapp.org/*` — a **virtual address intercepted by Chrome before any network request** (SO 30612138). No navigation to an extension page ever happens, so the Brave bug and renderer-initiated rules are irrelevant.
- The auth window **closes itself** on completion and resolves the promise with the final URL (containing `code`). Less code: the callback page is not needed at all.
- Google's own docs for installed apps point Chrome apps/extensions at the Identity API: "Use the Chrome Identity API … delivers the OAuth 2.0 response directly to your app, eliminating the need for a redirect URI."
- Support: Chrome/Edge/Brave/Vivaldi/Arc (Chromium), **Firefox** (MDN: `browser.identity.launchWebAuthFlow`), Opera (Chromium-based). **Not Safari** — keep Option A there.
- Requires the `identity` permission (no special CWS friction; it's a standard permission).
- One caveat: enterprises can restrict it via the `ExtensionOAuthRedirectUrls` policy (default = standard redirect URL only, which is exactly what you'd use — fine).

**Recommendation:** branch inside `signInWithOpenRouter()`: use `launchWebAuthFlow` when available, fall back to the extension-page callback on Safari. Both paths feed the same `exchangeOpenRouterCode()`. This maximizes compatibility and eliminates the Brave hang for the majority of your users.

### 1.4 Concrete hardening for the sign-in flow

1. **Add `state`**: generate a random value, store beside the verifier in `chrome.storage.session`, verify on callback. OpenRouter returns it only after a genuine authorization; protects against CSRF (recommended in Google's OAuth docs too).
2. **Add `key_label=Clearify`**: the user sees a labeled key in their OpenRouter dashboard and can revoke just yours. Pair with the deep-link management URL (`/keys/<sha256-hex>`) in the account card.
3. **Track the auth window** (both options): listen for `chrome.windows.onRemoved` for the auth window id; if closed without completion, broadcast `OPENROUTER_SIGNIN_CANCELLED` so the side panel resets its status instead of staying stuck on "Opening OpenRouter sign-in…".
4. **Guard double-clicks**: if a sign-in is already in flight, focus the existing window instead of minting a second verifier (you already do this pattern for the popup fallback — `popupWindowId`).
5. **Timeout the exchange**: wrap the `/auth/keys` fetch in an `AbortController` (~15 s). Codes expire in 10 min, so a hung fetch leaves the user with a silent failure.
6. **Auto-close the callback page** (Option A / Safari): show "Signed in ✓" for ~1.5 s, then `window.close()`. Never make the user clean up your window.
7. **Strip the code from the URL** on the callback page via `history.replaceState` after reading it — defense in depth.
8. **Keep the window type sane**: `type: 'popup'` at 400×600 is fine for Google sign-in (it's a real Chrome window). If you ever see Google-side complaints, drop to a normal tab. Never run OAuth from the browser-action popup — it closes on blur.
9. **Stable extension ID**: publish to CWS and pin the `key` in dev manifests (Chrome's OAuth tutorial documents the exact procedure) so `chrome-extension://<id>/…` never changes under you.

### 1.5 What will get you flagged at CWS review (and what won't)

- ✅ Narrow `host_permissions` (3 API domains) — good; keep it that way.
- ⚠️ `content_scripts: ["<all_urls>"]` — the biggest review and install-friction item. Justify it in the listing, or better: refactor to `activeTab` + `scripting.executeScript` on Analyze click (see Part 2, item 9). That converts the scary "read and change all your data on all websites" install warning into nearly nothing.
- ⚠️ Remote Google Fonts `@import` in `sidepanel.css` — works, but self-hosting the woff2 (or using your system-font stack) removes a remote-content question from review and fixes offline rendering.
- ❌ OAuth method is not a review item. Google sign-in on openrouter.ai is OpenRouter's client, not yours — Google's embedded-webview restrictions don't apply to a Chrome window you open.

---

## Part 2 — System design review

### 2.1 Architecture as it stands

```
content-script.js (all_urls, document_idle)      sidepanel.js (side panel / popup window)
        │  EXTRACT_CONTENT                                │  runtime messages
        ▼                                                 ▼
        └────────────► background/service-worker.js ◄────┘
                  (orchestrator: analysis, settings, OAuth)
                  storage.local: settings, apiKeys, lastResult
                  storage.session: openrouterVerifier
                        │
                        ▼
        utils/api.js → OpenRouter / NVIDIA / Gemini (PKCE callback via callback/)
```

Builds: one shared codebase → per-browser manifest → `distributions/{chromium,arc,firefox,opera,safari}` zipped by `scripts/build.js` (+ Safari converter).

**Strengths (keep):**
- Clean layering: extraction → orchestration → provider abstraction → UI; single SW shared across all engines with runtime capability detection
- Correct PKCE (S256, verifier in `storage.session`, cleared on use and on browser exit); sender-ID validation on every message listener
- Tight CSP (`script-src 'self'`), narrow host permissions, no remote code, no bundler — zero npm runtime deps, trivially auditable
- Provider abstraction with per-provider quirks (NVIDIA thinking-off kwargs); tests exist for oauth + prompts + parsing; build stamps versions and warns on non-increasing semver

### 2.2 Issues found (ordered by severity)

1. **Model/provider changes are not persisted** — real bug. `modelSelect`/`providerSelect` `change` handlers only mutate in-memory `currentSettings`; `SAVE_SETTINGS` fires only when the API-key save button is clicked. If a user switches the model and hits Analyze, `analyzePage()` reads `chrome.storage.local` and runs the **previously saved model**. Fix: persist settings on `change` (debounced), not on the key-save button.
2. **`lastResult` staleness**: on panel reopen, results are shown for whatever was last analyzed, even if the user has navigated to a different article. Key results by URL (`_meta.url`), and/or have the SW invalidate via `tabs.onUpdated`. At minimum show "Analyzed: <title>" and a mismatch notice.
3. **Stuck sign-in status**: nothing watches the auth window. User closes it → side panel stays at "Opening OpenRouter sign-in…" forever. (Fix in 1.4.3.)
4. **SW death mid-analysis**: `isAnalyzing` is module state; if Chrome kills the SW mid-run, the panel's `sendMessage` port closes and the raw error "message port closed…" surfaces. Persist a run token in `storage.session`, and on SW startup clear stale tokens; map the port error to "Analysis interrupted — try again."
5. **No timeouts on `extractContentFromTab` or the key exchange** — both can hang indefinitely. AbortController on both.
6. **Misleading progress copy**: the "Searching for news coverage…" step runs for videos even when no Gemini key exists (enrichment silently skips). Gate the step on `geminiApiKey`.
7. **Fake progress timer desync**: `stepInterval` advances steps on a 2.2 s cadence while real `ANALYSIS_STEP` events arrive independently; they fight. Drive the UI purely from real events, using the timer only as a heartbeat fallback.
8. **Raw API errors shown to users**: "OpenRouter key exchange failed (403)" etc. Map error codes → plain English + one action (see 3.4).
9. **`<all_urls>` content script** (see 1.5): switch to `activeTab` + `scripting` on user gesture. `sidePanel.open({tabId})`/the popup fallback already runs on a user gesture, so the injection moment is available. This also removes the broadest permission warning at install — a conversion win.
10. **Remote font** (`@import` Google Fonts in `sidepanel.css`): self-host Inter or drop to the system stack (CWS review optics + offline).
11. **Footer donation link points at Flutterwave *sandbox*** (`sandbox.flutterwave.com/donate/…`) — that's the test environment; donors will hit a test payment page. Swap to the production link.
12. **Naming inconsistency**: manifest name "News Credibility Extension" vs UI brand "Clearify.io" vs store-visible `HTTP-Referer: https://clearify.io`. Unify to one name everywhere before store submission.
13. **Transcript/content trust**: YouTube transcript is fetched from `ytInitialPlayerResponse` caption tracks — fine, but if YouTube serves a consent wall or no captions, `transcriptWarning` covers it. TikTok has no transcript by design — good that it's stated in the UI.
14. **Test coverage**: only pure functions are tested. Add tests for the message-routing contract and the callback-page parsing (both are small and pure-ifyable).
15. **No rate-limit/backoff handling** for 429s from free models — relevant to UX copy (3.3).

None of these are architectural. The architecture itself is sound; the fixes are localized.

---

## Part 3 — UX research: making the experience great

The product's premise is *trust*. Every UX decision should answer: "why should I believe this score?" Grounding: Nielsen Norman heuristics (visibility of system status; user control; error recovery; recognition over recall; consistency), extension-specific patterns (one-click action, ~360–420 px panels, browser conventions), and AI-UX literature (latency perception, uncertainty communication, hallucination disclosure).

### 3.1 Onboarding — the biggest lever (NN/g: activation = first value)

Today, a fresh install lands on "Analyze This Page" with no key set → guaranteed first failure. Fix:

- **First-run state** (no key in storage): value prop in one line ("See the bias, credibility and missing context of any news article or video"), then **"Connect OpenRouter — free"** as the primary CTA, "Use my own API key" secondary. Two clicks to first analysis.
- **Never auto-launch the auth flow** on install/panel open — the Chrome Identity docs call this out explicitly: interactive auth must follow an explaining UI, not app launch.
- **Explain what connect means** before the redirect — the scariest part for users is unknown scope. State: "Clearify creates its own labeled API key on your OpenRouter account. You can set a spend limit and revoke it any time." Link to the key management page (deep-link hash) after sign-in.

### 3.2 Sign-in UX details

- Status dot + Connected/Not connected already exists — extend the account card to show the key label and a "Manage on OpenRouter" link (deep-link via the SHA-256 hash), plus "Sign out" (present) and "Set spend limit" (external, pre-filled to their key).
- Handle all three ends: success (celebration + panel refocus), user-cancel (window closed → reset status, no error language), failure (friendly mapping below).
- With `launchWebAuthFlow`, the window closes itself — the flow ends *in* the panel, which feels far more native than a leftover tab you must close.

### 3.3 Latency & progress (AI-UX)

- Real steps already stream (`ANALYSIS_STEP`) — good. Keep the ring loader, drive steps from real events only.
- Show elapsed time ("Analyzing… 14 s") and set expectations: free-tier models can take 30 s+. An honest "this uses a free model; it can be slow — pick a faster one in settings" beats an unexplained wait.
- Add a **Cancel** button during analysis (user control + it saves the user's credits on a misfire).
- Disable Analyze/Re-analyze while running (currently only guarded in the SW, not the UI).

### 3.4 Errors & recovery

Map every failure to plain English + one action:

| Condition | Message |
|---|---|
| 401/403 from provider | "Your key was rejected — reconnect OpenRouter" (button) |
| 429 / free-model busy | "This free model is busy right now. Try again, or pick another free model." |
| 400 invalid code/verifier | "Sign-in session expired — please sign in again." |
| Exchange timeout | "OpenRouter didn't respond. Check your connection and retry." |
| No text extracted | Current message is good; add "supported pages: news articles, YouTube, TikTok" |
| Port-closed (SW death) | "Analysis interrupted. Try again." |

### 3.5 Results presentation & trust

- The ring+verdict anchor is right. Add a **regional-context chip** — your prompt already computes the regional lens ("Nigerian context", etc.) but the UI never shows it. Surfacing it is a differentiator and an honesty signal.
- **Dimension bars invert scores** (`100 - bias`) — label the polarity in-situ ("0 = loaded language · 100 = neutral") or on hover; today a user cannot tell which direction is good.
- **Blind Spots / Other Perspectives are ungrounded** for articles — they come from the model's parametric memory with no web check (only videos get Gemini grounding). This is the product's biggest trust risk: a hallucinated "omission" destroys credibility for a trust product. Options: (a) label provenance honestly ("from AI's background knowledge — not live search"), (b) ground articles too (OpenRouter web plugin or Gemini grounding) and cite sources, (c) both, with a "Verify against the web" action. Strongly recommend (c) as roadmap P2.
- Pair the single 0–100 score with a band ("Significant Bias") and an explicit "AI estimate — verify independently" (you already have the disclaimer — move it adjacent to the score, not the bottom).
- Add **Share/Copy result** (compact text summary) — growth loop and utility.
- Keyboard: Enter to analyze; keep Escape-to-close for the popup (already present).

### 3.6 Polish, accessibility, themes

- **Dark mode**: side panel is light-only; at night it glares. Add `prefers-color-scheme` tokens — the tokenized CSS (`--bg-base` etc.) makes this a one-variable-per-theme job.
- **Contrast**: `--text-3: #4a7a6a` on `--bg-surface: #f5faf8` ≈ 4.0:1 — borderline for 13.5 px text; darken one step.
- **Motion**: ring/bar animations — respect `prefers-reduced-motion`.
- **Screen-reader semantics**: score ring needs `role="img"` + `aria-label` ("Credibility 72 of 100, Significant Bias"); loading step should be `aria-live="polite"`; dimension bars need accessible descriptions. You already do `aria-expanded` on toggles — good, extend it.
- **Transcript section**: preview + trim note + warnings are already well handled — keep.

### 3.7 Prioritized roadmap

- **P0 (bugs/launch blockers):** model persistence bug (#2.2.1), first-run no-key state, auth-window cancel handling, friendly error mapping, stale `lastResult`, sandbox donation link, naming consistency.
- **P1 (hardening + conversion):** `launchWebAuthFlow` for Chromium/Firefox (Safari keeps page callback), `state` + `key_label` + timeouts, activeTab refactor, self-host font, dark mode, elapsed-time + cancel during analysis.
- **P2 (trust & depth):** grounded Blind Spots/Perspectives with citations, provenance labels, share/export, a11y audit pass, i18n.

### Sources

- OpenRouter: OAuth PKCE guide + API authentication (openrouter.ai/docs), incl. optional params, code expiry, error codes, key deep-links
- Chrome for Developers: `chrome.identity` reference; "OAuth 2.0: authenticate users with Google" (extension-ID pinning procedure); extension network-request docs
- Google identity: OAuth 2.0 for iOS & Desktop Apps (redirect methods, Chrome Identity API recommendation, `state` for CSRF); OAuth troubleshooting ("This browser or app may not be secure" = embedded user agents)
- Chromium: issue 380052370 (server redirects to extension pages allowed); issue 497599683 (navigation-throttle context); Brave issue #56271 (302 to chrome-extension:// hangs in Brave)
- MDN: `browser.identity.launchWebAuthFlow` (Firefox support)
- Stack Overflow: 30612138 (chromiumapp.org is a virtual intercepted address), 21169241 (web→extension navigation requires web-accessible resources), 68038854
- Google Enterprise policy: `ExtensionOAuthRedirectUrls` (identity-API redirect allowlist)
