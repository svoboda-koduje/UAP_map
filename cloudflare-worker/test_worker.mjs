// Lokální test logiky Cloudflare Workeru (bez nutnosti reálného nasazení).
// Mockuje fetch/caches/KV a ověřuje chování jednotlivých endpointů.

const results = { checks: {}, errors: [] };

function assert(cond, label) {
    results.checks[label] = !!cond;
    if (!cond) results.errors.push(label);
}

// --- Mock edge cache (Cloudflare `caches.default`) ---
class FakeCache {
    constructor() { this.store = new Map(); }
    async match(req) {
        const key = typeof req === 'string' ? req : req.url;
        return this.store.get(key) ? this.store.get(key).clone() : undefined;
    }
    async put(req, res) {
        const key = typeof req === 'string' ? req : req.url;
        this.store.set(key, res.clone());
    }
}
globalThis.caches = { default: new FakeCache() };

// --- Sample Google News RSS (realistická struktura) ---
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>"UFO sighting" - Google News</title>
<item>
<title><![CDATA[Mysterious lights over Nevada spark UFO sighting reports - Local News]]></title>
<link>https://news.google.com/rss/articles/CBMi123?oc=5</link>
<guid isPermaLink="false">abc123</guid>
<pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate>
<description>Some description with &amp; entities &lt;b&gt;bold&lt;/b&gt;</description>
<source url="https://example.com">Local News</source>
</item>
<item>
<title>Second story &amp; more &#39;quoted&#39; text - Another Source</title>
<link>https://news.google.com/rss/articles/CBMi456?oc=5</link>
<pubDate>Sun, 06 Sep 2026 08:30:00 GMT</pubDate>
</item>
</channel>
</rss>`;

const SAMPLE_RSS_BING = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>UFO sighting - Bing News</title>
<item>
<title>Bing fallback story</title>
<link>https://www.bing.com/news/articles/xyz789</link>
<pubDate>Mon, 07 Sep 2026 12:00:00 GMT</pubDate>
</item>
</channel>
</rss>`;

let fetchCallLog = [];
let fetchBehavior = 'ok'; // 'ok' | 'network_error' | 'http_error' (legacy, applies globally)
let newsGoogleOverride = null; // null | 'network_error' | 'http_error' (news-specific overrides)
let newsBingOverride = null;   // null | 'network_error' | 'http_error'

globalThis.fetch = async (url, opts) => {
    fetchCallLog.push({ url: String(url), headers: opts && opts.headers });

    if (String(url).includes('news.google.com') && newsGoogleOverride) {
        if (newsGoogleOverride === 'network_error') throw new TypeError('Failed to fetch');
        if (newsGoogleOverride === 'http_error') return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    }
    if (String(url).includes('bing.com') && newsBingOverride) {
        if (newsBingOverride === 'network_error') throw new TypeError('Failed to fetch');
        if (newsBingOverride === 'http_error') return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    }

    if (fetchBehavior === 'network_error') {
        throw new TypeError('Failed to fetch');
    }
    if (fetchBehavior === 'http_error') {
        return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    }
    if (String(url).includes('nominatim.openstreetmap.org')) {
        return {
            ok: true,
            status: 200,
            json: async () => ([{
                display_name: 'Nevada, USA',
                lat: '39.5', lon: '-116.0',
                boundingbox: ['35', '42', '-120', '-114'],
                address: { country_code: 'us' },
            }]),
        };
    }
    if (String(url).includes('news.google.com')) {
        return { ok: true, status: 200, text: async () => SAMPLE_RSS };
    }
    if (String(url).includes('bing.com')) {
        return { ok: true, status: 200, text: async () => SAMPLE_RSS_BING };
    }
    throw new Error('unexpected fetch url: ' + url);
};

// --- Mock KV namespace ---
class FakeKV {
    constructor() { this.data = new Map(); }
    async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
    async put(key, value) { this.data.set(key, value); }
}

const worker = (await import('./worker.js')).default;

function makeRequest(path, origin = 'https://svoboda-koduje.github.io', method = 'GET') {
    return new Request(`https://worker.example.com${path}`, {
        method,
        headers: origin ? { Origin: origin } : {},
    });
}

// ===================== TESTY =====================

// 1) /geocode - úspěšný požadavek, správný tvar dat, CORS hlavička
{
    fetchCallLog = []; fetchBehavior = 'ok';
    const res = await worker.fetch(makeRequest('/geocode?q=Nevada&lang=en&detail=1'), {});
    const body = await res.json();
    assert(res.status === 200, '1a_geocode_status_200');
    assert(Array.isArray(body) && body[0] && body[0].display_name === 'Nevada, USA', '1b_geocode_shape_matches_nominatim');
    assert(res.headers.get('Access-Control-Allow-Origin') === 'https://svoboda-koduje.github.io', '1c_geocode_cors_origin_reflected');
    assert(fetchCallLog[0].url.includes('polygon_geojson=1'), '1d_geocode_detail_flag_adds_polygon');
    assert(fetchCallLog[0].headers['User-Agent'].includes('UAP-Map-Proxy'), '1e_geocode_sets_useragent');
}

// 2) /geocode - bez detailu (used by live-news geocoder) nemá polygon param
{
    fetchCallLog = []; fetchBehavior = 'ok';
    await worker.fetch(makeRequest('/geocode?q=Nevada&lang=en'), {});
    assert(!fetchCallLog[0].url.includes('polygon_geojson'), '2a_geocode_no_detail_omits_polygon');
}

// 3) /geocode - cache hit při druhém volání stejného dotazu (žádný nový fetch)
{
    fetchCallLog = []; fetchBehavior = 'ok';
    const res1 = await worker.fetch(makeRequest('/geocode?q=CachedQuery&lang=en'), {});
    await res1.json();
    const callsAfterFirst = fetchCallLog.length;
    const res2 = await worker.fetch(makeRequest('/geocode?q=CachedQuery&lang=en'), {});
    const body2 = await res2.json();
    assert(callsAfterFirst === 1, '3a_geocode_first_call_hits_network');
    assert(fetchCallLog.length === 1, '3b_geocode_second_call_served_from_cache_no_new_fetch');
    assert(res2.headers.get('X-Cache') === 'HIT', '3c_geocode_cache_header_hit');
    assert(body2[0].display_name === 'Nevada, USA', '3d_geocode_cached_body_correct');
}

// 4) /geocode - chybějící parametr q -> 400
{
    const res = await worker.fetch(makeRequest('/geocode'), {});
    assert(res.status === 400, '4a_geocode_missing_q_returns_400');
}

// 5) /geocode - Nominatim nedostupný (síťová chyba) -> 502, žádný pád
{
    fetchBehavior = 'network_error';
    const res = await worker.fetch(makeRequest('/geocode?q=Fail&lang=en'), {});
    const body = await res.json();
    assert(res.status === 502, '5a_geocode_network_error_returns_502');
    assert(typeof body.error === 'string' && body.error.length > 0, '5b_geocode_network_error_has_message');
    fetchBehavior = 'ok';
}

// 6) /geocode - Nominatim vrátí HTTP chybu (503) -> 502 s hláškou
{
    fetchBehavior = 'http_error';
    const res = await worker.fetch(makeRequest('/geocode?q=Fail2&lang=en'), {});
    assert(res.status === 502, '6a_geocode_http_error_returns_502');
    fetchBehavior = 'ok';
}

// 7) /news - správné rozparsování RSS do očekávaného tvaru
{
    fetchCallLog = []; fetchBehavior = 'ok';
    const res = await worker.fetch(makeRequest('/news'), {});
    const body = await res.json();
    assert(res.status === 200, '7a_news_status_200');
    assert(body.status === 'ok', '7b_news_status_field_ok');
    assert(Array.isArray(body.items) && body.items.length === 2, '7c_news_two_items_parsed');
    assert(body.items[0].title === 'Mysterious lights over Nevada spark UFO sighting reports - Local News', '7d_news_cdata_title_decoded');
    assert(body.items[0].link === 'https://news.google.com/rss/articles/CBMi123?oc=5', '7e_news_link_extracted');
    assert(body.items[0].pubDate === 'Mon, 07 Sep 2026 10:00:00 GMT', '7f_news_pubdate_extracted');
    assert(body.items[1].title === "Second story & more 'quoted' text - Another Source", '7g_news_entities_decoded');
}

// 8) /news - cache hit při druhém volání
{
    fetchCallLog = [];
    const callsBefore = fetchCallLog.length;
    const res = await worker.fetch(makeRequest('/news'), {});
    await res.json();
    assert(res.headers.get('X-Cache') === 'HIT', '8a_news_second_call_cache_hit');
    assert(fetchCallLog.length === 0, '8b_news_no_network_call_on_cache_hit');
}

// 9) /news - Google News nedostupné -> graceful degradace, ne pád
{
    fetchBehavior = 'network_error';
    // Vyprázdníme cache pro /news, aby test skutečně zkusil síť
    globalThis.caches.default.store.delete('https://cache.internal/news');
    const res = await worker.fetch(makeRequest('/news'), {});
    const body = await res.json();
    assert(res.status === 502, '9a_news_network_error_returns_502');
    assert(body.status === 'error' && Array.isArray(body.items) && body.items.length === 0, '9b_news_error_shape_still_consistent');
    fetchBehavior = 'ok';
}

// 16) /news - Google News selže (503), Bing News jako záloha uspěje
{
    globalThis.caches.default.store.delete('https://cache.internal/news');
    fetchCallLog = [];
    newsGoogleOverride = 'http_error';
    const res = await worker.fetch(makeRequest('/news'), {});
    const body = await res.json();
    assert(res.status === 200, '16a_news_fallback_to_bing_status_200');
    assert(body.status === 'ok', '16b_news_fallback_to_bing_status_field_ok');
    assert(Array.isArray(body.items) && body.items.length === 1, '16c_news_fallback_to_bing_items_parsed');
    assert(body.items[0].title === 'Bing fallback story', '16d_news_fallback_to_bing_correct_content');
    assert(body.source === 'bing', '16e_news_fallback_marks_source_as_bing');
    newsGoogleOverride = null;
}

// 17) /news - Google News i Bing News selžou -> smysluplná chyba, appka nespadne
{
    globalThis.caches.default.store.delete('https://cache.internal/news');
    newsGoogleOverride = 'http_error';
    newsBingOverride = 'http_error';
    const res = await worker.fetch(makeRequest('/news'), {});
    const body = await res.json();
    assert(res.status === 502, '17a_news_both_sources_fail_returns_502');
    assert(body.status === 'error' && Array.isArray(body.items) && body.items.length === 0, '17b_news_both_sources_fail_shape_consistent');
    assert(typeof body.error === 'string' && body.error.includes('Google') && body.error.includes('Bing'), '17c_news_both_sources_fail_error_mentions_both');
    newsGoogleOverride = null;
    newsBingOverride = null;
}

// 10) /counter - inkrementuje a persistuje přes KV
{
    const kv = new FakeKV();
    const res1 = await worker.fetch(makeRequest('/counter'), { COUNTER_KV: kv });
    const body1 = await res1.json();
    const res2 = await worker.fetch(makeRequest('/counter'), { COUNTER_KV: kv });
    const body2 = await res2.json();
    assert(body1.count === 1, '10a_counter_first_visit_is_1');
    assert(body2.count === 2, '10b_counter_second_visit_is_2');
}

// 11) /counter - chybí KV binding -> smysluplná chyba, ne pád
{
    const res = await worker.fetch(makeRequest('/counter'), {});
    assert(res.status === 500, '11a_counter_missing_kv_returns_500');
}

// 12) CORS - neschválený origin dostane fallback (první z whitelistu), ne "*"
{
    const res = await worker.fetch(makeRequest('/geocode?q=Nevada', 'https://evil.example.com'), {});
    const allow = res.headers.get('Access-Control-Allow-Origin');
    assert(allow !== '*' && allow !== 'https://evil.example.com', '12a_cors_rejects_unlisted_origin');
}

// 13) OPTIONS (CORS preflight) - vrátí 2xx s CORS hlavičkami, žádné tělo
{
    const res = await worker.fetch(makeRequest('/geocode', 'https://svoboda-koduje.github.io', 'OPTIONS'), {});
    assert(res.status < 300, '13a_options_preflight_ok');
    assert(res.headers.get('Access-Control-Allow-Origin') === 'https://svoboda-koduje.github.io', '13b_options_cors_header_present');
}

// 14) Neznámá cesta -> 404 JSON, ne pád
{
    const res = await worker.fetch(makeRequest('/nonexistent'), {});
    assert(res.status === 404, '14a_unknown_path_404');
}

// 15) / a /health -> jednoduchý health-check
{
    const res = await worker.fetch(makeRequest('/health'), {});
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, '15a_health_check_ok');
}

console.log(JSON.stringify(results, null, 2));
if (results.errors.length > 0) {
    console.error('FAILED CHECKS:', results.errors);
    process.exit(1);
} else {
    console.log('ALL CHECKS PASSED:', Object.keys(results.checks).length);
}
