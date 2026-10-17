# VectaSim – Marke

Das Zeichen heißt **„Trace"**.

![Preview](preview.png)

## Das Zeichen

Das Zeichen besteht aus **einer** Linie, der Anflugspur. Sie verläuft erst waagerecht, sinkt dann in einer ruhigen Kurve und flacht zum Flare ab. Sie endet im **gelben Aufsetzpunkt**, der auf der **Runway** liegt. Die Runway ist eine kräftige Grundlinie, davor sitzt ein kurzer Strich der verlängerten Centerline. Das Zeichen enthält keine Buchstabenform.

- **Spur (Akzent `#5ab8f0`)**: das Anflugprofil aus dem Debrief, auf ein Glyph reduziert. Cyan steht in der App für den Ist-Wert, so wie die blaue Luftspur im Diagramm „Runway von oben".
- **Punkt (`#ffd54a`)**: der Touchdown. Er hat das Gelb des eigenen Flugzeugs und ist freigestellt, damit er auch einfarbig lesbar bleibt.
- **Grundlinie (Textfarbe)**: die Runway. Links liegt die Schwelle mit dem Centerline-Strich davor, der Punkt sitzt kurz dahinter, rechts folgt der Ausrollweg.

Die Wortmarke ist aus Inter (© The Inter Project Authors, SIL OFL 1.1) als Konturen gesetzt.

### Lesbarkeit

- **512 px / App-Icon**: Spur, Flare, Freistellring, Schwelle und Centerline-Strich sind sichtbar.
- **32 px**: Stufe, Punkt und Grundlinie sind klar. Der Centerline-Strich ist noch als Punkt da.
- **16 px**: Die Silhouette „Stufe auf Linie mit gelbem Punkt" bleibt. Für ≤ 48 px gibt es eine **Kleinvariante**. Sie ist vollflächig, hat eine Strichstärke von 7 statt 6, einen größeren Punkt und eine durchgehende Grundlinie ohne Centerline-Strich. Sie wird für `32x32.png`, `Square30x30Logo.png`, `Square44x44Logo.png` und die 16/24/32/48er-Einträge in `icon.ico` verwendet.
- **Kontrast auf `#0b0f14`**: Text 16:1, Akzent 8,7:1, Gelb 13,6:1.
- **Kontrast auf Hell `#f4f6f9`**: Tinte `#0f1318` 17:1, Akzent `#1f86c4` 3,7:1. Gelb erreicht nur 1,3:1. Der Punkt bekommt deshalb einen Rand in Tinte, statt das Gelb abzudunkeln, denn es ist die Flugzeugfarbe.

## Dateien

| Datei | Zweck |
|---|---|
| `logo.svg` | Zeichen für dunkle Flächen (64er-Raster, transparent) |
| `logo-on-light.svg` | Zeichen für helle Flächen |
| `logo-mono.svg` | einfarbig mit `currentColor` (Standard `#0f1318`); der Punkt ist per Maske freigestellt |
| `logo-wordmark.svg`, `-on-light`, `-mono` | Zeichen plus „VectaSim" (Inter SemiBold, −14 ‰, als Pfade). „Vecta" steht in Textfarbe, „Sim" in Muted. Die Grundlinie der Schrift sitzt auf der Unterkante der Runway. |
| `app-icon.svg` | Leinwand 1024 im macOS-Raster: Körper 824 bei 100 Rand, r = 185. Innen opak, außen voll transparent. |
| `preview.png` | Übersicht 1200 × 630 |

Abgeleitet sind:

- `app/src-tauri/icons/*`: per `tauri icon` aus dem App-Icon erzeugt, danach `icon.ico`, `32x32.png` und `Square30/44` mit der Kleinvariante überschrieben.
- `app/public/favicon.svg`
- `app/src/ui/Logo.tsx`

Cargo bettet geänderte Icons nicht automatisch neu ein, deshalb nach einer Änderung `cargo clean -p vectasim && cargo build -p vectasim` ausführen.

## Regeln

**Schutzraum**: Rundum bleibt mindestens der Durchmesser des Freistellrings frei, also 15 von 64 Einheiten (≈ ¼ der Zeichenbreite).

**Mindestgröße**: Die volle Fassung des Zeichens ab 24 px. Von 16 bis 23 px nur die Kleinvariante oder Mono. Die Wortmarke ab 20 px Höhe.

**Farben**

| Rolle | Dunkel | Hell |
|---|---|---|
| Spur | `#5ab8f0` (`--accent`) | `#1f86c4` |
| Runway, „Vecta" | `#e7ebf0` (`--text`) | `#0f1318` |
| Aufsetzpunkt | `#ffd54a` | `#ffd54a` + Rand `#0f1318` |
| „Sim" | `#939eac` (`--text-muted`) | `#5a6472` |
| Icon-Fläche | `#0f1318`, Haarlinie `rgba(200,220,255,.12)` | – |

**Nicht erlaubt**

- Verläufe, Schatten, Glanz oder 3D. Kein Verlaufsquadrat dahinter.
- Eine zweite Linie, ein Flugzeug, einen Globus oder einen Kondensstreifen ergänzen.
- Buchstaben ins Zeichen einbauen.
- Den Punkt anders als gelb einfärben (Ausnahme: Mono).
- Spur und Runway farblich tauschen.
- Spiegeln, drehen oder verzerren.
- Die Kurve steiler oder flacher zeichnen oder den Flare entfernen.
- Den Freistellring entfernen.
- „VectaSim" in einer anderen Schrift oder Schreibweise setzen, oder „Sim" heller als „Vecta".
- Das Zeichen auf unruhige Kartenflächen ohne Fläche dahinter stellen.

## In der App

`<Logo size={28} />` aus `app/src/ui/Logo.tsx`. Die Runway ist `currentColor` (in der Sidebar `--text`), die Spur `var(--accent)`, der Punkt immer `#ffd54a`. Mit `mono` wird auch die Spur `currentColor`. In der Sidebar bleibt die Fläche 36 px groß und hat keinen Verlauf.
