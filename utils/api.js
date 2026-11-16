const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    keyLabel: 'OpenRouter API Key',
    keyHint: 'Get a free key',
    keyUrl: 'https://openrouter.ai/settings/keys',
    oauth: true,
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'google/gemma-4-31b-it:free',
      'thinkingmachines/inkling-2-small:free',
    ],
    baseUrl: 'https://openrouter.ai/api/v1',
    // Per-model facts from openrouter.ai/api/v1/models (checked 2026-11-16).
    // json: the model accepts response_format — models without it 400, and a
    // guaranteed 400+retry on the DEFAULT model doubled every run's latency
    // and free-tier rate-limit exposure. reasoning: the model reasons by
    // default (ultra ships effort 'high', ~80% of max_tokens for thinking) —
    // reasoning shares the max_tokens budget, so it must be switched off or
    // the JSON comes back empty or truncated ("Empty response from API" /
    // parse failures). Unknown models get neither extra; the 400-fallback
    // in callProvider strips both if these flags ever drift from the API.
    modelFlags: {
      'nvidia/nemotron-3-ultra-550b-a55b:free': { json: false, reasoning: true },
      'nvidia/nemotron-3.5-super-vl:free': { json: true, reasoning: true },
      'google/gemma-4-31b-it:free': { json: true, reasoning: false },
      'thinkingmachines/inkling-2-small:free': { json: false, reasoning: true },
    },
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    keyLabel: 'NVIDIA API Key',
    keyHint: 'Get a free key',
    keyUrl: 'https://build.nvidia.com/signin',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    // IDs verified against integrate.api.nvidia.com/v1/chat/completions
    // (2026-11-16): nemotron-3-super-120b-a12b (EOL 2026-10-03),
    // nemotron-nano-3-30b-a3b (EOL 2026-09-01) and moonshotai/kimi-k2.6
    // (EOL 2026-11-15) all answer 410 Gone before auth — a dead ID kills
    // every analysis. Successors: 3.5-super-vl, nano-omni (reasoning), and
    // z-ai/glm-5.3-flash in Moonshot's slot.
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3.5-super-vl-120b-a12b',
      'nvidia/nemotron-nano-omni-30b-a3b-reasoning',
      'deepseek-ai/deepseek-v4.1-flash',
      'z-ai/glm-5.3-flash',
      'meta/muse-glimmer-30b',
    ],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // NVIDIA keys thinking on per-model; disable it since we want straight answers
    extraBodyForModel(model) {
      if (model.includes('nemotron')) {
        return { chat_template_kwargs: { enable_thinking: false } };
      }
      if (model.includes('deepseek-v4')) {
        return { chat_template_kwargs: { thinking: false } };
      }
      return {};
    },
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    keyLabel: 'Gemini API Key',
    keyHint: 'Get a free key',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.8-flash',
    // gemini-3.5-flash is a retired alias that auto-routes to 3.6-flash
    // (ai.google.dev deprecations, checked 2026-11-16) — ship real IDs.
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
};

// One retry on 429/503 or a transient network error, a hard timeout, and
// clean user-abort propagation. Timeout throws the friendly message; a user
// abort stays an AbortError so analyzePage keeps reporting cancellation as
// "cancelled", not failure.
async function fetchWithGuards(url, init = {}, { signal, timeoutMs = 60000, backoffMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new DOMException('aborted', 'AbortError');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const resp = await fetch(url, { ...init, signal: ctrl.signal });
      if ((resp.status === 429 || resp.status === 503) && attempt === 0) {
        // Free-tier models 429 often; honor the server's Retry-After hint
        // when sane, capped so a hostile header can never stall the run.
        const hinted = Number(resp.headers?.get?.('retry-after'));
        const wait = Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted * 1000, 8000) : backoffMs;
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      return resp;
    } catch (err) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (ctrl.signal.aborted) throw new Error('The AI provider timed out. Try again, or pick a faster model.');
      // Transient network error (ECONNRESET, ETIMEDOUT, "fetch failed"):
      // one retry before surfacing — grounding and provider calls both
      // benefit; a persistent failure still fails fast on the second try.
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

async function callProvider(providerId, apiKey, model, prompt, signal) {
  switch (providerId) {
    case 'gemini':
      return callGemini(apiKey, model || PROVIDERS.gemini.defaultModel, prompt, { signal });
    case 'nvidia': {
      const nvidiaModel = model || PROVIDERS.nvidia.defaultModel;
      return callOpenAICompatible(
        PROVIDERS.nvidia.baseUrl,
        apiKey,
        nvidiaModel,
        prompt,
        { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        PROVIDERS.nvidia.extraBodyForModel(nvidiaModel),
        signal
      );
    }
    case 'openrouter': {
      const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://clearify.io',
        'X-Title': 'Clearify.io',
      };
      // Ask schema-capable models for guaranteed JSON and switch reasoning
      // off on reasoning-capable ones — both decided per model by the
      // registry's modelFlags (live API facts, not guesses). A model that
      // rejects any extra falls back to the bare prompt-only contract
      // silently, so registry drift can never hard-fail a run.
      const orModel = model || PROVIDERS.openrouter.defaultModel;
      const flags = PROVIDERS.openrouter.modelFlags[orModel] || {};
      const extraBody = {};
      if (flags.json) extraBody.response_format = { type: 'json_object' };
      if (flags.reasoning) extraBody.reasoning = { effort: 'none' };
      try {
        return await callOpenAICompatible(
          PROVIDERS.openrouter.baseUrl,
          apiKey,
          orModel,
          prompt,
          headers,
          extraBody,
          signal
        );
      } catch (err) {
        if (/\b400\b/.test(err.message)) {
          return callOpenAICompatible(
            PROVIDERS.openrouter.baseUrl,
            apiKey,
            orModel,
            prompt,
            headers,
            {},
            signal
          );
        }
        throw err;
      }
    }
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

// The Gemini provider's generateContent call — just the analysis LLM. The
// grounding that feeds the perspectives/blind-spots fields is keyless and
// lives in utils/search.js; nothing here needs a provider's search tool.
async function callGemini(apiKey, model, prompt, { signal } = {}) {
  const url = `${PROVIDERS.gemini.baseUrl}/models/${model}:generateContent`;
  // Gemini 3.x thinks at 'high' by default and thought tokens share the
  // maxOutputTokens budget — a small cap comes back empty or truncated.
  // 'low' is the level every registry model supports ('minimal' errors on
  // 3.8-flash). temperature/topP are deliberately gone: 3.6+ ignores them
  // and will start rejecting them, and older 3.x reasons better on
  // defaults. responseMimeType guarantees JSON output for the parser.
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: 'low' },
    },
  };

  const resp = await fetchWithGuards(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  }, { signal });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) {
    // MAX_TOKENS here means thinking ate the budget — the caller's message
    // names it instead of a bare "empty response".
    const why = candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : '';
    throw new Error(`Empty response from Gemini${why}`);
  }
  return text;
}

async function callOpenAICompatible(baseUrl, apiKey, model, prompt, extraHeaders = {}, extraBody = {}, signal) {
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    top_p: 0.9,
    // Reasoning tokens (OpenRouter reasoning models, NIM thinking models)
    // share this budget with the visible JSON — 3072 starved it; 8192
    // leaves room for thinking plus the full analysis object.
    max_tokens: 8192,
    ...extraBody,
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    ...extraHeaders,
  };

  const resp = await fetchWithGuards(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, { signal });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (!text) {
    // finish_reason "length" = the budget went to reasoning, none left for
    // content — surface the cause so the panel can say what happened.
    const why = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '';
    throw new Error(`Empty response from API${why}`);
  }
  return text;
}

// Shared with the panel: the three perspective cards, in display order.
const PERSPECTIVE_POSITIONS = ['progressive', 'mainstream', 'conservative'];

// The response shape is fixed; the prompt text supplies all context.
const RESPONSE_SCHEMA = `{
  "credibilityScore": <number 0-100, where 80+ means mostly neutral/credible>,
  "dimensions": {
    "linguisticBias": <number 0-100, 0=no loaded language, 100=extreme loaded language>,
    "ideologicalLean": <number 0-100, 0=perfectly balanced, 100=extreme one-sided>,
    "sentimentPolarity": <number 0-100, 0=factually neutral tone, 100=extreme emotional manipulation>,
    "factualCompleteness": <number 0-100, 0=all key facts absent, 100=all key facts present>
  },
  "framingAnalysis": "<1-2 sentence description of how the content frames the topic — tone, emphasis, narrative arc>",
  "omissions": [
    "<specific fact or perspective the content omits, reported by other sources>",
    "<another omission if found, or remove this element>"
  ],
  "perspectives": {
    "progressive": {
      "source": "<name of a progressive/reform-leaning outlet in the content's region covering this story, or 'N/A'>",
      "url": "<the exact URL of the source this summary is based on — never invent one; use 'N/A' if none>",
      "summary": "<1-2 sentence summary of how progressive sources in that region frame this story>"
    },
    "mainstream": {
      "source": "<name of a mainstream/centrist outlet in the content's region covering this story, or 'N/A'>",
      "url": "<the exact URL of the source this summary is based on — never invent one; use 'N/A' if none>",
      "summary": "<1-2 sentence summary of how mainstream sources in that region frame this story>"
    },
    "conservative": {
      "source": "<name of a conservative/traditionalist outlet or creator in the content's region covering this story, or 'N/A'>",
      "url": "<the exact URL of the source this summary is based on — never invent one; use 'N/A' if none>",
      "summary": "<1-2 sentence summary of how conservative sources in that region frame this story>"
    }
  }
}`;

function buildAnalysisPrompt(articleText, metadata, webContext) {
  const webContextSection = webContext
    ? `Web Coverage (live search results — real articles with their exact URLs):\n${webContext}\n\nEach numbered entry above is a real source with a real URL. Judge omissions against this coverage: every omission must be a fact evident from the entries above — a fact other listed sources report that this article leaves out. For every perspective you report, set its "url" field to the EXACT URL of an entry above that the summary is based on — copy the URL character for character. Never invent a URL; if no listed source fits a perspective, use 'N/A' for both source and url.\n\n`
    : `NO live web coverage was retrieved for this article, so you have NO real sources for the perspectives and omissions fields. Do NOT invent outlets, URLs, headlines, or coverage claims. For each perspective: set "source" and "url" to 'N/A', and phrase "summary" as general background context about how such stories are typically framed — never as how specific other outlets reported this story. Keep omissions to gaps evident from the article text itself.\n\n`;

  return `You are an expert global media bias analyst. You must identify the REGIONAL and POLITICAL context of the article (e.g. Nigerian, Indian, Brazilian, UK, US, etc.) and evaluate bias within that local context — do NOT default to a US-centric left-right spectrum. Analyze the following news article and return a JSON object with this exact structure. Do NOT wrap in markdown code fences.

Article Title: ${metadata.title}
Source: ${metadata.source}
URL: ${metadata.url}
Author: ${metadata.author}

${webContextSection}Article Text:
${articleText}

Return ONLY this JSON structure (no other text):
${RESPONSE_SCHEMA}`;
}

// Balanced-brace scan, string-aware: models sometimes wrap JSON in prose or
// emit stray objects after it — a greedy "{…}" regex would swallow all of
// that and fail to parse. Walk to the first object that closes at depth 0,
// ignoring braces inside string literals.
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      if (--depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseResponse(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  }
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const candidate = extractFirstJsonObject(cleaned);
    if (candidate) {
      return JSON.parse(candidate);
    }
    throw new Error('Could not parse AI response as JSON');
  }
}

// Anti-hallucination backstop. The grounded prompt demands citations copied
// exactly from the coverage list, but models drift; any perspective "url"
// that is not literally one of the gathered sources is an invented link.
// Blank it (and an outlet name that matches no gathered outlet) so the panel
// renders an uncited card instead of a fabricated one.
function validatePerspectiveCitations(analysis, results) {
  const perspectives = analysis?.perspectives;
  if (!perspectives || !Array.isArray(results) || results.length === 0) return;

  const allowedUrls = new Set();
  const knownSources = new Set();
  for (const r of results) {
    for (const u of [r.url, r.outletUrl]) {
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
        allowedUrls.add(u);
        try {
          knownSources.add(new URL(u).hostname.replace(/^www\./, '').toLowerCase());
        } catch {
          /* unreachable: guarded by the same regex as allowedUrls */
        }
      }
    }
    if (typeof r.source === 'string' && r.source) knownSources.add(r.source.toLowerCase());
  }
  const sourceKnown = (s) =>
    knownSources.has(s.toLowerCase()) ||
    knownSources.has(s.toLowerCase().replace(/^the\s+/, ''));

  for (const pos of PERSPECTIVE_POSITIONS) {
    const p = perspectives[pos];
    if (!p || typeof p !== 'object') continue;

    const hasUrl = typeof p.url === 'string' && p.url !== 'N/A';
    const urlAllowed = hasUrl && allowedUrls.has(p.url);
    if (hasUrl && !urlAllowed) p.url = 'N/A';

    // A URL copied exactly from the coverage vouches for the card. Otherwise
    // the outlet name must itself be one we gathered, or it is invented too.
    if ((hasUrl ? !urlAllowed : true) && typeof p.source === 'string' && p.source !== 'N/A' && !sourceKnown(p.source)) {
      p.source = 'N/A';
    }
  }
}

export {
  PROVIDERS,
  PERSPECTIVE_POSITIONS,
  fetchWithGuards,
  callProvider,
  callGemini,
  buildAnalysisPrompt,
  parseResponse,
  validatePerspectiveCitations,
};
