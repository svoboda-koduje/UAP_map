/* =============================================================================
 * timeline_pro.js - ROZŠÍŘENÝ BADATELSKÝ PŘEHRÁVAČ pro Interaktivní mapu UAP/UFO
 * -----------------------------------------------------------------------------
 * Nahrazuje původní přehrávač (krok jen po letech) a přidává:
 *   - krok přehrávání: rok / měsíc / den,
 *   - režim zobrazení: jen aktuální krok / kumulativně / klouzavé okno N kroků,
 *   - ČASOVÉ PODMÍNKY (které dny se mají přehrávat): vysoké Kp, klidné Kp, dny
 *     kolem nástupu geomagnetické bouře, vlny hlášení, úplněk, nov, maxima
 *     meteorických rojů, víkendy, vyloučení dnů ohňostrojů,
 *   - přeskakování prázdných kroků, krokování ◀ ▶, posuvník času,
 *   - časovou osu: sloupce = počet pozorování, čára = Kp index, kliknutím skok.
 * Přehrávač respektuje všechny ostatní filtry mapy (tvar, kategorie, region,
 * fulltext, roční období, denní doba, filtr Kp) - používá applyAllFilters()
 * z index.html. Data Kp bere z vrstvy kp_layer.js (window.KP).
 * ========================================================================== */
(function (root) {
    'use strict';

    const DAY = 86400000;
    const EPOCH = Date.UTC(1900, 0, 1);
    const KP_OFFSET = Math.round((Date.UTC(1932, 0, 1) - EPOCH) / DAY); // den 0 dat Kp v našem číslování
    const DT_RE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/;
    const SYNODIC = 29.530588853;
    const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14) / DAY; // nov 6. 1. 2000 18:14 UT (ve dnech)
    const SHOWERS = [[1, 2, 1, 5], [4, 20, 4, 23], [5, 4, 5, 7], [7, 28, 7, 31], [8, 10, 8, 14], [10, 19, 10, 23], [11, 16, 11, 19], [12, 12, 12, 15], [12, 21, 12, 23]];

    // ------------------------------------------------------------------ texty
    const TXT = {
        cs: {
            step: 'Krok přehrávání:', stepYear: 'Rok', stepMonth: 'Měsíc', stepDay: 'Den',
            mode: 'Zobrazení bodů:', modeStep: 'Jen aktuální krok', modeCum: 'Kumulativně (body přibývají)', modeWin: 'Klouzavé okno',
            winN: 'Délka okna (kroků):',
            cond: 'Časová podmínka (které dny přehrávat):',
            c_none: '-- Všechny dny --', c_kp_ge: '🧲 Dny s vysokým Kp indexem', c_kp_quiet: '🧲 Geomagneticky klidné dny (Kp 0–1)',
            c_storm_window: '🧲 Dny kolem nástupu geomagnetické bouře', c_flap: '📈 Vlny hlášení (dny s mimořádným počtem)',
            c_moon_full: '🌕 Kolem úplňku (±2 dny)', c_moon_new: '🌑 Kolem novu (±2 dny)', c_meteors: '☄️ Maxima meteorických rojů',
            c_weekend: '📅 Víkendy (so, ne)', c_no_fireworks: '🎆 Bez dnů ohňostrojů (4. 7., Silvestr, 5. 11.)',
            condT: 'Práh Kp:', condN: 'Okno ± dní:',
            skip: 'Přeskakovat kroky bez pozorování',
            prev: 'Předchozí krok', next: 'Další krok', seek: 'Pozice v čase',
            ready: 'Připraveno', building: 'Připravuji data…', stopped: 'Zastaveno', noData: 'Pro zvolené nastavení nejsou žádná pozorování.',
            kpMissing: 'Tato podmínka potřebuje data Kp, která se nepodařilo načíst.',
            count: function (n, total) { return n.toLocaleString('cs-CZ') + ' pozorování' + (total !== null ? ' (celkem ' + total.toLocaleString('cs-CZ') + ')' : ''); },
            kpDay: function (lbl, g) { return 'Kp max ' + lbl + (g ? ' (' + g + ')' : ''); },
            kpSpan: function (n, t, mean) { return 'dnů s Kp ≥ ' + t + ': ' + n + ', průměr denních maxim ' + mean; },
            legend: 'Sloupce: počet pozorování · žlutá čára: Kp (0–9) · klik = skok v čase',
            legendNoKp: 'Sloupce: počet pozorování · klik = skok v čase',
            hint: 'Přehrávač respektuje všechny zapnuté filtry mapy. Obarvení bodů podle Kp zapnete v panelu Geomagnetická aktivita.'
        },
        en: {
            step: 'Playback step:', stepYear: 'Year', stepMonth: 'Month', stepDay: 'Day',
            mode: 'Point display:', modeStep: 'Current step only', modeCum: 'Cumulative (points accumulate)', modeWin: 'Sliding window',
            winN: 'Window length (steps):',
            cond: 'Time condition (which days to play):',
            c_none: '-- All days --', c_kp_ge: '🧲 Days with a high Kp index', c_kp_quiet: '🧲 Geomagnetically quiet days (Kp 0–1)',
            c_storm_window: '🧲 Days around a geomagnetic storm onset', c_flap: '📈 Report waves (days with exceptional counts)',
            c_moon_full: '🌕 Around full moon (±2 days)', c_moon_new: '🌑 Around new moon (±2 days)', c_meteors: '☄️ Meteor shower maxima',
            c_weekend: '📅 Weekends (Sat, Sun)', c_no_fireworks: '🎆 Excluding fireworks dates (Jul 4, New Year, Nov 5)',
            condT: 'Kp threshold:', condN: 'Window ± days:',
            skip: 'Skip steps without sightings',
            prev: 'Previous step', next: 'Next step', seek: 'Position in time',
            ready: 'Ready', building: 'Preparing data…', stopped: 'Stopped', noData: 'No sightings for the chosen settings.',
            kpMissing: 'This condition needs Kp data, which could not be loaded.',
            count: function (n, total) { return n.toLocaleString('en-US') + ' sightings' + (total !== null ? ' (total ' + total.toLocaleString('en-US') + ')' : ''); },
            kpDay: function (lbl, g) { return 'Kp max ' + lbl + (g ? ' (' + g + ')' : ''); },
            kpSpan: function (n, t, mean) { return 'days with Kp ≥ ' + t + ': ' + n + ', mean daily maximum ' + mean; },
            legend: 'Bars: number of sightings · yellow line: Kp (0–9) · click = seek',
            legendNoKp: 'Bars: number of sightings · click = seek',
            hint: 'The player respects all active map filters. Turn on Kp colouring in the Geomagnetic activity panel.'
        }
    };
    function lang() { return (typeof currentLanguage !== 'undefined' && currentLanguage === 'en') ? 'en' : 'cs'; }
    function t(k) { return TXT[lang()][k]; }
    function $(id) { return document.getElementById(id); }

    // ------------------------------------------------------------------ stav
    const S = {
        step: 'year', mode: 'step', winN: 5, cond: 'none', condT: 5, condN: 2, skipEmpty: true,
        keys: [], buckets: new Map(), firstKey: 0, lastKey: 0, pos: -1, playing: false, timer: null, dirty: true,
        cum: [], cumPos: -1, bins: null, building: null, startYear: 1900, endYear: 2026
    };

    // ------------------------------------------------------------------ pomocné výpočty
    function dayNum(item) {
        if (item._tlDay !== undefined) return item._tlDay;
        let v = null;
        const m = DT_RE.exec(item.dt || '');
        if (m) {
            const mo = +m[1], d = +m[2], y = +m[3];
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900) v = Math.round((Date.UTC(y, mo - 1, d) - EPOCH) / DAY);
        }
        item._tlDay = v;
        return v;
    }
    function dateOf(day) { return new Date(EPOCH + day * DAY); }
    function keyOfDay(day, step) {
        if (step === 'day') return day;
        const d = dateOf(day);
        return step === 'year' ? d.getUTCFullYear() : d.getUTCFullYear() * 12 + d.getUTCMonth();
    }
    function keyRangeDays(key, step) { // [prvníDen, posledníDen] daného kroku
        if (step === 'day') return [key, key];
        if (step === 'year') return [Math.round((Date.UTC(key, 0, 1) - EPOCH) / DAY), Math.round((Date.UTC(key + 1, 0, 1) - EPOCH) / DAY) - 1];
        const y = Math.floor(key / 12), m = key % 12;
        return [Math.round((Date.UTC(y, m, 1) - EPOCH) / DAY), Math.round((Date.UTC(y, m + 1, 1) - EPOCH) / DAY) - 1];
    }
    function labelOf(key, step) {
        const loc = lang() === 'cs' ? 'cs-CZ' : 'en-GB';
        if (step === 'year') return String(key);
        if (step === 'month') return new Date(Date.UTC(Math.floor(key / 12), key % 12, 1)).toLocaleDateString(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' });
        return dateOf(key).toLocaleDateString(loc, { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
    }
    function moonAge(day) { // stáří Měsíce ve dnech (0 = nov), v poledne UT
        const x = ((EPOCH / DAY + day + 0.5) - NEW_MOON_REF) / SYNODIC;
        return (x - Math.floor(x)) * SYNODIC;
    }
    function inShower(mo, d) {
        for (let i = 0; i < SHOWERS.length; i++) { const s = SHOWERS[i]; if (mo === s[0] && d >= s[1] && d <= s[3]) return true; }
        return false;
    }
    function kpData() { return (root.KP && root.KP.state && root.KP.state.kp) ? root.KP.state.kp : null; }
    function needsKp(cond) { return cond === 'kp_ge' || cond === 'kp_quiet' || cond === 'storm_window'; }

    // Maska dnů (v číslování dat Kp), které leží do ±N dnů od nástupu bouře
    function stormWindowMask(kp, T, N) {
        const core = root.KP.core, MISS = core.MISSING, mask = new Uint8Array(kp.days);
        const isStorm = function (d) { const v = kp.dayMax[d]; return v !== MISS && core.k3Class(v) >= T; };
        for (let d = 2; d < kp.days; d++) {
            if (!isStorm(d) || isStorm(d - 1) || isStorm(d - 2)) continue;
            for (let x = Math.max(0, d - N); x <= Math.min(kp.days - 1, d + N); x++) mask[x] = 1;
        }
        return mask;
    }

    // Vrátí funkci (item, den) -> true/false podle zvolené časové podmínky
    function makeCondition(base) {
        const cond = S.cond, core = root.KP ? root.KP.core : null;
        if (cond === 'none') return null;
        if (cond === 'kp_ge') { const T = S.condT; return function (it) { const v = root.KP.valueFor(it, 'daymax'); return v !== null && core.k3Class(v) >= T; }; }
        if (cond === 'kp_quiet') return function (it) { const v = root.KP.valueFor(it, 'daymax'); return v !== null && core.k3Class(v) <= 1; };
        if (cond === 'storm_window') {
            const mask = stormWindowMask(kpData(), S.condT, S.condN);
            return function (it) { const loc = root.KP.locateItem(it); return !!(loc && mask[loc.day]); };
        }
        if (cond === 'flap') {
            // den je "vlna", když má aspoň 5 hlášení a zároveň aspoň 4× víc než běžný den téhož měsíce
            const perDay = new Map(), perMonth = new Map();
            base.forEach(function (it) {
                const d = dayNum(it); if (d === null) return;
                perDay.set(d, (perDay.get(d) || 0) + 1);
                const mk = keyOfDay(d, 'month'); perMonth.set(mk, (perMonth.get(mk) || 0) + 1);
            });
            const flap = new Set();
            perDay.forEach(function (c, d) {
                if (c < 5) return;
                const mk = keyOfDay(d, 'month'), r = keyRangeDays(mk, 'month');
                if (c >= 4 * (perMonth.get(mk) / (r[1] - r[0] + 1))) flap.add(d);
            });
            return function (it, d) { return flap.has(d); };
        }
        if (cond === 'moon_full') return function (it, d) { return Math.abs(moonAge(d) - SYNODIC / 2) <= 2; };
        if (cond === 'moon_new') return function (it, d) { const a = moonAge(d); return a <= 2 || a >= SYNODIC - 2; };
        if (cond === 'meteors') return function (it, d) { const x = dateOf(d); return inShower(x.getUTCMonth() + 1, x.getUTCDate()); };
        if (cond === 'weekend') return function (it, d) { const w = dateOf(d).getUTCDay(); return w === 0 || w === 6; };
        if (cond === 'no_fireworks') return function (it, d) {
            const x = dateOf(d), mo = x.getUTCMonth() + 1, da = x.getUTCDate();
            return !((mo === 7 && da >= 3 && da <= 5) || (mo === 12 && da === 31) || (mo === 1 && da === 1) || (mo === 11 && da === 5));
        };
        return null;
    }

    // ------------------------------------------------------------------ příprava dat
    function build() {
        if (S.building) return S.building;
        setStats(t('building'));
        const p = (needsKp(S.cond) && root.KP ? root.KP.ensureLoaded() : Promise.resolve()).then(function () {
            if (needsKp(S.cond) && !kpData()) throw new Error('kp');
            let y0 = parseInt($('timeline-start-year').value, 10), y1 = parseInt($('timeline-end-year').value, 10);
            if (!(y0 >= 1900)) y0 = 1900; if (!(y1 <= 2030)) y1 = 2030; if (y1 < y0) { const x = y0; y0 = y1; y1 = x; }
            S.startYear = y0; S.endYear = y1;
            const base = applyAllFilters(allData, { yearMin: y0, yearMax: y1 });
            const cond = makeCondition(base);
            const buckets = new Map();
            for (let i = 0; i < base.length; i++) {
                const it = base[i], d = dayNum(it);
                if (d === null) continue;
                if (cond && !cond(it, d)) continue;
                const k = S.step === 'day' ? d : (S.step === 'year' ? it.year : it.year * 12 + (it.month - 1));
                let b = buckets.get(k); if (!b) { b = []; buckets.set(k, b); }
                b.push(it);
            }
            S.buckets = buckets;
            S.firstKey = keyOfDay(Math.round((Date.UTC(y0, 0, 1) - EPOCH) / DAY), S.step);
            S.lastKey = keyOfDay(Math.round((Date.UTC(y1, 11, 31) - EPOCH) / DAY), S.step);
            if (S.skipEmpty) S.keys = Array.from(buckets.keys()).filter(function (k) { return k >= S.firstKey && k <= S.lastKey; }).sort(function (a, b) { return a - b; });
            else { S.keys = []; for (let k = S.firstKey; k <= S.lastKey; k++) S.keys.push(k); }
            S.cum = []; S.cumPos = -1; S.dirty = false;
            buildBins();
            const sc = $('tl-scrub'); if (sc) { sc.max = Math.max(0, S.keys.length - 1); }
        });
        S.building = p.then(function () { S.building = null; }, function (e) { S.building = null; throw e; });
        return S.building;
    }

    function buildBins() {
        const canvas = $('tl-chart'); const nb = Math.max(20, Math.min(S.lastKey - S.firstKey + 1, canvas ? Math.floor(canvas.clientWidth || 260) : 260));
        const span = S.lastKey - S.firstKey + 1;
        const counts = new Float64Array(nb), kpSum = new Float64Array(nb), kpN = new Uint32Array(nb);
        S.buckets.forEach(function (arr, k) { if (k < S.firstKey || k > S.lastKey) return; counts[Math.min(nb - 1, Math.floor((k - S.firstKey) / span * nb))] += arr.length; });
        const kp = kpData();
        if (kp) {
            const MISS = root.KP.core.MISSING;
            const d0 = keyRangeDays(S.firstKey, S.step)[0], d1 = keyRangeDays(S.lastKey, S.step)[1];
            for (let d = Math.max(d0, KP_OFFSET); d <= d1 && d - KP_OFFSET < kp.days; d++) {
                const v = kp.dayMax[d - KP_OFFSET]; if (v === MISS) continue;
                const b = Math.min(nb - 1, Math.floor((keyOfDay(d, S.step) - S.firstKey) / span * nb));
                kpSum[b] += v / 3; kpN[b]++;
            }
        }
        S.bins = { nb: nb, counts: counts, kpSum: kpSum, kpN: kpN, hasKp: !!kp };
        drawChart();
    }

    function drawChart() {
        const c = $('tl-chart'); if (!c) return;
        const w = Math.max(100, c.clientWidth || 260), h = 84, dpr = root.devicePixelRatio || 1;
        if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
        g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, w, h);
        const B = S.bins; if (!B) return;
        let mx = 1; for (let i = 0; i < B.nb; i++) if (B.counts[i] > mx) mx = B.counts[i];
        const bw = w / B.nb;
        g.fillStyle = '#00bcd4';
        for (let i = 0; i < B.nb; i++) { if (!B.counts[i]) continue; const bh = Math.max(1, Math.sqrt(B.counts[i] / mx) * (h - 6)); g.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh); }
        if (B.hasKp) {
            g.strokeStyle = '#ffb300'; g.lineWidth = 1.2; g.beginPath(); let started = false;
            for (let i = 0; i < B.nb; i++) {
                if (!B.kpN[i]) { started = false; continue; }
                const y = h - 3 - (B.kpSum[i] / B.kpN[i]) / 9 * (h - 6), x = (i + 0.5) * bw;
                if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; }
            }
            g.stroke();
        }
        if (S.pos >= 0 && S.keys.length) {
            const x = ((S.keys[S.pos] - S.firstKey + 0.5) / (S.lastKey - S.firstKey + 1)) * w;
            g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        }
        const lg = $('tl-legend'); if (lg) lg.textContent = B.hasKp ? t('legend') : t('legendNoKp');
    }

    // ------------------------------------------------------------------ vykreslení kroku
    function viewMode() { const el = document.querySelector('input[name="view-mode"]:checked'); return el ? el.value : 'markers'; }

    function itemsFor(pos) {
        if (S.mode === 'step') return S.buckets.get(S.keys[pos]) || [];
        if (S.mode === 'window') {
            let out = [];
            for (let i = Math.max(0, pos - S.winN + 1); i <= pos; i++) { const b = S.buckets.get(S.keys[i]); if (b) out = out.concat(b); }
            return out;
        }
        return null; // kumulativní režim se řeší zvlášť
    }

    function renderFrame(pos) {
        S.pos = pos;
        const key = S.keys[pos], bucket = S.buckets.get(key) || [];
        let shown;
        if (S.mode === 'cumulative') {
            if (S.cumPos === pos - 1 && pos > 0 && viewMode() === 'markers') {
                // rychlá cesta: jen přidat nové body k již vykresleným
                for (let i = 0; i < bucket.length; i++) S.cum.push(bucket[i]);
                if (bucket.length) renderClassicMarkers(bucket);
                root.currentlyFilteredData = S.cum;
            } else {
                S.cum = [];
                for (let i = 0; i <= pos; i++) { const b = S.buckets.get(S.keys[i]); if (b) for (let j = 0; j < b.length; j++) S.cum.push(b[j]); }
                updateMarkers(S.cum, true);
            }
            S.cumPos = pos; shown = S.cum;
        } else {
            shown = itemsFor(pos);
            updateMarkers(shown, true);
        }
        // panel
        const disp = $('timeline-display-year');
        disp.innerText = labelOf(key, S.step);
        disp.style.fontSize = S.step === 'year' ? '4em' : (S.step === 'month' ? '1.9em' : '2.3em');
        let line = t('count')(bucket.length, S.mode === 'step' ? null : shown.length);
        const kp = kpData();
        if (kp) {
            const core = root.KP.core, r = keyRangeDays(key, S.step);
            if (S.step === 'day') {
                const v = r[0] - KP_OFFSET >= 0 && r[0] - KP_OFFSET < kp.days ? kp.dayMax[r[0] - KP_OFFSET] : core.MISSING;
                if (v !== core.MISSING) line += ' · ' + t('kpDay')(core.k3Label(v), core.k3GScale(v));
            } else {
                const T = needsKp(S.cond) && S.cond !== 'kp_quiet' ? S.condT : 5; let n = 0, sum = 0, cnt = 0;
                for (let d = Math.max(r[0], KP_OFFSET); d <= r[1] && d - KP_OFFSET < kp.days; d++) {
                    const v = kp.dayMax[d - KP_OFFSET]; if (v === core.MISSING) continue;
                    cnt++; sum += v / 3; if (core.k3Class(v) >= T) n++;
                }
                if (cnt) line += ' · ' + t('kpSpan')(n, T, (sum / cnt).toFixed(1));
            }
        }
        setStats(line);
        const sc = $('tl-scrub'); if (sc) sc.value = pos;
        drawChart();
    }

    function setStats(text) { const el = $('timeline-stats'); if (el) el.innerText = text; }

    // ------------------------------------------------------------------ ovládání
    function ensureBuilt() {
        if (!S.dirty && S.keys.length) return Promise.resolve(true);
        const prevKey = S.pos >= 0 && S.keys.length ? S.keys[S.pos] : null, prevStep = S._builtStep;
        return build().then(function () {
            S._builtStep = S.step;
            if (!S.keys.length) { S.pos = -1; $('timeline-display-year').innerText = '---'; setStats(t('noData')); drawChart(); return false; }
            // zachovat pozici v čase, pokud se neměnil typ kroku
            let target = null;
            if (S._resumeDay != null) target = keyOfDay(S._resumeDay, S.step);
            else if (prevKey !== null && prevStep === S.step) target = prevKey;
            S._resumeDay = null;
            if (target !== null) { let i = lowerBound(S.keys, target); if (i >= S.keys.length) i = S.keys.length - 1; S.pos = i - 1; }
            else S.pos = -1;
            return true;
        }).catch(function (e) {
            setStats(e && e.message === 'kp' ? t('kpMissing') : String(e && e.message || e));
            return false;
        });
    }
    function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

    function buttons(playing) {
        const a = $('btn-timeline-play'), b = $('btn-timeline-pause');
        if (a) a.style.display = playing ? 'none' : 'block';
        if (b) b.style.display = playing ? 'block' : 'none';
    }

    function tick() {
        if (!S.playing) return;
        const go = S.dirty ? ensureBuilt() : Promise.resolve(true);
        go.then(function (ok) {
            if (!S.playing) return;
            if (!ok || S.pos + 1 >= S.keys.length) { pause(); return; }
            renderFrame(S.pos + 1);
            const speed = parseInt($('timeline-speed').value, 10) || 800;
            S.timer = setTimeout(tick, speed);
        });
    }

    function play() {
        if (S.playing) return;
        ensureBuilt().then(function (ok) {
            if (!ok) return;
            if (S.pos + 1 >= S.keys.length) { S.pos = -1; S.cum = []; S.cumPos = -1; }
            S.playing = true; buttons(true); tick();
        });
    }
    function pause() { S.playing = false; clearTimeout(S.timer); buttons(false); }
    function stop() {
        pause();
        S.pos = -1; S.cum = []; S.cumPos = -1; S.dirty = true;
        $('timeline-display-year').innerText = '---';
        setStats(t('stopped'));
        const sc = $('tl-scrub'); if (sc) sc.value = 0;
        drawChart();
        if (typeof updateMapWithLoader === 'function') updateMapWithLoader(); // zpět na běžné zobrazení podle filtrů
    }
    function seek(pos) {
        pause();
        ensureBuilt().then(function (ok) {
            if (!ok) return;
            renderFrame(Math.max(0, Math.min(S.keys.length - 1, pos)));
        });
    }
    function stepBy(delta) {
        pause();
        ensureBuilt().then(function (ok) { if (ok) renderFrame(Math.max(0, Math.min(S.keys.length - 1, S.pos + delta))); });
    }
    function markDirty() { S.dirty = true; }
    // po změně nastavení znovu připravit data a zůstat na stejném místě v čase
    function reseek() {
        pause();
        ensureBuilt().then(function (ok) { if (ok) renderFrame(Math.max(0, Math.min(S.keys.length - 1, S.pos + 1))); });
    }

    // ------------------------------------------------------------------ UI
    function buildUi() {
        const panel = $('panel-timeline');
        if (!panel || $('tl-scrub')) return;
        const css = document.createElement('style');
        css.textContent =
            '#panel-timeline{width:330px;}' +
            '#tl-nav{display:flex;gap:6px;align-items:center;margin:0 0 6px;}#tl-nav button{width:42px;margin:0;padding:6px 0;background:#455a64;}' +
            '#tl-nav input{flex:1;margin:0;}#tl-chart{width:100%;height:84px;display:block;border:1px solid #444;border-radius:4px;cursor:crosshair;}' +
            '#tl-legend{font-size:.72em;color:#888;margin:2px 0 10px;}#tl-opts label{display:block;margin-top:8px;font-size:.9em;}' +
            '#tl-opts select,#tl-opts input[type=number]{margin-top:3px;}#tl-opts .tl-row{display:flex;gap:8px;}#tl-opts .tl-row>div{flex:1;}' +
            '#tl-opts .tl-check{display:flex;align-items:center;cursor:pointer;margin-top:10px;}#tl-opts .tl-check input{width:auto;margin:0 10px 0 0;}' +
            '#tl-hint{font-size:.75em;color:#888;margin:10px 0 14px;padding-bottom:12px;border-bottom:1px solid #444;}';
        document.head.appendChild(css);

        // 1) posuvník času + krokování + graf - hned pod tlačítka Přehrát/Stop
        const playBtn = $('btn-timeline-play');
        const nav = document.createElement('div');
        nav.innerHTML = '<div id="tl-nav"><button id="tl-prev" class="custom-button">◀</button><input type="range" id="tl-scrub" min="0" max="0" value="0"><button id="tl-next" class="custom-button">▶</button></div>' +
            '<canvas id="tl-chart"></canvas><div id="tl-legend"></div>';
        playBtn.parentElement.insertAdjacentElement('afterend', nav);

        // 2) badatelské volby - pod graf (před rychlost a rozsah let)
        const opts = document.createElement('div');
        opts.id = 'tl-opts';
        const conds = ['none', 'kp_ge', 'kp_quiet', 'storm_window', 'flap', 'moon_full', 'moon_new', 'meteors', 'weekend', 'no_fireworks'];
        opts.innerHTML =
            '<div class="tl-row"><div><label for="tl-step" data-tl="step"></label><select id="tl-step"><option value="year" data-tl="stepYear"></option><option value="month" data-tl="stepMonth"></option><option value="day" data-tl="stepDay"></option></select></div></div>' +
            '<label for="tl-mode" data-tl="mode"></label><select id="tl-mode"><option value="step" data-tl="modeStep"></option><option value="cumulative" data-tl="modeCum"></option><option value="window" data-tl="modeWin"></option></select>' +
            '<div id="tl-win-box" style="display:none;"><label for="tl-win" data-tl="winN"></label><input type="number" id="tl-win" min="2" max="60" value="5"></div>' +
            '<label for="tl-cond" data-tl="cond"></label><select id="tl-cond">' + conds.map(function (c) { return '<option value="' + c + '" data-tl="c_' + c + '"></option>'; }).join('') + '</select>' +
            '<div class="tl-row"><div id="tl-t-box" style="display:none;"><label for="tl-t" data-tl="condT"></label><select id="tl-t">' + [4, 5, 6, 7, 8].map(function (n) { return '<option value="' + n + '"' + (n === 5 ? ' selected' : '') + '>Kp ≥ ' + n + '</option>'; }).join('') + '</select></div>' +
            '<div id="tl-n-box" style="display:none;"><label for="tl-n" data-tl="condN"></label><input type="number" id="tl-n" min="0" max="10" value="2"></div></div>' +
            '<label class="tl-check"><input type="checkbox" id="tl-skip" checked><span data-tl="skip"></span></label>' +
            '<div id="tl-hint" data-tl="hint"></div>';
        nav.insertAdjacentElement('afterend', opts);

        // 3) původní tlačítka nahradit klony (zbavíme se starých listenerů) a napojit nové ovládání
        ['btn-timeline-play', 'btn-timeline-pause', 'btn-timeline-stop'].forEach(function (id) {
            const el = $(id); if (!el) return; const c = el.cloneNode(true); el.parentNode.replaceChild(c, el);
        });
        $('btn-timeline-play').addEventListener('click', play);
        $('btn-timeline-pause').addEventListener('click', pause);
        $('btn-timeline-stop').addEventListener('click', stop);
        $('tl-prev').addEventListener('click', function () { stepBy(-1); });
        $('tl-next').addEventListener('click', function () { stepBy(1); });
        $('tl-scrub').addEventListener('input', function () { seek(parseInt(this.value, 10) || 0); });
        $('tl-chart').addEventListener('click', function (e) {
            const r = this.getBoundingClientRect(), frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            ensureBuilt().then(function (ok) {
                if (!ok) return;
                const key = S.firstKey + Math.floor(frac * (S.lastKey - S.firstKey + 1));
                let i = lowerBound(S.keys, key); if (i >= S.keys.length) i = S.keys.length - 1;
                seek(i);
            });
        });
        const bind = function (id, fn) { $(id).addEventListener('change', function () { fn(this); syncBoxes(); markDirty(); if (S.playing) return; if (S.pos >= 0) reseek(); else if (S._builtStep) ensureBuilt(); }); };
        bind('tl-step', function (el) {
            // při změně kroku zůstat na stejném místě v čase (rok 1997 -> leden 1997 -> 1. 1. 1997)
            if (S.pos >= 0 && S.keys.length && !S.dirty) S._resumeDay = keyRangeDays(S.keys[S.pos], S.step)[0];
            S.step = el.value;
        });
        bind('tl-mode', function (el) { S.mode = el.value; S.cum = []; S.cumPos = -1; });
        bind('tl-win', function (el) { S.winN = Math.max(2, Math.min(60, parseInt(el.value, 10) || 5)); });
        bind('tl-cond', function (el) { S.cond = el.value; });
        bind('tl-t', function (el) { S.condT = parseInt(el.value, 10) || 5; });
        bind('tl-n', function (el) { S.condN = Math.max(0, Math.min(10, parseInt(el.value, 10) || 0)); });
        bind('tl-skip', function (el) { S.skipEmpty = el.checked; });
        ['timeline-start-year', 'timeline-end-year'].forEach(function (id) { const el = $(id); if (el) { el.min = 1900; el.addEventListener('change', markDirty); el.addEventListener('input', markDirty); } });
        // změna kteréhokoli jiného filtru mapy => data přehrávače je třeba připravit znovu
        document.addEventListener('change', function (e) {
            const id = e.target && e.target.id;
            if (id && /^(shape-filter|season-filter|timeofday-filter|show-cat-|kp-filter|kp-metric|kp-use-lon|country-filter|comment-search)/.test(id)) markDirty();
        });
        document.addEventListener('click', function (e) { if (e.target && e.target.closest && e.target.closest('.stepper-btn,#reset-filters,.reset-data-btn,.reset-analysis-btn,#apply-filters')) markDirty(); });
        if (typeof root.adjustTimelineYear === 'function') { const orig = root.adjustTimelineYear; root.adjustTimelineYear = function () { const r = orig.apply(this, arguments); markDirty(); return r; }; }
    }

    function syncBoxes() {
        $('tl-win-box').style.display = S.mode === 'window' ? 'block' : 'none';
        $('tl-t-box').style.display = (S.cond === 'kp_ge' || S.cond === 'storm_window') ? 'block' : 'none';
        $('tl-n-box').style.display = S.cond === 'storm_window' ? 'block' : 'none';
    }

    function refreshTexts() {
        document.querySelectorAll('#panel-timeline [data-tl]').forEach(function (el) { el.textContent = t(el.getAttribute('data-tl')); });
        const p = $('tl-prev'), n = $('tl-next'), s = $('tl-scrub');
        if (p) { p.title = t('prev'); p.setAttribute('aria-label', t('prev')); }
        if (n) { n.title = t('next'); n.setAttribute('aria-label', t('next')); }
        if (s) s.setAttribute('aria-label', t('seek'));
        if (S.pos >= 0 && S.keys.length && !S.playing) { $('timeline-display-year').innerText = labelOf(S.keys[S.pos], S.step); }
        drawChart();
    }

    function init() {
        if (!$('panel-timeline') || typeof applyAllFilters !== 'function') return;
        buildUi(); syncBoxes();
        if (typeof root.setLanguage === 'function' && !root.setLanguage._tlWrapped) {
            const orig = root.setLanguage;
            const wrapped = function () { const r = orig.apply(this, arguments); try { refreshTexts(); } catch (e) { } return r; };
            Object.keys(orig).forEach(function (k) { wrapped[k] = orig[k]; });
            wrapped._tlWrapped = true; root.setLanguage = wrapped;
        }
        refreshTexts();
        // staré funkce přesměrovat na nový přehrávač (kdyby je volal jiný kód)
        root.startTimelineAnimation = play; root.pauseTimelineAnimation = pause; root.stopTimelineAnimation = stop;
        // po otevření panelu dokreslit graf (dokud je panel skrytý, nemá plátno šířku)
        const nav = document.querySelector('[onclick*="panel-timeline"]');
        if (nav) nav.addEventListener('click', function () { setTimeout(function () { if (S.bins) buildBins(); else drawChart(); }, 400); });
    }

    root.TimelinePro = { state: S, play: play, pause: pause, stop: stop, seek: seek, stepBy: stepBy, build: build, markDirty: markDirty, _moonAge: moonAge, _dayNum: dayNum };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
