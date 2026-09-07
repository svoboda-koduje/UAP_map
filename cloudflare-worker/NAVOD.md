# Návod: nasazení vlastního proxy serveru (Cloudflare Worker)

Tento návod tě provede nasazením `worker.js` na Cloudflare - jde o pár kroků přes webové rozhraní, žádné programování ani příkazovou řádku nepotřebuješ. Celý proces zabere cca 10-15 minut.

Po dokončení mi pošli výslednou URL adresu tvého Workeru (tvar `https://uap-map-proxy.NĚCO.workers.dev`) - já podle ní dokončím úpravu `index.html` a pošlu ti finální soubor ke commitnutí, přesně jako u předchozích oprav.

## Než začneš - over si dvě věci ve `worker.js`

Otevři soubor `worker.js` (nemusíš nic umět v JS, jde jen o úpravu dvou řádků na začátku souboru) a zkontroluj:

1. **`ALLOWED_ORIGINS`** (řádek cca 40) - musí obsahovat doménu, ze které tvoje appka běží. Pokud používáš GitHub Pages na výchozí adrese, nech `https://svoboda-koduje.github.io`. Pokud máš appku jinde (vlastní doménu, jinou URL), doplň ji do pole. Řádek `'null'` tam nech - je potřeba, když appku testuješ lokálně otevřením souboru v prohlížeči.
2. **`NOMINATIM_CONTACT`** (řádek cca 47) - je tam odkaz na tvůj GitHub repozitář, což stačí. Pravidla používání Nominatim (geokódovací služby, kterou appka využívá) vyžadují, aby šlo poznat, čí je to appka - proto tam kontakt musí být.

## Krok 1: Založení účtu na Cloudflare

1. Jdi na **https://dash.cloudflare.com/sign-up**
2. Zaregistruj se (e-mail + heslo, nebo přes Google účet)
3. Potvrď e-mail, pokud si to Cloudflare vyžádá

Zůstaneš na **bezplatném (Free) tarifu** - pro tuhle appku bohatě stačí (100 000 požadavků/den zdarma). Placený tarif (Workers Paid, cca 120 Kč/měsíc) by přišel na řadu, jen kdyby appka měla řádově tisíce návštěvníků denně - to není potřeba řešit teď.

## Krok 2: Vytvoření Workeru

1. V levém menu klikni na **Workers & Pages**
2. Klikni na **Create** (nebo "Create application" → záložka "Workers")
3. Zvol **Create Worker**
4. Dej mu název, např. `uap-map-proxy` (uvidíš ho pak v URL adrese)
5. Klikni **Deploy** (nasadí se výchozí ukázkový kód - to je v pořádku, hned ho přepíšeme)

## Krok 3: Vložení vlastního kódu

1. Na stránce Workeru klikni na **Edit code** (nebo "Quick edit")
2. Smaž veškerý existující kód v editoru
3. Otevři přiložený soubor `worker.js`, zkopíruj celý jeho obsah a vlož ho do editoru
4. Klikni **Save and deploy** (nebo **Deploy**)

## Krok 4: Nastavení počítadla návštěv (KV úložiště)

Počítadlo návštěv potřebuje trvalé úložiště (Cloudflare Workers KV):

1. V levém menu jdi na **Workers & Pages → KV** (může být i pod "Storage & Databases")
2. Klikni **Create namespace**, pojmenuj ho např. `uap-counter` a vytvoř ho
3. Vrať se na svůj Worker → **Settings → Variables** (nebo "Bindings")
4. Najdi sekci **KV Namespace Bindings** a klikni **Add binding**
5. Jako **Variable name** napiš přesně `COUNTER_KV` (musí sedět přesně, appka na to volání odkazuje)
6. Jako **KV namespace** vyber ten, který jsi vytvořil v kroku 2 (`uap-counter`)
7. Ulož a znovu nasaď Worker, pokud si to vyžádá

## Krok 5: Vyzkoušení

Otevři v prohlížeči (nová karta) tuto adresu (uprav podle svého skutečného názvu Workeru):

```
https://uap-map-proxy.TVŮJ-ÚČET.workers.dev/health
```

Měl bys vidět něco jako:
```json
{"ok":true,"service":"uap-map-proxy","endpoints":["/geocode","/news","/counter"]}
```

Pak vyzkoušej ještě:
```
https://uap-map-proxy.TVŮJ-ÚČET.workers.dev/news
```
- měl bys vidět seznam aktuálních zpráv o UFO v JSON tvaru (`{"status":"ok","items":[...]}`).

```
https://uap-map-proxy.TVŮJ-ÚČET.workers.dev/counter
```
- měl bys vidět `{"count":1}` (a při každém dalším načtení číslo o jedna vyšší).

```
https://uap-map-proxy.TVŮJ-ÚČET.workers.dev/geocode?q=Prague&lang=cs
```
- měl bys vidět JSON s údaji o Praze.

Pokud všechny čtyři adresy vrací rozumná data (ne chybu), Worker je funkční.

## Krok 6: Pošli mi URL

Zkopíruj svou URL adresu (tu první část, bez `/health` na konci) - něco jako:

```
https://uap-map-proxy.tvuj-ucet.workers.dev
```

a pošli mi ji v chatu. Já ji vložím do `index.html` (nahradí se tím placeholder `WORKER_BASE_URL`), znovu vše otestuju a pošlu ti finální soubor ke commitnutí - stejně jako u předchozích čtyř oprav.

## Poznámka k nákladům

- **Workers Free**: 100 000 požadavků/den zdarma, navždy. Pro osobní/badatelský projekt by to mělo bohatě stačit.
- **Workers KV Free**: 100 000 čtení a 1 000 zápisů denně zdarma - počítadlo návštěv se do toho vejde s velkou rezervou.
- Pokud by appka jednou měla opravdu vysokou návštěvnost a narazila na limity zdarma tarifu, Cloudflare ti to jasně ukáže v přehledu a přechod na placený tarif (Workers Paid, 5 USD/měsíc = cca 120 Kč) je jedno kliknutí - žádné překvapivé účtování bez varování.
