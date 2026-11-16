import {
  callProvider,
  buildAnalysisPrompt,
  parseResponse,
  validatePerspectiveCitations,
  PROVIDERS,
} from '../utils/api.js';
import { generateCodeVerifier, computeCodeChallenge } from '../utils/oauth.js';
import { sendMessage } from '../utils/message.js';
import { searchWeb, buildSearchQuery, buildCoverageContext } from '../utils/search.js';

const MAX_ARTICLE_CHARS = 12000;

// Module state — on an MV3 worker restart this resets, which is the correct
// degradation: a killed worker's run is dead, the panel's pending ANALYZE_PAGE
// surfaces as "Analysis interrupted. Please try again." (port-closed error),
// lastResult rehydrates from resultStore, and a fresh run is unblocked
// instead of being fenced off by a stale isAnalyzing flag.
let lastResult = null;

// Analysis results live in storage.session where the engine provides it:
// the browser clears that store when the session ends, so a restarted
// browser always reopens the panel on its idle page instead of
// resurrecting the previous session's analysis. It still survives MV3
// worker restarts mid-session, which is all the rehydrate needs.
// storage.local remains the fallback for engines without the API.
const resultStore = chrome.storage.session || chrome.storage.local;
let isAnalyzing = false;
let currentAbort = null;

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['providerId', 'providerModel', 'apiKeys'], (result) => {
      const providerId = result.providerId || 'openrouter';
      const provider = PROVIDERS[providerId] || PROVIDERS.openrouter;
      let providerModel = result.providerModel;

      if (!providerModel || !provider.models.includes(providerModel)) {
        providerModel = provider.defaultModel;
      }

      resolve({
        providerId,
        providerModel,
        apiKeys: result.apiKeys || {},
      });
    });
  });
}

async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set(settings, resolve);
  });
}

async function extractContentFromTab(tabId, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 12000);
    const done = (val) => {
      clearTimeout(timer);
      resolve(val);
    };
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_CONTENT' }, (response) => {
      if (chrome.runtime.lastError) {
        done(null);
        return;
      }
      done(response);
    });
    // Cancellation mid-extraction resolves as null; analyzePage checks the
    // signal first so that maps to "cancelled", not "failed".
    if (signal) signal.addEventListener('abort', () => done(null), { once: true });
  });
}

// tab.url is unreadable without the "tabs" permission (host_permissions
// cover only the API endpoints), so the page's own content script is the
// source of truth for the URL the user is looking at. No content script
// (chrome:// pages, injection failure) resolves as null.
function getPageUrlFromTab(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_URL' }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError || typeof response?.url !== 'string') {
        resolve(null);
        return;
      }
      resolve(response.url);
    });
  });
}

// Free provider-independent grounding: keyless web search (Google News RSS,
// DuckDuckGo fallback) gathers real articles + URLs. Raw results are kept so
// validatePerspectiveCitations can strip any citation the model invented.
async function searchCoverage(metadata, articleText, signal) {
  const query = buildSearchQuery(metadata, articleText);
  if (!query) return null;
  try {
    const results = await searchWeb(query, signal, metadata?.lang);
    if (results.length === 0) return null;
    return { context: buildCoverageContext(results), results };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[clearify] Web search failed:', err.message);
    return null;
  }
}

async function analyzePage(tabId, onStep) {
  if (isAnalyzing) {
    return { error: 'Analysis already in progress' };
  }
  isAnalyzing = true;
  const abort = new AbortController();
  currentAbort = abort;
  const signal = abort.signal;

  try {
    onStep('Extracting content…');
    const content = await extractContentFromTab(tabId, signal);

    if (signal.aborted) return { cancelled: true };

    if (!content) {
      return { error: 'Could not communicate with the page. Try refreshing and clicking Analyze again.' };
    }

    if (!content.text || content.text.length < 50) {
      return { error: 'Could not extract enough text from this page. Make sure you are on a news article.' };
    }

    const settings = await getSettings();
    const apiKey = settings.apiKeys[settings.providerId];

    if (!apiKey) {
      const provider = PROVIDERS[settings.providerId];
      return { error: `${provider.name} API key not set. Click the gear icon to enter your key.` };
    }

    // Live grounding for every analysis: free keyless web search gathers
    // real articles + URLs; the model must cite them exactly, and anything
    // it cites that was not gathered is stripped before caching.
    onStep('Searching for news coverage…');
    const coverage = await searchCoverage(content.metadata, content.text, signal);
    const webContext = coverage?.context || null;

    let text = content.text;
    if (text.length > MAX_ARTICLE_CHARS) {
      // Prefer cutting at a paragraph boundary over a mid-sentence chop
      const cut = text.lastIndexOf('\n\n', MAX_ARTICLE_CHARS);
      text = cut > MAX_ARTICLE_CHARS * 0.5 ? text.substring(0, cut) : text.substring(0, MAX_ARTICLE_CHARS);
    }

    onStep('Evaluating bias dimensions…');
    const prompt = buildAnalysisPrompt(text, content.metadata, webContext);
    const rawResponse = await callProvider(settings.providerId, apiKey, settings.providerModel, prompt, signal);
    const analysisData = parseResponse(rawResponse);

    if (coverage) validatePerspectiveCitations(analysisData, coverage.results);

    analysisData._meta = {
      contentType: 'article',
      title: content.metadata?.title || '',
      url: content.metadata?.url || '',
      source: content.metadata?.source || '',
      webEnriched: !!coverage,
      analyzedAt: Date.now(),
    };

    lastResult = analysisData;
    await resultStore.set({ lastResult: analysisData });
    return { data: analysisData };
  } catch (err) {
    if (signal.aborted || err.name === 'AbortError') {
      return { cancelled: true };
    }
    return { error: err.message || 'Analysis failed' };
  } finally {
    isAnalyzing = false;
    if (currentAbort === abort) currentAbort = null;
  }
}

// Own extension page (panel, sidebar, popup)? sender.url is an extension
// URL for those, the host page's URL for content scripts. sender.tab is
// the wrong test — it is also set for extension pages hosted in a tab,
// which is how Opera opens sidebar panels, and that check starved the
// Opera panel of settings entirely. Foreign extensions are already
// rejected by the sender.id guard at the top of onMessage.
function isOwnPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

function urlsMatch(a, b) {
  try {
    const strip = (u) => new URL(u).href.replace(/#.*$/, '');
    return strip(a) === strip(b);
  } catch {
    return a === b;
  }
}

async function exchangeOpenRouterCode(code, codeVerifier) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let resp;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: 'S256',
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error('OpenRouter did not respond. Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    if (resp.status === 403) throw new Error('Sign-in session expired. Please sign in again.');
    if (resp.status === 400) throw new Error('Sign-in failed. Please try again.');
    throw new Error(`Sign-in failed (OpenRouter error ${resp.status}).`);
  }
  const data = await resp.json();
  if (!data.key) throw new Error('OpenRouter returned no key');
  return data.key;
}

function buildOpenRouterAuthUrl(callbackUrl, challenge, state) {
  const authUrl = new URL('https://openrouter.ai/auth');
  authUrl.searchParams.set('callback_url', callbackUrl);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  // state: matches the redirect to this request (CSRF protection)
  authUrl.searchParams.set('state', state);
  // key_label: the key shows up labeled in the user's OpenRouter dashboard
  authUrl.searchParams.set('key_label', 'Clearify');
  return authUrl.toString();
}

async function clearPendingSignIn() {
  await chrome.storage.session.remove(['openrouterVerifier', 'openrouterState']);
}

// chrome.identity.launchWebAuthFlow is the only sign-in path. The redirect
// goes to a virtual https://<ext-id>.chromiumapp.org/ URL that the browser
// intercepts before any navigation happens, so no chrome-extension://
// redirect ever occurs. Engines without the identity API (Safari) fall
// back to a manually pasted API key in the panel's advanced options.
async function signInWithOpenRouter() {
  if (!chrome.identity?.launchWebAuthFlow || !chrome.identity.getRedirectURL) {
    throw new Error('Sign-in is not supported in this browser. Paste an OpenRouter API key in Advanced options instead.');
  }

  const verifier = generateCodeVerifier();
  const state = generateCodeVerifier();
  await chrome.storage.session.set({ openrouterVerifier: verifier, openrouterState: state });
  const challenge = await computeCodeChallenge(verifier);

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      interactive: true,
      url: buildOpenRouterAuthUrl(chrome.identity.getRedirectURL(), challenge, state),
    });
  } catch {
    // User closed the auth window before finishing
    await clearPendingSignIn();
    return { cancelled: true };
  }
  if (!redirectUrl) {
    await clearPendingSignIn();
    return { cancelled: true };
  }

  const params = new URLSearchParams(new URL(redirectUrl).search);
  const code = params.get('code');
  if (!code || params.get('state') !== state) {
    await clearPendingSignIn();
    throw new Error('Sign-in session expired. Please sign in again.');
  }

  // The verifier is single-use; destroy it on every exit path, including a
  // failed exchange, so no PKCE material outlives the flow.
  let key;
  try {
    key = await exchangeOpenRouterCode(code, verifier);
  } finally {
    await clearPendingSignIn();
  }
  const settings = await getSettings();
  settings.apiKeys.openrouter = key;
  await saveSettings({ apiKeys: settings.apiKeys });
  sendMessage('OPENROUTER_SIGNED_IN').catch(() => {});
  return { success: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content scripts are low-trust; only act on our own extension's messages
  if (!sender.id || sender.id !== chrome.runtime.id) return;

  if (msg.type === 'ANALYZE_PAGE') {
    const runAnalysis = (tabId) => {
      analyzePage(tabId, (step) => {
        sendMessage('ANALYSIS_STEP', { step }).catch(() => {});
      }).then(sendResponse);
    };
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        sendResponse({ error: 'No active tab found' });
        return;
      }
      runAnalysis(tabs[0].id);
    });
    return true;
  }

  if (msg.type === 'CANCEL_ANALYSIS') {
    currentAbort?.abort();
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'GET_LAST_RESULT') {
    (async () => {
      let result = lastResult;
      if (!result) {
        const store = await resultStore.get(['lastResult']);
        result = store.lastResult || null;
      }
      if (!result) {
        sendResponse({ data: null });
        return;
      }
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const pageUrl = tabs[0] ? await getPageUrlFromTab(tabs[0].id) : null;
      // Stale results for a different page are worse than no results — and
      // a page whose URL can't be read (no content script) can't vouch.
      if (pageUrl == null || !urlsMatch(pageUrl, result._meta?.url || '')) {
        sendResponse({ data: null, stale: true });
      } else {
        sendResponse({ data: result });
      }
    })();
    return true;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    if (!isOwnPage(sender)) return; // writes come from the panel, not page contexts
    const settings = msg.settings;
    if (!settings || typeof settings !== 'object' || !settings.apiKeys || typeof settings.apiKeys !== 'object') {
      sendResponse({ error: 'Invalid settings' });
      return true;
    }
    saveSettings(settings).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'GET_SETTINGS') {
    // Extension pages only — content-script contexts never receive keys.
    if (!isOwnPage(sender)) return;
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === 'GET_PROVIDERS') {
    sendResponse({ providers: PROVIDERS });
    return true;
  }

  if (msg.type === 'SIGN_IN_OPENROUTER') {
    signInWithOpenRouter()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'SIGN_OUT_OPENROUTER') {
    getSettings().then(async (settings) => {
      delete settings.apiKeys.openrouter;
      await saveSettings({ apiKeys: settings.apiKeys });
      await clearPendingSignIn();
      sendResponse({ success: true });
    });
    return true;
  }

});

// One shared background for every engine, detected at runtime. Firefox and
// Opera open their own sidebar; Chrome/Edge/Brave/Vivaldi/Arc use
// chrome.sidePanel. Safari opens the panel as a default action popup
// (declared in its manifest) and Firefox Android gets the same via
// action.setPopup at startup below.
if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (typeof browser !== 'undefined' && browser.sidebarAction) {
      browser.sidebarAction.open().catch(() => {});
    } else {
      // chrome.sidePanel is Chromium-only (Firefox uses browser.sidebarAction
      // above). addons-linter flags direct member access as "not implemented
      // by Firefox", so the method is resolved through an alias; runtime
      // behavior is identical on every engine.
      const sidePanel = chrome.sidePanel;
      if (typeof sidePanel?.open === 'function') {
        sidePanel.open({ tabId: tab.id }).catch(() => {});
      }
    }
  });
}

(async () => {
  if (typeof browser === 'undefined' || !browser.action?.setPopup) return;
  try {
    const { os } = await browser.runtime.getPlatformInfo();
    if (os === 'android') {
      await browser.action.setPopup({ popup: chrome.runtime.getURL('sidepanel/sidepanel.html') });
    }
  } catch (err) {
    // ignore; desktop keeps sidebar behavior
  }
})();
