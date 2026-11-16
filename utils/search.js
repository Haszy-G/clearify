// Free, provider-independent grounding — no keys, no accounts, no provider
// tools. Primary: Google News RSS, which aggregates the same story across
// many outlets (exactly what the perspectives and blind-spots fields need)
// and has no bot challenge in practice. Fallback: DuckDuckGo's HTML endpoint
// for general web results. Every result carries REAL URLs — the citations
// the model must copy exactly, and which validatePerspectiveCitations
// enforces afterwards.

import { fetchWithGuards } from './api.js';

const MAX_RESULTS = 6;
const SEARCH_TIMEOUT_MS = 15000;

function decodeHtmlEntities(text) {
  // Keys are the bare entity names so no literal "&…;" sequences appear here.
  const named = { amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ', '#x27': "'", '#39': "'" };
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&(amp|quot|lt|gt|nbsp|#x27|#39);/g, (m, name) => named[name] ?? m);
}

const stripTags = (html) => html.replace(/<[^>]+>/g, '').trim();

// DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded real url>.
function unwrapRedirect(href) {
  let url = href;
  if (url.startsWith('//')) url = 'https:' + url;
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) url = uddg;
  } catch {
    return '';
  }
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

export function parseDuckDuckGoResults(html) {
  const results = [];
  const blocks = html.split(/<h2[^>]*class="result__title"[^>]*>/).slice(1);
  for (const block of blocks.slice(0, 12)) {
    const linkMatch = block.match(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const url = unwrapRedirect(linkMatch[1]);
    if (!url) continue;
    const title = decodeHtmlEntities(stripTags(linkMatch[2]));
    if (!title) continue;
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/);
    const snippet = snippetMatch ? decodeHtmlEntities(stripTags(snippetMatch[1])) : '';
    results.push({ title, url, snippet });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

// Google News RSS items look like:
//   <item><title>Headline - Reuters</title>
//         <link>https://news.google.com/rss/articles/CBMi…?oc=5</link>
//         <pubDate>Thu, 25 Jun 2026 07:00:00 GMT</pubDate>
//         <source url="https://www.reuters.com">Reuters</source></item>
// <link> is a news.google.com redirect that resolves to the real article in
// the browser; <source url> is the outlet's own homepage. Both are real,
// citable URLs. <description> only repeats the headline, so it is skipped.
export function parseGoogleNewsResults(xml) {
  const results = [];
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  for (const item of items) {
    const rawTitle = decodeHtmlEntities(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim();
    if (!rawTitle) continue;
    const url = decodeHtmlEntities(item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const sourceMatch = item.match(/<source[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/);
    const outletUrl = sourceMatch ? sourceMatch[1].trim() : '';
    const source = sourceMatch ? decodeHtmlEntities(sourceMatch[2]).trim() : '';
    // Headlines arrive as "Actual headline - Outlet"; split the suffix off.
    let title = rawTitle;
    if (source && rawTitle.endsWith(` - ${source}`)) {
      title = rawTitle.slice(0, -` - ${source}`.length).trim();
    }
    const date = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '')
      .replace(/^[A-Za-z]+,\s*/, '') // day name
      .replace(/\s+\d{2}:\d{2}:\d{2}\s+\w+$/, '') // time + zone
      .trim();
    results.push({ title, url, snippet: '', source, outletUrl, date });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

// Search for the STORY, not the outlet: including the source site in the
// query biases results toward the page the user is already reading — the
// opposite of what the perspectives cards need. When there is no usable
// headline (paywall, SPA shell), the article's opening words usually carry
// enough of the who/what to find the story.
export function buildSearchQuery(metadata, articleText) {
  const title = (metadata?.title || '').trim();
  if (title) return title.slice(0, 150);
  return (articleText || '').trim().split(/\s+/).slice(0, 14).join(' ').slice(0, 150);
}

export function buildCoverageContext(results) {
  return results
    .map((r, i) => {
      const who = r.source ? `${r.source} — ` : '';
      const when = r.date ? ` (${r.date})` : '';
      const lines = [`[${i + 1}] ${who}${r.title}${when}`, r.url];
      if (r.outletUrl) lines.push(`outlet: ${r.outletUrl}`);
      if (r.snippet) lines.push(r.snippet);
      return lines.join('\n');
    })
    .join('\n\n');
}

// Map the page's BCP-47 language tag (e.g. "en-NG", "pt-BR", "fr") onto the
// Google News edition parameters. Matching the story's region surfaces that
// region's own outlets instead of the US edition's picks; unsupported or
// malformed tags fall back to the default edition, and if an edition combo
// upsets the endpoint the fallback web search still grounds the analysis.
export function googleNewsParams(lang) {
  const m = /^([a-z]{2,3})(?:[-_]([A-Za-z]{2}))?$/.exec((lang || '').trim());
  if (!m) return 'hl=en-US&gl=US&ceid=US:en';
  const hl = m[1];
  const gl = m[2] ? m[2].toUpperCase() : 'US';
  return `hl=${hl}&gl=${gl}&ceid=${gl}:${hl}`;
}

async function searchGoogleNews(query, signal, lang) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${googleNewsParams(lang)}`;
  const resp = await fetchWithGuards(
    url,
    { headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' } },
    { signal, timeoutMs: SEARCH_TIMEOUT_MS }
  );
  if (!resp.ok) return [];
  return parseGoogleNewsResults(await resp.text());
}

// DDG's bot challenge answers with HTTP 202 plus an "anomaly" page — `ok` is
// true for 202, so recognize it by status, not ok-ness, or the pipeline
// mistakes the challenge page for a result set and silently runs ungrounded.
async function searchDuckDuckGo(query, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchWithGuards(
    url,
    { headers: { 'Accept': 'text/html' } },
    { signal, timeoutMs: SEARCH_TIMEOUT_MS }
  );
  if (!resp.ok || resp.status === 202) return [];
  return parseDuckDuckGoResults(await resp.text());
}

export async function searchWeb(query, signal, lang) {
  // Primary: news-specific coverage, aggregated per story across outlets.
  try {
    const news = await searchGoogleNews(query, signal, lang);
    if (news.length > 0) return news;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[clearify] Google News search failed:', err.message);
  }
  // Fallback: general web search. Failures land as [] — the analysis still
  // runs, but webEnriched tells the panel it ran without live sources.
  try {
    return await searchDuckDuckGo(query, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[clearify] DuckDuckGo search failed:', err.message);
    return [];
  }
}
