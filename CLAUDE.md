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
- **PWA-Machbarkeitstest fertig** in `pwa-spike/` (siehe `pwa-spike/README.md`) und am Handy
  getestet (2. Nov. 2026, Android, Chrome): **WebGPU ~19 Bilder/s bei ~45 ms Modell**, wasm unter
  10 Bilder/s bei über 100 ms. Erkennung laut Nutzer „ganz gut, auch mit Sleeves“.
- **Plattform-Entscheidung offen**, aber die PWA ist nach dem Handy-Test brauchbar (vom Nutzer
  bevorzugt, Web-Hintergrund). Native Kotlin-App wurde vorgeschlagen, ist nicht angefangen.

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
1280-dim-Vektor) im Browser über onnxruntime-web 1.30.0. **Standard-Backend ist überall WebGPU**
(`DEFAULT_BACKEND` in `pwa-spike/js/embedder.js`). Ohne nutzbare GPU fällt `createEmbedder` automatisch
auf wasm zurück (4 Threads dank Cross-Origin-Isolation); `?backend=wasm` erzwingt wasm. Kosinus-Ähnlichkeit
gegen alle 2205 Referenzvektoren, Kartenausschnitt über einen festen Rahmen im oberen Bildteil.

Simulierte Kamerabilder (`pwa-spike/eval.html`, je 300 Stück, am PC):

| Stufe | Kartennummer | Variante | Variante oder optisch gleich | Top-5 |
|---|---|---|---|---|
| sauber | 100 % | 100 % | 100 % | 100 % |
| normal | 100 % | 95,7 % | 98,3 % | 100 % |
| schwer | 86,7 % | 80,7 % | 82,7 % | 95 % |

Geschwindigkeit: ~21 ms pro Bild am PC (wasm). Am Handy siehe „Erkenntnisse aus dem Handy-Test“.

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
  im Browser-Fenster nur mit sichtbarem Fenster aussagekräftig. Nach einigen Minuten im Hintergrund
  feuern Timer nur noch etwa einmal pro Minute. Tests im ausgeblendeten Fenster daher ohne
  `setTimeout`-Wartezeiten bauen, z. B. Kamera-Anfragen manuell auflösen und den Test-Canvas per
  `track.requestFrame()` neu ausgeben. Ein `captureStream()`-Canvas liefert erst dann ein Bild.

## Scanner-Robustheit (`pwa-spike/index.html`)

- Kamera-Start und -Stopp laufen über einen `generation`-Zähler. Ein überholter Start fasst den
  gemeinsamen Zustand nicht an und gibt seinen Stream selbst frei. Nach jedem `await` wird erneut
  geprüft. `cameraOn` gilt ab Beginn des Starts, daher bricht ein zweiter Tipp während der
  Kamera-Freigabe den Start ab. Getestet: zwei Starts in vertauschter Reihenfolge, Abbruch während
  `getUserMedia`; danach ist kein Stream mehr `live`.
- Die Erkennungsschleife überspringt einzelne Fehler. Nach 5 Fehlern in Folge stoppt sie die Kamera
  und zeigt die Meldung in der Statuszeile, bei WebGPU mit Hinweis auf wasm.

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
Erreicht Chrome am Handy den PC nicht (auch nicht die FritzBox), fehlt Chrome die Android-Berechtigung
„Geräte in der Nähe“ (Zugriff aufs lokale Netz). Firefox braucht sie nicht. Kommt eine Anfrage an,
steht sie im Server-Log, auch ein abgelehntes Zertifikat (`TLS handshake failed`).

## Erkenntnisse aus dem Handy-Test

- WebGPU ist am Handy gut 2× schneller als wasm → als Standard-Backend nehmen.
- Das Handy hat zwei Rückkameras; die automatisch gewählte war dauerhaft unscharf. Der Scanner hat
  deshalb eine Objektivauswahl (gespeichert), dazu Dauer-Autofokus, Tippen zum Fokussieren und Zoom.
- Nutzerwunsch: nur **ein** Treffer, groß und lesbar, über 500 ms geglättet; Kamera an/aus; alles
  ohne Scrollen auf einem Bildschirm.
- Noch offen: Trefferquote genauer messen (Folienkarten, Licht), und wie die Variantenauswahl
  (Nachdrucke derselben Illustration) in der Übersicht aussehen soll.

## Offene Punkte / noch nicht recherchiert

- Preise: CardTrader hat eine API mit Token (prüfen, ob GCG abgedeckt ist). Für Cardmarket ist der
  API-Zugang vermutlich eingeschränkt; kein Scraping. In einer PWA braucht es wegen CORS und
  Token-Schutz einen kleinen Proxy (z. B. einen Cloudflare Worker).
- ExBurst-Login und Import: keine offizielle API bekannt. Lieber die ExBurst-Entwickler fragen, statt
  die interne API nachzubauen. Aus einer PWA ginge es ebenfalls nur über einen Proxy.
- Kartenbilder gehören Bandai: für privaten Gebrauch ok, nicht öffentlich mit ausliefern.
  **Direkt einbinden geht nicht**: gundam-gcg.com sendet `Cross-Origin-Resource-Policy: same-site`,
  Browser zeigen die Bilder auf fremden Seiten nicht an. Der Spike nimmt deshalb die lokalen Kopien
  über `/ref-images/` vom Dev-Server. Für eine echte PWA braucht es einen Proxy oder eine andere Quelle.
  **Funktionierende Alternative:** `cdn.exburst.dev/cards/gundam-en/<official_id>.webp` sendet
  `Access-Control-Allow-Origin: *`, verwendet dieselben Dateinamen und cacht 30 Tage. Das ist
  allerdings ExBursts Bandbreite; vor intensiver Nutzung bei ExBurst nachfragen. Die Bilder selbst
  auf GitHub Pages zu hosten wäre eine öffentliche Weiterverbreitung der Bandai-Bilder (Pages ist
  auch bei privatem Repo öffentlich) → nicht gewollt. Variante dazu: App auf Pages, Bilder beim
  ersten Anzeigen von der ExBurst-CDN laden und im Service-Worker-Cache halten.

## Konventionen

- **Diese CLAUDE.md immer aktuell halten** (Wunsch des Nutzers): Nach jeder relevanten Änderung,
  Erkenntnis oder Entscheidung hier nachtragen und veraltete Aussagen korrigieren, im selben Commit.

- Abhängigkeiten exakt pinnen und Versionen gegen die Registry prüfen; keine Version unter
  2 Wochen Alter verwenden. Python-Werkzeuge möglichst nur mit der Standardbibliothek.
- Datenbank-Neuaufbau nach einem neuen Set: `build_carddb.py --details --images --refresh`, danach
  `build-index.html` erneut ausführen. Der Index muss zur Reihenfolge in `variants.json` passen; der
  Server erzeugt `variants.json` bei jedem Start neu.
