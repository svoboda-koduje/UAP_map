import requests

url = "https://nuforc.org/subndx/?id=e202402"
headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'}

try:
    print(f"Stahuji diagnostická data z: {url}")
    response = requests.get(url, headers=headers, timeout=15)
    
    print("--- ZAČÁTEK VÝPISU STRÁNKY ---")
    html = response.text
    
    # Zkusíme najít tabulku, případně cokoliv, co vypadá jako datový blok
    if "<table" in html.lower():
        print("Bingo! Byla nalezena značka tabulky. Zde je její začátek:")
        idx = html.lower().find("<table")
        print(html[idx : idx+2000])
    elif "json" in html.lower() or "data=" in html.lower():
        print("Tabulka nenalezena klasicky, ale vidím skrytá data:")
        print(html[len(html)//2 : len(html)//2 + 2000])
    else:
        print("Tabulka nenalezena. Vypisuji ukázku surového HTML:")
        print(html[1000:3000])
        
    print("--- KONEC VÝPISU STRÁNKY ---")
    
except Exception as e:
    print(f"Chyba diagnostiky: {e}")

# Záměrně proces shodíme, abychom měli k dispozici chybový výpis v Actions
raise Exception("Toto je plánované zastavení diagnostiky. Kód je v pořádku.")
