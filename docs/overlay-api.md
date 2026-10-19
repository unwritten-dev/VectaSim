# Overlay & API (local server, API v1)

VectaSim can start a small local HTTP/WebSocket server – for **OBS browser sources**, a **tablet/phone on your Wi-Fi** as a second screen, and a **JSON API** for virtual airlines and your own tools. It is **read-only** and **off by default**.

To turn it on: *Settings → Overlay & API → Turn on local server*. Default address `http://127.0.0.1:8095/` (port configurable, 1024–65535). The start page `/` lists all links, an API overview and the OBS tips.

Code: `crates/vectasim-server` (server, overlays under `overlay/`), app integration `app/src-tauri/src/server.rs`, panel `app/src/ServerPanel.tsx`.

## Overlays for OBS

| URL | OBS size | Content |
|---|---|---|
| `/overlay/hud` | 1920 × 120 | phase, altitude, speed, V/S, heading, remaining distance, ETA |
| `/overlay/landing` | 900 × 260 | appears for 20 s after touchdown: landing rate, g, bounces, band (smooth/normal/firm/hard), runway, touchdown point |
| `/overlay/route` | 700 × 200 | route, block time, aircraft, phase bar |

OBS: *Sources → + → Browser → paste URL → width/height as above*. The background is transparent. URL parameters:

- `?scale=1.5` – font size (0.25–4)
- `?preview=1` – sample data for positioning the source
- `?local=1` – local time instead of UTC
- `?token=…` – only for access from other devices (LAN mode)
- `?lang=de` / `?lang=en` – language of the overlay texts and the start page (default: the app language, setting `language`; anything unknown → default). The server sets `<html lang>`, and `overlay.js` picks its texts from it (its own small DE/EN table); numbers as in the app (`1 500 ft` / `1,500 ft`), flight phases stay in English. The overlay translates the landing band itself from `band`.

The overlays connect via WebSocket and reconnect on their own after a disconnect (app closed, port changed), with an increasing delay. They only set text and classes, never HTML from the data.

## JSON API v1

All responses are `application/json` with `Cache-Control: no-store`. Field names are camelCase, missing values are `null` (fields are never omitted), units are part of the name (`…Ft`, `…Kt`, `…Fpm`, `…Kg`, `…Nm`, `…M`, `…Deg`), times `…Ms` are Unix milliseconds. Within v1, fields may be added, but none are removed or renamed. Errors: `{"error": "<message>", "status": <HTTP code>}` – the message is currently a German text meant for humans; check `status`, not the text.

### `GET /api/v1/status`

```json
{"apiVersion":1,"app":"VectaSim","version":"0.5.1","provider":"mock","connection":"connected","detail":"Demo","simName":"Demo","simVersion":null,"recording":true,"streamerMode":false,"serverTimeMs":1792342722583,"lang":"de"}
```

`lang`: the app language (`de` | `en`) – the language of `bandLabel` and the default for the overlay pages.

### `GET /api/v1/flight`

The current flight (as in the “Flight” side panel), `null` when there is no flight.

```json
{"id":"demo-flight","state":"active","phase":"descent","offBlockMs":1792337321178,"takeoffMs":1792338221178,"landingMs":null,"onBlockMs":null,"blockTimeMs":5401502,"flightTimeMs":4501502,"departure":"EDDF","arrival":null,"destination":"EGLL","callsign":"DLH4YA","aircraft":{"title":"Airbus A320neo Lufthansa D-AINA","icaoType":"A20N","registration":"D-AINA","airline":"Lufthansa"},"distanceNm":333.0,"maxAltitudeFt":36000.0,"remainingNm":19.0,"etaMs":1792343002996,"fuel":{"startKg":9100.0,"currentKg":4200.0,"usedKg":4900.0,"plannedRampKg":9100.0,"plannedLandingKg":4000.0},"landingRateFpm":null,"touchdowns":0,"maxG":1.21,"minG":0.86}
```

`maxG` / `minG`: highest and lowest g-load in the air so far, outside the touchdowns (0.3 s moving average, two decimals; the last 3 s are held back until it is clear no touchdown follows), `null` before the first airborne sample.

### `GET /api/v1/telemetry`

The latest telemetry, `null` when not connected.

```json
{"timestampMs":1792342722783,"latitude":51.47,"longitude":-0.308,"altitudeMslFt":5761.9,"altitudeAglFt":5678.9,"iasKt":238.6,"tasKt":243.6,"groundSpeedKt":243.6,"verticalSpeedFpm":-716.1,"headingMagDeg":270.0,"headingTrueDeg":269.0,"pitchDeg":0.0,"bankDeg":0.0,"gForce":1.0,"onGround":false,"gearPct":0.0,"flapsIndex":0,"fuelTotalKg":4200.0,"paused":false,"simRate":1.0,"windDirTrueDeg":null,"windKt":null}
```

### `GET /api/v1/landing`

The latest touchdown of the current flight, otherwise the latest landing (excluding touch-and-gos) from the logbook; `null` if there is none. `band`: `smooth` (< 150 fpm) · `normal` (< 300) · `firm` (< 600) · `hard`, or `null` when the touchdown is unrated (`landingRateSource: "unrated"`: reached by slewing or time acceleration without a sim touchdown value; `bandLabel` then says “unrated”/“unbewertet”, and the logbook fallback skips such touchdowns); `gBand` by `peakG`: < 1.25 · < 1.5 · < 2.0 · above. `bandLabel` is the label of `band` in the app language (`status.lang`: `sanft/normal/fest/hart` or `smooth/normal/firm/hard`) – overlays should translate `band` (the code) themselves.

```json
{"flightId":"demo-flight","touchdownIndex":0,"timestampMs":1792342751179,"landingRateFpm":-142.0,"landingRateSource":"sim","band":"smooth","bandLabel":"sanft","peakG":1.18,"gBand":"smooth","bounces":0,"touchAndGo":false,"pitchDeg":3.1,"bankDeg":0.4,"groundSpeedKt":131.0,"airport":"EGLL","runway":"27L","touchdownDistanceM":412.0,"centerlineOffsetM":-1.4,"inTouchdownZone":true,"stableFromFt":1000.0,"approachBand":"stable","aircraft":{"title":"Airbus A320neo Lufthansa D-AINA","icaoType":"A20N","registration":"D-AINA","airline":"Lufthansa"},"live":false}
```

### `GET /api/v1/logbook?limit=10`

The most recent flights, `limit` 1–50 (default 10; not a number → 400).

```json
{"flights":[{"id":"demo-0","state":"completed","departure":"EDDF","arrival":"EGLL","offBlockMs":null,"onBlockMs":null,"blockTimeMs":5820000,"distanceNm":352.0,"callsign":"DLH4YA","aircraft":{"title":"Airbus A320neo Lufthansa D-AINA","icaoType":"A20N","registration":"D-AINA","airline":"Lufthansa"},"landingRateFpm":-142.0,"landings":1}]}
```

### `WS /api/v1/ws`

Server → client only (messages from the client are ignored, at most 16 simultaneous connections). Every message is a JSON object with `type`:

| `type` | When | Content |
|---|---|---|
| `hello` | right after connecting | `apiVersion`, `status`, `flight`, `telemetry`, `landing` – the full picture |
| `telemetry` | twice per second | `telemetry`, `flight` |
| `status` | the connection to the sim changes | `status` |
| `phase` | the flight phase changes | `from`, `to`, `atMs` |
| `landing` | a new touchdown | `landing` (as in `/api/v1/landing`) |
| `flightSaved` | the flight is in the logbook | `flightId`, `state`, `atMs` |

Example (Node ≥ 22):

```js
const ws = new WebSocket("ws://127.0.0.1:8095/api/v1/ws");
ws.onmessage = (m) => console.log(JSON.parse(m.data));
```

```json
{"atMs":1792342751184,"from":"final","to":"landing","type":"phase"}
{"atMs":1792342771184,"flightId":"demo-flight","state":"completed","type":"flightSaved"}
```

## Access and security

- **Off** until you turn it on; then only on `127.0.0.1` – other devices cannot reach it.
- **Reachable on the network (with token)** binds `0.0.0.0`. Other devices then need the random token (24 characters, ~119 bits): `?token=…`, header `Authorization: Bearer …` or `X-VectaSim-Token: …`. On this PC it still works without a token (the OBS URLs stay the same). *Regenerate* invalidates old LAN links. Windows asks for firewall permission the first time.
- No token is needed only if the peer is loopback **and** the `Host` header names `127.0.0.1`/`localhost`/`[::1]` (protection against DNS rebinding).
- **CORS / Origin:** only the server’s own origin, `http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*` and OBS (`http://absolute`) are allowed; other websites get 403 – also during the WebSocket handshake.
- **Read-only:** GET/HEAD (and OPTIONS for the CORS preflight), everything else 405.
- **Streamer mode:** all responses and overlays are masked like the UI – registration `D-••••`, callsign `•••••`, airline `•••`, and these values in the aircraft title as well. `status.streamerMode` says whether masking is active.
- Pages with a strict Content Security Policy (`default-src 'none'`, scripts/styles only from the server), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

## Developing without the app

`cargo run -p vectasim-server --example demo [port] [--lan] [--privacy]` starts the server with a made-up flight (60 s loop: descent → approach → touchdown at 30 s → taxi → saved at 50 s); then open `http://127.0.0.1:8095/`.
