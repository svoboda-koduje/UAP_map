import pandas as pd
import requests
from bs4 import BeautifulSoup
from geopy.geocoders import Nominatim
from datetime import datetime
from dateutil.relativedelta import relativedelta
import time
import csv
import io

def get_coordinates(city, state, country, geolocator, cache):
    query = f"{city}, {state}, {country}"
    if query in cache:
        return cache[query]
    try:
        location = geolocator.geocode(query, timeout=10)
        time.sleep(1.1)
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
    
    # Skrýváme se za standardní prohlížeč Chrome, aby nás server nezablokoval
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
    index_url = "https://nuforc.org/ndx/?id=event"
    
    raw_scraped_data = []
    
    try:
        print(f"Připojuji se na hlavní rozcestník: {index_url}")
        response = requests.get(index_url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        month_links = [a['href'] for a in soup.find_all('a', href=True) if 'subndx' in a['href']]
        print(f"Nalezeno {len(month_links)} odkazů na měsíce.")
        
        recent_links = month_links[:25]
        
        for link in recent_links:
            page_url = f"https://nuforc.org{link}" if link.startswith('/') else (link if link.startswith('http') else f"https://nuforc.org/{link}")
            print(f"Čtu tabulku z: {page_url}")
            
            try:
                # Obejít blokování od serverů - stáhneme ručně přes requests, až pak čte pandas
                page_response = requests.get(page_url, headers=headers, timeout=15)
                tables = pd.read_html(io.StringIO(page_response.text))
                
                if tables:
                    df_month = tables[0]
                    df_month.columns = [str(c).lower().strip() for c in df_month.columns]
                    
                    for index, row in df_month.iterrows():
                        # Inteligentní detekce sloupce s datem (kdyby náhodou NUFORC měnil názvy)
                        date_col = next((col for col in df_month.columns if 'occurred' in col or 'date / time' in col or 'datetime' in col), None)
                        
                        if not date_col:
                            continue
                            
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
                    print(f"Úspěšně zpracováno, prozatímní počet hlášení: {len(raw_scraped_data)}")
                else:
                    print(f"Na stránce {page_url} nebyla nalezena žádná tabulka.")
                
                time.sleep(1) 
            except Exception as e:
                print(f"Chyba při zpracování tabulky {page_url}: {e}")
                
    except Exception as e:
        print(f"Kritická chyba při stahování hlavního indexu: {e}")

    print(f"CELKEM staženo {len(raw_scraped_data)} surových záznamů z webu.")

    # Ochrana proti tvorbě prázdných souborů
    if len(raw_scraped_data) == 0:
        print("POZOR: Nepodařilo se stáhnout žádná data. Skript nemůže pokračovat a bude ukončen.")
        raise Exception("Nebyly staženy žádné záznamy.")

    limit_date = datetime.now() - relativedelta(months=24)
    formatted_rows = []
    
    print("Přistupuji ke geokódování a formátování (TESTOVACÍ VZOREK 30 ZÁZNAMŮ)...")
    for row in raw_scraped_data[:30]:
        try:
            date_str = row["occurred"].split(" ")[0]
            if len(date_str.split('/')) == 3:
                event_date = datetime.strptime(date_str, "%m/%d/%Y")
                if event_date < limit_date:
                    continue
        except Exception:
            pass
            
        lat, lng = get_coordinates(row["city"], row["state"], row["country"], geolocator, geo_cache)
        
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

    columns = [
        "datetime", "city", "state", "country", "shape", 
        "duration (seconds)", "duration (hours/min)", 
        "comments", "date posted", "latitude", "longitude", "archive_id"
    ]
    
    df = pd.DataFrame(formatted_rows, columns=columns)
    filename = "nuforc_aktualni_pozorovani.csv"
    df.to_csv(filename, index=False, encoding='utf-8', quoting=csv.QUOTE_MINIMAL)
    print(f"Hotovo! Uloženo do {filename}. Počet skutečně uložených řádků: {len(df)}")

if __name__ == "__main__":
    update_nuforc_data()
