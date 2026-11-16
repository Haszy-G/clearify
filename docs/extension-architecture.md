# Clearify Extension — Complete Mental Model

Ground truth as of 2026-10-18, verified against every source file. One shared codebase builds into five per-browser distributions; every runtime page, component, message, and transition is mapped here.

---

## 1. Bird's-eye view

```
                        ┌──────────────────────────────────────────────┐
                        │              USER'S BROWSER TAB              │
                        │  (news article · any readable page)          │
                        └──────────────────────────────────────────────┘
                              │ injected at document_idle        ▲ renders nothing
                              ▼                                 │ (reads only)
┌─────────────────────┐  EXTRACT_CONTENT  ┌─────────────────────────────────────┐
│ content/content-     │◄──────────────────│  background/service-worker.js        │
│ script.js           │──────────────────►│  (the single orchestrator)           │
│ article text +      │  {contentType,    │                                      │
│ metadata extraction │   text, metadata} │  • settings (get/save)               │
└─────────────────────┘                   │  • analysis pipeline (abortable)     │
                                           │  • OAuth PKCE via chrome.identity    │
                                           │  • lastResult cache + staleness      │
                                           └───────┬──────────────┬──────────────┘
                                                   │              │
                                    runtime messages          outbound HTTPS
                                                   ▼              ▼
┌─────────────────────────────────────────────┐        ┌──────────────────────────┐
│ sidepanel/sidepanel.html + .js + .css        │        │ openrouter.ai            │
│ ONE page, three surfaces:                    │        │  /auth (OAuth consent)   │
│  • Chrome/Edge/Brave/Vivaldi/Arc side panel │        │  /api/v1/auth/keys      │
│  • Firefox / Opera sidebar                   │        │  /api/v1/chat/completions│
│  • Safari / Firefox-Android action popup    │        ├──────────────────────────┤
│                                              │        │ generativelanguage.      │
│ four states: idle → loading → results/error │        │ googleapis.com (Gemini   │
│ settings overlay + opera pin-hint overlay    │        │  provider LLM)          │
└─────────────────────────────────────────────┘        ├──────────────────────────┤
                                                       │ integrate.api.nvidia.com │
        utils/ (shared by SW + panel)                  ├──────────────────────────┤
                                                       │ news.google.com (RSS)    │
                                                       │ html.duckduckgo.com      │
                                                       │ — keyless coverage search│
                                                       └──────────────────────────┘
        • api.js    — providers, prompts, fetch wrappers
        • search.js — keyless news search (Google News RSS, DDG fallback)
        • oauth.js  — PKCE helpers        • message.js — promise sendMessage
```

There is **no second window, no callback page, no popup-window fallback**. The panel
page is the only UI. Everything else is the service worker.

---

## 2. The pages (surfaces) and how each opens

The extension ships exactly **one HTML page** — `sidepanel/sidepanel.html`. What
differs per engine is *how the browser displays it*:

| Build | Manifest declares | Toolbar click → | How the panel closes |
|---|---|---|---|
| chromium (Chrome, Edge, Brave, Vivaldi) | `side_panel.default_path` | SW `action.onClicked` → `chrome.sidePanel.open({tabId})` | side-panel header X (no in-panel close button) |
| arc | same | same | same |
| firefox | `sidebar_action` | SW → `browser.sidebarAction.open()` | sidebar header X |
| opera | `sidebar_action` | SW → `browser.sidebarAction.open()` | sidebar header X |
| safari | `action.default_popup` | browser opens the popup natively (`onClicked` never fires) | closes natively (popup dismiss) |
| firefox android | none at build | SW sets `action.setPopup()` at startup (OS check) | closes natively (popup dismiss) |

The panel loads **no remote resources**: fonts (Public Sans, IBM Plex Mono)
are self-hosted in `sidepanel/fonts/` under OFL 1.1, declared via `@font-face`
at the top of `sidepanel.css`.

---

## 3. Panel state machine (the only page's internal model)

```
                 open panel, no prior result
                        │ (default visible, no animation)
                        ▼
                   ┌────────┐   Analyze This Page
      cancel ┌────►│  IDLE  │──────────────►  showState(loading)
             │     └────────┘                     │  + .enter → 160ms fade
             │        ▲                           ▼
             │        │                     ┌──────────┐  spinner (700ms, the only
             │        │ stale result on     │ LOADING  │  looping animation) + real
             │        │ reopen (URL≠tab)    └────┬─────┘  ANALYSIS_STEP text + elapsed
             │        │                          │          + Cancel button
             │        │              success     │  error        ┌─────────┐
             │        │        ┌─────────────────┤─────────────► │  ERROR  │
             │        │        ▼                 │               └─────────┘
             │   ┌──────────┐                    │                    │ Try Again
             └───│ RESULTS  │◄───────────────────┘ cancel →          ▼
                 └──────────┘                    │            back to loading
                  Re-analyze ────────────────────┘  restores the state
                                                    visible before loading
```

- `showState(el)` hides all four sections, reveals one, forces reflow, adds `.enter`
  → one 160ms fade. No other entrance animation exists.
- Overlays (not states, always in the DOM): `#settings-panel` (gear toggle, fades in
  160ms) and `#opera-pin-hint` (Opera only, session-dismissed).
- Results content: score numeral (instant) + score meter (400ms width fill) + verdict
  colour + 4 bias bars (400ms fills, no stagger) + framing pullquote + blind spots
  (numbered list) + 3 perspective cards (dimmed at 0.35 opacity when empty) + content
  badge (DOM-built spans) + re-analyze button.

---

## 4. Component responsibilities

| File | Responsibility | Knows about |
|---|---|---|
| `content/content-script.js` | Passive reader. Answers `EXTRACT_CONTENT` (article text via selector ladder + og:* metadata) and `GET_PAGE_URL` (the page's live URL for the staleness check). Never writes to the page, never initiates messages. | nothing else — no storage, no API keys |
| `background/service-worker.js` | The brain. Owns settings, runs analysis, mints OAuth keys (PKCE material destroyed on every exit path), caches lastResult (staleness-checked via the content-script URL probe), enforces cancellation via one `AbortController` per run. | utils/*, all message types, all providers |
| `sidepanel/sidepanel.js` | View controller. Owns the state machine, settings form, sign-in status, error mapping (`friendlyAnalysisError`). Persists provider/model choices on change (`persistSettings`). | SW via messages only — plus the `PERSPECTIVE_POSITIONS` constant imported from api.js (layout data, not provider data); never touches providers/keys directly |
| `utils/api.js` | Single source of truth: `PROVIDERS` registry (openrouter/nvidia/gemini, models, base URLs), `callProvider` dispatch with per-provider headers/quirks, the analysis prompt builder (grounded + ungrounded variants), `parseResponse` (JSON + fence stripping + regex fallback), `validatePerspectiveCitations` (strips any perspective citation that was not literally gathered by the search layer). | no chrome.* APIs — pure, unit-tested |
| `utils/search.js` | Keyless grounding: Google News RSS (primary) + DuckDuckGo HTML (fallback), 202-anomaly detection, query building (story title → article-text fallback), coverage formatting. | no chrome.* APIs — pure, unit-tested |
| `utils/oauth.js` | PKCE primitives: base64url, 43-char verifier, S256 challenge. Pure, unit-tested. | nothing |
| `utils/message.js` | `sendMessage(type, payload)` → promise. Two callers (SW broadcasts, panel requests). | nothing |
| `scripts/manifests/*.json` | Per-engine declaration (see §2 + §8). | — |
| `scripts/build.js` | Copies shared dirs (`utils content sidepanel icons`) + `background` + one manifest → `distributions/<name>/` + zip. `--version` stamps all manifests first. | — |
| `scripts/build-safari.sh` | Wraps `distributions/safari` into a native macOS app. | — |

---

## 5. The message bus — complete catalog

Every `chrome.runtime` / `chrome.tabs` message in the codebase. All listeners verify
`sender.id === chrome.runtime.id` (content scripts are low-trust); `GET_SETTINGS`
and `SAVE_SETTINGS` additionally require an own-page sender (`sender.url` under
`chrome.runtime.getURL('')`) — page contexts never see or write keys. `sender.tab`
must not be used for this test: it is set for tab-hosted extension pages too
(Opera's sidebar panel), which starved the Opera panel of settings.

| Message | From → To | Payload | Response / effect |
|---|---|---|---|
| `GET_PROVIDERS` | panel → SW | — | `{providers}` (registry from api.js) |
| `GET_SETTINGS` | panel → SW | — | `{providerId, providerModel, apiKeys}` with model validated against registry |
| `SAVE_SETTINGS` | panel → SW | `{settings}` | validates shape, persists to `storage.local`, `{success}` \| `{error}` |
| `ANALYZE_PAGE` | panel → SW | — | SW queries the **active tab** itself, runs pipeline, `{data}` \| `{error}` \| `{cancelled}` |
| `CANCEL_ANALYSIS` | panel → SW | — | aborts the run's `AbortController`, `{success}` |
| `GET_LAST_RESULT` | panel → SW | — | `{data}` — or `{data:null, stale:true}` if the active page's URL (via `GET_PAGE_URL`) ≠ the saved `_meta.url`, or no content script answers |
| `SIGN_IN_OPENROUTER` | panel → SW | — | runs whole OAuth flow; `{success}` \| `{cancelled}` \| `{error}` |
| `SIGN_OUT_OPENROUTER` | panel → SW | — | deletes key, clears pending sign-in, `{success}` |
| `ANALYSIS_STEP` | SW → broadcast | `{step}` | panel updates loading text — real events only, no canned sequence |
| `OPENROUTER_SIGNED_IN` | SW → broadcast | — | panel re-fetches settings → account card flips to "Connected" |
| `EXTRACT_CONTENT` | SW → content script (tabs.sendMessage) | — | `{contentType, text, metadata}` |
| `GET_PAGE_URL` | SW → content script (tabs.sendMessage) | — | `{url}` — the page's live URL; the SW's source of truth for staleness (`tab.url` would need the `tabs` permission) |

## 6. Storage schema

```
chrome.storage.local (persists across restarts)
  providerId      "openrouter" | "nvidia" | "gemini"
  providerModel    model id string (validated against registry on read)
  apiKeys          { openrouter?: key, nvidia?: key, gemini?: key }

chrome.storage.session (cleared when the browser closes)
  lastResult       { credibilityScore, dimensions{...}, framingAnalysis,
                    omissions[], perspectives{...}, _meta{contentType: 'article',
                    title, url, source, webEnriched, analyzedAt} }
                    — session store where the engine provides it, storage.local
                    as the fallback. A restarted browser reopens the panel on
                    its idle page (no resurrection of last session's analysis);
                    MV3 worker restarts mid-session still rehydrate. GET_LAST_RESULT
                    shows it only when the active page's URL (probed via
                    GET_PAGE_URL) matches _meta.url, so a saved result never
                    renders on the wrong page.
  openrouterVerifier / openrouterState   live only during an OAuth flow
  operaPinHintDismissed                  pin-hint dismissal, per session
```

---

## 7. The four lifecycle flows

### 7a. Opening the panel
```
browser shows sidepanel.html (per §2)
  → panel: loadSettings()           GET_PROVIDERS + GET_SETTINGS → populate
                                     selects, key hint, account card
  → panel: GET_LAST_RESULT
       SW: memory cache → else result store (storage.session, storage.local
           fallback) → ask the active tab's content script for its URL
           (GET_PAGE_URL) → mismatch or unreadable page = {stale}
  → panel: data? renderResults() : stay on idle
```

### 7b. Analysis (the core flow)
```
click Analyze / Re-analyze / Try Again
  → panel: capture prevState → showState(loading) + spinner + elapsed timer
  → panel: sendMessage(ANALYZE_PAGE)
       SW:  AbortController per run → extract active tab (12s timeout)
            ├─ aborted                    → {cancelled} → panel restores prevState
            ├─ no content / <50 chars     → {error}
            ├─ provider key missing       → {error "Click the gear icon…"}
            ├─ keyless coverage search: story title (else opening words)
            │   as the query → Google News RSS → DuckDuckGo fallback;
            │   both empty → ungrounded prompt variant (12k char cap)
            ├─ callProvider (signal wired to every fetch)
            ├─ parseResponse → validatePerspectiveCitations (perspective
            │   URLs/outlets not literally in the gathered coverage are
            │   blanked) → attach _meta {webEnriched} → cache + session store
            └─ {data}
            every stage boundary: SW broadcasts ANALYSIS_STEP → panel text
  → panel: success → renderResults → fade in, meter/bars fill 400ms
            error  → friendlyAnalysisError() mapping → error state
            (SW death mid-run surfaces as "Analysis interrupted")
```
Cancel path: `CANCEL_ANALYSIS` → SW aborts → extraction resolves null-but-aborted,
fetch throws AbortError → `{cancelled}` → panel returns to prevState.

### 7c. OpenRouter sign-in (identity API only)
```
panel: "Sign in with OpenRouter" → SIGN_IN_OPENROUTER
  SW: chrome.identity missing (Safari)  → error "paste an API key instead"
  SW: PKCE verifier + state → storage.session
  SW: launchWebAuthFlow(interactive) → openrouter.ai/auth
        ?callback_url=<identity.getRedirectURL()>   ← virtual https://<id>.chromiumapp.org/
        &code_challenge=S256 &state &key_label=Clearify
     (browser-owned window; no chrome-extension:// redirect ever happens)
  user cancels window                  → {cancelled} → panel: "Sign-in cancelled"
  SW: parse code+state from intercepted redirect → mismatch = expired
  SW: POST /api/v1/auth/keys (15s timeout) → user-scoped API key
  SW: apiKeys.openrouter = key → storage.local
  SW: broadcast OPENROUTER_SIGNED_IN → panel GET_SETTINGS → "Connected"
```
Safari/Firefox-Android users connect via Advanced options → paste key → Save
(`persistSettings`, toast 2s).

### 7d. Settings
Provider/model selects persist immediately on change (Analyze reads storage, so an
unsaved switch would silently run the old model). API-key Save button does the same
plus the toast. OAuth account card is visible only when provider = openrouter.

---

## 8. Per-browser manifest matrix

| | chromium | arc | firefox | opera | safari |
|---|---|---|---|---|---|
| permissions | sidePanel, storage, **identity** | same | storage, **identity** | storage, **identity** | storage (no identity — manual key) |
| host_permissions | openrouter · gemini · nvidia APIs · Google News RSS · DDG HTML | same | same | same | same |
| UI declaration | `side_panel` | `side_panel` | `sidebar_action` | `sidebar_action` (+19/38 icons) | `action.default_popup` |
| background | module service worker | same | module scripts (event page) | module service worker | module service worker |
| content script | `<all_urls>` @ document_idle | same | same | same | same |

Builds land in `distributions/<name>/` + `.zip` — each a complete, loadable folder.

---

## 9. What used to exist and is deliberately gone

So the model doesn't carry ghosts:
- **`callback/openrouter-callback.html|js`** — OAuth callback page. Deleted; identity
  flow needs no landing page (redirect intercepted before navigation).
- **Popup-window fallback** (`openPopupFallback`, `CLOSE_POPUP`, `popupWindowId`,
  `isPopup`/`popupTabId` URL params, auth-window tracking) — deleted. Safari gets UI
  via manifest `default_popup`; Firefox Android via `setPopup`.
- **Setup-state section** — removed in the panel redesign; the settings gear is the
  single connect surface.
- **Canned loading steps** (`ARTICLE_STEPS`/`VIDEO_STEPS` + fake timer) — replaced by
  real `ANALYSIS_STEP` events.
- **Editorial animation system** (staggered rise-ins, count-ups, scale-ins) — replaced
  by one 160ms fade + one spinner + 400ms data fills; reduced-motion stills everything
  except a breathing spinner.
- **Panel close control** (`CLOSE_SIDEBAR` message, panel-side `isSidePanel`
  detection, `chrome.sidePanel.close()` / `opr.sidebarAction.close()` calls,
  Escape-to-close) — removed; the browser's own side-panel/sidebar/popup UI
  closes the panel in every build. The panel ships no close button.
- **Session-scoped lastResult, v1** — an early design kept the result cache in
  plain `storage.local` and relied on URL staleness alone; the shipped code
  prefers `storage.session` (cleared when the browser closes, so a restarted
  browser opens on the idle page) with `storage.local` as the fallback for
  engines without the API. The `GET_PAGE_URL` staleness check still guards
  against a saved result rendering on the wrong page within a session.
