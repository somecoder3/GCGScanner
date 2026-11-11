# GCG Scanner (PWA)

Erkennt Gundam-Card-Game-Karten mit der Handykamera, sammelt sie in einer Liste und exportiert
sie im ExBurst-Importformat. Läuft komplett im Browser und nach dem ersten Laden auch offline.

Ablauf in der App: Startseite → *Einzelkarten scannen* → Karte in den Rahmen halten → grüner Rahmen → *Übernehmen*
(oder auf den Treffer tippen) → *Fertig* → Varianten prüfen, Mengen anpassen → *CSV teilen /
kopieren / speichern* → *ExBurst-Collection öffnen* (exburst.dev/gundam/collection/sets) und dort beim
Import einfügen.

Falsch erkannt? Das ✕ neben dem Treffer schließt die Karte aus, bis eine Karte übernommen wird.
Beim Booster-Öffnen oben rechts (▾) das Set wählen, dann vergleicht die App nur mit dessen Karten.
Unter *Einstellungen* lassen sich die Scanner-Zeiten anpassen (Anzeigedauer, Tippsperre, Glättung).

## Aufbau

| Pfad | Inhalt |
|---|---|
| `index.html`, `css/`, `js/app.js` | App: Scanner und Übersicht (`#liste`) |
| `js/embedder.js` | MobileNetV2-Merkmale über onnxruntime-web, WebGPU mit Rückfall auf wasm |
| `js/matcher.js` | Index laden (int8, wahlweise voll float32), Suche, Nachdrucke derselben Illustration finden |
| `js/detector.js`, `js/detector-worker.js`, `js/rectify.js` | Kartenränder finden und Karte entzerren (OpenCV.js im Worker) |
| `js/collection.js` | Liste der gescannten Karten (localStorage), CSV-Export |
| `js/imagepack.js`, `js/images.js` | Verschlüsselte Bildpakete: Passwort, Entschlüsseln, lokaler Bildspeicher |
| `sw.js` | Service Worker: Offline-Cache, entschlüsselte Bilder unter `images/card/`, Isolations-Header |
| `data/` | Index und Kartenliste, **committet** (nur lokal erzeugbar) |
| `images/` | Verschlüsselte Kartenbilder (ein Paket pro Set) und `index.json`, **committet** |
| `model/`, `vendor/` | Modell, ONNX-Runtime und OpenCV.js, **nicht** im Repo (Skripte unter `tools/`) |
| `dev/` | Index bauen, Bildpakete bauen, Erkennung messen (eine/mehrere Karten); nur mit dem Dev-Server, wird nicht veröffentlicht |

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
python tools/vendor/fetch_vendor.py
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

Dann den Dev-Server starten, **http://localhost:8000/dev/build-index.html** → *Start* (ca. 3 min, entfernt
dabei den „SAMPLE“-Schriftzug der offiziellen Bilder, siehe `dev/watermark.html`) und
`pwa/data/` committen. Kartenliste und Index werden immer zusammen gespeichert, damit sie zueinander
passen.

## Kartenbilder (verschlüsselte Pakete)

Die Bilder gehören Bandai und dürfen nicht öffentlich auf GitHub Pages liegen. ExBursts CDN blockiert
fremde Seiten (Hotlink-Schutz). Deshalb liegen sie nur **verschlüsselt** in `images/`: AES-GCM, der
Schlüssel kommt per PBKDF2 aus einem Passwort, das nirgends gespeichert ist. Ohne Passwort sind die
Pakete wertlos.

Pakete bauen (braucht die lokalen Kartenbilder aus `build_carddb.py --images`): Dev-Server starten,
**http://localhost:8000/dev/build-images.html** öffnen, Passwort zweimal eingeben → *Start* (ca. 3 min).
Dann `pwa/images/` committen. Bei späteren Läufen (neues Set) dasselbe Passwort nehmen: Unveränderte
Pakete bleiben byte-gleich, nur neue oder geänderte kommen dazu. Ein neues Passwort (Haken setzen)
verschlüsselt alles neu, danach muss es auf jedem Handy neu eingegeben werden.

In der App: *Fertig* → Passwort eingeben → *Freischalten*. Die App merkt sich den abgeleiteten Schlüssel
(nicht das Passwort) und lädt neue Pakete später selbst. *Einstellungen → Kartenbilder vom Handy
löschen* entfernt Bilder und Schlüssel.

## Auf GitHub Pages veröffentlichen

Einmalig im Repo auf GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Danach baut und veröffentlicht `.github/workflows/pages.yml` die App bei jedem Push auf `main`, der
`pwa/` betrifft. Den Lauf kann man unter *Actions → Deploy PWA* auch manuell starten. Die Adresse ist
`https://<benutzer>.github.io/GCGScanner/`. Am Handy in Chrome öffnen, dann *Menü → App installieren*.

Bei einem Update erscheint oben in der App „Neue Version – neu laden“.
