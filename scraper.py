import requests
from bs4 import BeautifulSoup
from geopy.geocoders import Nominatim
from datetime import datetime
from dateutil.relativedelta import relativedelta
import time
import csv
import pandas as pd

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
    except Exception:
        pass
    cache[query] = ("", "")
    return cache[query]

def update_nuforc_data():
    print("Zahajuji stahování a zpracování NUFORC dat přes BeautifulSoup...")
    geolocator = Nominatim(user_agent="nuforc_github_scraper_bot")
    geo_cache = {}
    
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'}
    index_url = "https://nuforc.org/ndx/?id=event"
    
    raw_scraped_data = []
    
    try:
        print(f"Připojuji se na hlavní rozcestník: {index_url}")
        response = requests.get(index_url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        month_links = [a['href'] for a in soup.find_all('a', href=True) if 'subndx' in a['href']]
        recent_links = month_links[:25] # Stačí posledních 25 měsíců
        
        for link in recent_links:
            page_url = f"https://nuforc.org{link}" if link.startswith('/') else f"https://nuforc.org/{link}"
            print(f"Čtu tabulku z: {page_url}")
            
            try:
                page_response = requests.get(page_url, headers=headers, timeout=15)
                page_soup = BeautifulSoup(page_response.text, 'html.parser')
                
                # Zacílíme přímo na tu skrytou tabulku, kterou jsme odhalili v diagnostice
                table = page_soup.find('table', id='table_1') or page_soup.find('table')
                
                if table and table.find('tbody'):
                    rows = table.find('tbody').find_all('tr')
                    for row in rows:
                        cols = row.find_all('td')
                        # Tabulka má 10 sloupců, my chceme indexy 1 až 7
                        if len(cols) >= 8:
                            raw_scraped_data.append({
                                "occurred": cols[1].text.strip(),
                                "city": cols[2].text.strip(),
                                "state": cols[3].text.strip(),
                                "country": cols[4].text.strip(),
                                "shape": cols[5].text.strip(),
                                "summary": cols[6].text.strip(),
                                "reported": cols[7].text.strip()
                            })
                    print(f"Úspěšně zpracováno, prozatímní počet hlášení: {len(raw_scraped_data)}")
                else:
                    print(f"Na stránce {page_url} nebyla tabulka nalezena.")
                
                time.sleep(1) 
            except Exception as e:
                print(f"Chyba při zpracování tabulky {page_url}: {e}")
                
    except Exception as e:
        print(f"Kritická chyba při stahování hlavního indexu: {e}")

    print(f"CELKEM staženo {len(raw_scraped_data)} surových záznamů z webu.")

    if len(raw_scraped_data) == 0:
        raise Exception("Nebyly staženy žádné záznamy.")

    limit_date = datetime.now() - relativedelta(months=24)
    formatted_rows = []
    
    print("Přistupuji ke geokódování a formátování (TESTOVACÍ VZOREK 30 ZÁZNAMŮ)...")
    
    # TESTOVACÍ OMEZOVAČ - POKUD VŠE ZAFUNGUJE, SMAŽ TOTO [:30] A NECH TAM JEN: for row in raw_scraped_data:
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
            "duration (seconds)": "", # V novém rozhraní se délka trvání bohužel nezobrazuje
            "duration (hours/min)": "", 
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
    print(f"Hotovo! Uloženo do {filename}. Skutečný počet uložených řádků: {len(df)}")

if __name__ == "__main__":
    update_nuforc_data()
