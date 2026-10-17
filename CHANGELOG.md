# Changelog

## Unreleased (0.1.0)

Erster Stand – Phase 1 (MVP) in Arbeit.

- Live-Karte (MapLibre/OpenFreeMap) mit Flugzeug, höhencodiertem Track, Flughäfen (OurAirports), Airport-Diagramm beim Hineinzoomen, VATSIM-Verkehr/ATC, METAR-Badges
- Flugphasen-Erkennung, Touchdown-Detektor nach festen, dokumentierten Regeln (Sim-Wert, V/S-Rückfall, Worst-of-Bounces, AGL-Korroboration), Flugzusammenfassung mit Integritäts-Flags
- Lokales SQLite-Logbuch mit komprimierten Tracks, Profil-Chart, Export (CSV/GPX/KML/JSON), Flotte, besuchte Flughäfen
- SimBrief-Dispatch mit geplanter Route und OFP-vs-Ist
- Landing-Debrief: Runway-Draufsicht mit Aufsetzpunkt, Anflugprofil, Stabilized-Approach-Checkliste, gespeichertes METAR
- Oberfläche mit Icon-Sidebar, Vollbild-Karte, Seitenleiste, Logbuch Liste/Detail), Demo-Modus
- Auto-Update über signierte GitHub-Releases
