/**
 * ============================================================================
 * UAP MAPA - VLASTNÍ PROXY / BACKEND (Cloudflare Worker)
 * ============================================================================
 * Nahrazuje tři veřejné bezplatné služby, na kterých aplikace dřív závisela
 * (corsproxy.io, api.rss2json.com, api.counterapi.dev) jedním vlastním,
 * spolehlivým endpointem, který běžíš ty sám.
 *
 * Poskytuje tři cesty:
 *   GET /geocode?q=<dotaz>&lang=cs|en&detail=0|1
 *       -> proxy na Nominatim (OpenStreetMap) geokódování, s cachováním
 *          na edge síti a korektní identifikací dle pravidel Nominatim.
 *   GET /news
 *       -> stáhne a rozparsuje Google News RSS feed přímo (bez rss2json.com),
 *          výsledek má STEJNÝ tvar, jaký appka očekávala od rss2json.com:
 *          { status: "ok", items: [{ title, link, pubDate }, ...] }
 *   GET /counter
 *       -> počítadlo návštěv přes Cloudflare Workers KV (trvalé úložiště),
 *          vrací { count: <číslo> }.
 *
 * ----------------------------------------------------------------------------
 * NASAZENÍ (shrnutí - podrobný návod máš v samostatném souboru NAVOD.md):
 *   1. Zdarma účet na https://dash.cloudflare.com
 *   2. Workers & Pages -> Create -> Create Worker
 *   3. Vlož obsah TOHOTO souboru místo výchozího kódu, ulož a nasaď (Deploy)
 *   4. Settings -> Variables -> KV Namespace Bindings -> přidej binding
 *      s názvem proměnné "COUNTER_KV" (namespace si vytvoříš tamtéž)
 *   5. Zkopíruj přidělenou URL (např. https://uap-map-proxy.TVŮJ-ÚČET.workers.dev)
 *      a pošli mi ji - já podle ní upravím index.html.
 *
 * DŮLEŽITÉ - než nasadíš, uprav tyto dvě věci níže:
 *   - ALLOWED_ORIGINS: doména, ze které appka běží (GitHub Pages apod.)
 *   - NOMINATIM_CONTACT: tvůj kontakt (e-mail nebo URL projektu) - vyžaduje
 *     to zásadní pravidla používání Nominatim/OSM (viz komentář níže).
 * ============================================================================
 */

// Odkud smí appka Worker volat (CORS). Přidej i vlastní doménu, pokud ji máš.
// "null" je potřeba pro testování z lokálního souboru (file://) v prohlížeči.
const ALLOWED_ORIGINS = [
    'https://svoboda-koduje.github.io',
    'null',
];

// Nominatim (OpenStreetMap) vyžaduje identifikaci aplikace kontaktem, viz
// https://operations.osmfoundation.org/policies/nominatim/ - uveď svůj
// e-mail nebo URL projektu, ať je možné tě kontaktovat při zneužití.
const NOMINATIM_CONTACT = 'https://github.com/svoboda-koduje/UAP_map';

// Jak dlouho se cachují odpovědi na edge síti Cloudflare (v sekundách).
const GEOCODE_CACHE_TTL = 60 * 60 * 24; // 24 hodin - lokace se nemění
const NEWS_CACHE_TTL = 60 * 10;         // 10 minut - zprávy se aktualizují průběžně

function corsHeaders(origin) {
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
}

function jsonResponse(data, origin, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(origin),
            ...extraHeaders,
        },
    });
}

// ----------------------------------------------------------------------------
// /geocode - proxy na Nominatim, s cachováním výsledků na edge síti
// ----------------------------------------------------------------------------
async function handleGeocode(request, origin) {
    const url = new URL(request.url);
    const q = url.searchParams.get('q');
    const lang = (url.searchParams.get('lang') || 'en').slice(0, 5);
    const detail = url.searchParams.get('detail') === '1';

    if (!q || !q.trim()) {
        return jsonResponse({ error: 'Chybí parametr q (hledaný dotaz).' }, origin, 400);
    }

    // Cache klíč zahrnuje dotaz i úroveň detailu, aby se nemíchaly výsledky
    const cacheKey = new Request(
        `https://cache.internal/geocode?q=${encodeURIComponent(q)}&lang=${lang}&detail=${detail ? 1 : 0}`
    );
    const cache = caches.default;
    let cached = await cache.match(cacheKey);
    if (cached) {
        const body = await cached.json();
        return jsonResponse(body, origin, 200, { 'X-Cache': 'HIT' });
    }

    let nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&addressdetails=1&accept-language=${encodeURIComponent(lang)}&email=${encodeURIComponent(NOMINATIM_CONTACT)}`;
    if (detail) {
        nominatimUrl += '&polygon_geojson=1&polygon_threshold=0.005';
    }

    let data;
    try {
        const resp = await fetch(nominatimUrl, {
            headers: {
                // Nominatim vyžaduje identifikující User-Agent (browser fetch to
                // nastavit nedovolí, proto to dřív šlo jen přes cizí CORS proxy -
                // server-side Worker to ale nastavit smí).
                'User-Agent': `UAP-Map-Proxy/1.0 (${NOMINATIM_CONTACT})`,
            },
        });
        if (!resp.ok) {
            return jsonResponse({ error: `Nominatim vrátil chybu ${resp.status}` }, origin, 502);
        }
        data = await resp.json();
    } catch (err) {
        return jsonResponse({ error: 'Geokódovací služba je momentálně nedostupná.' }, origin, 502);
    }

    const responseToCache = jsonResponse(data, origin, 200, {
        'Cache-Control': `public, max-age=${GEOCODE_CACHE_TTL}`,
    });
    // Uložíme kopii do edge cache (nezávisle na tom, co dostane klient)
    try {
        await cache.put(cacheKey, new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${GEOCODE_CACHE_TTL}` },
        }));
    } catch (e) { /* cachování je jen optimalizace, chyba zde appku nesmí shodit */ }

    return jsonResponse(data, origin, 200, { 'X-Cache': 'MISS' });
}

// ----------------------------------------------------------------------------
// /news - stáhne Google News RSS a rozparsuje ho do stejného tvaru,
// jaký appka dřív dostávala z rss2json.com
// ----------------------------------------------------------------------------
function decodeXmlEntities(str) {
    return String(str)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
}

function extractTag(itemXml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = itemXml.match(re);
    return m ? decodeXmlEntities(m[1]) : '';
}

function parseGoogleNewsRss(xmlText) {
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xmlText)) !== null) {
        const itemXml = m[1];
        const title = extractTag(itemXml, 'title');
        const link = extractTag(itemXml, 'link');
        const pubDate = extractTag(itemXml, 'pubDate');
        if (title) {
            items.push({ title, link, pubDate });
        }
    }
    return items;
}

// Běžná prohlížečová hlavička - na rozdíl od Nominatim výše (kde se appka
// naopak MUSÍ identifikovat) tady chceme vypadat jako běžný prohlížeč,
// protože zpravodajské RSS zdroje občas blokují požadavky, které vypadají
// jako automatizovaný nástroj z cloudové/datacenter sítě.
const NEWS_FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
};

const GOOGLE_NEWS_URL = 'https://news.google.com/rss/search?q=UFO+sighting&hl=en-US&gl=US&ceid=US:en';
const BING_NEWS_URL = 'https://www.bing.com/news/search?q=UFO+sighting&format=RSS&mkt=en-US';

// Zkusí stáhnout RSS XML z dané adresy. Vrací { ok: true, xmlText } při
// úspěchu, nebo { ok: false, reason } při chybě (nikdy nevyhazuje výjimku).
async function tryFetchRss(url) {
    try {
        const resp = await fetch(url, { headers: NEWS_FETCH_HEADERS });
        if (!resp.ok) {
            return { ok: false, reason: `HTTP ${resp.status}` };
        }
        return { ok: true, xmlText: await resp.text() };
    } catch (err) {
        return { ok: false, reason: 'síťová chyba' };
    }
}

async function handleNews(request, origin) {
    const cacheKey = new Request('https://cache.internal/news');
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
        const body = await cached.json();
        return jsonResponse(body, origin, 200, { 'X-Cache': 'HIT' });
    }

    // Primární zdroj: Google News RSS. Umí vracet 503, když požadavek
    // nevypadá jako běžný prohlížeč/RSS čtečka, nebo když blokuje celý
    // rozsah IP adres cloudových poskytovatelů (včetně Cloudflare Workers) -
    // bez ohledu na hlavičky. Proto appka má i záložní zdroj níže, aby
    // zůstala odolná, i kdyby Google News nebyl dostupný.
    let source = await tryFetchRss(GOOGLE_NEWS_URL);
    let usedFallback = false;

    // Záložní zdroj: Bing News RSS. Použije se, jen když Google News selže.
    if (!source.ok) {
        const bingResult = await tryFetchRss(BING_NEWS_URL);
        if (bingResult.ok) {
            source = bingResult;
            usedFallback = true;
        } else {
            return jsonResponse({
                status: 'error',
                items: [],
                error: `Zpravodajský zdroj je momentálně nedostupný (Google News: ${source.reason}, Bing News: ${bingResult.reason}).`,
            }, origin, 502);
        }
    }

    // Google News i Bing News RSS mají shodnou strukturu <item><title>/<link>/<pubDate>,
    // takže stejný parser funguje pro oba zdroje.
    const items = parseGoogleNewsRss(source.xmlText);

    const result = { status: 'ok', items, source: usedFallback ? 'bing' : 'google' };
    try {
        await cache.put(cacheKey, new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${NEWS_CACHE_TTL}` },
        }));
    } catch (e) { /* cachování je jen optimalizace */ }

    return jsonResponse(result, origin, 200, { 'X-Cache': 'MISS' });
}

// ----------------------------------------------------------------------------
// /counter - počítadlo návštěv přes Workers KV
// ----------------------------------------------------------------------------
async function handleCounter(request, env, origin) {
    if (!env.COUNTER_KV) {
        return jsonResponse({ error: 'KV úložiště není nastavené (chybí binding COUNTER_KV).' }, origin, 500);
    }
    try {
        const current = parseInt((await env.COUNTER_KV.get('visits')) || '0', 10);
        const next = current + 1;
        await env.COUNTER_KV.put('visits', String(next));
        return jsonResponse({ count: next }, origin);
    } catch (err) {
        return jsonResponse({ error: 'Počítadlo je momentálně nedostupné.' }, origin, 502);
    }
}

// ----------------------------------------------------------------------------
// Hlavní vstupní bod Workeru
// ----------------------------------------------------------------------------
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || 'null';

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders(origin) });
        }

        if (url.pathname === '/geocode') {
            return handleGeocode(request, origin);
        }
        if (url.pathname === '/news') {
            return handleNews(request, origin);
        }
        if (url.pathname === '/counter') {
            return handleCounter(request, env, origin);
        }
        if (url.pathname === '/' || url.pathname === '/health') {
            return jsonResponse({ ok: true, service: 'uap-map-proxy', endpoints: ['/geocode', '/news', '/counter'] }, origin);
        }

        return jsonResponse({ error: 'Neznámá cesta.' }, origin, 404);
    },
};
