# Store submission — Clearify 1.0.0

Artifacts are built and verified: `distributions/*.zip`, all stamped `1.0.0`, all containing the Instagram support link. This is the per-store runbook with paste-ready listing copy.

## Artifact → store map

| Store | Upload this | Why |
|---|---|---|
| Chrome Web Store | `distributions/chromium.zip` | Uses `chrome.sidePanel`. Also serves Brave, Vivaldi, and Arc users directly from the CWS listing — they install CWS extensions natively. `arc.zip` is only for sideloading during Arc's occasional CWS outages. |
| Microsoft Edge Add-ons | `distributions/chromium.zip` | Same manifest; Edge supports `chrome.sidePanel` (Edge 114+). Edge Partner Center also offers "import from Chrome Web Store" once the CWS listing is live. |
| Opera Add-ons | `distributions/opera.zip` | Uses `sidebar_action` instead of `sidePanel`. |
| Firefox Add-ons (AMO) | `distributions/firefox.zip` | `sidebar_action` + gecko id `clearify-extension@clearify.io` + `strict_min_version: 127.0` already set. |
| Safari App Store | **not the zip** | Needs macOS + Xcode: run `scripts/build-safari.sh` → open `distributions/safari-xcode/News Credibility.xcodeproj` → set team → Archive → sign (App Store distribution or Developer ID + notarize) → upload via App Store Connect. Alternative: Apple's [App Store Connect web packager](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect) skips Xcode entirely. |

## Accounts you need first

| Store | Cost | Sign up |
|---|---|---|
| Chrome Web Store | $5 once | https://chrome.google.com/webstore/devconsole |
| Edge Partner Center | free | https://aka.ms/microsoftedge/extension |
| Opera Add-ons | free | https://addons.opera.com/developer |
| Firefox AMO | free | https://addons.mozilla.org/developers |
| Apple Developer | $99/yr | https://developer.apple.com |

## Review blockers — fix BEFORE submitting

1. **`<all_urls>` content script** (all targets). This is the #1 CWS/AMO rejection trigger. The justification below may pass, but your own P1 list (`docs/openrouter-signin-research-and-ux-review.md` §187) already plans an `activeTab` + `scripting` refactor, which would remove the broad match entirely and make reviews trivial. Decision: ship 1.0.0 as-is and justify, or refactor first.
2. **Privacy policy URL** — mandatory for CWS, AMO, and Edge. Keep the main repo **private** (it contains source + internal docs). GitHub Pages on the free plan only publishes from **public** repos, so host the policy in a separate tiny public repo: create `clearify-policy` (public), push `docs/privacy-policy.md` as `index.md` at its root, then Settings → Pages → Deploy from branch → `main` → `/root`. The policy lands at `https://<github-username>.github.io/clearify-policy/` — paste that URL into every store's privacy-policy field. `docs/privacy-policy.md` is written with Jekyll front matter, so Pages renders it without any conversion work.
3. **Screenshots** — **captured and verified in `screenshots/`**:
   - `clearify-in-action-1280x800.png` — BBC article + panel side by side, exactly 1280×800 (primary listing shot)
   - `panel-400x800.png` — the side panel UI alone (panel DOM verified: logo, tagline, "Analyze This Page", Support card linking `https://www.instagram.com/itshaszy/`)
   - `article-880x800.png` — source half of the composite (kept for retakes)

   CWS also accepts an optional 440×280 promo tile — not yet produced. To retake any shot, run Chrome for Testing (branded Chrome ignores `--load-extension`) with `--load-extension=distributions/chromium` and capture the panel at 400×800 against a news article.
4. **Uncommitted release tree** — `git status` shows the 1.0.0 manifests, the link change, staged distribution deletions, deleted `README.md` and `docs/RELEASE.md`, plus unrelated docs. Review, commit, and tag `v1.0.0` so the submitted binaries trace to a ref.

## Paste-ready listing copy

**Name** (CWS ≤75 chars, AMO ≤58 — this is 43):
```
Clearify — News Bias & Credibility Analyzer
```

**CWS short summary** (≤132 chars — this is 90):
```
AI-powered bias and credibility checks on any news article, right in your browser sidebar.
```

**AMO summary** (≤250 chars — this is 216):
```
Analyze news bias and credibility in real time. Clearify scores sourcing, flags slanted language, and shows how other outlets cover the same story — from your browser sidebar, with your own AI key.
```

**Description** (works for all stores):
```
Clearify gives every reader an instant second opinion on the news.

Open any news article, click Clearify, and the side panel runs an AI-powered analysis of the piece you're reading:

• Bias check — where the story sits on the political spectrum and which language pushes it there
• Credibility score — sourcing quality, evidence density, and caution flags
• Perspective view — how other outlets are covering the same story
• Plain-language summary — what the piece claims, and what it leaves out

Bring your own AI key: sign in with OpenRouter in one click, or paste an OpenRouter, Google Gemini, or NVIDIA key. Your key stays in your browser; Clearify has no servers and collects nothing.

No ads. No tracking. No accounts required.

HOW IT WORKS
When you request an analysis, Clearify extracts the text of the article you're on — only then — and sends it to the AI provider you chose. It also gathers coverage of the same story from Google News RSS (and DuckDuckGo as fallback) so the analysis is grounded in how other outlets report it.

PERMISSIONS
• Read articles: extract article text from the page you're analyzing, on your command.
• Sign in: one-click OpenRouter sign-in (OAuth). On Safari, paste a key instead.
• Store settings: your API key and preferences, saved locally in your browser.
• AI + news sources: openrouter.ai, Google AI, NVIDIA, Google News RSS, DuckDuckGo.

SUPPORT
Follow and support Clearify: https://www.instagram.com/itshaszy/
```

**Single-purpose statement** (CWS asks for this):
```
Clearify analyzes the bias and credibility of news articles the user is reading.
```

**Category:** News & Weather (fallback: Productivity).

## Permission justifications (per-manifest, accurate)

| Permission | In | Justification |
|---|---|---|
| `storage` | all | Store the user's API key and preferences locally in the browser. Nothing leaves the device except analysis requests. |
| `identity` | chromium, opera, firefox | OAuth sign-in to OpenRouter so the user doesn't hand-copy an API key. |
| `sidePanel` | chromium | Show analysis results in Chrome's side panel. |
| `sidebar_action` | opera, firefox | Show analysis results in the browser's sidebar (same UI). |
| content script `<all_urls>` | all | Extracts article text on the current page only when the user clicks Analyze. No data collection, no logging, no behavior outside that action. |
| `https://openrouter.ai/*` | all | AI analysis API and OAuth. Article text is sent here on user request. |
| `https://generativelanguage.googleapis.com/*` | all | Optional direct Google Gemini key path. |
| `https://integrate.api.nvidia.com/*` | all | Optional direct NVIDIA NIM key path. |
| `https://news.google.com/*` | all | Google News RSS: aggregate how many outlets cover the story being analyzed. Redirects stay on this host. |
| `https://html.duckduckgo.com/*` | all | Fallback search when RSS yields no coverage for the story. |

**Data-use disclosure (CWS privacy tab):** declare "Website content" (article text, sent to the user's chosen AI provider on user action) and "Authentication" (OpenRouter OAuth). Declare NO ads, NO analytics, NO sale of data. Stored data: none on any server — local browser storage only.

## Submission order

1. Commit + tag `v1.0.0`.
2. Create the private main repo + tiny public `clearify-policy` repo (see blocker 2), enable Pages, note the policy URL. Screenshots are already done (`screenshots/`).
3. Chrome Web Store first — review takes 1–7 days and unblocks Edge (import) + Arc/Brave/Vivaldi automatically.
4. Firefox AMO and Opera in parallel (free, independent).
5. Edge: upload `chromium.zip`, or one-click import the CWS listing.
6. Safari last: needs macOS, Xcode wrap (`scripts/build-safari.sh`), signing, and App Store Connect.
