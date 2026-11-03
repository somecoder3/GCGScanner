# PWA-Machbarkeitstest

Prüft, ob sich Gundam-Karten im Browser per **Bildvergleich** zuverlässig und schnell
genug erkennen lassen: Kamerabild → Ausschnitt im Kartenrahmen → MobileNetV2-Merkmale
→ ähnlichste der 2205 Referenzvarianten (inkl. Alt Arts).

Kein Node/Build-Schritt: statische Seiten mit JavaScript-Modulen, ein kleiner Python-Server.

## Einmalig einrichten (PC)

```bash
python tools/carddb/build_carddb.py --details --images
```

```bash
python -m venv build/venv
```

```bash
build/venv/Scripts/python -m pip install -r tools/model/requirements.txt
```

```bash
build/venv/Scripts/python tools/model/prepare_model.py
```

```bash
python tools/vendor/fetch_ort.py
```

Dann den Server starten und **http://localhost:8000/build-index.html** öffnen → *Start*.
Das berechnet `data/embeddings.bin` (ca. 6 min).

```bash
python pwa-spike/serve.py
```

## Seiten

| Seite | Zweck |
|---|---|
| `index.html` | Scanner: Kamera, Kartenrahmen, Top-3-Treffer, Liste, CSV-Export im ExBurst-Format |
| `build-index.html` | Referenz-Index aus den lokalen Kartenbildern berechnen (nur PC) |
| `eval.html` | Trefferquote mit simulierten Kamerabildern messen (nur PC) |

Standard ist WebGPU (am Handy gut 2× schneller); ohne nutzbare GPU fällt die Seite automatisch auf
WebAssembly zurück. `?backend=wasm` an die URL hängen, um WebAssembly zu erzwingen.

## Am Handy testen

Die Kamera braucht HTTPS (außer auf `localhost`). Handy und PC müssen im selben WLAN sein.

```bash
python pwa-spike/serve.py --https
```

1. Der Server zeigt `https://<IP>:8443/` an. Diese Adresse in Chrome auf dem Handy öffnen.
2. Die Zertifikatswarnung bestätigen (*Erweitert → Weiter*), das Zertifikat ist selbst erstellt.
3. Falls die Seite nicht lädt: Die Windows-Firewall muss Python im privaten Netzwerk erlauben.
   In Chrome muss außerdem die Android-Berechtigung *Geräte in der Nähe* erteilt sein, sonst
   erreicht Chrome keine Adressen im Heimnetz (Einstellungen → Apps → Chrome → Berechtigungen).
4. *Kamera starten*, eine Karte formatfüllend in den Rahmen halten. Grüner Rahmen = stabiler Treffer.
