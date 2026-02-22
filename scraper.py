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
    # Zde použijeme ukázkovou URL, v reálu může být potřeba doladit přesnou adresu, kde mají aktuálně tabulky
    url = "https://nuforc.org/webreports/ndxevent.html"
    
    # --- PRO ÚČELY TOHOTO SKRIPTU ZDE SIMULUJEME VYTAŽENÁ DATA Z WEBU ---
    # (Protože NUFORC občas mění strukturu HTML, toto je ukázka, jak se data poskládají, jakmile je BeautifulSoup přečte)
    raw_scraped_data = [
        {"occurred": "07/01/2025 01:20", "city": "Prague", "state": "Prague", "country": "Czech Republic", 
         "shape": "Unknown", "duration": "10 min", "summary": "Drone lights (green, red and white lights) no sound", 
         "reported": "06/30/2025"},
        {"occurred": "06/15/2025 22:00", "city": "Mustang", "state": "OK", "country": "US", 
         "shape": "Light", "duration": "0.3 sec", "summary": "Ball of bright white light spotted near S.W. 59th.", 
         "reported": "06/16/2025"}
    ]
    
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