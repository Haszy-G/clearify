(function () {
  function extractArticleText() {
    const selectors = [
      'article',
      '[role="article"]',
      '.article-body',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.story-body',
      '.article__body',
      'main p',
      '.content p',
    ];

    let bestText = '';

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length === 0) continue;

      const seen = new Set();
      const topLevel = Array.from(els).filter((el) => {
        for (const parent of seen) {
          if (parent.contains(el)) return false;
        }
        seen.add(el);
        return true;
      });

      const currentText = topLevel
        .map((el) => el.innerText.trim())
        .filter((t) => t.length > 0)
        .join('\n\n');

      if (currentText.length > 200) return currentText;
      if (currentText.length > bestText.length) bestText = currentText;
    }

    if (bestText.length < 200) {
      const paragraphs = document.querySelectorAll('p');
      const seen = new Set();
      const uniqueParagraphs = Array.from(paragraphs).filter((p) => {
        for (const parent of seen) {
          if (parent.contains(p)) return false;
        }
        seen.add(p);
        return true;
      });
      const paragraphText = uniqueParagraphs
        .map((p) => p.innerText.trim())
        .filter((t) => t.length > 0)
        .join('\n\n');
      if (paragraphText.length > bestText.length) bestText = paragraphText;
    }

    return bestText.trim();
  }

  function extractMetadata() {
    const title =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('h1')?.innerText ||
      document.title ||
      '';

    const url = window.location.href;

    const source =
      document.querySelector('meta[property="og:site_name"]')?.content ||
      window.location.hostname;

    const description =
      document.querySelector('meta[property="og:description"]')?.content ||
      document.querySelector('meta[name="description"]')?.content ||
      '';

    const author =
      document.querySelector('meta[name="author"]')?.content ||
      document.querySelector('[rel="author"]')?.innerText ||
      '';

    // BCP-47 language tag (e.g. "en-NG", "pt-BR"); feeds the Google News
    // edition parameters so coverage comes from the story's own region.
    const lang =
      document.documentElement.lang ||
      document.querySelector('meta[property="og:locale"]')?.content ||
      '';

    return { title, url, source, description, author, lang };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return true;

    if (msg.type === 'EXTRACT_CONTENT') {
      sendResponse({
        contentType: 'article',
        text: extractArticleText(),
        metadata: extractMetadata(),
      });
      return true;
    }

    // The SW can't read tab.url without the "tabs" permission; this is the
    // source of truth for the staleness check on cached results.
    if (msg.type === 'GET_PAGE_URL') {
      sendResponse({ url: window.location.href });
      return true;
    }

    return true;
  });
})();
