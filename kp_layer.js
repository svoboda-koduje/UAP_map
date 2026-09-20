/* =============================================================================
 * kp_layer.js - ANALYTICKÁ VRSTVA "GEOMAGNETICKÁ AKTIVITA (Kp INDEX)"
 * pro Interaktivní mapu UAP/UFO (index.html)
 * -----------------------------------------------------------------------------
 * Co modul dělá:
 *   1) Načte kompaktní soubor kp_data.json (vytváří ho kp_update.py přes
 *      GitHub Actions z dat GFZ Potsdam; přímé stažení z kp.gfz.de v prohlížeči
 *      nejde - server neposílá CORS hlavičky).
 *   2) Každému pozorování přiřadí hodnotu Kp (tříhodinové okno UT i denní maximum).
 *   3) Mapa: obarvení bodů podle Kp, filtr podle Kp, řádek s Kp v bublině bodu,
 *      sloupce Kp v CSV exportu.
 *   4) Statistika nad právě vyfiltrovanými daty:
 *        - rozdělení pozorování podle Kp vs. očekávané rozdělení (baseline
 *          spárovaná po kalendářních měsících, u 3h metriky i po UT okně),
 *        - permutační test s kruhovým posunem uvnitř kalendářních měsíců,
 *        - superponovaná epochová analýza kolem nástupů geomagnetických bouří.
 *
 * Zdroj dat: Matzka, J., Stolle, C., Yamazaki, Y., Bronkalla, O., Morschhauser, A.
 * (2021): The geomagnetic Kp index and derived indices of geomagnetic activity.
 * Space Weather, https://doi.org/10.1029/2020SW002641 - data CC BY 4.0,
 * https://doi.org/10.5880/Kp.0001
 *
 * Výpočetní jádro (KP.core) nepoužívá DOM a jde testovat samostatně v Node.js.
 * ========================================================================== */
(function (root) {
    'use strict';

    // =========================================================================
    // 1. VÝPOČETNÍ JÁDRO (bez DOM)
    // =========================================================================
    const MS_DAY = 86400000;
    const MS_SLOT = 3 * 3600000;
    const START_UTC = Date.UTC(1932, 0, 1);
    const MISSING = 255;
    // Převodní tabulka Kp (ve třetinách, index 0..27) -> ap (Bartels)
    const AP_TABLE = [0, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 22, 27, 32, 39, 48, 56, 67, 80, 94,
        111, 132, 154, 179, 207, 236, 300, 400];

    // Kp ve třetinách -> třída 0..9 (např. 5-, 5o, 5+ => 5)
    function k3Class(k3) { return Math.round(k3 / 3); }

    // Kp ve třetinách -> zápis "5-", "5o", "5+"
    function k3Label(k3) {
        if (k3 === MISSING || k3 === null || k3 === undefined) return '?';
        const base = Math.round(k3 / 3);
        const rem = k3 - base * 3; // -1, 0, +1
        return base + (rem < 0 ? '−' : rem > 0 ? '+' : 'o');
    }

    // NOAA G-škála geomagnetických bouří (5-..5+ = G1, ... 9o = G5)
    function k3GScale(k3) {
        if (k3 === MISSING || k3 < 14) return '';
        if (k3 >= 27) return 'G5';
        if (k3 >= 23) return 'G4';
        if (k3 >= 20) return 'G3';
        if (k3 >= 17) return 'G2';
        return 'G1';
    }

    function decode(json) {
        if (!json || typeof json.kp !== 'string' || !json.alphabet) throw new Error('kp_data.json: neplatný formát');
        const s = json.kp;
        const days = Math.floor(s.length / 8);
        const lut = new Uint8Array(128).fill(MISSING);
        for (let i = 0; i < json.alphabet.length; i++) lut[json.alphabet.charCodeAt(i)] = i;
        const k3 = new Uint8Array(days * 8);
        for (let i = 0; i < days * 8; i++) {
            const c = s.charCodeAt(i);
            k3[i] = c < 128 ? lut[c] : MISSING;
        }
        const startUtc = json.start ? Date.parse(json.start + 'T00:00:00Z') : START_UTC;
        const dayMax = new Uint8Array(days).fill(MISSING);
        const dayAp = new Float32Array(days).fill(NaN);
        const dayMonth = new Uint16Array(days);
        for (let d = 0; d < days; d++) {
            let mx = -1, sum = 0, n = 0;
            for (let j = 0; j < 8; j++) {
                const v = k3[d * 8 + j];
                if (v !== MISSING) { if (v > mx) mx = v; sum += AP_TABLE[v]; n++; }
            }
            if (n > 0) dayMax[d] = mx;
            if (n === 8) dayAp[d] = sum / 8;
            const dt = new Date(startUtc + d * MS_DAY);
            dayMonth[d] = (dt.getUTCFullYear() - 1932) * 12 + dt.getUTCMonth();
        }
        return {
            k3: k3, days: days, startUtc: startUtc, dayMax: dayMax, dayAp: dayAp, dayMonth: dayMonth,
            nMonths: days > 0 ? dayMonth[days - 1] + 1 : 0,
            meta: {
                lastDay: json.last_day || null, lastDefinitive: json.last_definitive_day || null,
                generated: json.generated_utc || null, citation: json.citation || '', license: json.license || ''
            }
        };
    }

    const DT_RE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/;

    // Převod zápisu "M/D/RRRR HH:MM" (místní čas) na index dne a 3h okna v UT.
    // useLon = true: místní čas se převede na UT podle zeměpisné délky (15° = 1 h).
    function locate(kp, dtStr, lon, useLon) {
        const m = DT_RE.exec(dtStr || '');
        if (!m) return null;
        const mo = +m[1], da = +m[2], y = +m[3];
        if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
        const hasTime = m[4] !== undefined;
        let t = Date.UTC(y, mo - 1, da, hasTime ? +m[4] : 0, hasTime ? +m[5] : 0);
        if (hasTime && useLon && Number.isFinite(lon)) t -= (lon / 15) * 3600000;
        const rel = t - kp.startUtc;
        const day = Math.floor(rel / MS_DAY);
        if (day < 0 || day >= kp.days) return null;
        const slot = hasTime ? Math.floor((rel - day * MS_DAY) / MS_SLOT) : -1;
        return { day: day, slot: slot };
    }

    // Deterministický generátor náhodných čísel (stejný výsledek při každém spuštění)
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }

    /* Příprava analýzy.
     * located: pole {day, slot} (nebo null) pro každé pozorování
     * opts: { metric: 'slot' | 'daymax', threshold: 4..9 (třída Kp) }
     * Jednotka = den (daymax) nebo 3h okno (slot). Stratum = kalendářní měsíc
     * (u 'slot' navíc UT okno dne) - tím se odfiltruje dlouhodobý trend počtu
     * hlášení, sluneční cyklus, sezónnost i denní chod. */
    function prepare(kp, located, opts) {
        const metric = opts.metric === 'slot' ? 'slot' : 'daymax';
        const T = opts.threshold || 5;
        const perDay = metric === 'slot' ? 8 : 1;
        const values = metric === 'slot' ? kp.k3 : kp.dayMax;
        const nUnits = kp.days * perDay;
        const nStrata = kp.nMonths * perDay;
        const counts = new Uint32Array(nUnits);
        const dayCounts = new Uint32Array(kp.days);

        let nTotal = located.length, nOutOfRange = 0, nNoTime = 0, nMissingKp = 0, nUsed = 0;
        let firstDay = Infinity, lastDay = -1;
        for (let i = 0; i < located.length; i++) {
            const L = located[i];
            if (!L) { nOutOfRange++; continue; }
            dayCounts[L.day]++;
            if (L.day < firstDay) firstDay = L.day;
            if (L.day > lastDay) lastDay = L.day;
            let u;
            if (metric === 'slot') {
                if (L.slot < 0) { nNoTime++; continue; }
                u = L.day * 8 + L.slot;
            } else u = L.day;
            if (values[u] === MISSING) { nMissingKp++; continue; }
            counts[u]++; nUsed++;
        }

        // Souhrny po stratech
        const sN = new Float64Array(nStrata);        // pozorování ve stratu
        const sUnits = new Uint32Array(nStrata);     // platné jednotky ve stratu
        const sStorm = new Uint32Array(nStrata);     // jednotky nad prahem
        const sK3 = new Float64Array(nStrata);       // součet Kp (třetiny) přes jednotky
        const sClass = new Uint32Array(nStrata * 10);
        const obsClass = new Float64Array(10);
        let obsStorm = 0, obsK3 = 0;
        for (let u = 0; u < nUnits; u++) {
            const v = values[u];
            if (v === MISSING) continue;
            const day = metric === 'slot' ? (u >> 3) : u;
            const s = metric === 'slot' ? kp.dayMonth[day] * 8 + (u & 7) : kp.dayMonth[day];
            const c = k3Class(v);
            sUnits[s]++; sK3[s] += v; sClass[s * 10 + c]++;
            if (c >= T) sStorm[s]++;
            const n = counts[u];
            if (n) { sN[s] += n; obsClass[c] += n; obsK3 += n * v; if (c >= T) obsStorm += n; }
        }
        const expClass = new Float64Array(10);
        let expStorm = 0, expK3 = 0, nActive = 0;
        for (let s = 0; s < nStrata; s++) {
            const n = sN[s];
            if (!n) continue;
            nActive++;
            const w = n / sUnits[s];
            expStorm += w * sStorm[s];
            expK3 += w * sK3[s];
            for (let c = 0; c < 10; c++) expClass[c] += w * sClass[s * 10 + c];
        }

        return {
            metric: metric, threshold: T, perDay: perDay, values: values, counts: counts, dayCounts: dayCounts,
            sN: sN, sUnits: sUnits, sStorm: sStorm, nStrata: nStrata, nActiveStrata: nActive,
            nTotal: nTotal, nUsed: nUsed, nOutOfRange: nOutOfRange, nNoTime: nNoTime, nMissingKp: nMissingKp,
            firstDay: firstDay, lastDay: lastDay,
            obsClass: obsClass, expClass: expClass, obsStorm: obsStorm, expStorm: expStorm,
            obsMeanKp: nUsed ? obsK3 / nUsed / 3 : NaN, expMeanKp: nUsed ? expK3 / nUsed / 3 : NaN
        };
    }

    /* Stratifikovaný permutační test s KRUHOVÝM POSUNEM. Nulová hypotéza: uvnitř
     * kalendářního měsíce nezávisí počet pozorování na geomagnetické aktivitě.
     * V každém měsíci se řada Kp náhodně pootočí o celé dny vůči řadě pozorování
     * (den d dostane Kp dne d+posun, cyklicky v rámci měsíce). Tím zůstává
     * zachována vícedenní setrvačnost bouří i vícedenní vlny hlášení a u 3h
     * metriky také denní chod - prosté míchání jednotek by významnost
     * nadhodnocovalo. Vrací Promise; počítá po dávkách, aby nezamrzlo UI. */
    function permutationTest(kp, prep, nPerm, onProgress) {
        const metric = prep.metric, T = prep.threshold, values = prep.values, counts = prep.counts;
        const per = prep.perDay;
        // Začátek a délka každého měsíce (v indexech dnů)
        const mStart = new Int32Array(kp.nMonths).fill(-1), mLen = new Uint16Array(kp.nMonths);
        for (let d = 0; d < kp.days; d++) { const mi = kp.dayMonth[d]; if (mStart[mi] < 0) mStart[mi] = d; mLen[mi]++; }
        // Pro každý měsíc s pozorováními spočítat statistiku pro všechny možné posuny
        const tables = [];
        let fixed = 0;
        for (let mi = 0; mi < kp.nMonths; mi++) {
            const len = mLen[mi], d0 = mStart[mi];
            if (len < 2) continue;
            const nz = [];
            let nStormUnits = 0, nValid = 0;
            for (let i = 0; i < len; i++) {
                let any = false;
                for (let s = 0; s < per; s++) {
                    const u = (d0 + i) * per + s;
                    if (counts[u]) any = true;
                    if (values[u] !== MISSING) { nValid++; if (k3Class(values[u]) >= T) nStormUnits++; }
                }
                if (any) nz.push(i);
            }
            if (!nz.length) continue;
            if (nStormUnits === 0) continue;
            const tab = new Float64Array(len);
            let varies = false;
            for (let shift = 0; shift < len; shift++) {
                let S = 0;
                for (let q = 0; q < nz.length; q++) {
                    const i = nz[q], j = (i + shift) % len;
                    for (let s = 0; s < per; s++) {
                        const c = counts[(d0 + i) * per + s];
                        if (!c) continue;
                        const v = values[(d0 + j) * per + s];
                        if (v !== MISSING && k3Class(v) >= T) S += c;
                    }
                }
                tab[shift] = S;
                if (S !== tab[0]) varies = true;
            }
            if (!varies) { fixed += tab[0]; continue; }
            tables.push(tab);
        }
        const rnd = mulberry32(20260920);
        const results = new Float64Array(nPerm);
        let done = 0;

        function onePermutation() {
            let S = fixed;
            for (let i = 0; i < tables.length; i++) { const tab = tables[i]; S += tab[Math.floor(rnd() * tab.length)]; }
            return S;
        }

        return new Promise(function (resolve) {
            function chunk() {
                const t0 = Date.now();
                while (done < nPerm && Date.now() - t0 < 40) results[done++] = onePermutation();
                if (onProgress) onProgress(done / nPerm);
                if (done < nPerm) { setTimeout(chunk, 0); return; }
                const O = prep.obsStorm;
                let mean = 0;
                for (let i = 0; i < nPerm; i++) mean += results[i];
                mean /= nPerm;
                // Střed nulového rozdělení = přesná střední hodnota přes všechny posuny
                let E = fixed;
                for (let i = 0; i < tables.length; i++) { let a = 0; const tab = tables[i]; for (let j = 0; j < tab.length; j++) a += tab[j]; E += a / tab.length; }
                let extreme = 0;
                for (let i = 0; i < nPerm; i++) if (Math.abs(results[i] - E) >= Math.abs(O - E) - 1e-9) extreme++;
                const sorted = Array.from(results).sort(function (a, b) { return a - b; });
                const q = function (p) { return sorted[Math.min(nPerm - 1, Math.max(0, Math.round(p * (nPerm - 1))))]; };
                resolve({
                    nPerm: nPerm, observed: O, expected: E, nullMean: mean,
                    ratio: E > 0 ? O / E : NaN,
                    nullLo: E > 0 ? q(0.025) / E : NaN, nullHi: E > 0 ? q(0.975) / E : NaN,
                    p: (extreme + 1) / (nPerm + 1), nInformativeStrata: tables.length
                });
            }
            chunk();
        });
    }

    /* Superponovaná epochová analýza: průměrný relativní počet pozorování
     * (počet za den / průměr téhož měsíce) ve dnech -W..+W kolem nástupu bouře.
     * Nástup = den s denním max. Kp >= T, kterému předcházely 2 klidnější dny. */
    function superposedEpoch(kp, prep, W, minMonthCount) {
        W = W || 10; minMonthCount = minMonthCount || 10;
        const T = prep.threshold;
        const mCount = new Float64Array(kp.nMonths), mDays = new Uint32Array(kp.nMonths);
        for (let d = 0; d < kp.days; d++) { mDays[kp.dayMonth[d]]++; mCount[kp.dayMonth[d]] += prep.dayCounts[d]; }
        const rel = new Float32Array(kp.days).fill(NaN);
        for (let d = prep.firstDay; d <= prep.lastDay && d < kp.days; d++) {
            const mi = kp.dayMonth[d];
            if (mCount[mi] >= minMonthCount) rel[d] = prep.dayCounts[d] / (mCount[mi] / mDays[mi]);
        }
        const isStorm = function (d) { const v = kp.dayMax[d]; return v !== MISSING && k3Class(v) >= T; };
        const sum = new Float64Array(2 * W + 1), sum2 = new Float64Array(2 * W + 1), n = new Uint32Array(2 * W + 1);
        let nEvents = 0;
        for (let d = Math.max(2, prep.firstDay); d <= prep.lastDay && d < kp.days; d++) {
            if (!isStorm(d) || isStorm(d - 1) || isStorm(d - 2)) continue;
            let used = false;
            for (let L = -W; L <= W; L++) {
                const x = d + L;
                if (x < 0 || x >= kp.days) continue;
                const r = rel[x];
                if (r !== r) continue; // NaN
                sum[L + W] += r; sum2[L + W] += r * r; n[L + W]++; used = true;
            }
            if (used) nEvents++;
        }
        const lags = [], mean = [], lo = [], hi = [];
        for (let i = 0; i <= 2 * W; i++) {
            lags.push(i - W);
            if (n[i] < 2) { mean.push(null); lo.push(null); hi.push(null); continue; }
            const mu = sum[i] / n[i];
            const sd = Math.sqrt(Math.max(0, (sum2[i] - n[i] * mu * mu) / (n[i] - 1)));
            const se = sd / Math.sqrt(n[i]);
            mean.push(mu); lo.push(mu - 1.96 * se); hi.push(mu + 1.96 * se);
        }
        return { lags: lags, mean: mean, lo: lo, hi: hi, nEvents: nEvents };
    }

    const core = {
        MISSING: MISSING, AP_TABLE: AP_TABLE, decode: decode, locate: locate, prepare: prepare,
        permutationTest: permutationTest, superposedEpoch: superposedEpoch,
        k3Class: k3Class, k3Label: k3Label, k3GScale: k3GScale, mulberry32: mulberry32
    };

    // Node.js (testy): exportovat jen jádro a skončit
    if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
        module.exports = core;
        return;
    }

    // =========================================================================
    // 2. PŘEKLADY
    // =========================================================================
    const TXT = {
        cs: {
            menuKp: '🧲 Geomagnetická aktivita (Kp index)',
            kpTitle: '🧲 Geomagnetická aktivita (Kp)',
            kpIntro: 'Porovnání pozorování s planetárním Kp indexem (GFZ Potsdam, od r. 1932). Analýza vždy pracuje s daty, která jsou právě vyfiltrovaná na mapě.',
            kpStatusLoading: 'Načítám data Kp…',
            kpStatusReady: function (a, b) { return 'Data Kp: 1932-01-01 až ' + a + (b ? ' (definitivní do ' + b + ')' : ''); },
            kpStatusError: 'Data Kp nejsou k dispozici (chybí soubor kp_data.json). Spusťte na GitHubu workflow „Automatická aktualizace Kp indexu“.',
            kpMetricLabel: 'Použitá hodnota Kp:',
            kpMetricDay: 'Denní maximum Kp (všechna pozorování)',
            kpMetricSlot: 'Kp ve 3h okně pozorování (jen záznamy s časem)',
            kpUseLon: 'Převést místní čas na UT podle zeměpisné délky',
            kpMapSection: 'Zobrazení na mapě',
            kpColorMode: 'Obarvit body podle Kp',
            kpFilterLabel: 'Filtr pozorování podle Kp:',
            kpFilterAll: '-- Bez filtru --',
            kpFilterQuiet: 'Jen klid (Kp 0–1)',
            kpFilterGe: function (n) { return 'Jen Kp ≥ ' + n + (n >= 5 ? ' (bouře G' + (n - 4) + '+)' : ' (zvýšená aktivita)'); },
            kpAnalysisSection: 'Statistická analýza',
            kpThresholdLabel: 'Práh „geomagnetické bouře“:',
            kpThresholdOpt: function (n) { return 'Kp ≥ ' + n + (n >= 5 ? ' (G' + (n - 4) + ' a silnější)' : ' (aktivní pole)'); },
            kpViewportOnly: 'Jen body v aktuálním výřezu mapy',
            kpRunBtn: '▶ Spustit analýzu',
            kpRunning: function (p) { return 'Počítám permutační test… ' + p + ' %'; },
            kpNoData: 'Žádná pozorování s přiřaditelnou hodnotou Kp (data Kp začínají rokem 1932).',
            kpPopup: 'Geomag. aktivita:',
            kpPopupSlot: '3h okno', kpPopupDay: 'denní max', kpPopupNone: 'pro toto datum nejsou data Kp',
            kpLegendTitle: 'Kp', kpLegendNoData: 'bez dat',
            kpModalTitle: 'Pozorování UAP/UFO a geomagnetická aktivita (Kp index)',
            kpClose: 'Zavřít', kpDownloadCsv: '💾 Stáhnout výsledky (.csv)',
            kpHeadN: 'Analyzovaná pozorování', kpHeadMean: 'Průměrné Kp při pozorování',
            kpHeadStorm: function (n) { return 'Podíl pozorování při Kp ≥ ' + n; },
            kpHeadRatio: 'Poměr pozorováno / očekáváno',
            kpExpected: 'očekáváno', kpObserved: 'pozorováno',
            kpVerdictNone: 'Rozdíl proti očekávání je v mezích náhody (permutační test).',
            kpVerdictMore: 'Při zvýšené geomagnetické aktivitě je hlášení VÍCE, než odpovídá náhodě.',
            kpVerdictLess: 'Při zvýšené geomagnetické aktivitě je hlášení MÉNĚ, než odpovídá náhodě.',
            kpVerdictWeak: 'Pro tento výběr je bouřkových období příliš málo - test nemá vypovídací hodnotu.',
            kpVerdictTiny: ' – rozdíl je statisticky zjistitelný, ale věcně velmi malý',
            kpPLabel: 'p-hodnota (oboustranná)', kpNullRange: '95% rozmezí náhody pro poměr',
            kpChartDistTitle: 'Rozdělení pozorování podle Kp: skutečnost vs. očekávání',
            kpChartDistObs: 'Pozorováno (% hlášení)', kpChartDistExp: 'Očekáváno při nezávislosti (%)',
            kpChartDistRatio: 'Poměr pozorováno / očekáváno',
            kpChartSeaTitle: function (n, t) { return 'Dny kolem nástupu bouře (Kp ≥ ' + t + '), počet nástupů: ' + n; },
            kpChartSeaMean: 'Relativní počet hlášení (1 = běžný den téhož měsíce)',
            kpChartSeaBand: '95% interval', kpChartSeaX: 'Dny od nástupu bouře', kpChartKpX: 'Třída Kp',
            kpTableClass: 'Kp', kpTableObs: 'Pozorováno', kpTableExp: 'Očekáváno', kpTableRatio: 'Poměr',
            kpCoverage: function (r) {
                return 'Z ' + r.nTotal + ' vyfiltrovaných záznamů použito ' + r.nUsed + '; mimo rozsah dat Kp / bez platného data: ' +
                    r.nOutOfRange + (r.metric === 'slot' ? '; bez uvedeného času: ' + r.nNoTime : '') +
                    (r.nMissingKp ? '; chybějící Kp: ' + r.nMissingKp : '') + '.';
            },
            kpMethodTitle: 'Metodika a omezení (čtěte před interpretací)',
            kpMethod: '<ul>' +
                '<li><strong>Co je Kp:</strong> planetární tříhodinový index narušení geomagnetického pole (0–9) z 13 observatoří. Je to globální ukazatel, <em>ne</em> měření elektromagnetického pole v místě pozorování. Pro lokální studie je vhodné doplnit data blízké magnetické observatoře (síť INTERMAGNET, v ČR Budkov).</li>' +
                '<li><strong>Očekávání (baseline):</strong> pro každý kalendářní měsíc (u 3h metriky i pro každé UT okno dne) se bere skutečné rozdělení Kp v tomto měsíci a váží se počtem hlášení v něm. Tím se vyruší dlouhodobý růst počtu hlášení, 11letý sluneční cyklus, sezónnost i denní chod.</li>' +
                '<li><strong>Test:</strong> permutační test s kruhovým posunem – v každém kalendářním měsíci se řada Kp náhodně pootočí o celé dny vůči řadě hlášení (5000×). Jednotkou je den, ne jednotlivé hlášení, a zachovává se vícedenní setrvačnost bouří i vícedenní vlny hlášení; hromadná pozorování z jedné noci proto významnost uměle nezvyšují.</li>' +
                '<li><strong>Čas:</strong> databáze uvádí místní čas, Kp je v UT. Převod podle zeměpisné délky má chybu ±1–2 h (časová pásma, letní čas); záznamy bez času mají nejistotu ±1 den. Proto je výchozí metrikou denní maximum.</li>' +
                '<li><strong>Pozor na zjevné vysvětlení:</strong> při silných bouřích je ve středních šířkách vidět <em>polární záře</em> a lidé ji hlásí jako neznámý jev. Kladná souvislost proto sama o sobě nic neobvyklého nedokazuje – zkuste analýzu zopakovat bez tvaru „light“, podle kategorií A/B/C nebo jen pro denní pozorování.</li>' +
                '<li><strong>Mnohonásobné testování:</strong> když vyzkoušíte desítky filtrů, některý vyjde „významně“ čistě náhodou (při p &lt; 0,05 zhruba každý dvacátý). Hypotézu si stanovte předem.</li>' +
                '<li><strong>Korelace není kauzalita;</strong> kvalita datumů a poloh v hlášeních je proměnlivá.</li></ul>',
            kpCitation: 'Data Kp: Matzka et al. (2021), GFZ Potsdam, <a href="https://doi.org/10.5880/Kp.0001" target="_blank" rel="noopener">doi:10.5880/Kp.0001</a>, licence CC BY 4.0. <a href="https://kp.gfz.de/en/" target="_blank" rel="noopener">kp.gfz.de</a>'
        },
        en: {
            menuKp: '🧲 Geomagnetic activity (Kp index)',
            kpTitle: '🧲 Geomagnetic activity (Kp)',
            kpIntro: 'Compares sightings with the planetary Kp index (GFZ Potsdam, since 1932). The analysis always uses the data currently filtered on the map.',
            kpStatusLoading: 'Loading Kp data…',
            kpStatusReady: function (a, b) { return 'Kp data: 1932-01-01 to ' + a + (b ? ' (definitive until ' + b + ')' : ''); },
            kpStatusError: 'Kp data not available (kp_data.json is missing). Run the "Automatická aktualizace Kp indexu" workflow on GitHub.',
            kpMetricLabel: 'Kp value used:',
            kpMetricDay: 'Daily maximum Kp (all sightings)',
            kpMetricSlot: 'Kp in the 3-hour window of the sighting (records with time only)',
            kpUseLon: 'Convert local time to UT using longitude',
            kpMapSection: 'Map display',
            kpColorMode: 'Colour points by Kp',
            kpFilterLabel: 'Filter sightings by Kp:',
            kpFilterAll: '-- No filter --',
            kpFilterQuiet: 'Quiet only (Kp 0–1)',
            kpFilterGe: function (n) { return 'Only Kp ≥ ' + n + (n >= 5 ? ' (storm G' + (n - 4) + '+)' : ' (elevated activity)'); },
            kpAnalysisSection: 'Statistical analysis',
            kpThresholdLabel: '"Geomagnetic storm" threshold:',
            kpThresholdOpt: function (n) { return 'Kp ≥ ' + n + (n >= 5 ? ' (G' + (n - 4) + ' and stronger)' : ' (active field)'); },
            kpViewportOnly: 'Only points in the current map view',
            kpRunBtn: '▶ Run analysis',
            kpRunning: function (p) { return 'Running permutation test… ' + p + ' %'; },
            kpNoData: 'No sightings with an assignable Kp value (Kp data start in 1932).',
            kpPopup: 'Geomag. activity:',
            kpPopupSlot: '3h window', kpPopupDay: 'daily max', kpPopupNone: 'no Kp data for this date',
            kpLegendTitle: 'Kp', kpLegendNoData: 'no data',
            kpModalTitle: 'UAP/UFO sightings and geomagnetic activity (Kp index)',
            kpClose: 'Close', kpDownloadCsv: '💾 Download results (.csv)',
            kpHeadN: 'Sightings analysed', kpHeadMean: 'Mean Kp at sighting time',
            kpHeadStorm: function (n) { return 'Share of sightings at Kp ≥ ' + n; },
            kpHeadRatio: 'Observed / expected ratio',
            kpExpected: 'expected', kpObserved: 'observed',
            kpVerdictNone: 'The difference from expectation is within chance (permutation test).',
            kpVerdictMore: 'There are MORE reports during elevated geomagnetic activity than chance would give.',
            kpVerdictLess: 'There are FEWER reports during elevated geomagnetic activity than chance would give.',
            kpVerdictWeak: 'Too few storm periods in this selection - the test is not informative.',
            kpVerdictTiny: ' – statistically detectable but practically very small',
            kpPLabel: 'p-value (two-sided)', kpNullRange: '95% chance range of the ratio',
            kpChartDistTitle: 'Sightings by Kp: observed vs. expected',
            kpChartDistObs: 'Observed (% of reports)', kpChartDistExp: 'Expected under independence (%)',
            kpChartDistRatio: 'Observed / expected ratio',
            kpChartSeaTitle: function (n, t) { return 'Days around storm onset (Kp ≥ ' + t + '), onsets: ' + n; },
            kpChartSeaMean: 'Relative number of reports (1 = ordinary day of the same month)',
            kpChartSeaBand: '95% interval', kpChartSeaX: 'Days from storm onset', kpChartKpX: 'Kp class',
            kpTableClass: 'Kp', kpTableObs: 'Observed', kpTableExp: 'Expected', kpTableRatio: 'Ratio',
            kpCoverage: function (r) {
                return 'Of ' + r.nTotal + ' filtered records, ' + r.nUsed + ' were used; outside Kp data range / invalid date: ' +
                    r.nOutOfRange + (r.metric === 'slot' ? '; without time: ' + r.nNoTime : '') +
                    (r.nMissingKp ? '; missing Kp: ' + r.nMissingKp : '') + '.';
            },
            kpMethodTitle: 'Method and limitations (read before interpreting)',
            kpMethod: '<ul>' +
                '<li><strong>What Kp is:</strong> a planetary 3-hour index of geomagnetic disturbance (0–9) from 13 observatories. It is a global indicator, <em>not</em> a measurement of the electromagnetic field at the sighting location. For local studies add data from a nearby magnetic observatory (INTERMAGNET).</li>' +
                '<li><strong>Expectation (baseline):</strong> for every calendar month (and, for the 3h metric, every UT window of the day) the real Kp distribution of that month is weighted by the number of reports in it. This removes the long-term growth in reporting, the 11-year solar cycle, seasonality and the diurnal cycle.</li>' +
                '<li><strong>Test:</strong> circular-shift permutation test – within every calendar month the Kp series is rotated by a random number of whole days relative to the report series (5000×). The unit is a day, not a single report, and the multi-day persistence of storms and of report waves is preserved, so mass sightings from one night do not inflate significance.</li>' +
                '<li><strong>Time:</strong> the database gives local time, Kp is in UT. The longitude-based conversion is accurate to ±1–2 h (time zones, DST); records without time are uncertain by ±1 day. Hence the default metric is the daily maximum.</li>' +
                '<li><strong>Mind the obvious explanation:</strong> during strong storms <em>aurora</em> is visible at mid-latitudes and gets reported as an unknown phenomenon. A positive association alone therefore proves nothing unusual – repeat the analysis without the "light" shape, by category A/B/C, or for daytime sightings only.</li>' +
                '<li><strong>Multiple testing:</strong> try dozens of filters and some will come out "significant" by chance (about one in twenty at p &lt; 0.05). State the hypothesis in advance.</li>' +
                '<li><strong>Correlation is not causation;</strong> date and location quality of reports varies.</li></ul>',
            kpCitation: 'Kp data: Matzka et al. (2021), GFZ Potsdam, <a href="https://doi.org/10.5880/Kp.0001" target="_blank" rel="noopener">doi:10.5880/Kp.0001</a>, licence CC BY 4.0. <a href="https://kp.gfz.de/en/" target="_blank" rel="noopener">kp.gfz.de</a>'
        }
    };

    function lang() { return (typeof currentLanguage !== 'undefined' && currentLanguage === 'en') ? 'en' : 'cs'; }
    function t(key) { return TXT[lang()][key]; }
    function esc(v) { return (typeof escapeHtml === 'function') ? escapeHtml(v) : String(v).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
    function fmt(x, d) {
        if (x === null || x === undefined || x !== x) return '–';
        return Number(x).toLocaleString(lang() === 'cs' ? 'cs-CZ' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    }

    // Zaregistrovat statické texty do překladového systému stránky (data-translate-key)
    try {
        if (typeof translations !== 'undefined') {
            ['cs', 'en'].forEach(function (lg) {
                Object.keys(TXT[lg]).forEach(function (k) {
                    if (typeof TXT[lg][k] === 'string' && translations[lg]) translations[lg][k] = TXT[lg][k];
                });
            });
        }
    } catch (e) { /* překlady nejsou kritické */ }

    // =========================================================================
    // 3. STAV A NAČTENÍ DAT
    // =========================================================================
    const DATA_URL = 'kp_data.json';
    const CLASS_COLORS = ['#43a047', '#43a047', '#43a047', '#9ccc65', '#ffee58', '#ffb300', '#ff7043', '#e53935', '#c2185b', '#8e24aa'];
    const NODATA_COLOR = '#9e9e9e';

    const state = {
        kp: null, loading: null, error: null,
        metric: 'daymax', useLon: true, colorMode: false, filter: 'all', threshold: 5,
        lastResult: null, charts: []
    };

    function ensureLoaded() {
        if (state.kp) return Promise.resolve(state.kp);
        if (state.loading) return state.loading;
        setStatus(t('kpStatusLoading'));
        state.loading = fetch(DATA_URL, { cache: 'no-cache' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                state.kp = decode(json); state.error = null;
                setStatus(t('kpStatusReady')(state.kp.meta.lastDay || '?', state.kp.meta.lastDefinitive));
                return state.kp;
            })
            .catch(function (err) {
                state.error = err; state.loading = null;
                console.warn('Kp vrstva: data se nepodařilo načíst:', err);
                setStatus(t('kpStatusError'), true);
                throw err;
            });
        return state.loading;
    }

    function setStatus(text, isError) {
        const el = document.getElementById('kp-status');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? '#ff8a65' : '#aaa';
    }

    // Přiřazení pozorování k datům Kp (výsledek se ukládá přímo na záznam)
    function locateItem(item) {
        const mode = state.useLon ? 1 : 2;
        if (item._kpMode === mode) return item._kpLoc;
        const loc = state.kp ? locate(state.kp, item.dt, item.lon, state.useLon) : null;
        item._kpMode = mode; item._kpLoc = loc;
        return loc;
    }

    // Hodnota Kp (ve třetinách) pro záznam podle zvolené metriky; null = není
    function valueFor(item, metric) {
        if (!state.kp) return null;
        const loc = locateItem(item);
        if (!loc) return null;
        let v;
        if ((metric || state.metric) === 'slot') {
            if (loc.slot < 0) return null;
            v = state.kp.k3[loc.day * 8 + loc.slot];
        } else v = state.kp.dayMax[loc.day];
        return v === MISSING ? null : v;
    }

    // =========================================================================
    // 4. NAPOJENÍ NA MAPU (volá se z index.html)
    // =========================================================================
    function passesFilter(item) {
        if (state.filter === 'all' || !state.kp) return true;
        const v = valueFor(item);
        if (v === null) return false;
        const c = k3Class(v);
        if (state.filter === 'quiet') return c <= 1;
        return c >= parseInt(state.filter, 10);
    }

    function colorModeActive() { return !!(state.colorMode && state.kp); }

    function hexToGl(hex) {
        return { r: parseInt(hex.substr(1, 2), 16) / 255, g: parseInt(hex.substr(3, 2), 16) / 255, b: parseInt(hex.substr(5, 2), 16) / 255 };
    }
    const GL_COLORS = CLASS_COLORS.map(hexToGl), GL_NODATA = hexToGl(NODATA_COLOR);

    function glColor(item) {
        const v = valueFor(item);
        return v === null ? GL_NODATA : GL_COLORS[k3Class(v)];
    }

    const kpIconCache = {};
    function classicIcon(item, iconDetails) {
        const v = valueFor(item);
        const cls = v === null ? 'x' : String(k3Class(v));
        const key = iconDetails.category + '|' + cls;
        if (!kpIconCache[key]) {
            kpIconCache[key] = L.divIcon({
                html: iconDetails.svgMap, className: 'uap-icon-container kp-col-' + cls,
                iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12]
            });
        }
        return kpIconCache[key];
    }

    function badge(v) {
        const col = CLASS_COLORS[k3Class(v)];
        const g = k3GScale(v);
        return '<span class="kp-badge" style="background:' + col + '">' + k3Label(v) + (g ? ' · ' + g : '') + '</span>';
    }

    function popupHtml(item) {
        if (!state.kp) return '';
        const loc = locateItem(item);
        if (!loc) return '<div class="kp-popup-line"><strong>🧲 ' + esc(t('kpPopup')) + '</strong> <em>' + esc(t('kpPopupNone')) + '</em></div>';
        const parts = [];
        if (loc.slot >= 0) {
            const vs = state.kp.k3[loc.day * 8 + loc.slot];
            if (vs !== MISSING) parts.push(esc(t('kpPopupSlot')) + ' ' + badge(vs));
        }
        const vd = state.kp.dayMax[loc.day];
        if (vd !== MISSING) parts.push(esc(t('kpPopupDay')) + ' ' + badge(vd));
        const ap = state.kp.dayAp[loc.day];
        if (ap === ap) parts.push('Ap ' + Math.round(ap));
        if (!parts.length) return '';
        const d = new Date(state.kp.startUtc + loc.day * MS_DAY).toISOString().slice(0, 10);
        const win = loc.slot >= 0 ? ' ' + String(loc.slot * 3).padStart(2, '0') + '–' + String(loc.slot * 3 + 3).padStart(2, '0') + ' UT' : '';
        return '<div class="kp-popup-line"><strong>🧲 ' + esc(t('kpPopup')) + '</strong> ' + parts.join(' · ') +
            ' <span class="kp-popup-ut">(' + d + win + ')</span></div>';
    }

    function exportFields(item) {
        if (!state.kp) return {};
        const loc = locateItem(item);
        const out = { kp_ut_date: '', kp_3h: '', kp_day_max: '', ap_day: '' };
        if (!loc) return out;
        out.kp_ut_date = new Date(state.kp.startUtc + loc.day * MS_DAY).toISOString().slice(0, 10);
        if (loc.slot >= 0 && state.kp.k3[loc.day * 8 + loc.slot] !== MISSING) out.kp_3h = (state.kp.k3[loc.day * 8 + loc.slot] / 3).toFixed(3);
        if (state.kp.dayMax[loc.day] !== MISSING) out.kp_day_max = (state.kp.dayMax[loc.day] / 3).toFixed(3);
        if (state.kp.dayAp[loc.day] === state.kp.dayAp[loc.day]) out.ap_day = Math.round(state.kp.dayAp[loc.day]);
        return out;
    }

    function redrawMap() {
        if (typeof updateMapWithLoader === 'function' && typeof allData !== 'undefined' && allData.length) updateMapWithLoader();
        updateLegend();
    }

    function resetFilter() {
        state.filter = 'all'; state.colorMode = false;
        const f = document.getElementById('kp-filter'); if (f) f.value = 'all';
        const c = document.getElementById('kp-color-mode'); if (c) c.checked = false;
        updateLegend();
    }

    function updateLegend() {
        let el = document.getElementById('kp-legend');
        if (!colorModeActive()) { if (el) el.style.display = 'none'; return; }
        if (!el) { el = document.createElement('div'); el.id = 'kp-legend'; document.body.appendChild(el); }
        let html = '<strong>' + esc(t('kpLegendTitle')) + '</strong>';
        [[0, '0–2'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [7, '7'], [8, '8'], [9, '9']].forEach(function (p) {
            html += '<span class="kp-legend-item"><i style="background:' + CLASS_COLORS[p[0]] + '"></i>' + p[1] + '</span>';
        });
        html += '<span class="kp-legend-item"><i style="background:' + NODATA_COLOR + '"></i>' + esc(t('kpLegendNoData')) + '</span>';
        el.innerHTML = html; el.style.display = 'flex';
    }

    // =========================================================================
    // 5. ANALÝZA A VÝSTUP
    // =========================================================================
    function currentItems() {
        let items = (window.currentlyFilteredData && window.currentlyFilteredData.length) ? window.currentlyFilteredData
            : (typeof allData !== 'undefined' ? allData : []);
        const vp = document.getElementById('kp-viewport-only');
        if (vp && vp.checked && typeof map !== 'undefined' && map) {
            const b = map.getBounds();
            items = items.filter(function (it) { return b.contains([it.lat, it.lon]); });
        }
        return items;
    }

    function runAnalysis() {
        const btn = document.getElementById('kp-run');
        const prog = document.getElementById('kp-progress');
        if (btn) btn.disabled = true;
        return ensureLoaded().then(function (kp) {
            const items = currentItems();
            const located = new Array(items.length);
            for (let i = 0; i < items.length; i++) located[i] = locateItem(items[i]);
            const prep = prepare(kp, located, { metric: state.metric, threshold: state.threshold });
            if (!prep.nUsed) { if (prog) prog.textContent = t('kpNoData'); return null; }
            const nPerm = 5000;
            return permutationTest(kp, prep, nPerm, function (p) {
                if (prog) prog.textContent = t('kpRunning')(Math.round(p * 100));
            }).then(function (perm) {
                const sea = superposedEpoch(kp, prep, 10, 10);
                const res = { prep: prep, perm: perm, sea: sea, when: new Date() };
                state.lastResult = res;
                if (prog) prog.textContent = '';
                renderResult(res);
                return res;
            });
        }).catch(function (err) {
            if (prog) prog.textContent = state.error ? t('kpStatusError') : String(err && err.message || err);
            return null;
        }).then(function (r) { if (btn) btn.disabled = false; return r; });
    }

    function verdict(res) {
        const pm = res.perm;
        if (!(pm.expected >= 5) || pm.nInformativeStrata < 5) return { text: t('kpVerdictWeak'), cls: 'kp-v-weak' };
        if (pm.p < 0.05) {
            const pct = ' (' + (pm.ratio > 1 ? '+' : '\u2212') + fmt(Math.abs(pm.ratio - 1) * 100, 1) + ' %' + (Math.abs(pm.ratio - 1) < 0.05 ? t('kpVerdictTiny') : '') + ')';
            return pm.ratio > 1 ? { text: t('kpVerdictMore') + pct, cls: 'kp-v-more' } : { text: t('kpVerdictLess') + pct, cls: 'kp-v-less' };
        }
        return { text: t('kpVerdictNone'), cls: 'kp-v-none' };
    }

    function destroyCharts() { state.charts.forEach(function (c) { try { c.destroy(); } catch (e) { } }); state.charts = []; }

    function renderResult(res) {
        const modal = document.getElementById('kp-modal');
        const body = document.getElementById('kp-modal-body');
        if (!modal || !body) return;
        const r = res.prep, pm = res.perm, T = r.threshold, v = verdict(res);
        const obsShare = r.nUsed ? 100 * r.obsStorm / r.nUsed : NaN, expShare = r.nUsed ? 100 * r.expStorm / r.nUsed : NaN;

        let rows = '';
        for (let c = 0; c < 10; c++) {
            const o = r.obsClass[c], e = r.expClass[c];
            rows += '<tr><td><span class="kp-badge" style="background:' + CLASS_COLORS[c] + '">' + c + '</span></td><td>' + fmt(o, 0) +
                '</td><td>' + fmt(e, 1) + '</td><td>' + (e >= 5 ? fmt(o / e, 2) : '–') + '</td></tr>';
        }

        document.getElementById('kp-modal-title').textContent = t('kpModalTitle');
        body.innerHTML =
            '<div class="kp-cards">' +
            '<div class="kp-card"><div class="kp-card-v">' + fmt(r.nUsed, 0) + '</div><div class="kp-card-l">' + esc(t('kpHeadN')) + '</div></div>' +
            '<div class="kp-card"><div class="kp-card-v">' + fmt(r.obsMeanKp, 2) + '</div><div class="kp-card-l">' + esc(t('kpHeadMean')) + '<br>(' + esc(t('kpExpected')) + ' ' + fmt(r.expMeanKp, 2) + ')</div></div>' +
            '<div class="kp-card"><div class="kp-card-v">' + fmt(obsShare, 1) + ' %</div><div class="kp-card-l">' + esc(t('kpHeadStorm')(T)) + '<br>(' + esc(t('kpExpected')) + ' ' + fmt(expShare, 1) + ' %)</div></div>' +
            '<div class="kp-card"><div class="kp-card-v">' + fmt(pm.ratio, 2) + '×</div><div class="kp-card-l">' + esc(t('kpHeadRatio')) + '<br>' + esc(t('kpNullRange')) + ': ' + fmt(pm.nullLo, 2) + '–' + fmt(pm.nullHi, 2) + '</div></div>' +
            '</div>' +
            '<div class="kp-verdict ' + v.cls + '">' + esc(v.text) + ' <span>' + esc(t('kpPLabel')) + ': <strong>' + (pm.p < 0.001 ? '&lt; 0,001'.replace(',', lang() === 'cs' ? ',' : '.') : fmt(pm.p, 3)) + '</strong> (' + pm.nPerm + ' perm.)</span></div>' +
            '<p class="kp-note">' + esc(t('kpCoverage')(r)) + ' ' + esc(state.metric === 'slot' ? t('kpMetricSlot') : t('kpMetricDay')) + '.</p>' +
            '<h4>' + esc(t('kpChartDistTitle')) + '</h4><div class="kp-chart-box"><canvas id="kp-chart-dist"></canvas></div>' +
            '<h4>' + esc(t('kpChartSeaTitle')(res.sea.nEvents, T)) + '</h4><div class="kp-chart-box"><canvas id="kp-chart-sea"></canvas></div>' +
            '<table class="kp-table"><thead><tr><th>' + esc(t('kpTableClass')) + '</th><th>' + esc(t('kpTableObs')) + '</th><th>' + esc(t('kpTableExp')) + '</th><th>' + esc(t('kpTableRatio')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>' +
            '<details class="kp-method" open><summary>' + esc(t('kpMethodTitle')) + '</summary>' + t('kpMethod') + '</details>' +
            '<p class="kp-note">' + t('kpCitation') + '</p>';

        document.getElementById('kp-modal-close').textContent = t('kpClose');
        document.getElementById('kp-modal-csv').textContent = t('kpDownloadCsv');
        modal.style.display = 'block';
        drawCharts(res);
    }

    function drawCharts(res) {
        destroyCharts();
        if (typeof Chart === 'undefined') return;
        const r = res.prep;
        const labels = [], obs = [], exp = [], ratio = [];
        for (let c = 0; c < 10; c++) {
            labels.push(String(c));
            obs.push(r.nUsed ? 100 * r.obsClass[c] / r.nUsed : 0);
            exp.push(r.nUsed ? 100 * r.expClass[c] / r.nUsed : 0);
            ratio.push(r.expClass[c] >= 5 ? r.obsClass[c] / r.expClass[c] : null);
        }
        const dist = document.getElementById('kp-chart-dist');
        if (dist) state.charts.push(new Chart(dist.getContext('2d'), {
            data: {
                labels: labels,
                datasets: [
                    { type: 'bar', label: t('kpChartDistObs'), data: obs, backgroundColor: CLASS_COLORS, borderColor: '#333', borderWidth: 1, yAxisID: 'y', order: 2 },
                    { type: 'bar', label: t('kpChartDistExp'), data: exp, backgroundColor: 'rgba(120,120,120,0.45)', borderColor: '#555', borderWidth: 1, yAxisID: 'y', order: 3 },
                    { type: 'line', label: t('kpChartDistRatio'), data: ratio, borderColor: '#1a237e', backgroundColor: '#1a237e', yAxisID: 'y2', tension: 0.2, spanGaps: false, order: 1 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                scales: {
                    x: { title: { display: true, text: t('kpChartKpX') } },
                    y: { beginAtZero: true, title: { display: true, text: '%' } },
                    y2: { position: 'right', beginAtZero: true, suggestedMax: 2, grid: { drawOnChartArea: false }, title: { display: true, text: t('kpChartDistRatio') } }
                }
            }
        }));
        const sea = document.getElementById('kp-chart-sea');
        if (sea) state.charts.push(new Chart(sea.getContext('2d'), {
            type: 'line',
            data: {
                labels: res.sea.lags,
                datasets: [
                    { label: t('kpChartSeaMean'), data: res.sea.mean, borderColor: '#e53935', backgroundColor: '#e53935', tension: 0.2, pointRadius: 3 },
                    { label: t('kpChartSeaBand'), data: res.sea.hi, borderColor: 'rgba(229,57,53,0.35)', borderDash: [5, 4], pointRadius: 0, fill: '+1', backgroundColor: 'rgba(229,57,53,0.10)' },
                    { label: '', data: res.sea.lo, borderColor: 'rgba(229,57,53,0.35)', borderDash: [5, 4], pointRadius: 0 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { labels: { filter: function (item) { return !!item.text; } } } },
                scales: { x: { title: { display: true, text: t('kpChartSeaX') } }, y: { suggestedMin: 0.5, suggestedMax: 1.5 } }
            }
        }));
    }

    function downloadResultCsv() {
        const res = state.lastResult; if (!res) return;
        const r = res.prep, pm = res.perm, L = [];
        L.push('# UAP map - Kp analysis;' + res.when.toISOString());
        L.push('# metric;' + r.metric + ';threshold_Kp;' + r.threshold + ';local_time_to_UT_by_longitude;' + state.useLon);
        L.push('# records_filtered;' + r.nTotal + ';records_used;' + r.nUsed + ';out_of_range;' + r.nOutOfRange + ';no_time;' + r.nNoTime + ';missing_kp;' + r.nMissingKp);
        L.push('# storm_observed;' + pm.observed + ';storm_expected;' + pm.expected.toFixed(3) + ';ratio;' + pm.ratio.toFixed(4) + ';null95_lo;' + pm.nullLo.toFixed(4) + ';null95_hi;' + pm.nullHi.toFixed(4) + ';p_two_sided;' + pm.p.toFixed(5) + ';permutations;' + pm.nPerm);
        L.push('# mean_kp_observed;' + r.obsMeanKp.toFixed(4) + ';mean_kp_expected;' + r.expMeanKp.toFixed(4));
        L.push('kp_class;observed;expected;ratio');
        for (let c = 0; c < 10; c++) L.push(c + ';' + r.obsClass[c] + ';' + r.expClass[c].toFixed(3) + ';' + (r.expClass[c] > 0 ? (r.obsClass[c] / r.expClass[c]).toFixed(4) : ''));
        L.push(''); L.push('lag_days;relative_reports_mean;ci95_lo;ci95_hi;storm_onsets;' + res.sea.nEvents);
        res.sea.lags.forEach(function (lag, i) {
            const f = function (x) { return x === null ? '' : x.toFixed(4); };
            L.push(lag + ';' + f(res.sea.mean[i]) + ';' + f(res.sea.lo[i]) + ';' + f(res.sea.hi[i]));
        });
        L.push(''); L.push('# Kp data: Matzka et al. (2021), GFZ Potsdam, doi:10.5880/Kp.0001, CC BY 4.0');
        const blob = new Blob(['﻿' + L.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a'); const url = URL.createObjectURL(blob);
        a.href = url; a.download = 'uap_kp_analysis_' + r.metric + '_kp' + r.threshold + '_' + r.nUsed + '.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    // =========================================================================
    // 6. UŽIVATELSKÉ ROZHRANÍ (panel, okno s výsledky, styly)
    // =========================================================================
    function buildUi() {
        if (document.getElementById('panel-kp')) return;
        const css = document.createElement('style');
        css.textContent =
            '#panel-kp{top:120px;left:340px;width:330px;}' +
            '#panel-kp h3{color:#ffb300;cursor:move;margin:0;padding-right:30px;}' +
            '#panel-kp h4{margin:8px 0 2px;font-size:.9em;color:#ffb300;border-top:1px solid #444;padding-top:8px;}' +
            '#panel-kp .kp-check{cursor:pointer;display:flex;align-items:center;font-size:.9em;}' +
            '#panel-kp .kp-check input{width:auto;margin:0 10px 0 0;}' +
            '#kp-status,#kp-progress{font-size:.8em;color:#aaa;min-height:1.2em;}#kp-progress{color:#ffeb3b;}' +
            '#kp-run:disabled{opacity:.5;cursor:wait;}' +
            '.kp-badge{display:inline-block;padding:0 6px;border-radius:9px;color:#111;font-weight:bold;font-size:.9em;}' +
            '.kp-popup-line{margin-top:4px;}.kp-popup-ut{color:#aaa;font-size:.85em;}' +
            '#kp-legend{position:fixed;left:50%;transform:translateX(-50%);bottom:42px;z-index:3500;display:none;gap:8px;align-items:center;' +
            'background:rgba(33,33,33,.92);color:#f0f0f0;border:1px solid #555;border-radius:6px;padding:4px 10px;font-size:.8em;flex-wrap:wrap;max-width:94vw;}' +
            '.kp-legend-item{display:inline-flex;align-items:center;gap:4px;}.kp-legend-item i{width:11px;height:11px;border-radius:50%;display:inline-block;border:1px solid #fff;}' +
            ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(function (c) { return '.kp-col-' + c + ' svg{fill:' + CLASS_COLORS[+c] + ' !important;stroke:#fff !important;filter:none !important;}'; }).join('') +
            '.kp-col-x svg{fill:' + NODATA_COLOR + ' !important;stroke:#fff !important;filter:none !important;}' +
            '#kp-modal{display:none;position:fixed;z-index:9000;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.85);overflow:auto;padding:70px 0 40px;box-sizing:border-box;backdrop-filter:blur(3px);}' +
            '#kp-modal-inner{background:#fefefe;color:#222;margin:auto;padding:20px;border-radius:8px;width:92%;max-width:1000px;box-shadow:0 5px 15px rgba(0,0,0,.5);box-sizing:border-box;}' +
            '#kp-modal-head{display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid #ccc;padding-bottom:10px;margin-bottom:15px;}' +
            '#kp-modal-head h2{margin:0;font-size:1.25em;}#kp-modal-head button{width:auto;margin:0;padding:8px 14px;}' +
            '#kp-modal-close{background-color:#f44336;}#kp-modal-csv{background-color:#3f51b5;}' +
            '.kp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;}' +
            '.kp-card{background:#f3f5f7;border:1px solid #d5dbe1;border-radius:6px;padding:10px;text-align:center;}' +
            '.kp-card-v{font-size:1.6em;font-weight:bold;color:#1a237e;}.kp-card-l{font-size:.8em;color:#555;}' +
            '.kp-verdict{margin:14px 0 6px;padding:10px 12px;border-radius:6px;font-weight:bold;border-left:5px solid #607d8b;background:#eceff1;}' +
            '.kp-verdict span{font-weight:normal;display:block;margin-top:3px;font-size:.9em;}' +
            '.kp-v-more{border-color:#e53935;background:#ffebee;}.kp-v-less{border-color:#1e88e5;background:#e3f2fd;}.kp-v-weak{border-color:#fb8c00;background:#fff3e0;}' +
            '.kp-note{font-size:.82em;color:#555;}#kp-modal h4{margin:18px 0 6px;color:#222;}' +
            '.kp-chart-box{position:relative;height:300px;}' +
            '.kp-table{border-collapse:collapse;margin:16px 0;font-size:.9em;}.kp-table th,.kp-table td{border:1px solid #ccc;padding:3px 12px;text-align:right;}.kp-table th{background:#eee;}' +
            '.kp-method{font-size:.88em;background:#fffde7;border:1px solid #f0e68c;border-radius:6px;padding:8px 12px;}.kp-method summary{cursor:pointer;font-weight:bold;}.kp-method li{margin:5px 0;}' +
            '@media (max-width:768px){#kp-modal{padding-top:20px;}.kp-chart-box{height:240px;}#kp-modal-head{flex-wrap:wrap;}}';
        document.head.appendChild(css);

        const panel = document.createElement('div');
        panel.id = 'panel-kp'; panel.className = 'sidebar-panel';
        let filterOpts = '<option value="all" data-translate-key="kpFilterAll"></option><option value="quiet" data-translate-key="kpFilterQuiet"></option>';
        [4, 5, 6, 7, 8].forEach(function (n) { filterOpts += '<option value="' + n + '" data-kp-ge="' + n + '"></option>'; });
        let thrOpts = '';
        [4, 5, 6, 7].forEach(function (n) { thrOpts += '<option value="' + n + '" data-kp-thr="' + n + '"' + (n === 5 ? ' selected' : '') + '></option>'; });
        panel.innerHTML =
            '<button class="panel-close-btn" data-translate-key-aria="ariaClosePanel" aria-label="Zavřít panel" onclick="togglePanel(\'panel-kp\')">✕</button>' +
            '<h3 data-translate-key="kpTitle"></h3>' +
            '<div style="font-size:.85em;color:#ccc;" data-translate-key="kpIntro"></div>' +
            '<div id="kp-status"></div>' +
            '<label for="kp-metric" data-translate-key="kpMetricLabel"></label>' +
            '<select id="kp-metric"><option value="daymax" data-translate-key="kpMetricDay"></option><option value="slot" data-translate-key="kpMetricSlot"></option></select>' +
            '<label class="kp-check"><input type="checkbox" id="kp-use-lon" checked><span data-translate-key="kpUseLon"></span></label>' +
            '<h4 data-translate-key="kpMapSection"></h4>' +
            '<label class="kp-check"><input type="checkbox" id="kp-color-mode"><span data-translate-key="kpColorMode"></span></label>' +
            '<label for="kp-filter" data-translate-key="kpFilterLabel"></label><select id="kp-filter">' + filterOpts + '</select>' +
            '<h4 data-translate-key="kpAnalysisSection"></h4>' +
            '<label for="kp-threshold" data-translate-key="kpThresholdLabel"></label><select id="kp-threshold">' + thrOpts + '</select>' +
            '<label class="kp-check"><input type="checkbox" id="kp-viewport-only"><span data-translate-key="kpViewportOnly"></span></label>' +
            '<button id="kp-run" class="primary-button" data-translate-key="kpRunBtn"></button>' +
            '<div id="kp-progress"></div>';
        document.body.appendChild(panel);

        const modal = document.createElement('div');
        modal.id = 'kp-modal';
        modal.innerHTML = '<div id="kp-modal-inner"><div id="kp-modal-head"><h2 id="kp-modal-title"></h2><div style="display:flex;gap:6px;">' +
            '<button id="kp-modal-csv" class="custom-button"></button><button id="kp-modal-close" class="custom-button"></button></div></div><div id="kp-modal-body"></div></div>';
        document.body.appendChild(modal);

        // --- obsluha ---
        document.getElementById('kp-metric').addEventListener('change', function () {
            state.metric = this.value;
            if (state.colorMode || state.filter !== 'all') redrawMap();
        });
        document.getElementById('kp-use-lon').addEventListener('change', function () {
            state.useLon = this.checked;
            if (state.colorMode || state.filter !== 'all') redrawMap();
        });
        document.getElementById('kp-color-mode').addEventListener('change', function () {
            const want = this.checked, self = this;
            ensureLoaded().then(function () { state.colorMode = want; redrawMap(); })
                .catch(function () { self.checked = false; state.colorMode = false; });
        });
        document.getElementById('kp-filter').addEventListener('change', function () {
            const want = this.value, self = this;
            ensureLoaded().then(function () { state.filter = want; redrawMap(); })
                .catch(function () { self.value = 'all'; state.filter = 'all'; });
        });
        document.getElementById('kp-threshold').addEventListener('change', function () { state.threshold = parseInt(this.value, 10) || 5; });
        document.getElementById('kp-run').addEventListener('click', runAnalysis);
        document.getElementById('kp-modal-close').addEventListener('click', function () { modal.style.display = 'none'; destroyCharts(); });
        document.getElementById('kp-modal-csv').addEventListener('click', downloadResultCsv);
        modal.addEventListener('click', function (e) { if (e.target === modal) { modal.style.display = 'none'; destroyCharts(); } });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.style.display === 'block') { modal.style.display = 'none'; destroyCharts(); } });

        refreshDynamicTexts();
    }

    // Texty, které nejdou řešit přes data-translate-key (funkce s parametrem)
    function refreshDynamicTexts() {
        document.querySelectorAll('#kp-filter option[data-kp-ge]').forEach(function (o) { o.textContent = t('kpFilterGe')(+o.getAttribute('data-kp-ge')); });
        document.querySelectorAll('#kp-threshold option[data-kp-thr]').forEach(function (o) { o.textContent = t('kpThresholdOpt')(+o.getAttribute('data-kp-thr')); });
        document.querySelectorAll('#panel-kp [data-translate-key]').forEach(function (el) {
            const v = TXT[lang()][el.getAttribute('data-translate-key')];
            if (typeof v === 'string') el.textContent = v;
        });
        if (state.kp) setStatus(t('kpStatusReady')(state.kp.meta.lastDay || '?', state.kp.meta.lastDefinitive));
        else if (state.error) setStatus(t('kpStatusError'), true);
        updateLegend();
        const modal = document.getElementById('kp-modal');
        if (modal && modal.style.display === 'block' && state.lastResult) renderResult(state.lastResult);
    }

    function init() {
        buildUi();
        if (typeof makeElementDraggable === 'function') { try { makeElementDraggable('panel-kp'); } catch (e) { } }
        const panel = document.getElementById('panel-kp');
        panel.addEventListener('mousedown', function (e) {
            if (!e.target.closest('.panel-close-btn') && typeof bringToFront === 'function') bringToFront(panel);
        });
        // Přepnutí jazyka: původní setLanguage doplníme o obnovu dynamických textů
        if (typeof root.setLanguage === 'function' && !root.setLanguage._kpWrapped) {
            const orig = root.setLanguage;
            root.setLanguage = function (lg) { const r = orig.apply(this, arguments); try { refreshDynamicTexts(); } catch (e) { } return r; };
            root.setLanguage._kpWrapped = true;
        }
        refreshDynamicTexts();
        // Data (cca 280 kB) načíst na pozadí krátce po startu, ať jsou Kp hodnoty v bublinách bodů
        setTimeout(function () { ensureLoaded().catch(function () { }); }, 6000);
    }

    root.KP = {
        core: core, state: state, ensureLoaded: ensureLoaded, passesFilter: passesFilter, colorModeActive: colorModeActive,
        glColor: glColor, classicIcon: classicIcon, popupHtml: popupHtml, exportFields: exportFields,
        resetFilter: resetFilter, runAnalysis: runAnalysis, valueFor: valueFor, locateItem: locateItem
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})(typeof window !== 'undefined' ? window : globalThis);
