# Analytická vrstva „Geomagnetická aktivita (Kp index)“ – návod

## Co přibylo

| Soubor | K čemu je |
|---|---|
| `kp_layer.js` | Celá nová vrstva: panel v menu, obarvení a filtr bodů podle Kp, řádek s Kp v bublině bodu, statistická analýza s grafy, export výsledků. |
| `kp_update.py` | Stáhne Kp index z GFZ Potsdam a vytvoří kompaktní `kp_data.json` (cca 280 kB). Používá jen standardní Python, nic se neinstaluje. |
| `.github/workflows/aktualizace_kp.yml` | GitHub Actions: spouští `kp_update.py` každý den v 05:40 UTC, při ručním spuštění a také hned po prvním nahrání těchto souborů. |
| `kp_data.json` | **Vznikne sám na GitHubu** (vytvoří ho workflow). V balíčku záměrně není. |
| `index.html` | Doplněno napojení na vrstvu + opravy chyb nalezených při kontrole (viz komentáře `OPRAVA:` v kódu). |

Proč data nestahuje přímo prohlížeč: server `kp.gfz.de` neposílá hlavičku CORS, takže prohlížeč návštěvníka odpověď odmítne (ověřeno). Proto je data potřeba mít v repozitáři – stejný princip jako u týdenní aktualizace NUFORC.

## Nasazení (jednou)

0. Soubor `aktualizace_kp.yml` (leží v kořeni projektu) **přesuň ručně do složky `.github\workflows\`** – vedle `aktualizace_dat.yml`. Claude do této chráněné složky zapisovat nesmí, proto ho uložil o úroveň výš. Bez tohoto kroku se data Kp nezačnou stahovat.
1. V GitHub Desktop udělej commit všech nových a změněných souborů a **Push**.
2. Na GitHubu v záložce **Actions** se sám spustí workflow „Automatická aktualizace Kp indexu (GFZ Potsdam)“. Do minuty přidá do repozitáře `kp_data.json`. (Kdyby se nespustil: Actions → tento workflow → *Run workflow*.)
3. V GitHub Desktop pak dej **Fetch origin / Pull**, ať máš `kp_data.json` i u sebe – jinak by další Push hlásil konflikt (stejně jako po nedělní aktualizaci NUFORC).
4. Po přebudování GitHub Pages (1–2 minuty) otevři mapu a v menu zvol **🧲 Geomagnetická aktivita (Kp index)**. Pokud prohlížeč drží starou verzi, pomůže Ctrl+F5.

Dokud `kp_data.json` v repozitáři není, panel to srozumitelně oznámí a zbytek mapy funguje beze změny.

## Jak vrstvu používat

- **Nejdřív filtruj, potom analyzuj.** Analýza pracuje vždy s tím, co je právě vyfiltrované na mapě (roky, tvar, kategorie A/B/C, stát, fulltext, pohoří…). Volba „Jen body v aktuálním výřezu mapy“ ji omezí na viditelnou oblast.
- **Použitá hodnota Kp:** „Denní maximum“ (výchozí, robustní, použije i záznamy bez času) nebo „Kp ve 3h okně“ (přesnější, ale jen pro záznamy s časem a s nejistotou převodu místního času na UT).
- **Obarvit body podle Kp / Filtr podle Kp:** rychlé vizuální prozkoumání – např. jen pozorování při bouři Kp ≥ 7.
- **Spustit analýzu:** otevře okno s výsledkem – podíl pozorování při bouři proti očekávání, poměr pozorováno/očekáváno s 95% rozmezím náhody, p‑hodnota permutačního testu, graf rozdělení podle Kp, graf dnů kolem nástupu bouří a tabulka. Tlačítko „Stáhnout výsledky (.csv)“ uloží čísla pro další zpracování.
- **Export CSV** v panelu „Analýza pro státy“ nově obsahuje sloupce `kp_ut_date`, `kp_3h`, `kp_day_max`, `ap_day`.

## Metodika stručně

- Očekávání (baseline) se počítá zvlášť pro každý kalendářní měsíc (u 3h metriky i pro každé UT okno dne), takže výsledek není zkreslen růstem počtu hlášení v čase, slunečním cyklem, sezónností ani denním chodem.
- Významnost: permutační test s kruhovým posunem řady Kp uvnitř měsíce (5000×). Zachovává vícedenní setrvačnost bouří i vícedenní vlny hlášení. Test byl ověřen na simulacích – bez skutečného efektu vychází „významně“ (p < 0,05) jen v jednotkách procent případů, jak má, a uměle vložený efekt spolehlivě najde.
- Kp je **planetární** index, ne měření v místě pozorování. Silné bouře navíc přinášejí polární záři viditelnou i ve středních šířkách – kladná souvislost proto sama o sobě nic neobvyklého nedokazuje.

## Zdroj a citace dat

Matzka, J., Stolle, C., Yamazaki, Y., Bronkalla, O., Morschhauser, A. (2021): The geomagnetic Kp index and derived indices of geomagnetic activity. *Space Weather*, https://doi.org/10.1029/2020SW002641. Data: GFZ Potsdam, https://doi.org/10.5880/Kp.0001, licence CC BY 4.0. Sluneční čísla ze zdrojového souboru (licence CC BY‑NC) se nepřebírají.
