# GCG Scanner (PWA)

Erkennt Gundam-Card-Game-Karten mit der Handykamera, sammelt sie in einer Liste und exportiert
sie im ExBurst-Importformat. Läuft komplett im Browser und nach dem ersten Laden auch offline.

Ablauf in der App: Kamera starten → Karte in den Rahmen halten → grüner Rahmen → *Übernehmen*
(oder auf den Treffer tippen) → *Fertig* → Varianten prüfen, Mengen anpassen → *CSV teilen /
kopieren / speichern* → in ExBurst unter Collection importieren.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `index.html`, `css/`, `js/app.js` | App: Scanner und Übersicht (`#liste`) |
| `js/embedder.js` | MobileNetV2-Merkmale über onnxruntime-web, WebGPU mit Rückfall auf wasm |
| `js/matcher.js` | Index laden (int8), Suche, Nachdrucke derselben Illustration finden |
| `js/collection.js` | Liste der gescannten Karten (localStorage), CSV-Export |
| `js/images.js` | Kartenbilder von `cdn.exburst.dev` (CORS erlaubt, alle 2205 vorhanden) |
| `sw.js` | Service Worker: Offline-Cache, Bilder dauerhaft, Isolations-Header |
| `data/` | Index und Kartenliste, **committet** (nur lokal erzeugbar) |
| `model/`, `vendor/` | Modell und ONNX-Runtime, **nicht** im Repo (Skripte unter `tools/`) |
| `dev/` | Index bauen, Erkennung messen; nur mit dem Dev-Server, wird nicht veröffentlicht |

## Lokal entwickeln

Einmalig (siehe auch `CLAUDE.md` im Repo-Root):

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

Dev-Server starten, App unter **http://localhost:8000/** öffnen:

```bash
python tools/devserver/serve.py
```

Am Handy im selben WLAN (die Kamera braucht HTTPS):

```bash
python tools/devserver/serve.py --https
```

Die angezeigte `https://<IP>:8443/` in Chrome öffnen und die Zertifikatswarnung bestätigen. Falls nichts
lädt: Python in der Windows-Firewall erlauben und Chrome die Android-Berechtigung *Geräte in der Nähe*
geben.

Im Dev-Modus (`VERSION = "dev"` in `sw.js`) lädt der Service Worker HTML, CSS und JS immer frisch.
Änderungen sind also nach einem Neuladen sichtbar.

## Index neu bauen (nach einem neuen Set)

```bash
python tools/carddb/build_carddb.py --details --images --refresh
```

Dann den Dev-Server starten, **http://localhost:8000/dev/build-index.html** → *Start* (ca. 6 min) und
`pwa/data/` committen. Kartenliste und Index werden immer zusammen gespeichert, damit sie zueinander
passen.

## Auf GitHub Pages veröffentlichen

Einmalig im Repo auf GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Danach baut und veröffentlicht `.github/workflows/pages.yml` die App bei jedem Push auf `main`, der
`pwa/` betrifft. Den Lauf kann man unter *Actions → Deploy PWA* auch manuell starten. Die Adresse ist
`https://<benutzer>.github.io/GCGScanner/`. Am Handy in Chrome öffnen, dann *Menü → App installieren*.

Bei einem Update erscheint oben in der App „Neue Version – neu laden“.
