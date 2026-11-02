# Kartendatenbank

`build_carddb.py` liest die offizielle Kartenliste von
<https://www.gundam-gcg.com/en/cards/> und schreibt `data/cards.db` (SQLite).
Es braucht nur Python 3.11+, keine zusätzlichen Pakete.

```bash
python tools/carddb/build_carddb.py --details --images
```

| Option | Wirkung |
|---|---|
| *(keine)* | nur Kartenliste: Nummer, Variante, Name, Bild-URL, Sets (wenige Sekunden) |
| `--details` | zusätzlich Seltenheit, Typ, Farbe, Werte, Effekttext (ca. 20 min beim ersten Lauf) |
| `--images` | lädt alle Kartenbilder nach `build/carddb-cache/images/` (Rohmaterial für den Alt-Art-Bildvergleich) |
| `--refresh` | Kartenlisten neu laden, z.B. nach einem neuen Set |

Alle Antworten werden unter `build/carddb-cache/` gespeichert. Ein erneuter Lauf
lädt nur, was fehlt.

## Alt-Art-Notation

Die offizielle Seite hängt `_pN` an, ExBurst `-ALTN`. Die Zuordnung ist 1:1 und
wurde stichprobenartig auf exburst.dev geprüft (inkl. `T-`, `R-`, `EXB-`, `EXR-`, bis `ALT8`):

| offiziell | ExBurst |
|---|---|
| `GD06-002` | `GD06-002` |
| `GD06-002_p1` | `GD06-002-ALT1` |
| `ST01-001_p8` | `ST01-001-ALT8` |

## Tabellen

- `card`: eine Zeile pro Kartennummer (Name, Typ, Farbe, Werte, Effekt)
- `variant`: eine Zeile pro Druck/Alt Art, Schlüssel ist die ExBurst-Nummer
- `package` / `variant_package`: in welchen Produkten eine Variante enthalten ist
- `meta`: Quelle, Erstellungszeitpunkt, Anzahl
