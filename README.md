# Clearify — News Bias & Credibility Analyzer

Clearify is a browser extension that analyzes the news article you're reading
for bias, credibility, and what might be missing — grounded in how other
outlets are covering the same story.

Your side panel shows a verdict (credibility score, slant, framing), the
evidence behind it, and other perspectives, including blind spots the article
doesn't mention.

## How it works

1. **Extract** — the content script pulls the article's text and headline from
   the page you're on. Nothing is sent until you press **Analyze**.
2. **Ground** — the background worker gathers coverage of the same story from
   Google News RSS (DuckDuckGo as fallback). This step is keyless.
3. **Analyze** — your chosen AI provider receives the article text plus the
   gathered coverage and returns a structured verdict.
4. **Verify** — every citation in the result is checked against the coverage
   that was actually gathered; anything the model invented is stripped.

## Privacy model

- No account, no telemetry, no analytics, no server. All state lives in your
  browser's local storage.
- Article text is sent only to the AI provider **you** configure, only when
  **you** press Analyze. Providers: OpenRouter (free models + OAuth sign-in),
  NVIDIA NIM, Google Gemini — all usable with free API keys.
- See [docs/privacy-policy.md](docs/privacy-policy.md).

## Providers and models

The registry lives in [`utils/api.js`](utils/api.js). Model IDs are verified
against each provider's live catalog and carry per-model capability flags
(`response_format` support, reasoning-token handling) so the analysis prompt
gets guaranteed JSON on every provider.

## Building from source

```sh
npm test            # unit tests (providers, search, oauth, guards)
npm run build       # builds distributions/{chromium,arc,firefox,opera,safari}/ + .zip
```

Load `distributions/chromium/` as an unpacked extension for development.
Firefox, Opera, Arc, and Safari builds share one source tree with per-browser
manifests (see [`scripts/build.js`](scripts/build.js)).

## Repository layout

| Path | Role |
|---|---|
| `background/service-worker.js` | Orchestration: settings, analysis runs, OAuth, cancellation |
| `sidepanel/` | The panel UI (state machine, settings, results) |
| `content/content-script.js` | Article extraction + stale-result URL probe |
| `utils/api.js` | Provider registry, prompt builder, response parsing/citation validation |
| `utils/search.js` | Keyless grounding (Google News RSS / DuckDuckGo) |
| `docs/` | Architecture notes, privacy policy, store submission notes |

## Disclaimer

Clearify's output is AI-generated analysis, not a verdict of truth. It can be
wrong. Read the evidence it shows you and judge for yourself.

## License

[PolyForm Strict 1.0.0](LICENSE) — source-available. You may read, audit, and
run this code for personal and noncommercial purposes; redistribution and
store re-publication of derivative works require written permission.
