# GCGScanner

Privates Projekt (für den Nutzer und seinen Sohn): Handy-App, die bei laufender Kamera
**Gundam Card Game**-Karten erkennt und daraus eine Importliste für **ExBurst**
(exburst.dev) erstellt. Kommunikation auf Deutsch. Plattform: Android-Handy.
Der Nutzer kommt aus der Webentwicklung.

## Ziele (aus der ursprünglichen Anfrage)

1. Mehrere Karten bei laufender Kamera erkennen, Scan beenden → Übersicht → ExBurst-Liste.
2. Alt Arts in ExBurst-Notation (`GD06-002-ALT1`).
3. Übersicht mit Kartenbildern (ursprünglich: von der offiziellen GCG-Seite; siehe Bildquelle unten).
4. Preise von CardTrader und/oder Cardmarket anzeigen.
5. Später: Login bei ExBurst, Binder/Collection wählen, direkt importieren.

## Stand (3. Nov. 2026)

- **Kartendatenbank fertig**: `data/cards.db` (committet), erzeugt von `tools/carddb/build_carddb.py`.
  1290 Karten, 2205 Druckvarianten. Details: `tools/carddb/README.md`.
- **Plattform entschieden: PWA** in `pwa/`, veröffentlicht über GitHub Pages
  (`.github/workflows/pages.yml`). Details und Abläufe: `pwa/README.md`.
  - Scanner (eine Karte im Rahmen) → *Fertig* → Übersicht `#liste` mit Bildern, Mengen,
    **Variantenauswahl** und CSV teilen/kopieren/speichern. Liste bleibt in `localStorage`.
  - ExBurst-Import vorerst von Hand: Button *ExBurst-Collection öffnen* → `https://exburst.dev/gundam/collection/sets`
    (vom Nutzer genannt), dort die kopierte CSV einfügen.
  - Offline-fähig über Service Worker. **Kartenbilder aus verschlüsselten Paketen** (`pwa/images/`,
    Passwort nur beim Nutzer), siehe „Kartenbilder“ unten. Die ExBurst-CDN geht wegen Hotlink-Schutz nicht.
  - Seit 3. Nov. live auf `https://somecoder3.github.io/GCGScanner/` und am Handy benutzt. Die
    Bildpakete hat der Nutzer mit seinem Passwort gebaut (Commit `819eb8f`, 28 Pakete, 2205 Bilder).
    Am Handy laut Nutzer „sieht gut aus“.
- Vorher (2. Nov.): Machbarkeitstest am Handy (Android, Chrome): **WebGPU ~19 Bilder/s bei ~45 ms
  Modell**, wasm unter 10 Bilder/s bei über 100 ms. Erkennung laut Nutzer „ganz gut, auch mit Sleeves“.
- Seit 4. Nov.: Einzelscan entzerrt die Karte (siehe „Erkennung“), voller Index als Einstellung,
  Index ohne „SAMPLE“-Schriftzug gebaut.
- Seit 5. Nov. (Nutzerwunsch): ✕-Button neben dem Treffer und Set-Filter im Menü oben rechts,
  siehe „Scanner-Robustheit“.
- Noch nicht umgesetzt: mehrere Karten gleichzeitig (Prototyp, siehe unten), Preise (laut Nutzer zuletzt,
  „nettes Gimmick“), ExBurst-Login/Direktimport (vorerst nicht nötig, Button reicht).

## Fakten, die schon geprüft sind

- Offizielle Kartenliste: `https://www.gundam-gcg.com/en/cards/index.php?package=<id>` liefert alle
  Karten eines Produkts in einer HTML-Seite (die Pagination läuft nur im Client). Paket-IDs stehen als
  `data-val="6xxxxx"` im Filter. Detailseite: `detail.php?detailSearch=<official_id>`.
  Bild: `https://www.gundam-gcg.com/en/images/cards/card/<official_id>.webp` (600×837, Alpha-Ecken).
- **Alt-Art-Notation**: offiziell `_pN`, bei ExBurst `-ALTN`, 1:1 (Stichproben auf exburst.dev:
  `GD`, `ST`, `EB`, `T-`, `R-`, `RP-`, `EXB-`, `EXR-`, bis `ALT8`). ExBurst-Kartenseite:
  `https://exburst.dev/gundam/cards/<exburst_id>`.
- **ExBurst-Importformat** (vom Nutzer):
  ```
  Card No,Owned,Wanted,Trading,Tags
  GD05-123-ALT1,1,0,0,
  GD06-004,2,0,0,
  ```
- Nummernformate: `GD01-001`, `ST01-001`, `EB01-001`, `T-001` (Token), `R-001`/`RP-001` (Ressource),
  `EXB-001`/`EXBP-001`, `EXR-001`/`EXRP-001`, jeweils optional `_pN`.
- **Bildquelle**: gundam-gcg.com sendet `Cross-Origin-Resource-Policy: same-site`, die Bilder lassen
  sich auf fremden Seiten nicht anzeigen. `https://cdn.exburst.dev/cards/gundam-en/<official_id>.webp`
  (BunnyCDN) sendet `Access-Control-Allow-Origin: *` und cacht 30 Tage. `?width=360` verkleinert
  serverseitig (69 statt 123 KB). Alle 2205 Varianten sind dort vorhanden (am 3. Nov. geprüft).
  Achtung: Eine `HEAD`-Anfrage liefert andere Header als `GET`; zum Prüfen `GET` verwenden.
  **Nicht nutzbar (3. Nov.): Die ExBurst-CDN hat Hotlink-Schutz.** Mit einem Referrer von
  `somecoder3.github.io` (und auch von `example.com` oder sogar `exburst.dev`) kommt 403. Nur Anfragen
  ohne Referrer und von `localhost` gehen durch. Deshalb liefen die lokalen Tests, auf Pages
  zeigt die App aber nur die Platzhalter mit der Kartennummer. Mit `referrerPolicy="no-referrer"`
  ließe sich das umgehen. Das hebelt aber ExBursts bewusste Schutzmaßnahme aus und ist **nicht**
  eingebaut. Gewählte Lösung: verschlüsselte Bildpakete (siehe „Kartenbilder“).
- Bandai-Bilder **nicht** selbst auf GitHub Pages hosten: Pages ist öffentlich (auch bei privatem
  Repo), das wäre eine Weiterverbreitung. Das Repo ist öffentlich (API liefert 200).

## Erkennung

Bildvergleich statt Texterkennung. MobileNetV2 (ONNX Model Zoo, ohne Klassifikator → 1280-dim-Vektor)
im Browser über onnxruntime-web 1.30.0. **Standard-Backend ist überall WebGPU**
(`DEFAULT_BACKEND` in `pwa/js/embedder.js`). Ohne nutzbare GPU fällt `createEmbedder` automatisch
auf wasm zurück. In der App lässt sich das unter *Einstellungen & Technik* umstellen
(`localStorage`), `?backend=wasm` erzwingt wasm. Kosinus-Ähnlichkeit gegen alle 2205
Referenzvektoren, Kartenausschnitt über einen festen Rahmen im oberen Bildteil, Glättung über 500 ms.

**Entzerren (seit 4. Nov., Standard an):** Der Scanner sucht im Rahmen (+15 % Rand) die Kartenränder
(`pwa/js/detector.js` → Worker `detector-worker.js` mit OpenCV.js 4.12, `pickCard()`/`around()` in
`rectify.js`) und gibt die entzerrte Karte ans Modell. Ohne gefundene Karte (oder wenn OpenCV nicht
lädt) nimmt er wie bisher den Rahmen-Ausschnitt. OpenCV.js (10 MB) lädt im Hintergrund. Abschaltbar unter
*Einstellungen & Technik* (`gcg-scanner-rectify`). Gemessen mit `eval.html` (Haken „Entzerren“):

| Stufe | Variante ohne → mit | Kartennummer ohne → mit | entzerrt |
|---|---|---|---|
| sauber | 100 → 99,3 % | 100 → 100 % | 99 % |
| normal | 95,7 → 99,0–99,3 % | 100 → 100 % | 99 % |
| schwer | 81,0 → 91–92 % | 87,0 → 93,7 % | 90–92 % |

Kosten am PC: ~30 statt ~8 ms pro Bild (24 → 15 Bilder/s). Handy noch nicht gemessen. Die Testbilder
haben einen ruhigen Hintergrund; echte Hände/Tische können die Kantensuche öfter scheitern lassen
(dann Rückfall auf den Rahmen). Beide Ausschnitte rechnen und den besseren Treffer nehmen brachte
nichts zusätzlich. `warpSide: 640` reicht (gleiche Werte wie 1280, etwas schneller).

**SAMPLE-Schriftzug (seit 4. Nov. aus dem Index entfernt):** Die offiziellen Bilder tragen einen
schrägen „SAMPLE“-Schriftzug (dünne, fast deckend weiße Kontur), echte Karten nicht. Es gibt mehrere
feste Varianten (Größe/Lage), nicht pro Set, sondern gemischt; auf hellen Karten kaum sichtbar (dann
auch kaum relevant). `pwa/dev/watermark.html` gruppiert alle Bilder nach Variante (nur schräge helle
Linien, k-means) und speichert pro Variante eine Maske in `pwa/dev/watermark/masks.json` (5 Masken,
Aufruf steht im Quelltext). `pwa/dev/watermark.js` wählt pro Bild die passende Maske und füllt sie per
OpenCV-Inpainting auf (halbe Größe, 300 px, reicht fürs Modell). `build-index.html` macht das vor dem
Einbetten in einem Worker (`watermark-worker.js`, ~75 ms pro Karte, Indexbau ~3 min) (Haken „SAMPLE entfernen“, `index.json` → `"watermark": "removed"`). Nebenwirkung: Wo der
Schriftzug über Kartentext liegt, verwischt der Text etwas. Die angezeigten Kartenbilder (Pakete)
bleiben unverändert. Gemessen mit `eval.html` (Testbilder ohne SAMPLE, anders aufgefüllt als der
Index; ohne Entzerren):

| Testbilder ohne SAMPLE | Variante normal | Variante schwer | Kartennummer schwer |
|---|---|---|---|
| bisheriger Index (mit SAMPLE) | 94,0 % | 72,7 % | 79,0 % |
| Index ohne SAMPLE | 97,7 % | 81,3 % | 87,3 % |

Die älteren Messungen (Testbilder mit SAMPLE gegen Index mit SAMPLE) waren also zu optimistisch.
Kommt mit einem neuen Set eine neue Schriftzug-Variante dazu, `watermark.html` neu laufen lassen.

**Index** (`pwa/data/`, committet, weil nur lokal aus den Kartenbildern erzeugbar):
`index.json` (Format, Anzahl, Hashes), `variants.json?v=<hash>`, `embeddings.bin?v=<hash>`. Die
Vektoren sind int8 mit einem float32-Skalierungsfaktor pro Vektor (2,8 MB statt 11 MB), siehe
`quantize()`/`loadIndex()` in `pwa/js/matcher.js`. Zusätzlich liegt der **volle float32-Index**
`embeddings-full.bin?v=<full>` daneben (Nutzerwunsch zum Vergleich). Die App lädt ihn nur, wenn unter
*Einstellungen & Technik → Index: voll* gewählt (`gcg-scanner-index`); `eval.html` hat dafür einen Haken.
`build-index.html` schickt beide in einem Upload, der Dev-Server speichert Kartenliste und beide
Indizes immer zusammen (Hash-Prüfung), daher können sie nicht auseinanderlaufen. Gemessen am 4. Nov.:
voll und kompakt gleichauf (normal 95,7 / 95,7 %, schwer 80,7 / 81,0 % Variante).

Simulierte Kamerabilder (`pwa/dev/eval.html`, je 300 Stück, am PC). Werte mit int8-Index und WebGPU
vom 3. Nov.; der float32-Index mit wasm lag gleichauf (schwer: 86,7 / 80,7 / 82,7 / 95 %):

| Stufe | Kartennummer | Variante | Variante oder optisch gleich | Top-5 |
|---|---|---|---|---|
| sauber | 100 % | 100 % | 100 % | 100 % |
| normal | 100 % | 95,7 % | 98,3 % | 100 % |
| schwer | 87,0 % | 81,0 % | 83,0 % | 95 % |

Geschwindigkeit am PC: WebGPU 7–10 ms pro Bild (~28 Bilder/s im Scanner), wasm ~21 ms.

Genauigkeit des Index direkt gemessen (3. Nov., 101 Karten): WebGPU- und CPU-Vektoren am PC sind
identisch (Kosinus 1,00000), int8 gegen exakt 0,99995 (min. 0,99992). Die Quantisierung ist damit rund
400× kleiner als typische Abstände zwischen Kandidaten und **kein** Grund für eine schlechtere
Erkennung. Der Nutzer empfand die Pages-Version als schlechter; Verdacht: Die Objektivwahl liegt in
`localStorage` und gilt pro Origin, auf `github.io` war also wieder das unscharfe Standard-Objektiv aktiv.

- **Viele ALT-Nummern sind Nachdrucke derselben Illustration** in anderen Produkten (Deck Build Box
  SC01, Edition Beta, Promos), z. B. `GD01-118` gibt es 9×. Sie unterscheiden sich nur durch Kleinigkeiten
  (Block-Nummer oben rechts, Folie). 175 Variantenpaare haben eine Ähnlichkeit über 0,95
  (`LOOK_ALIKE` in `matcher.js`). Per Kamera nicht trennbar. **Gelöst in der App:** Der Treffer
  zeigt „+N gleich aussehende Varianten“, die Übersicht markiert solche Einträge mit „Variante prüfen“,
  bis der Nutzer im Auswahldialog eine Variante gewählt hat (`checked`). Der Set-Filter (siehe
  unten) filtert nach Kartennummer, trennt also keine Nachdrucke aus anderen Produkten.
- Zwischen Karten mit verschiedenen Nummern gibt es keine nahezu identischen Referenzbilder.
- Ähnlich gestaltete Full-Art-Karten (LR+) liegen recht nah beieinander (z. B. 83,9 % gegen 81,5 %).
- Mögliche Verbesserung: Texterkennung der Kartennummer bei knappen Treffern.

## Mehrere Karten gleichzeitig (Stand 4. Nov.: nur Prototyp, nicht in der App)

`pwa/dev/multi-eval.html` erzeugt Tischbilder mit 1–9 Karten (Untergrund holz/dunkel/hell/Spielmatte,
Abstand berührend/eng/normal, Hüllen, Schräglage) und misst die Kartensuche aus `detector-worker.js`
(Optionen als JSON im Eingabefeld, z. B. `{"method":"density"}`). Bestes klassisches Verfahren
(Standard): Canny → Konturen → konvexe Hülle → 4 Ecken/`minAreaRect` → Seitenverhältnis. Pro Einzelbild
gefunden: dunkel+Abstand 78 %, Holz+Abstand 58 %, Spielmatte ~10 %, eng/berührend 0–15 %.
Ausprobiert und schlechter: Hough-Linien, gefüllte Konturen mit Öffnen, Kantendichte, Raster-Teilung,
Kantenprüfung entlang der Umrisse. Grund: GCG-Karten haben keinen einheitlichen Rand (Motiv bis zur
Kante), aneinanderliegende Karten verschmelzen, ein 3×3-Block hat sogar das Kartenformat.
Vorgeschlagen (Nutzer entscheidet noch): kleines Segmentierungsnetz auf synthetischen Szenen
trainieren (PC hat eine RTX 5060), alternativ Regel „mit ~1 cm Abstand auf ruhigen Untergrund“.

## PWA-Technik (`pwa/`)

- **Service Worker** (`pwa/sw.js`): Caches `gcg-shell-<VERSION>` (HTML/CSS/JS, vorab geladen),
  `gcg-assets-v1` (Modell, Runtime, Index; URLs ändern sich mit dem Inhalt) und `gcg-images-v1`
  (ExBurst-Bilder, für immer). `VERSION = "dev"` → HTML/CSS/JS immer aus dem Netz. Der Pages-Workflow
  setzt den Commit-SHA ein. Updates warten auf „Neue Version – neu laden“ in der App, dann
  `skipWaiting`. Die erste Installation übernimmt sofort; die App wartet bis zu 3 s darauf, damit
  schon der erste Download im Cache landet. Neue Asset-Pfade (z. B. ORT-Version) in
  `ASSET_PREFIXES` eintragen, sonst löscht `activate` sie.
- Der Service Worker setzt **COOP/COEP-Header**, die GitHub Pages nicht senden kann. Ab dem zweiten
  Laden ist die Seite damit `crossOriginIsolated` (nur für Multithread-wasm relevant).
- Kartenbilder werden mit `crossOrigin="anonymous"` geladen (CORS statt opaque), damit der Service
  Worker sie prüfen und cachen kann.
- Erster Besuch lädt ~50 MB (WebGPU-Runtime 26 MB, OpenCV.js 10 MB, Modell 8,8 MB, Index 3 MB),
  danach offline. Der volle Index (11 MB) kommt nur dazu, wenn er gewählt wird.
  `navigator.storage.persist()` wird angefragt.
- Zurück-Taste: Die Übersicht ist `#liste`. Wurde sie aus dem Scanner geöffnet, ist „Zurück“
  `history.back()`, sonst wird nur der Hash entfernt.
- In `app.js` steht `await boot()` am Dateiende, sonst greift `boot()` auf noch nicht
  initialisierte `let`-Variablen zu (TDZ-Fehler).
- `style.css` enthält `[hidden] { display: none !important; }`. Ohne diese Regel überschreiben
  `display: flex`-Regeln das `hidden`-Attribut: Scanner und Liste waren gleichzeitig sichtbar,
  Zoom-Leiste und leeres Trefferfeld ebenfalls. Fiel erst im Screenshot auf → Ansichten per
  Screenshot oder `getComputedStyle` prüfen, nicht nur die `hidden`-Eigenschaft.

## Kartenbilder (`pwa/js/imagepack.js`, `pwa/dev/build-images.html`)

- Bilder (300 px, WebP q 0.8, ~30 KB) pro Kartennummer-Präfix (`GD01`, `ST04`, `T`, …) in je ein Paket:
  `u32 Headerlänge + JSON [{f,o,n}] + Bytes`, verschlüsselt mit AES-GCM-256 (12-Byte-IV vorangestellt).
  Der Schlüssel kommt per PBKDF2-SHA256 (600 000 Iterationen, Salt in `images/index.json`) aus dem
  Passwort. `check` in `index.json` ist ein verschlüsselter Prüftext, damit ein falsches Passwort sofort
  auffällt. Dateinamen `<Name>.<sha256-16>.bin` (Inhalts-Hash). 28 Pakete, 63 MB.
- Die Bilder dürfen nicht frei zugänglich sein, und Verstecken/Verschleiern reicht dafür nicht. Nur mit dem Passwort
  (Zugriffsschutz) ist die Veröffentlichung vertretbar. Das Passwort steht nirgends im Repo; Claude
  kennt es nicht und hat zum Testen nur Wegwerf-Pakete gebaut, die **nicht** committet wurden.
- Neubau mit demselben Passwort: Salt bleibt, jedes Paket wird entschlüsselt und mit dem neuen
  Inhalt verglichen; Gleiches bleibt byte-gleich (Canvas-WebP-Encoder ist deterministisch, getestet).
  Nur neue/geänderte Pakete kommen ins Repo.
- Am Handy: `ImageStore.unlock()` leitet den Schlüssel ab (nicht extrahierbar, IndexedDB
  `gcg-scanner/keys`), entschlüsselt alle Pakete und legt jedes Bild in Cache Storage
  `gcg-card-images-v1` unter `images/card/<file>`. Welche Pakete schon da sind, steht in
  `images/card/_packs.json` im selben Cache. Beim App-Start lädt `updateImages()` neue Pakete im
  Hintergrund. Am PC dauert das Freischalten 7–8 s.
- Der Service Worker liefert `images/card/*` nur aus dem Cache (sonst 404) und lässt `images/*`
  (Pakete, `index.json`) ungecacht durch, damit die 63 MB nicht doppelt gespeichert werden.

## Scanner-Robustheit (`pwa/js/app.js`)

- Kamera-Start und -Stopp laufen über einen `generation`-Zähler. Ein überholter Start fasst den
  gemeinsamen Zustand nicht an und gibt seinen Stream selbst frei. Nach jedem `await` wird erneut
  geprüft. `cameraOn` gilt ab Beginn des Starts, daher bricht ein zweiter Tipp während der
  Kamera-Freigabe den Start ab. Getestet: zwei Starts in vertauschter Reihenfolge, Abbruch während
  `getUserMedia`; danach ist kein Stream mehr `live`.
- Die Erkennungsschleife überspringt einzelne Fehler. Nach 5 Fehlern in Folge stoppt sie die Kamera
  und zeigt die Meldung in der Statuszeile, bei WebGPU mit Hinweis auf wasm.
- Die Kamera stoppt beim Wechsel zur Übersicht und wenn die App in den Hintergrund geht. Danach
  läuft sie wieder an.
- Übernehmen hat eine Sperre von 600 ms gegen Doppeltipps. Ein zweites Exemplar ist ein zweiter Tipp.
- **Treffer halten und Klicksperre** (Nutzerwunsch 5. Nov., Treffer wechselten zu schnell, man erwischte
  die falsche Karte): Ein angezeigter Treffer bleibt mindestens `MIN_SHOW_MS` = 700 ms, solange er in
  der Glättung noch vorkommt. Nach jedem Wechsel ignorieren ✕, Übernehmen und Treffer-Tipp
  `CLICK_LOCK_MS` = 400 ms lang Tipps (ausgegraut). Übernehmen braucht zusätzlich „stabil“: Der
  angezeigte Treffer führt auch die Glättung seit 3 Bildern an. Test mit Kamera, die alle 150 ms zwischen
  zwei Karten springt: Wechsel frühestens nach ~740 ms. Popups zu übernommenen/ausgeschlossenen Karten
  zeigen das Kartenbild (`toast(message, variant)`).
- **✕ neben dem Treffer** schließt eine falsch erkannte Variante samt ihrer gleich aussehenden Nachdrucke
  (`LOOK_ALIKE`) aus der Suche aus, sonst käme sofort der Nachdruck. Gilt bis zur nächsten Übernahme,
  bis die Kamera stoppt (auch Objektivwechsel, Hintergrund) oder bis *Fertig*. Nur im Speicher.
- **Menü oben rechts (▾)** überlagert das Kamerabild. Bisher nur „Set“: Die Suche prüft dann nur Karten,
  deren Nummer mit dem Set beginnt (`GD03-…`, ALT-Varianten eingeschlossen), plus immer die allgemeinen
  Karten `T`, `R`, `RP`, `EXB(P)`, `EXR(P)` (`GENERAL_SETS`, Nutzerwunsch; stehen nicht in der Liste). Gedacht fürs Booster-Öffnen. Die Wahl bleibt in `localStorage`
  (`gcg-scanner-set`) und steht dann im Button („GD03 ▾“, orange), damit ein aktiver Filter auffällt.
  Umgesetzt über eine Byte-Maske `allowed` für `search()` in `matcher.js`.

## Testen im Browser-Fenster (Claude)

- Ausgeblendete Tabs drosseln stark: `requestAnimationFrame` läuft nicht, und nach einigen Minuten
  feuern Timer nur noch etwa einmal pro Minute. Zum Testen `window.requestAnimationFrame` durch
  `setTimeout` ersetzen und Kamera-Anfragen manuell auflösen. `img.decode()` hängt in
  Hintergrund-Tabs, stattdessen `onload` nutzen. Lazy-Bilder laden dort nicht.
- Simulierte Kamera: Canvas mit `captureStream(0)`, nach jedem Zeichnen `track.requestFrame()`
  aufrufen. Ohne neues Bild bleibt `video.play()` hängen.
- Lokal funktioniert manches, was auf Pages scheitert (z. B. ExBursts Hotlink-Schutz lässt
  `localhost` durch). Externe Abhängigkeiten mit einem echten Referrer (`curl -H "Referer: …"`)
  oder auf der Live-Seite prüfen.
- Pages-ähnlicher Test: `pwa/` nach `build/site-test` kopieren, `dev/` entfernen, `VERSION` setzen,
  mit `python -m http.server 8010 -d build/site-test` ausliefern (ohne COOP/COEP). Offline-Test:
  den Server stoppen und neu laden.

## Auf einem neuen Rechner einrichten

Nicht im Repo: `build/`, `pwa/model/`, `pwa/vendor/`. Voraussetzungen: Python 3.11+, Git Bash (für
`openssl`). Node ist nicht nötig.

```bash
python -m venv build/venv
build/venv/Scripts/python -m pip install -r tools/model/requirements.txt
build/venv/Scripts/python tools/model/prepare_model.py    # lädt MobileNetV2, prüft SHA-256
python tools/vendor/fetch_vendor.py                       # onnxruntime-web 1.30.0 + OpenCV.js 4.12 aus npm-Tarballs, prüft die Integrität
python tools/devserver/serve.py                           # App: http://localhost:8000/
```

Das reicht für die App, der Index ist committet. Nur zum Neubauen des Index bzw. für `dev/eval.html`
braucht es die Kartenbilder lokal (`build_carddb.py --details --images`, ~20–35 min, 128 MB in
`build/carddb-cache`; oder `build.zip` vom Arbeitsrechner im Repo-Root entpacken).

Handy-Test lokal: `python tools/devserver/serve.py --https` → `https://<LAN-IP>:8443/` in Chrome öffnen,
Zertifikatswarnung bestätigen, ggf. Python in der Windows-Firewall erlauben. Das Zertifikat liegt in
`build/cert/` und enthält die IPs vom Zeitpunkt der Erzeugung. Bei neuer IP `build/cert/` löschen.
Erreicht Chrome am Handy den PC nicht (auch nicht die FritzBox), fehlt Chrome die Android-Berechtigung
„Geräte in der Nähe“ (Zugriff aufs lokale Netz). Firefox braucht sie nicht. Kommt eine Anfrage an,
steht sie im Server-Log, auch ein abgelehntes Zertifikat (`TLS handshake failed`).

## GitHub Pages

- Workflow `.github/workflows/pages.yml`: holt ORT, OpenCV.js und Modell (mit Prüfsummen), setzt `VERSION` in
  `sw.js`, veröffentlicht `pwa/` ohne `dev/`. Actions sind auf Commit-SHAs gepinnt (checkout v7.0.1,
  setup-python v7.0.0, configure-pages v6.0.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1).
- Einmalig nötig (durch den Nutzer): Repo → Settings → Pages → Source: **GitHub Actions**.
- URL: `https://somecoder3.github.io/GCGScanner/`. Alle Pfade in der App sind relativ.

## Erkenntnisse aus dem Handy-Test (Machbarkeitstest)

- WebGPU ist am Handy gut 2× schneller als wasm → Standard-Backend.
- Das Handy hat zwei Rückkameras; die automatisch gewählte war dauerhaft unscharf. Der Scanner hat
  deshalb eine Objektivauswahl (gespeichert), dazu Dauer-Autofokus, Tippen zum Fokussieren und Zoom.
- Nutzerwunsch: nur **ein** Treffer, groß und lesbar, über 500 ms geglättet; Kamera an/aus; alles
  ohne Scrollen auf einem Bildschirm.
- Noch offen: Trefferquote genauer messen (Folienkarten, Licht).

## Offene Punkte / noch nicht recherchiert

- Preise: CardTrader hat eine API mit Token (prüfen, ob GCG abgedeckt ist). Für Cardmarket ist der
  API-Zugang vermutlich eingeschränkt; kein Scraping. In einer PWA braucht es wegen CORS und
  Token-Schutz einen kleinen Proxy (z. B. einen Cloudflare Worker).
- ExBurst-Login und Import: keine offizielle API bekannt. Lieber die ExBurst-Entwickler fragen, statt
  die interne API nachzubauen. Aus einer PWA ginge es ebenfalls nur über einen Proxy.

## Konventionen

- **Diese CLAUDE.md immer aktuell halten** (Wunsch des Nutzers): Nach jeder relevanten Änderung,
  Erkenntnis oder Entscheidung hier nachtragen und veraltete Aussagen korrigieren, im selben Commit.
- Abhängigkeiten exakt pinnen und Versionen gegen die Registry prüfen; keine Version unter
  2 Wochen Alter verwenden (gilt auch für GitHub Actions, per Commit-SHA). Python-Werkzeuge möglichst
  nur mit der Standardbibliothek.
- Neues Set: `build_carddb.py --details --images --refresh`, Dev-Server starten,
  `http://localhost:8000/dev/build-index.html` → Start (~3 min mit SAMPLE-Entfernung), dann
  `data/cards.db` und `pwa/data/` committen. Neue Schriftzug-Varianten prüfen: `dev/watermark.html`.
- **OpenCV.js-Falle:** Das Emscripten-Modul `cv` hat eine eigene `then()`-Methode, die mit sich selbst
  auflöst. `await cv` oder `return cv` aus einer `async`-Funktion ergibt eine Endlosschleife (100 % CPU,
  „Page Unresponsive“, auch im Worker). `openCv()` in `pwa/dev/watermark.js` entfernt `then` vorher.
  Daran hing der Indexbau am 4. Nov. über eine Stunde (zuerst fälschlich dem ausgeblendeten Fenster
  zugeschrieben).
- Testen im Browser-Fenster: Ist das Fenster ausgeblendet, werden Timer gedrosselt; Abfragen per
  JavaScript können in Zeitüberschreitungen laufen. Fortschritt lieber über Dateien prüfen
  (z. B. `pwa/data/index.json`). Der Dev-Server bricht unter Last gelegentlich
  einzelne Bildanfragen ab (`ConnectionAbortedError`); die Dev-Seiten versuchen es deshalb erneut.
- Icons: `build/venv/Scripts/python tools/icons/make_icons.py` (braucht numpy aus der venv).
- Neues Set, Bilder: nach dem Index `http://localhost:8000/dev/build-images.html` mit dem **bisherigen**
  Passwort ausführen (macht der Nutzer selbst), dann `pwa/images/` committen.
