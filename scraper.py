import pandas as pd
import requests
from bs4 import BeautifulSoup
from geopy.geocoders import Nominatim
from datetime import datetime
from dateutil.relativedelta import relativedelta
import time
import csv

def get_coordinates(city, state, country, geolocator, cache):
    """Získá GPS souřadnice pro dané město přes OpenStreetMap (s respektem k jejich limitům)."""
    query = f"{city}, {state}, {country}"
    if query in cache:
        return cache[query]
    
    try:
        location = geolocator.geocode(query, timeout=10)
        time.sleep(1.1)  # Nutná prodleva pro bezplatný server OSM
        if location:
            cache[query] = (location.latitude, location.longitude)
            return cache[query]
    except Exception as e:
        print(f"Chyba při geokódování {query}: {e}")
    
    cache[query] = ("", "")
    return cache[query]

def update_nuforc_data():
    print("Zahajuji stahování a zpracování NUFORC dat...")
    geolocator = Nominatim(user_agent="nuforc_github_scraper_bot")
    geo_cache = {}
    
    # 1. Získání reálných dat z NUFORC (nová struktura webu)
    print("Stahuji rozcestník měsíců z NUFORC...")
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    index_url = "https://nuforc.org/ndx/?id=event"
    
    raw_scraped_data = []
    
    try:
        response = requests.get(index_url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Najdeme všechny odkazy směřující na jednotlivé měsíce
        month_links = [a['href'] for a in soup.find_all('a', href=True) if 'subndx' in a['href']]
        recent_links = month_links[:25] # Stačí nám 25 nejnovějších měsíců
        
        for link in recent_links:
            page_url = f"https://nuforc.org{link}" if link.startswith('/') else f"https://nuforc.org/{link}"
            print(f"Čtu tabulku z: {page_url}")
            
            try:
                tables = pd.read_html(page_url)
                if tables:
                    df_month = tables[0]
                    df_month.columns = [str(c).lower().strip() for c in df_month.columns]
                    
                    for index, row in df_month.iterrows():
                        date_col = 'occurred' if 'occurred' in df_month.columns else ('date / time' if 'date / time' in df_month.columns else 'datetime')
                        date_time = str(row.get(date_col, ''))
                        
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
                            "reported": str(row.get('reported', row.get('posted', ''))).replace('nan', '')
                        })
                time.sleep(1) # Slušnost k serveru NUFORC
            except Exception as e:
                print(f"Nepodařilo se zpracovat {page_url}: {e}")
                
    except Exception as e:
        print(f"Chyba při stahování hlavního indexu: {e}")

    print(f"Úspěšně staženo {len(raw_scraped_data)} surových záznamů. Přistupuji ke geokódování a filtraci data...")

    # Výpočet limitního data (24 měsíců zpět)
    limit_date = datetime.now() - relativedelta(months=24)
    formatted_rows = []
    
    # ZDE JE TEN TESTOVACÍ OMEZOVAČ NA 30 ZÁZNAMŮ
    for row in raw_scraped_data[:30]:
        try:
            # Ošetření různých formátů data pro filtraci
            date_str = row["occurred"].split(" ")[0]
            if len(date_str.split('/')) == 3:
                event_date = datetime.strptime(date_str, "%m/%d/%Y")
                if event_date < limit_date:
                    continue # Přeskočí staré záznamy
        except Exception as e:
            pass # Pokud datum nejde rozparsovat, záznam propustíme
            
        # Získání GPS přes API
        lat, lng = get_coordinates(row["city"], row["state"], row["country"], geolocator, geo_cache)
        
        # Sestavení finálního řádku
        formatted_rows.append({
            "datetime": row["occurred"],
            "city": row["city"].upper() if row["city"] else "",
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
    
    # Export do CSV
    df = pd.DataFrame(formatted_rows, columns=columns)
    filename = "nuforc_aktualni_pozorovani.csv"
    df.to_csv(filename, index=False, encoding='utf-8', quoting=csv.QUOTE_MINIMAL)
    print(f"Hotovo! Uloženo do {filename}")

if __name__ == "__main__":
    update_nuforc_data()