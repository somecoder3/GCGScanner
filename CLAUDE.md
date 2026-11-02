# GCGScanner

Privates Projekt (für den Nutzer und seinen Sohn): Handy-App, die bei laufender Kamera
**Gundam Card Game**-Karten erkennt und daraus eine Importliste für **ExBurst**
(exburst.dev) erstellt. Kommunikation auf Deutsch. Plattform: Android-Handy.
Der Nutzer kommt aus der Webentwicklung.

## Ziele (aus der ursprünglichen Anfrage)

1. Mehrere Karten bei laufender Kamera erkennen, Scan beenden → Übersicht → ExBurst-Liste.
2. Alt Arts in ExBurst-Notation (`GD06-002-ALT1`).
3. Übersicht mit Bildern der offiziellen GCG-Seite.
4. Preise von CardTrader und/oder Cardmarket anzeigen.
5. Später: Login bei ExBurst, Binder/Collection wählen, direkt importieren.

## Stand (2. Nov. 2026)

- **Kartendatenbank fertig**: `data/cards.db` (committet), erzeugt von `tools/carddb/build_carddb.py`.
  1290 Karten, 2205 Druckvarianten. Details: `tools/carddb/README.md`.
- **PWA-Machbarkeitstest fertig** in `pwa-spike/` (siehe `pwa-spike/README.md`), aber
  **noch nicht am echten Handy getestet**. Das ist der nächste Schritt (zu Hause, gleiches WLAN).
- **Plattform-Entscheidung offen**: PWA (vom Nutzer bevorzugt, Web-Hintergrund) vs. native
  Kotlin-App. Hängt vom Handy-Test ab (Bilder/s und Trefferquote). Native wurde vorgeschlagen,
  ist aber nicht angefangen; auf dem Arbeitsrechner fehlten Android Studio, Java und Node.

## Fakten, die schon geprüft sind

- Offizielle Kartenliste: `https://www.gundam-gcg.com/en/cards/index.php?package=<id>` liefert alle
  Karten eines Produkts in einer HTML-Seite (die Pagination läuft nur im Client). Paket-IDs stehen als
  `data-val="6xxxxx"` im Filter. Detailseite: `detail.php?detailSearch=<official_id>`.
  Bild: `https://www.gundam-gcg.com/en/images/cards/card/<official_id>.webp` (600×837, Alpha-Ecken).
- **Alt-Art-Notation**: offiziell `_pN`, bei ExBurst `-ALTN`, 1:1 (Stichproben auf exburst.dev:
  `GD`, `ST`, `EB`, `T-`, `R-`, `RP-`, `EXB-`, `EXR-`, bis `ALT8`). ExBurst verwendet sogar dieselben
  Bilddateinamen (`cdn.exburst.dev/cards/gundam-en/GD06-002_p1.webp`). ExBurst-Kartenseite:
  `https://exburst.dev/gundam/cards/<exburst_id>`.
- **ExBurst-Importformat** (vom Nutzer):
  ```
  Card No,Owned,Wanted,Trading,Tags
  GD05-123-ALT1,1,0,0,
  GD06-004,2,0,0,
  ```
- Nummernformate: `GD01-001`, `ST01-001`, `EB01-001`, `T-001` (Token), `R-001`/`RP-001` (Ressource),
  `EXB-001`/`EXBP-001`, `EXR-001`/`EXRP-001`, jeweils optional `_pN`.

## Erkenntnisse aus dem Machbarkeitstest

Ansatz: Bildvergleich statt Texterkennung. MobileNetV2 (ONNX Model Zoo, ohne Klassifikator →
1280-dim-Vektor) im Browser über onnxruntime-web 1.30.0 (WASM, 4 Threads). Kosinus-Ähnlichkeit
gegen alle 2205 Referenzvektoren, Kartenausschnitt über einen festen Rahmen in der Bildmitte.

Simulierte Kamerabilder (`pwa-spike/eval.html`, je 300 Stück, am PC):

| Stufe | Kartennummer | Variante | Variante oder optisch gleich | Top-5 |
|---|---|---|---|---|
| sauber | 100 % | 100 % | 100 % | 100 % |
| normal | 100 % | 95,7 % | 98,3 % | 100 % |
| schwer | 86,7 % | 80,7 % | 82,7 % | 95 % |

~21 ms pro Bild am PC; Handy noch unbekannt (Schätzung: 3–5× langsamer).

- **Viele ALT-Nummern sind Nachdrucke derselben Illustration** in anderen Produkten (Deck Build Box
  SC01, Edition Beta, Promos), z. B. `GD01-118` gibt es 9×. Sie unterscheiden sich nur durch Kleinigkeiten
  (Block-Nummer oben rechts, Folie). 175 Variantenpaare haben eine Ähnlichkeit über 0,95. Das ist per
  Kamera nicht zuverlässig trennbar → **die Übersicht braucht eine Variantenauswahl**, evtl. mit
  Voreinstellung „ich scanne gerade Produkt X“.
- Zwischen Karten mit verschiedenen Nummern gibt es keine nahezu identischen Referenzbilder.
- Ähnlich gestaltete Full-Art-Karten (LR+) liegen recht nah beieinander (z. B. 83,9 % gegen 81,5 %).
- Geplante Verbesserungen: Kartenkanten erkennen und Perspektive entzerren (auch die Basis für
  mehrere Karten gleichzeitig), Abstimmung über mehrere Bilder, optional Texterkennung der Kartennummer
  bei knappen Treffern.
- Ausgeblendete Browser-Tabs drosseln stark, und `requestAnimationFrame` läuft dort nicht → Messungen
  im Browser-Fenster nur mit sichtbarem Fenster aussagekräftig.

## Auf einem neuen Rechner einrichten

Erzeugte oder heruntergeladene Dateien sind **nicht** im Repo (`build/`, `pwa-spike/data|model|vendor`).
Voraussetzungen: Python 3.11+, Git Bash (für `openssl`). Node ist nicht nötig.

```bash
python tools/carddb/build_carddb.py --details --images   # ~20–35 min; lädt 2205 Bilder (128 MB) in build/carddb-cache
python -m venv build/venv
build/venv/Scripts/python -m pip install -r tools/model/requirements.txt
build/venv/Scripts/python tools/model/prepare_model.py    # lädt MobileNetV2, prüft SHA-256
python tools/vendor/fetch_ort.py                          # onnxruntime-web 1.30.0 aus dem npm-Tarball, prüft die Integrität
python pwa-spike/serve.py                                 # dann http://localhost:8000/build-index.html → Start (~6 min)
```

Abkürzung: Wenn `build.zip` (Archiv des `build/`-Ordners vom Arbeitsrechner, nicht im Repo) mitgenommen
wurde, im Repo-Root entpacken. Danach entfallen die Bilder-Downloads. Die venv darin ist an den alten
Pfad gebunden und sollte neu erstellt werden.

Handy-Test: `python pwa-spike/serve.py --https` → angezeigte `https://<LAN-IP>:8443/` in Chrome öffnen,
Zertifikatswarnung bestätigen, ggf. Python in der Windows-Firewall erlauben. Das Zertifikat liegt in
`build/cert/` und enthält die IPs vom Zeitpunkt der Erzeugung. Bei neuer IP `build/cert/` löschen.

## Beim Handy-Test zu klären

- Bilder/s und ms Modell (oben links im Scanner) mit `wasm` und mit `?backend=webgpu`.
- Wie oft ist der grüne (stabile) Treffer richtig? Sleeves, Folienkarten, Licht?
- Danach: PWA oder native entscheiden.

## Offene Punkte / noch nicht recherchiert

- Preise: CardTrader hat eine API mit Token (prüfen, ob GCG abgedeckt ist). Für Cardmarket ist der
  API-Zugang vermutlich eingeschränkt; kein Scraping. In einer PWA braucht es wegen CORS und
  Token-Schutz einen kleinen Proxy (z. B. einen Cloudflare Worker).
- ExBurst-Login und Import: keine offizielle API bekannt. Lieber die ExBurst-Entwickler fragen, statt
  die interne API nachzubauen. Aus einer PWA ginge es ebenfalls nur über einen Proxy.
- Kartenbilder gehören Bandai: für privaten Gebrauch ok, nicht öffentlich mit ausliefern
  (zur Laufzeit von der offiziellen Seite laden).

## Konventionen

- Abhängigkeiten exakt pinnen und Versionen gegen die Registry prüfen; keine Version unter
  2 Wochen Alter verwenden. Python-Werkzeuge möglichst nur mit der Standardbibliothek.
- Datenbank-Neuaufbau nach einem neuen Set: `build_carddb.py --details --images --refresh`, danach
  `build-index.html` erneut ausführen. Der Index muss zur Reihenfolge in `variants.json` passen; der
  Server erzeugt `variants.json` bei jedem Start neu.
