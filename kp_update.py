#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kp_update.py - stáhne geomagnetický Kp index z GFZ Potsdam a uloží ho
do kompaktního souboru kp_data.json, který čte analytická vrstva mapy
(kp_layer.js).

PROČ TENTO SKRIPT EXISTUJE
  Server kp.gfz.de neposílá hlavičku Access-Control-Allow-Origin, takže
  prohlížeč návštěvníka si z něj data přímo stáhnout NEMŮŽE (CORS).
  Data proto jednou denně stáhne GitHub Actions (viz
  .github/workflows/aktualizace_kp.yml) a uloží je přímo do repozitáře.

ZDROJ DAT A LICENCE
  Matzka, J., Stolle, C., Yamazaki, Y., Bronkalla, O. and Morschhauser, A.,
  2021. The geomagnetic Kp index and derived indices of geomagnetic
  activity. Space Weather, https://doi.org/10.1029/2020SW002641
  Data: https://doi.org/10.5880/Kp.0001  (licence CC BY 4.0)
  Sluneční čísla (SN) ze zdrojového souboru se NEPŘEBÍRAJÍ (mají licenci
  CC BY-NC 4.0), přebírá se pouze Kp.

FORMÁT VÝSTUPU (kp_data.json)
  "kp" je jeden dlouhý řetězec: 8 znaků na každý den (osm tříhodinových
  oken UT 00-03, 03-06, ... 21-24), dny jdou po sobě od data "start".
  Každý znak kóduje hodnotu Kp ve třetinách: index = round(Kp * 3),
  tedy 0..27 (Kp 0o .. 9o), znak = ALPHABET[index]. Chybějící hodnota = "-".

Skript používá jen standardní knihovnu Pythonu (nic se neinstaluje).
Použití:   python kp_update.py            (stáhne z GFZ)
           python kp_update.py soubor.txt (načte lokální kopii - pro testy)
"""

import json
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone

SOURCE_URLS = [
    "https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt",
    "https://kp.gfz.de/fileadmin/files_for_gfz_cms/Kp_ap_Ap_SN_F107_since_1932.txt",
]
OUTPUT_FILE = "kp_data.json"
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQR"  # 28 znaků = Kp 0o .. 9o ve třetinách
MISSING = "-"
START = date(1932, 1, 1)
MIN_EXPECTED_DAYS = 34000  # pojistka: soubor od roku 1932 musí mít přes 34 000 dní


def download_text():
    last_error = None
    for url in SOURCE_URLS:
        try:
            print(f"Stahuji: {url}")
            req = urllib.request.Request(url, headers={"User-Agent": "UAP_map-kp-updater (GitHub Actions)"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as exc:  # zkusíme další adresu
            print(f"  nepodařilo se: {exc}")
            last_error = exc
    raise RuntimeError(f"Data Kp se nepodařilo stáhnout z žádné adresy: {last_error}")


def parse(text):
    """Vrátí (řetězec kp, počet dní, poslední definitivní den, poslední den)."""
    days = {}          # index dne od 1.1.1932 -> 8 znaků
    last_definitive = None
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        p = line.split()
        if len(p) < 15:
            continue
        try:
            d = date(int(p[0]), int(p[1]), int(p[2]))
        except ValueError:
            continue
        idx = (d - START).days
        if idx < 0:
            continue
        chars = []
        for v in p[7:15]:
            try:
                kp = float(v)
            except ValueError:
                kp = -1.0
            if kp < 0:
                chars.append(MISSING)
            else:
                k3 = int(round(kp * 3))
                if not 0 <= k3 <= 27:
                    raise ValueError(f"Neplatná hodnota Kp {v} dne {d}")
                chars.append(ALPHABET[k3])
        days[idx] = "".join(chars)
        # poslední sloupec D: 0 = předběžné, 1/2 = Kp definitivní
        if p[-1] in ("1", "2") and MISSING not in chars:
            last_definitive = d

    if not days:
        raise RuntimeError("Ve zdrojovém souboru nebyl nalezen žádný datový řádek.")

    n_days = max(days) + 1
    # oříznout případné prázdné dny na konci, mezery uprostřed vyplnit "chybí"
    while n_days > 0 and days.get(n_days - 1, MISSING * 8) == MISSING * 8:
        n_days -= 1
    kp_string = "".join(days.get(i, MISSING * 8) for i in range(n_days))
    return kp_string, n_days, last_definitive, START + timedelta(days=n_days - 1)


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            text = fh.read()
    else:
        text = download_text()

    kp_string, n_days, last_definitive, last_day = parse(text)

    if n_days < MIN_EXPECTED_DAYS and len(sys.argv) <= 1:
        raise RuntimeError(f"Podezřele málo dní ({n_days}) - soubor raději nepřepisuji.")
    if len(kp_string) != n_days * 8:
        raise RuntimeError("Vnitřní chyba: délka řetězce neodpovídá počtu dní.")

    out = {
        "format": "uap-map-kp-v1",
        "source": "GFZ Helmholtz Centre for Geosciences, Geomagnetic Observatory Niemegk - https://kp.gfz.de",
        "citation": "Matzka, J., Stolle, C., Yamazaki, Y., Bronkalla, O. and Morschhauser, A., 2021. "
                    "The geomagnetic Kp index and derived indices of geomagnetic activity. "
                    "Space Weather, https://doi.org/10.1029/2020SW002641",
        "data_doi": "https://doi.org/10.5880/Kp.0001",
        "license": "CC BY 4.0",
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "start": START.isoformat(),
        "days": n_days,
        "last_day": last_day.isoformat(),
        "last_definitive_day": last_definitive.isoformat() if last_definitive else None,
        "alphabet": ALPHABET,
        "missing": MISSING,
        "kp": kp_string,
    }
    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    missing = kp_string.count(MISSING)
    print(f"Hotovo: {OUTPUT_FILE}, dní: {n_days} ({START} až {last_day}), "
          f"chybějících hodnot: {missing}, definitivní do: {last_definitive}")


if __name__ == "__main__":
    main()
