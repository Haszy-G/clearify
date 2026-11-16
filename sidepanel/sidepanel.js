import { sendMessage } from '../utils/message.js';
import { PERSPECTIVE_POSITIONS } from '../utils/api.js';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const idleState = $('#idle-state');
  const loadingState = $('#loading-state');
  const resultsState = $('#results-state');
  const errorState = $('#error-state');
  const settingsPanel = $('#settings-panel');
  const settingsToggle = $('#settings-toggle');
  const settingsScrim = $('#settings-scrim');
  const settingsCloseBtn = $('#settings-close');
  const providerSelect = $('#provider-select');
  const modelSelect = $('#model-select');
  const apiKeyInput = $('#api-key-input');
  const saveKeyBtn = $('#save-key-btn');
  const apiKeyToggle = $('#api-key-toggle');
  const apiKeyField = $('#api-key-field');
  const settingsSaved = $('#settings-saved');
  const openrouterSigninField = $('#openrouter-signin-field');
  const openrouterSigninBtn = $('#openrouter-signin-btn');
  const openrouterSignoutBtn = $('#openrouter-signout-btn');
  const openrouterSigninStatus = $('#openrouter-signin-status');
  const contentTypeBadge = $('#content-type-badge');

  // Single source of truth for providers lives in utils/api.js
  let PROVIDERS = {};

  let currentSettings = {
    providerId: 'openrouter',
    providerModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    apiKeys: {},
  };

  function showState(el) {
    [idleState, loadingState, resultsState, errorState].forEach((s) => {
      s.classList.add('hidden');
      s.classList.remove('enter');
    });
    el.classList.remove('hidden');
    void el.offsetWidth;
    el.classList.add('enter');
  }

  // Settings opens on click, but closes once the pointer leaves the panel
  // or the header band it hangs from. A 300ms grace covers the gap between
  // them; an open <select> or focused input inside pins it open so native
  // dropdowns don't count as "leaving".
  const bandEl = document.querySelector('.band');
  let settingsCloseTimer = null;
  const cancelSettingsClose = () => clearTimeout(settingsCloseTimer);
  const inSettingsArea = (t) => !!(t && (settingsPanel.contains(t) || bandEl.contains(t)));

  // Overlay geometry is measured, not hardcoded: the sheet hangs from wherever
  // the band actually ends (font load can change its height).
  const metaRuleEl = document.querySelector('.meta-rule');
  const measureBandBottom = () => {
    const bottom = bandEl.offsetHeight + (metaRuleEl ? metaRuleEl.offsetHeight : 0) + 12;
    document.documentElement.style.setProperty('--band-bottom', bottom + 'px');
  };
  measureBandBottom();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureBandBottom);

  const syncSettingsChrome = () => {
    const open = !settingsPanel.classList.contains('hidden');
    settingsScrim.classList.toggle('hidden', !open);
    settingsToggle.classList.toggle('active', open);
  };
  const closeSettings = () => {
    cancelSettingsClose();
    settingsPanel.classList.add('hidden');
    syncSettingsChrome();
  };

  settingsToggle.addEventListener('click', () => {
    cancelSettingsClose();
    settingsPanel.classList.toggle('hidden');
    syncSettingsChrome();
    if (!settingsPanel.classList.contains('hidden')) measureBandBottom();
  });

  settingsScrim.addEventListener('click', closeSettings);
  settingsCloseBtn.addEventListener('click', closeSettings);

  document.addEventListener('mouseout', (e) => {
    if (settingsPanel.classList.contains('hidden')) return;
    if (inSettingsArea(e.relatedTarget)) return;
    const active = document.activeElement;
    if (active && settingsPanel.contains(active) && (active.tagName === 'SELECT' || active.tagName === 'INPUT')) return;
    cancelSettingsClose();
    settingsCloseTimer = setTimeout(closeSettings, 300);
  });
  document.addEventListener('mouseover', (e) => {
    if (inSettingsArea(e.target)) cancelSettingsClose();
  });

  // Opera sidebar: dock hint — no API to pin, so nudge once, session-scoped
  const pinHint = $('#opera-pin-hint');
  const isOperaSidebar = typeof opr !== 'undefined' && !!(opr.sidebarAction);
  if (pinHint && isOperaSidebar) {
    chrome.storage.session.get(['operaPinHintDismissed'], ({ operaPinHintDismissed }) => {
      if (!operaPinHintDismissed) pinHint.classList.remove('hidden');
    });
    $('#opera-pin-hint-dismiss').addEventListener('click', () => {
      pinHint.classList.add('hidden');
      chrome.storage.session.set({ operaPinHintDismissed: true });
    });
  }

  function populateModels(providerId) {
    const provider = PROVIDERS[providerId];
    modelSelect.innerHTML = '';
    provider.models.forEach((model) => {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      if (model === currentSettings.providerModel) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }

  function updateKeyHint(providerId) {
    const provider = PROVIDERS[providerId];
    if (!provider) return;
    const label = document.querySelector('label[for="api-key-input"]');
    label.textContent = provider.keyLabel;
    apiKeyInput.placeholder = `Paste your ${provider.keyLabel}`;
    const hint = document.querySelector('#key-hint');
    hint.textContent = `${provider.keyHint} from `;
    const link = document.createElement('a');
    link.href = provider.keyUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = provider.name;
    hint.appendChild(link);
  }

  function updateApiKeyVisibility() {
    const provider = PROVIDERS[currentSettings.providerId];
    const hasOAuth = !!(provider && provider.oauth);
    apiKeyToggle.classList.toggle('hidden', !hasOAuth);
    apiKeyToggle.setAttribute('aria-expanded', 'false');
    apiKeyField.classList.toggle('hidden', hasOAuth);
  }

  apiKeyToggle.addEventListener('click', () => {
    const expanded = apiKeyToggle.getAttribute('aria-expanded') === 'true';
    apiKeyToggle.setAttribute('aria-expanded', String(!expanded));
    apiKeyField.classList.toggle('hidden', expanded);
  });

  function updateOpenRouterSignin() {
    const isOpenRouter = currentSettings.providerId === 'openrouter';
    openrouterSigninField.classList.toggle('hidden', !isOpenRouter);
    if (!isOpenRouter) return;
    const signedIn = !!(currentSettings.apiKeys || {}).openrouter;
    document.querySelector('.account-card-title').textContent = 'OpenRouter';
    openrouterSigninStatus.textContent = signedIn ? 'Connected' : 'Not connected';
    openrouterSigninStatus.classList.toggle('connected', signedIn);
    document.querySelector('#openrouter-status-dot').classList.toggle('connected', signedIn);
    openrouterSigninBtn.classList.toggle('hidden', signedIn);
    openrouterSignoutBtn.classList.toggle('hidden', !signedIn);
  }

  // Persist provider/model choices immediately — Analyze reads settings from
  // storage, so an unsaved switch would silently run the previous model.
  function persistSettings() {
    // Fire-and-forget: the SW persists; nothing in the panel depends on the ack.
    sendMessage('SAVE_SETTINGS', { settings: currentSettings });
  }

  function onProviderChange() {
    const providerId = providerSelect.value;
    currentSettings.providerId = providerId;
    currentSettings.providerModel = PROVIDERS[providerId].defaultModel;
    populateModels(providerId);
    updateKeyHint(providerId);
    updateOpenRouterSignin();
    updateApiKeyVisibility();
    apiKeyInput.value = currentSettings.apiKeys[providerId] || '';
    persistSettings();
  }

  providerSelect.addEventListener('change', onProviderChange);

  async function startOpenRouterSignIn() {
    openrouterSigninStatus.textContent = 'Opening OpenRouter sign-in…';
    const resp = await sendMessage('SIGN_IN_OPENROUTER');
    if (!resp) return;
    if (resp.cancelled) {
      openrouterSigninStatus.textContent = 'Sign-in cancelled';
    } else if (resp.error) {
      openrouterSigninStatus.textContent = `Sign-in failed: ${resp.error}`;
    }
    // success arrives via the OPENROUTER_SIGNED_IN broadcast
  }

  openrouterSigninBtn.addEventListener('click', startOpenRouterSignIn);

  openrouterSignoutBtn.addEventListener('click', () => {
    sendMessage('SIGN_OUT_OPENROUTER').then((resp) => {
      if (resp && resp.success) {
        currentSettings.apiKeys.openrouter = undefined;
        updateOpenRouterSignin();
      }
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.type === 'OPENROUTER_SIGNED_IN') {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
        void chrome.runtime.lastError; // SW restart race — settings reload below covers it
        if (resp) {
          currentSettings.apiKeys = resp.apiKeys || {};
          updateOpenRouterSignin();
        }
      });
    }
  });

  modelSelect.addEventListener('change', () => {
    currentSettings.providerModel = modelSelect.value;
    persistSettings();
  });

  async function loadSettings() {
    const providersResp = await sendMessage('GET_PROVIDERS');
    PROVIDERS = providersResp?.providers || {};
    const resp = await sendMessage('GET_SETTINGS');
    if (!resp) return;
    currentSettings = {
      providerId: resp.providerId || 'openrouter',
      providerModel: resp.providerModel || (PROVIDERS.openrouter && PROVIDERS.openrouter.defaultModel),
      apiKeys: resp.apiKeys || {},
    };
    providerSelect.innerHTML = '';
    Object.keys(PROVIDERS).forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = PROVIDERS[id].name;
      if (id === currentSettings.providerId) opt.selected = true;
      providerSelect.appendChild(opt);
    });
    populateModels(currentSettings.providerId);
    const savedModel = currentSettings.providerModel;
    if (PROVIDERS[currentSettings.providerId] && PROVIDERS[currentSettings.providerId].models && PROVIDERS[currentSettings.providerId].models.includes(savedModel)) {
      modelSelect.value = savedModel;
    }
    updateKeyHint(currentSettings.providerId);
    updateOpenRouterSignin();
    updateApiKeyVisibility();
    apiKeyInput.value = currentSettings.apiKeys[currentSettings.providerId] || '';
  }

  saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const providerId = currentSettings.providerId;
    if (!key) return;
    currentSettings.apiKeys[providerId] = key;
    currentSettings.providerModel = modelSelect.value;
    persistSettings();
    settingsSaved.classList.remove('hidden');
    setTimeout(() => settingsSaved.classList.add('hidden'), 2000);
  });

  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveKeyBtn.click();
  });

  function renderScore(score) {
    const fill = $('#score-meter-fill');
    const needle = $('#score-needle');
    const num = $('#score-number');
    const pct = Math.min(100, Math.max(0, Number(score) || 0));
    fill.style.width = '0%';
    needle.style.left = '0%';
    num.textContent = pct;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fill.style.width = `${pct}%`;
        needle.style.left = `${pct}%`;
      });
    });
  }

  function verdictBand(score) {
    if (score >= 80) return 'verdict-high';
    if (score >= 60) return 'verdict-moderate';
    if (score >= 40) return 'verdict-low';
    return 'verdict-critical';
  }

  function setVerdict(score) {
    const el = $('#score-verdict');
    el.className = `score-verdict ${verdictBand(score)}`;
    if (score >= 80) {
      el.textContent = 'Mostly Credible';
    } else if (score >= 60) {
      el.textContent = 'Moderate Bias';
    } else if (score >= 40) {
      el.textContent = 'Significant Bias';
    } else {
      el.textContent = 'Highly Biased';
    }
  }

  function setDimension(id, value) {
    const bar = $(`#dim-${id}`);
    const val = $(`#dim-${id}-val`);
    const pct = Math.min(100, Math.max(0, Number(value) || 0));
    bar.style.width = '0%';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bar.style.width = `${pct}%`;
      });
    });
    val.textContent = `${pct}%`;
  }

  function setFraming(text) {
    $('#framing-text').textContent = text;
  }

  function setOmissions(omissions) {
    const section = $('#omissions-section');
    const list = $('#omissions-list');
    list.innerHTML = '';
    if (!omissions || omissions.length === 0) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    omissions.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'omission';
      div.textContent = item;
      list.appendChild(div);
    });
  }

  function setPerspectives(perspectives) {
    const positions = PERSPECTIVE_POSITIONS;
    positions.forEach((pos) => {
      const data = perspectives[pos] || {};
      const url = typeof data.url === 'string' && /^https?:\/\//i.test(data.url) ? data.url : '';
      // The outlet name is the link; the cited URL sits under it as the
      // anchor target and hover tooltip. Only http(s), never a model-invented
      // scheme, and a missing name falls back to the real hostname.
      const src = $(`#persp-${pos}-source`);
      let label = data.source && data.source !== 'N/A' ? data.source : '—';
      if (url && label === '—') {
        try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep '—' */ }
      }
      src.textContent = label;
      if (url) {
        src.href = url;
        src.title = url;
      } else {
        src.removeAttribute('href');
        src.removeAttribute('title');
      }
      $(`#persp-${pos}-summary`).textContent = data.summary || 'No opposing perspective found.';

      const card = $(`#persp-${pos}`);
      card.style.opacity = data.summary ? '1' : '0.35';
    });
  }

  function renderContentBadge(meta) {
    contentTypeBadge.classList.add('hidden');
    contentTypeBadge.replaceChildren();

    if (!meta) return;

    const addBadge = (className, text, title) => {
      const span = document.createElement('span');
      if (className) span.className = className;
      span.textContent = text;
      if (title) span.title = title;
      contentTypeBadge.appendChild(span);
    };

    addBadge('content-badge-icon', '📰');
    addBadge('', 'Article');
    if (meta.source) addBadge('content-badge-channel', meta.source);
    if (meta.webEnriched) {
      addBadge('content-badge-enriched', '🔍 WEB');
    } else {
      addBadge(
        'content-badge-ungrounded',
        '⚠ NO SOURCES',
        'No live coverage was found for this page — perspective cards are AI-generated context without cited sources.'
      );
    }
    contentTypeBadge.classList.remove('hidden');
  }

  function friendlyAgo(ts) {
    if (!ts) return '';
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function renderResults(data) {
    const score = data.credibilityScore ?? 0;
    renderScore(score);
    setVerdict(score);

    const dims = [
      ['linguistic', 100 - (data.dimensions?.linguisticBias ?? 100)],
      ['ideological', 100 - (data.dimensions?.ideologicalLean ?? 100)],
      ['sentiment', 100 - (data.dimensions?.sentimentPolarity ?? 100)],
      ['factual', data.dimensions?.factualCompleteness ?? 0],
    ];
    dims.forEach(([id, value]) => setDimension(id, value));

    setFraming(data.framingAnalysis || 'No framing analysis available.');
    setOmissions(data.omissions || []);
    setPerspectives(data.perspectives || {});

    const meta = data._meta || null;
    renderContentBadge(meta);
    $('#analyzed-ago').textContent = friendlyAgo(meta?.analyzedAt);

    showState(resultsState);
  }

  // Loading text is driven by real ANALYSIS_STEP events from the service
  // worker — no canned sequence, so what it says is what is happening.
  function updateLoadingStep(text) {
    if (text) $('#loading-step').textContent = text;
  }


  let elapsedInterval = null;

  function friendlyAnalysisError(raw) {
    const msg = String(raw || '');
    if (/port closed|Receiving end does not exist/i.test(msg)) return 'Analysis interrupted. Please try again.';
    if (/\b401\b|\b403\b/.test(msg)) return 'Your API key was rejected. Check the key in settings and try again.';
    if (/\b429\b|rate.?limit/i.test(msg)) return 'This free model is busy right now. Try again in a moment, or pick another model in settings.';
    if (/\b404\b/.test(msg)) return 'That model is not available. Pick another one in settings.';
    if (/finish_?reason:?\s*(length|max_tokens)/i.test(msg)) return 'The model spent its response budget before finishing. Try again, or pick another model in settings.';
    if (/timed? ?out|abort/i.test(msg)) return 'The request timed out. Try again, or pick a faster model.';
    if (/network|failed to fetch|ERR_/i.test(msg)) return 'Could not reach the AI provider. Check your connection and try again.';
    if (msg.length > 180) return `${msg.slice(0, 180)}…`;
    return msg || 'Something went wrong';
  }

  function startAnalysis() {
    // Remember what was on screen so a cancelled run returns to it
    const prevState = [idleState, resultsState, errorState]
      .find((s) => !s.classList.contains('hidden')) || idleState;

    $('#loading-step').textContent = 'Extracting content…';
    showState(loadingState);

    const startedAt = Date.now();
    const elapsedEl = $('#loading-elapsed');
    clearInterval(elapsedInterval);
    elapsedEl.textContent = '0s';
    elapsedInterval = setInterval(() => {
      elapsedEl.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
    }, 1000);

    const stepListener = (msg, sender) => {
      if (sender.id !== chrome.runtime.id) return;
      if (msg.type === 'ANALYSIS_STEP') {
        updateLoadingStep(msg.step);
      }
    };
    chrome.runtime.onMessage.addListener(stepListener);

    const message = { type: 'ANALYZE_PAGE' };

    // Raw chrome.runtime.sendMessage, not the sendMessage wrapper: this
    // callback needs chrome.runtime.lastError's text to map "port closed"
    // (SW death mid-run) to a friendly message; the wrapper collapses that
    // to undefined.
    chrome.runtime.sendMessage(message, (response) => {
      clearInterval(elapsedInterval);
      chrome.runtime.onMessage.removeListener(stepListener);

      if (chrome.runtime.lastError) {
        $('#error-message').textContent = friendlyAnalysisError(chrome.runtime.lastError.message);
        showState(errorState);
        return;
      }
      if (response && response.cancelled) {
        showState(prevState);
        return;
      }
      if (response && response.error) {
        $('#error-message').textContent = friendlyAnalysisError(response.error);
        showState(errorState);
        return;
      }
      if (response && response.data) {
        renderResults(response.data);
      } else {
        $('#error-message').textContent = 'No analysis data returned';
        showState(errorState);
      }
    });
  }

  $('#loading-cancel-btn').addEventListener('click', () => {
    sendMessage('CANCEL_ANALYSIS').catch(() => {});
  });

  $('#idle-analyze-btn').addEventListener('click', startAnalysis);
  $('#reanalyze-btn').addEventListener('click', startAnalysis);
  $('#error-retry-btn').addEventListener('click', startAnalysis);

  // ponytail: static BMC link in sidepanel.html — no JS ad fetch needed. Delete this if you add sponsored creatives later.

  loadSettings().then(() => {
    sendMessage('GET_LAST_RESULT').then((response) => {
      if (response && response.data) {
        renderResults(response.data);
      }
    });
  });
})();
