import pandas as pd
import requests
from bs4 import BeautifulSoup
from geopy.geocoders import Nominatim
from datetime import datetime
from dateutil.relativedelta import relativedelta
import time
import csv

def get_coordinates(city, state, country, geolocator, cache):
    """Pomocná funkce pro získání souřadnic s využitím jednoduché paměti (cache), abychom nehledali stejné město víckrát."""
    query = f"{city}, {state}, {country}"
    if query in cache:
        return cache[query]
    
    try:
        # Služba OpenStreetMap vyžaduje identifikaci pomocí user_agent
        location = geolocator.geocode(query, timeout=10)
        time.sleep(1.1)  # Nutné zpomalení kvůli limitům bezplatného serveru (max 1 dotaz za sekundu)
        if location:
            cache[query] = (location.latitude, location.longitude)
            return cache[query]
    except Exception as e:
        print(f"Chyba při geokódování {query}: {e}")
    
    cache[query] = ("", "")
    return cache[query]

def update_nuforc_data():
    print("Zahajuji stahování a zpracování NUFORC dat...")
    
    # Nastavení geolokátoru
    geolocator = Nominatim(user_agent="nuforc_github_scraper_bot")
    geo_cache = {}
    
    # 1. Získání dat z textové databáze NUFORC (Index By Event Date)
    # 1. Získání reálných dat z NUFORC (Index By Event Date)
    print("Stahuji rozcestník měsíců z NUFORC...")
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    index_url = "https://nuforc.org/webreports/ndxevent.html"
    
    raw_scraped_data = []
    
    try:
        response = requests.get(index_url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Najdeme všechny odkazy směřující na jednotlivé měsíce
        month_links = [a['href'] for a in soup.find_all('a', href=True) if 'ndxe' in a['href']]
        
        # Omezíme se pouze na posledních 25 měsíců (pro pokrytí tvého požadavku 24 měsíců)
        recent_links = month_links[:25]
        
        for link in recent_links:
            page_url = link if link.startswith('http') else f"https://nuforc.org/webreports/{link}"
            print(f"Čtu tabulku z: {page_url}")
            
            try:
                # Modul pandas přečte veškeré HTML tabulky na dané stránce
                tables = pd.read_html(page_url)
                if tables:
                    df_month = tables[0]
                    # Sjednocení názvů sloupců na malá písmena
                    df_month.columns = [str(c).lower().strip() for c in df_month.columns]
                    
                    # Projdeme tabulku a převedeme ji do našeho formátu
                    for index, row in df_month.iterrows():
                        date_time = str(row.get('date / time', row.get('datetime', '')))
                        if not date_time or date_time == 'nan':
                            continue
                            
                        raw_scraped_data.append({
                            "occurred": date_time,
                            "city": str(row.get('city', '')).replace('nan', ''),
                            "state": str(row.get('state', '')).replace('nan', ''),
                            "country": str(row.get('country', '')).replace('nan', ''),
                            "shape": str(row.get('shape', '')).replace('nan', ''),
                            "duration": str(row.get('duration', '')).replace('nan', ''),
                            "summary": str(row.get('summary', '')).replace('nan', ''),
                            "reported": str(row.get('posted', row.get('reported', ''))).replace('nan', '')
                        })
                # Slušnost k serveru - vteřina pauza mezi stahováním měsíců
                time.sleep(1) 
            except Exception as e:
                print(f"Nepodařilo se zpracovat {page_url}: {e}")
                
    except Exception as e:
        print(f"Chyba při stahování hlavního indexu: {e}")

    print(f"Úspěšně staženo {len(raw_scraped_data)} surových záznamů. Přistupuji ke geokódování a filtraci data...")
    
    # Výpočet data před 24 měsíci pro filtraci
    limit_date = datetime.now() - relativedelta(months=24)
    
    formatted_rows = []
    
    for row in raw_scraped_data:
        try:
            # Převedeme datum na formát datetime pro porovnání stáří
            event_date = datetime.strptime(row["occurred"].split(" ")[0], "%m/%d/%Y")
            if event_date < limit_date:
                continue # Přeskočíme události starší než 24 měsíců
        except ValueError:
            pass # Pokud formát data nesedí, zpracujeme dál
            
        # Získání souřadnic přes OpenStreetMap
        lat, lng = get_coordinates(row["city"], row["state"], row["country"], geolocator, geo_cache)
        
        # Sestavení řádku přesně podle tvé definice
        formatted_rows.append({
            "datetime": row["occurred"],
            "city": row["city"].upper(), # Příklad formátování: města velkým písmem jako v tvém příkladu
            "state": row["state"],
            "country": row["country"],
            "shape": row["shape"],
            "duration (seconds)": row.get("duration", "") if "sec" in row.get("duration", "") else "",
            "duration (hours/min)": row.get("duration", "") if "min" in row.get("duration", "") or "hour" in row.get("duration", "") else "",
            "comments": row["summary"],
            "date posted": row["reported"],
            "latitude": lat,
            "longitude": lng,
            "archive_id": ""
        })
        print(f"Zpracováno: {row['city']} -> Lat: {lat}, Lng: {lng}")

    columns = [
        "datetime", "city", "state", "country", "shape", 
        "duration (seconds)", "duration (hours/min)", 
        "comments", "date posted", "latitude", "longitude", "archive_id"
    ]
    
    # Vytvoření a uložení CSV
    df = pd.DataFrame(formatted_rows, columns=columns)
    filename = "nuforc_aktualni_pozorovani.csv"
    df.to_csv(filename, index=False, encoding='utf-8', quoting=csv.QUOTE_MINIMAL)
    print(f"Hotovo! Uloženo do {filename}")

if __name__ == "__main__":
    update_nuforc_data()