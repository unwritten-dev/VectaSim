# Approach assessment profiles

VectaSim rates every approach against a set of thresholds: the stabilised-approach gates at
1000 and 500 ft, the continuous checks from 1000 ft down to 50 ft (speed, sink rate, glide
path, localizer, bank, gear and flaps, thrust, spoilers) and the four bands from "stable" to
"unstable below the hard gate". An **assessment profile** decides which thresholds apply. A
profile only lists the values that differ from the generic set; everything else stays as in
the generic profile.

The values of the built-in profiles and the public documents they come from are researched in
[approach-profiles-sources.md](approach-profiles-sources.md); every built-in value below traces
to a row there. The code is `crates/vectasim-core/src/approach_profile.rs`.

## Built-in profiles

| Profile | Id | Values that differ from generic | Traced to (sources doc) |
|---|---|---|---|
| Generic (FSF/EASA) | `generic` | none – the defaults below | "P0 Generic": FSF ALAR BN 7.1, EASA AMC1/GM1 CAT.OP.MPA.115, EASA Data4Safety (D4S) p. 14 |
| Airbus-style | `airbus` | `gateSpeedAboveKt` **10** (gate window Vapp −5/+10 kt) | "P1 Airbus-style": AB-STAB Table 4 (VAPP −5 / +10 kt) |
| Boeing-style | `boeing` | none (identical to generic) | "P2 Boeing-style": no public Boeing values; BOE-AERO defers to the FSF ALAR tool kit |
| Turboprop / regional | `turboprop` | `gateSpeedAboveKt` **5**; `thrustCheck` **false** | "P3 Turboprop": ATR Flight Safety 2021 (±5 kt); thrust check off – turboprop gas-generator N1 stays high at flight idle (VectaSim convention) |
| GA piston | `ga_piston` | `gateSpeedAboveKt` **10**; `speedS1AboveKt` **10**; `speedS2AboveKt` **20**; `vsS1Fpm` **1000**; `vsS2Fpm` **1200**; `configGateFt` **500**; `hardGateFt` **300** | "P4 GA piston": FAA Airplane Flying Handbook ch. 9 (AFH9) p. 9-6 (+10/−5 KIAS, 500–1000 fpm, 500 ft VMC gate), AFH9 / FSF-GA 2017 (go around if unstable below 300 ft); S2 levels are VectaSim conventions |

Deliberately not used: the Airbus 7° bank figure (AB-STAB Table 4) is a callout criterion, not
a stabilisation limit, so the Airbus-style profile keeps the 15° gate bank. The band window of
the GA piston profile stays at 1000 ft (`windowTopFt`).

Effective values of the generic profile (the defaults the others change):

| Key | Generic | Key | Generic |
|---|---|---|---|
| `gateSpeedAboveKt` / `gateSpeedBelowKt` | 20 / 5 kt | `gateMaxVsFpm` | 1000 fpm |
| `gateMaxBankDeg` | 15° | `gateDots` | 1 dot |
| `speedS1AboveKt` / `speedS1BelowKt` | 20 / 5 kt | `speedS2AboveKt` / `speedS2BelowKt` | 35 / 10 kt |
| `vsS1Fpm` / `vsS2Fpm` | 1200 / 1500 fpm | `bankS1Deg` / `bankS2Deg` | 15° / 30° |
| `gsS1Dots` / `gsS2Dots` | 1 / 2 dots | `locS1Dots` / `locS2Dots` | 1 / 1.5 dots |
| `configGateFt` | 1000 ft | `hardGateFt` | 500 ft |
| `windowTopFt` | 1000 ft | `thrustCheck` | true (N1 ≥ 40 % for 5 s) |

The 15° gate bank comes from the D4S S1 level and the FAA AFH ch. 9 – FSF BN 7.1 gives no bank
number.

### What the GA piston heights mean

- **Configuration gate 500 ft:** gear down and no flap change are only required from 500 ft
  down; the 1000 ft gate does not check gear and flaps.
- **Hard gate 300 ft:** an exceedance below 300 ft makes the approach "unstable below 300 ft"
  (generic: below 500 ft). The gate list still shows the 1000 and 500 ft gates.

## Which profile a flight gets

1. **The aircraft in the fleet** (*Logbook → Aircraft*, field *Approach assessment*): a
   built-in or an imported profile. *Automatic* (the default) goes on with 2.
2. **The ICAO type** (the aircraft's type in the fleet, else the simulator's ATC model, else the
   SimBrief plan):

   | Types | Profile |
   |---|---|
   | Airbus A318–A321, A19N/A20N/A21N, A330, A340, A350, A380, A300/A310, A220 (BCS1/BCS3) | `airbus` |
   | Boeing 7x7 (B732…B739, B37M/B38M/B39M/B3XM, 747, 757, 767, 777, 787 incl. B78X), 717, MD-80/90, MD-11, DC-10 | `boeing` |
   | ATR 42/72, DHC-8 (Q400), other multi-crew turboprops (SF34, JS31/32/41, D328, F50, B190, DHC6, BE20/30/9L) | `turboprop` |
   | Light aircraft: C150/152/172/177/182/206/210, PA-28/32/34/44/46, SR20/22, DA20/40/42/62, Bonanza/Baron, Mooney, AA5, TB20; single-engine turboprops PC12, TBM, C208, Kodiak, M600 | `ga_piston` |
   | E-jets, ERJ, CRJ, business jets | `generic` |

   The A220 is mapped to the Airbus-style profile by decision; the sources doc lists it as
   generic (not an Airbus FBW design, no public A220 values). The only difference is the
   +10 kt gate speed window.

3. **The engine type**, for a type not in the table: piston → `ga_piston`, turboprop →
   `turboprop` (a single-engine turboprop → `ga_piston`), jet → `generic`. VectaSim does not
   record the simulator's `ENGINE TYPE`; it only recognises a piston engine by a recording whose
   turbine N1 stays at 0 in the air.
4. Otherwise **generic**.

The debrief and the flight detail name the profile ("Assessed with: Airbus-style profile") with
the differing values as a tooltip. Comparisons with your other flights ("stable from", gate
quotas, exceedances) and the trends only use approaches assessed with the same profile.
Changing an aircraft's profile, or replacing or deleting a custom profile, assesses the
affected flights again.

## Custom profiles

*Settings → Approach assessment → Import profile (JSON)* reads a file in this format:

```json
{
  "id": "my-va",
  "name": "My VA SOP",
  "basedOn": "airbus",
  "source": "My VA SOP, chapter 4.2 (2026)",
  "overrides": {
    "gateSpeedAboveKt": 10,
    "gateMaxBankDeg": 10,
    "thrustCheck": false
  }
}
```

| Field | Required | Rule |
|---|---|---|
| `id` | yes | 2–40 characters: lower-case letters, digits, `-`, `_`; starts with a letter or digit; not a built-in id. Importing the same id again replaces the profile. |
| `name` | yes | 1–60 characters, shown in the debrief and the fleet. |
| `basedOn` | no | A built-in id; its overrides apply first. Default `generic`. |
| `source` | no | Free text up to 500 characters (where the values come from). |
| `overrides` | no | Only the keys below, each within its range. |

Anything else – an unknown field or key, a string where a number belongs, a value out of range,
an S2 level below its S1 level, a hard gate above the window top – is refused with the reason.
At most 50 custom profiles; a file may be at most 16 KB. Custom profiles are stored in the app
settings (not in the `.vectasim` export).

### Allowed keys

| Key | Meaning | Range |
|---|---|---|
| `gateSpeedAboveKt` | 1000/500 ft gates: IAS at most this above Vapp | 0–40 kt |
| `gateSpeedBelowKt` | gates: IAS at most this below Vapp | 0–20 kt |
| `gateMaxVsFpm` | gates: sink rate at most | 500–2000 fpm |
| `gateMaxBankDeg` | gates: bank at most | 5–45° |
| `gateDots` | gates: glidepath and localizer deviation at most | 0.25–3 dots |
| `speedS1AboveKt` / `speedS1BelowKt` | continuous speed check, level S1 | 3–50 / 0–20 kt |
| `speedS2AboveKt` / `speedS2BelowKt` | continuous speed check, level S2 | 5–60 / 0–30 kt |
| `speedDurationS` | minimum duration of a speed exceedance | 1–30 s |
| `vsS1Fpm` / `vsS2Fpm` | sink rate S1 / S2 | 500–2500 / 500–3000 fpm |
| `vsS1DurationS` / `vsS2DurationS` | minimum durations | 1–30 s |
| `bankS1Deg` / `bankS2Deg` | bank S1 / S2 | 5–45 / 10–60° |
| `bankDurationS` | minimum duration | 1–30 s |
| `gsS1Dots` / `gsS2Dots` | glidepath S1 / S2 | 0.25–3 / 0.5–4 dots |
| `gsDurationS` | minimum duration | 1–30 s |
| `locS1Dots` / `locS2Dots` | localizer S1 / S2 | 0.25–3 / 0.5–4 dots |
| `locDurationS` | minimum duration | 1–30 s |
| `momentaryS` | excursions shorter than this never count | 0–10 s |
| `configGateFt` | gear down and no flap change from this height down | 300–1500 ft |
| `hardGateFt` | one exceedance below this height = "unstable below …" | 100–1000 ft |
| `windowTopFt` | top of the band window | 500–1500 ft |
| `thrustCheck` | run the thrust check at all | `true` / `false` |
| `thrustMinN1Pct` | thrust check: N1 at least | 10–80 % |
| `thrustDurationS` | minimum duration of low thrust | 1–30 s |
| `spoilersMaxPct` | deployed spoilers at most | 0–50 % |
| `statsSpeedAboveKt` / `statsSpeedBelowKt` | window of the "time outside" statistics | 3–30 / 0–20 kt |

## Reference speed: VREF and Vapp

EASA Data4Safety defines its speed levels against VREF. VectaSim applies every speed threshold –
continuous checks and gates, in every profile – to **Vapp**: the value entered for the aircraft
in the fleet, else the median IAS flown from 500 to 100 ft, else 1.3 × VS0 from the simulator.
Vapp is about VREF + 5 kt (Airbus: VAPP = VLS + 5…15 kt), so the generic "−5 kt below Vapp"
corresponds to the FSF "not below VREF". This is a VectaSim convention, not a published number.
