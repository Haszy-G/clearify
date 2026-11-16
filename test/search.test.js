import assert from 'node:assert';
import { parseDuckDuckGoResults, parseGoogleNewsResults, buildCoverageContext, buildSearchQuery, googleNewsParams, searchWeb } from '../utils/search.js';

const fixture = `<div class="results">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.theguardian.com%2Fworld%2Fstrike-third-week&rut=1">Strike enters third week as talks stall</a></h2>
<a class="result__snippet" href="#">Union leaders said negotiations would resume on Friday after a walkout.</a>
<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.reuters.com/business/x">Rail strike latest: pay talks continue &amp; operators warn of disruption</a></h2>
<a class="result__snippet" href="#">Pay talks continue between the union and the rail operator.</a>
</div>`;

const results = parseDuckDuckGoResults(fixture);
assert.equal(results.length, 2, 'two results parsed');
assert.ok(results[0].url.startsWith('https://www.theguardian.com/world/strike-third-week'), 'uddg redirect param unwrapped to the real article URL');
assert.equal(results[0].title, 'Strike enters third week as talks stall', 'title cleaned of markup');
assert.ok(results[0].snippet.includes('Union leaders'), 'snippet extracted');
assert.equal(results[1].url, 'https://www.reuters.com/business/x', 'direct https link passes through untouched');
assert.ok(results[1].title.includes('&'), 'HTML entities decoded in title');
assert.ok(!results[1].title.includes('amp;'), 'entity not left half-decoded');

assert.deepStrictEqual(parseDuckDuckGoResults('<html><body>no results here</body></html>'), [], 'no results yields empty array');

const many = parseDuckDuckGoResults(
  Array.from({ length: 12 }, (_, i) =>
    `<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/${i}">Result ${i}</a></h2><a class="result__snippet" href="#">Snippet ${i}</a>`
  ).join('')
);
assert.equal(many.length, 6, 'result list capped at 6');

const coverage = buildCoverageContext(results);
assert.ok(coverage.includes('https://www.theguardian.com/world/strike-third-week'), 'coverage carries the real URL');
assert.ok(coverage.includes('[1]'), 'coverage entries are numbered');

// -- Google News RSS parsing ------------------------------------------------

const gnewsItem = (n, outlet, outletUrl) => `<item><title>Story ${n} headline - ${outlet}</title><link>https://news.google.com/rss/articles/CBMi${n}?oc=5</link><guid isPermaLink="false">g${n}</guid><pubDate>Thu, 25 Jun 2026 07:00:00 GMT</pubDate><description><a href="https://news.google.com/rss/articles/CBMi${n}?oc=5">Story ${n}</a></description><source url="${outletUrl}">${outlet}</source></item>`;
const gnewsXml = `<rss version="2.0"><channel><title>q - Google News</title>${gnewsItem(1, 'Reuters', 'https://www.reuters.com')}${gnewsItem(2, 'Al Jazeera', 'https://www.aljazeera.com')}${gnewsItem(3, 'BBC', 'https://www.bbc.com')}</channel></rss>`;

const news = parseGoogleNewsResults(gnewsXml);
assert.equal(news.length, 3, 'three Google News items parsed');
assert.equal(news[0].title, 'Story 1 headline', 'outlet suffix split off the headline');
assert.equal(news[0].source, 'Reuters', 'outlet name captured');
assert.equal(news[0].outletUrl, 'https://www.reuters.com', 'outlet homepage URL captured');
assert.equal(news[0].url, 'https://news.google.com/rss/articles/CBMi1?oc=5', 'article redirect URL captured');
assert.equal(news[0].date, '25 Jun 2026', 'pubDate normalized to "25 Jun 2026"');

const entityXml = `<rss version="2.0"><channel><item><title>Farmers & rail strike talks - Le Monde</title><link>https://news.google.com/x</link><source url="https://www.lemonde.fr">Le Monde</source></item></channel></rss>`;
const [entityNews] = parseGoogleNewsResults(entityXml);
assert.ok(entityNews.title.includes('&'), 'entity decoded in Google News title');
assert.ok(!entityNews.title.includes('amp;'), 'entity not left half-decoded');

assert.deepStrictEqual(parseGoogleNewsResults('<rss version="2.0"><channel></channel></rss>'), [], 'empty feed yields no results');
assert.deepStrictEqual(parseGoogleNewsResults('not xml at all'), [], 'garbage input yields no results');

// -- buildSearchQuery -------------------------------------------------------

// The outlet is deliberately NOT part of the query: searching for it would
// bias results toward the page the user is already reading.
assert.equal(buildSearchQuery({ title: 'Rail strike enters third week', source: 'The Guardian' }), 'Rail strike enters third week', 'query is the story title, not the outlet');
assert.equal(
  buildSearchQuery({ title: '', source: 'X' }, 'Kenya parliament passes budget bill after long night of debate over amendments'),
  'Kenya parliament passes budget bill after long night of debate over amendments',
  'no headline: falls back to the opening words of the article text'
);
assert.equal(buildSearchQuery({}, ''), '', 'no title and no text yields empty query');

// -- Google News edition params (article locale → regional coverage) -------

assert.equal(googleNewsParams('en-NG'), 'hl=en&gl=NG&ceid=NG:en', 'Nigerian English maps to the Nigeria edition');
assert.equal(googleNewsParams('pt-BR'), 'hl=pt&gl=BR&ceid=BR:pt', 'Brazilian Portuguese maps to the Brazil edition');
assert.equal(googleNewsParams('fr'), 'hl=fr&gl=US&ceid=US:fr', 'language-only tag keeps the language, defaults the country');
assert.equal(googleNewsParams('en_US'), 'hl=en&gl=US&ceid=US:en', 'underscore variant accepted');
assert.equal(googleNewsParams(''), 'hl=en-US&gl=US&ceid=US:en', 'no tag → default US edition');
assert.equal(googleNewsParams('not-a-lang'), 'hl=en-US&gl=US&ceid=US:en', 'malformed tag → default US edition');

// -- searchWeb source ordering (fetch mocked) -------------------------------

const realFetch = globalThis.fetch;
let seenGoogleNewsUrl = '';

// Google News down (500) → falls back to DuckDuckGo (202 anomaly = no results).
let ddgCalls = 0;
globalThis.fetch = async (url) => {
  if (url.includes('news.google.com')) return { ok: false, status: 500 };
  ddgCalls++;
  return { ok: true, status: 202, text: async () => '<html>anomaly challenge page</html>' };
};
assert.deepStrictEqual(await searchWeb('rail strike'), [], 'both sources down → empty results, no throw');
assert.equal(ddgCalls, 1, 'DuckDuckGo fallback was reached');

// Google News healthy → its results are returned and DuckDuckGo is never hit.
ddgCalls = 0;
globalThis.fetch = async (url) => {
  if (url.includes('news.google.com')) {
    seenGoogleNewsUrl = url;
    return { ok: true, status: 200, text: async () => gnewsXml };
  }
  ddgCalls++;
  return { ok: true, status: 200, text: async () => fixture };
};
const fromNews = await searchWeb('rail strike', undefined, 'en-NG');
assert.equal(fromNews.length, 3, 'Google News results returned');
assert.equal(ddgCalls, 0, 'no DuckDuckGo call when Google News answered');
assert.ok(seenGoogleNewsUrl.includes('ceid=NG:en'), 'article locale forwarded as the edition param');

// Google News empty (200, no items) → DuckDuckGo used as fallback.
ddgCalls = 0;
globalThis.fetch = async (url) => {
  if (url.includes('news.google.com')) return { ok: true, status: 200, text: async () => '<rss version="2.0"><channel></channel></rss>' };
  ddgCalls++;
  return { ok: true, status: 200, text: async () => fixture };
};
const fromDdg = await searchWeb('rail strike');
assert.equal(fromDdg.length, 2, 'DuckDuckGo results parsed on fallback');
assert.equal(ddgCalls, 1, 'fallback fired exactly once');

globalThis.fetch = realFetch;

// -- coverage context shape ------------------------------------------------

const newsCoverage = buildCoverageContext(news);
assert.ok(newsCoverage.includes('[1] Reuters — Story 1 headline (25 Jun 2026)'), 'entry carries outlet + headline + date');
assert.ok(newsCoverage.includes('outlet: https://www.reuters.com'), 'entry lists the outlet homepage URL');
assert.ok(newsCoverage.includes('https://news.google.com/rss/articles/CBMi1?oc=5'), 'entry lists the article URL');

console.log('search.test.js: all checks passed');
