# Approach assessment profiles: public sources

Research for manufacturer- and category-specific approach assessment profiles
(`ApproachConfig` in `crates/vectasim-core/src/approach.rs`). Compiled 2026-10-21.
Status: implemented in 0.6.2 (`crates/vectasim-core/src/approach_profile.rs`); the
profiles as built, their values and the type mapping are described in
[approach-profiles.md](approach-profiles.md), which wins where the two differ. This
document stays the research record. Deviations of the implementation from the proposals
below: the P4 "hard gate" parameter exists (`hardGateFt`, 300 ft for GA piston);
single-engine turboprops get the GA piston profile with the thrust check left on (their
gas-generator N1 stays high at idle, so it practically never fires); and the sim's
`ENGINE TYPE` is not recorded – for a type outside the table only a piston engine is
recognised (turbine N1 at 0 in the air), everything else falls back to P0.

## Scope and citation rules

- **Only public, citable documents.** That means safety foundation briefing notes,
  manufacturer safety magazines and briefing notes that the manufacturer or a
  regulator publishes openly, regulatory material (EASA AMC/GM, FAA AC/handbooks,
  ICAO excerpts as quoted by IATA), and accident-investigation reports in the
  investigator's own words.
- **Never** FCOM/FCTM/QRH text, operator manuals, or forum/sim-site transcriptions of
  them. A value known only from such a source is marked **not citable** and is left
  out of the recommendations.
- Quotes are at most 25 words. "≈" marks a close paraphrase.
- Confidence: **high** = primary document read, exact value stated; **medium** =
  primary document, but the value is a callout criterion, an example, or its reference
  speed is not stated; **low** = secondary or indirect.
- Profiles may differ from Generic **only** where a public source differs. Everything
  else inherits the generic default.

### Source keys

| Key | Document | Year | URL |
|---|---|---|---|
| FSF71 | FSF ALAR Briefing Note 7.1 "Stabilized Approach" (ALAR Tool Kit) | 2009 rev. | https://skybrary.aero/sites/default/files/bookshelf/864.pdf |
| FSF42 | FSF ALAR BN 4.2 "Energy Management" | 2009 rev. | https://skybrary.aero/sites/default/files/bookshelf/857.pdf |
| FSF61 | FSF ALAR BN 6.1 "Being Prepared to Go Around" | 2009 rev. | https://skybrary.aero/sites/default/files/bookshelf/860.pdf |
| FSF82 | FSF ALAR BN 8.2 "The Final Approach Speed" | 2009 rev. | https://skybrary.aero/sites/default/files/bookshelf/866.pdf |
| FSF-GA | FSF "Go-Around Decision-Making and Execution Project", final report, §10.3 (pp. 43–46) | 2017 | https://www.flightsafety.org/wp-content/uploads/2017/03/Go-around-study_final.pdf |
| AB-STAB | Airbus FOBN "Approach Techniques – Flying Stabilized Approaches", FLT_OPS-APPR-SEQ01 REV02 | Oct 2006 | https://www.faa.gov/sites/faa.gov/files/2022-11/AirbusSafetyLib_-FLT_OPS-APPR-SEQ01%20-%20Stabilized%20App.pdf (also skybrary bookshelf/165.pdf) |
| AB-NRG | Airbus FOBN "Aircraft Energy Management during Approach", FLT_OPS-APPR-SEQ03 REV02 | Oct 2005 | https://skybrary.aero/sites/default/files/bookshelf/166.pdf |
| AB-SF24 | Airbus Safety First #24, "Control your Speed… During Descent, Approach and Landing" | Jul 2017 | https://skybrary.aero/sites/default/files/bookshelf/4071.pdf |
| AAIB | UK AAIB Bulletin 10/2009, A320-232 G-EUUU, EW/G2009/03/20 | 2009 | https://assets.publishing.service.gov.uk/media/5422eab3ed915d1374000023/Airbus_A320-232__G-EUUU_10-09.pdf |
| BOE-AERO | Boeing AERO QTR_03/12 "Reducing Runway Landing Overruns" | 2012 | https://skybrary.aero/sites/default/files/bookshelf/1938.pdf |
| ATR | ATR Flight Safety (S. Sellem), "Decision making during approach" | Jul 2021 | https://safety.atr-aircraft.com/2021/07/29/decision-making-during-approach/ |
| EASA-AMC | EASA AMC1/GM1 CAT.OP.MPA.115(a), AMC&GM to Part-CAT Issue 2 Amdt 21 (Annex IV to ED Decision 2022/012/R), pp. 30–31 | 2022 | https://www.easa.europa.eu/sites/default/files/dfu/amc_gm_to_part-cat_-_issue_2_amendment_21.pdf |
| D4S | EASA Data4Safety "Guidance for identifying unstable approach with flight data", Rev 00, p. 14 | Apr 2022 | https://www.easa.europa.eu/en/downloads/136957/en |
| IATA | IATA/IFALPA/CANSO/IFATCA "Unstable Approaches: Risk Mitigation Policies, Procedures and Best Practices", 2nd ed., §3 (pp. 10–15; quotes ICAO Doc 8168 and IOSA FLT 3.11.59) | 2016 | https://www.iata.org/contentassets/7a5cd514de9c4c63ba0a7ac21547477a/unstable-approaches-2016-2nd-edition.pdf |
| FAA-9179 | FAA AC 91-79A Chg 2 "Mitigating the Risks of a Runway Overrun Upon Landing", App. 1 §3 | 2014/2018 | https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_91-79A_Chg_2.pdf |
| FAA-12071 | FAA AC 120-71B "Standard Operating Procedures…", §1.3 | 2017 | https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_120-71B.pdf |
| AFH9 | FAA Airplane Flying Handbook FAA-H-8083-3C, ch. 9 "Approaches and Landings", p. 9-6 | 2021 | https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/airplane_handbook/10_afh_ch9.pdf |
| AFH16 | FAA AFH FAA-H-8083-3C, ch. 16 "Transition to Jet-Powered Airplanes", pp. 16-20/21 | 2021 | https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/airplane_handbook/17_afh_ch16.pdf |
| TC | Transport Canada CASA 2015-04 "Stabilized Approach", issue 02 | 2019 | https://tc.canada.ca/en/aviation/reference-centre/civil-aviation-safety-alerts/stabilized-approach-civil-aviation-safety-alerts-casa-no-2015-04 |
| CFR125 | 14 CFR 25.125 (CS 25.125 is harmonised) | current | https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-25/subpart-B/subject-group-ECFR14f0e2fcc647a42/section-25.125 |
| HELI | HeliOffshore "Approach Path Management Guidelines" v3.0 (optional, helicopters) | 2017 | https://skybrary.aero/sites/default/files/bookshelf/4235.pdf |

## 1. Speed window around the reference

| Source | Reference / value | Wording (≤25 words) | Conf. |
|---|---|---|---|
| FSF71 p.2 | VREF … VREF+20 kt IAS | "The aircraft speed is not more than VREF + 20 kt indicated airspeed and not less than VREF" | high |
| FSF82 p.2 | Target = VREF+5 in calm wind | "VREF … plus five knots is a typical target final approach speed." | high |
| FSF-GA p.43 (2017, proposed) | VREF … VREF+10 kt | "Airspeed is stabilized within VREF +10 kt to VREF (without wind adjustments)." | high (but marked "proposed for industry validation") |
| AB-STAB Table 4 p.4 | VAPP −5 / +10 kt (callout criterion at and below the stabilisation height) | "Lower than V APP - 5 kt or Greater than V APP + 10 kt"; VAPP "considered to be equal to V REF + 5 kt (or V LS + 5 kt…)" | high (as callout limit) |
| AB-SF24 (Stabilisation criteria box) | Must be "at approach speed" at the stabilisation height; no ± given | ≈ aircraft must be at approach speed with stabilized thrust at the stabilisation height | high (no number) |
| D4S p.14 | S1 > VREF+20 / < VREF−5 (3 s); S2 > VREF+35 / < VREF−10 (3 s); 1000→50 ft | table values | high |
| FAA-9179 App.1 §3.d | ≤ VREF+5 (or POH speed + wind adjustments), never < VREF | "not more than VREF + 5 or the POH published approach airspeed, with appropriate adjustments … never less than VREF" | high |
| AFH16 p.16-20 | 0 … +10 kt above target by 500 ft AGL (jets) | "Indicated airspeed should be between zero and 10 knots above the target airspeed by 500 feet AGL." | high |
| AFH9 p.9-6 | +10 / −5 KIAS of recommended landing speed (AFM, 1.3 VSO or placard) (piston) | "within +10 /-5 KIAS of the recommended landing speed specified in the AFM, 1.3VSO, or on approved placards/markings" | high |
| ATR (2021) | ±5 kt (−5/+10 kt single engine); reference speed not named | "±5 kt (-5/+10 kt in single engine)" | medium |
| IATA p.10 | example tolerance +5/−0 kt | "(+ 5 knots/- 0 knots airspeed for example)" | medium (example) |
| EASA-AMC (d)(4) | "acceptable tolerance of the intended landing speed", set by operator | no number | high (no number) |
| TC 2015-04 | "range of speeds specific to the aircraft type" | no number | high (no number) |
| Boeing | No public numeric value found; BOE-AERO defers to the FSF ALAR tool kit. Values reproduced on sim/forum sites from the Boeing FCTM are **not citable**. | – | – |

## 2. Sink rate on final

| Source | Value | Wording | Conf. |
|---|---|---|---|
| FSF71 p.2 | ≤ 1000 fpm; special briefing if more | "Sink rate is no greater than 1,000 fpm; if an approach requires a sink rate greater than 1,000 fpm, a special briefing should be conducted" | high |
| FSF-GA p.43 | ≤ 1000 fpm | "Sink rate is no greater than 1,000 fpm." | high |
| AB-STAB Table 4 | callout if > 1000 ft/mn | "Vertical Speed — Greater than - 1000 ft/mn" | high |
| EASA-AMC GM1 (b) | target ≤ 1000 fpm normally; brief if more | "target rate of descent … normally does not exceed 1 000 fpm … this should be briefed in advance" | high |
| EASA-AMC AMC1 (c) | variation ≤ 50 % of target | "Variations in the rate of descent should normally not exceed 50 % of the target rate of descent." | high |
| D4S p.14 | S1 > 1200 fpm (5 s); S2 > 1500 fpm (3 s); 1000→50 ft | table values | high |
| ATR (2021) | max 1000 ft/min; adjustments ±300 ft/min from target | "Maximum sink rate 1000 ft / minute"; "±300 ft / minute from target rate" | medium |
| AFH16 p.16-21 | typical 500–700 fpm (jets), rule of thumb GS/2 × 10 | "Typical descent rates fall between 500 and 700 feet per minute." | high (guidance, no limit) |
| AFH9 p.9-6 | generally 500–1000 fpm (light GA); if > 500 fpm, reduce before 300 ft AGL | "If using a descent rate in excess of 500 fpm … the pilot should reduce the descent rate prior to 300 ft AGL." | high |
| FAA-9179 App.1 §3.c | ≈ GS × 5 fpm for 3°, no limit | – | high (no limit) |
| IATA p.10 | ≈ 600–700 fpm typical for jets on 3° | – | high (descriptive) |

## 3. Bank angle on final

| Source | Value | Wording | Conf. |
|---|---|---|---|
| FSF71 | **no numeric limit**; circling: wings level by 300 ft | "during a circling approach, wings should be level on final when the aircraft reaches 300 ft above airport elevation" | high |
| AB-STAB Table 4 | callout if > 7° | "Bank Angle — Greater than 7 degrees" | high (callout) |
| EASA-AMC AMC1 (b)(1) | < 30° from the predetermined point (normally the FAF) | "the angle of bank should be less than 30 degrees" | high |
| D4S p.14 | S1 > 15° (3 s), S2 > 30° (3 s), 1000→50 ft | table values | high |
| AFH9 p.9-6 | normally ≤ 15° once established on final (piston) | "Bank angle normally limited to 15 degrees once established on final." | high |

## 4. Gate heights and height reference

| Source | Gates | Height datum | Wording | Conf. |
|---|---|---|---|---|
| FSF71 | 1000 ft IMC / 500 ft VMC | above airport elevation | "1,000 feet above airport elevation in … (IMC); or, 500 feet above airport elevation in … (VMC)" | high |
| FSF-GA p.43 (2017) | 1000 ft = configuration gate (800–1500 by type); 500 ft = stable gate; 300 ft = go-around gate; same in IMC and VMC | AGL | "The stable approach criteria are the same at each gate for approaches conducted in both IMC and VMC." | high (proposed) |
| AB-STAB Table 2 | 1000 IMC / 500 VMC; circling lower (e.g. 400 ft) | above airfield elevation | "A lower minimum stabilization height may be allowed for circling approaches (e.g. 400 ft)." | high |
| AB-SF24 (Stabilisation criteria box) | 1000 ft IMC, 500 ft VMC "or according to airline's policy" | AGL | – | high |
| ICAO Doc 8168 (via IATA p.15) | IMC: ≥ 1000 ft; all flights: ≥ 500 ft | height above threshold | "all flights of any nature shall be stabilized by no lower than 150 meters (500 feet) height above threshold" | high (secondary quote of PANS-OPS) |
| IOSA FLT 3.11.59 (via IATA p.15) | 1000 AAL IMC, 500 AAL VMC; operator may use 500 ft AAL in IMC e.g. for turboprops | AAL | "Lower minimum approach stabilization heights are authorized for turbo-propeller aircraft operations (e.g., 500 feet AAL on VMC/IMC approaches)" | high (secondary quote) |
| IATA p.11 | operators use 1500 … 500 ft; some 1000 ft always | – | ≈ some operators require 1000 ft regardless of weather | high |
| EASA-AMC (e)/(f) | all: before 500 ft; no visual reference: before 1000 ft | above landing runway threshold elevation | "stabilised for landing before reaching 500 ft above the landing runway threshold elevation" | high |
| D4S | analysis window 1000 → 0 ft; most criteria 1000 → 50 ft; low GS 1000 → 500 ft | height above threshold (FDM) | – | high |
| FAA-9179 | 1000 ft IMC / 500 ft VMC | above TDZE | "stabilized on profile before descending through the 1,000-ft window or through the 500 ft above touchdown zone elevation (TDZE)" | high |
| AFH16 | landing config by 1000 ft; evaluate at 500 ft | AGL | "Every approach should be evaluated at 500 feet." | high |
| AFH9 | 500 ft VMC / 1000 ft IMC; GA pattern: immediate go-around if unstable below 300 ft | above airport elevation / AGL | "an immediate go-around should be initiated if the approach becomes unstabilized below 300 ft AGL" | high |
| ATR | 1000 IMC, 500 VMC, 300 after circle-to-land | AAL | "1000 ft AAL in IMC conditions"; "300 ft AAL following circle-to-land" | medium |
| TC 2015-04 | 1000 ft IMC, 500 ft VMC | above aerodrome elevation | – | high |

VectaSim measures HAT (threshold elevation), which matches ICAO PANS-OPS and EASA. The
other datums (airport elevation, TDZE, AAL, AGL) differ by a few feet at most runways.
VectaSim cannot tell IMC from VMC, so it applies a single set of gates (see Open questions).

## 5. Configuration gates

| Source | Rule | Wording | Conf. |
|---|---|---|---|
| FSF71 | landing configuration at the stabilisation height | "The aircraft is in the correct landing configuration" | high |
| FSF42 p.2 | typical policy: landing configuration at the OM (1500–2000 ft) | "cross the OM (usually between 1,500 feet and 2,000 feet above airport elevation) with the aircraft in the landing configuration" | high (typical, not a limit) |
| FSF-GA | final landing configuration selected by 1000 ft (800–1500 by type); speed brakes retracted | "The final landing configuration should be selected." | high (proposed) |
| AB-STAB Table 3 | desired landing configuration at the stabilisation height; NPA: landing config and VAPP at the FAF | "For Non-Precision Approaches, some of these elements (desired landing configuration and VAPP) should be achieved when the aircraft reaches the FAF" | high |
| AB-NRG p.3/4 | speedbrakes usually not below 1000 ft; slats ≥ 3 nm before FAF | "Usually the use of speedbrakes is not recommended when below 1000 ft above airfield elevation and/or in the landing flaps configuration." | high |
| EASA-AMC (d)(5) | correct landing configuration; a later change is allowed if procedures require it after visual reference | "unless operating procedures require a final configuration change for performance reasons after visual reference is acquired" | high |
| D4S | late flap: any change > 2° or 1 notch, 1000 → 0 ft; late gear: any deployment or not deployed | table values | high |
| FAA-9179 / AFH16 | gear down and landing flaps early; jets: by 1000 ft AGL | "The airplane should be in the landing configuration by 1,000 feet AGL" (AFH16) | high |
| AFH9 | piston: full flaps not before final is established; landing configuration part of the 500/1000 ft criteria | "Full flaps are not recommended until the final approach is established." | high |
| Airbus CONF 3/FULL, Boeing flaps 30/40 etc. | landing-flap conventions | Airbus public: VLS shown for "CONF 3 or FULL" (AB-SF24). Boeing flap detents per type: only FCOM/FCTM → **not citable** | high (Airbus) / – |

## 6. Thrust / power

| Source | Rule | Wording | Conf. |
|---|---|---|---|
| FSF71 | appropriate for configuration; not below AOM minimum approach power | "Power setting is appropriate for the aircraft configuration and is not below the minimum power for approach as defined by the aircraft operating manual" | high |
| FSF71 p.3 | deviation pattern: approach flown at idle to touchdown | "Entire approach flown at idle thrust down to touchdown" | high |
| FSF-GA | thrust stabilised for the target speed | "Thrust is stabilized to maintain the target approach airspeed." | high |
| AB-STAB Table 3 | thrust stabilised, usually above idle | "The thrust is stabilized, usually above idle, to maintain the target approach speed along the desired final approach path" | high |
| EASA-AMC (d)(6) | thrust/power and trim appropriate | – | high |
| D4S p.14 | low thrust: N1 below a fleet-specific 1st percentile for 10 s (examples N1 < 35 % / < 30 % mentioned) | "Fleet specific (1st percentile) [10s]" | high |
| FAA-9179 §3.e | turbojet: engine speed for best response | "The engine speed should be at a setting that allows best response when and if a rapid power increase is needed." | high |
| AFH9 | piston: as FSF71 | "a power setting appropriate for the aircraft configuration and not below the minimum power for approach as defined by the AFM" | high |
| ATR | power consistent with weight, wind and vertical guidance | "Power setting is consistent with appropriate aircraft weight" | medium |

No public source gives an N1 value. `thrust_min_n1_pct = 40` is a VectaSim convention.

## 7. Localizer / glideslope and non-precision path

| Source | Rule | Wording | Conf. |
|---|---|---|---|
| FSF71 | ILS within 1 dot GS and LOC; CAT II/III within expanded localizer | "instrument landing system (ILS) approaches must be flown within one dot of the glideslope and localizer" | high |
| FSF-GA | CAT I ILS 1 dot; RNAV ½ scale; LOC/VOR 1 dot lateral; visual: PAPI 2.75–3.25°, lined up by 300 ft | "RNAV: within ½-scale deflection of vertical and lateral scales and within RNP requirements" | high (proposed) |
| AB-STAB Table 4 | callouts: LOC ¼ dot, GS 1 dot (or excessive deviation warning) | "1/4 dot or Excessive (Beam) Deviation Warning" (LOC); "1 dot …" (GS) | high (callout) |
| AB-SF24 | good practice: FLAPS 2 at one dot below GS on intercept | – | high (technique) |
| D4S p.14 | GS S1 ±1 dot, S2 ±2 dots (5 s; low GS 1000→500 ft); LOC S1 1 dot, S2 1.5 dots (5 s) | table values | high |
| EASA-AMC | "acceptable tolerance" set by operator; GM: lateral tolerance does not mean aligned with centreline by a given height | – | high |
| ATR | 1 dot lateral/vertical as example of small deviations to call and correct; +50/−0 ft at DA/MDA | "+50 / -0 ft" (altitude deviation at DA or MDA) | medium |

## 8. Go-around rules and "momentary" wording

| Source | Rule | Wording | Conf. |
|---|---|---|---|
| FSF71 | mandatory: unstable at or below the gate → immediate go-around; transient exceedances excepted | "if any flight parameter exceeds deviation limits (other than transiently) when below the minimum stabilization height, a go-around must be conducted immediately" | high |
| FSF61 | no-fault go-around policy | "'No-fault' ('no-blame') go-around policies should be implemented by operators" | high |
| FSF-GA (2017) | 1000/500 ft: continue only if the next gate is achievable; 300 ft: go around without hesitation; momentary overshoots acceptable | "momentary overshoots made necessary by atmospheric conditions; such overshoots are acceptable. Frequent or sustained overshoots are not." | high (proposed) |
| AB-STAB p.7 | go-around unless only small corrections are needed | "a go-around must be initiated unless the crew estimates that only small corrections are necessary to rectify minor deviations" | high |
| AB-SF24 (Stabilisation criteria box) | go-around if the crew assesses stabilisation cannot be reached before landing | ≈ PM calls out; go-around if stabilisation can't be obtained prior to landing | high |
| IATA rec. 3.1.1 | regulators should require a mandatory go-around when criteria are not met | "for a mandatory go-around to be flown if they are not met and maintained" | high |
| FAA-9179 / AFH16 / AFH9 | "should" go around if not stabilised at the gate | "If the approach is not stabilized at that height, a go-around should be initiated." (AFH16) | high |
| TC 2015-04 | go-around required if unstable or destabilised | "has become destabilized afterwards, a go-around is required." | high |
| D4S | no momentary wording; minimum durations 3–10 s per criterion | – | high |

## 9. Type-specific public items

| Item | Content | Source | Conf. |
|---|---|---|---|
| Airbus VLS | FBW (except A320 family): VLS = 1.23 × VS1G; A320 family: k × VS1G with 1.23 ≤ k ≤ 1.28; VLS ≥ VMCL | AB-SF24 (VLS section) | high |
| Airbus VAPP | VAPP = VLS (landing CONF) + APPR COR; AFS: APPR COR = ⅓ headwind, 5 ≤ APPR COR ≤ 15 kt; ≥ VLS+5 with A/THR, autoland, icing, gusty crosswind > 20 kt | AB-SF24 (VAPP section); AAIB states the same rule in its own words | high |
| Airbus VREF | VREF = VLS CONF FULL; failures: VAPP = VREF + ΔVREF + APPR COR | AB-SF24 (VAPP in case of system failure) | high |
| Airbus decelerated approach | reaches VAPP at 1000 ft; CONF 2 before FDP if intercept below 2000 ft (A320) / 2500 ft (A330/A340/A350/A380) | AB-SF24 (decelerated approach) | high |
| Generic VREF | 1.3 × stall speed (landing flaps) | FSF82 p.1; AFH16 p.16-20 | high |
| Certification VREF | ≥ 1.23 VSR0, ≥ VMCL | CFR125 / CS 25.125 | high |
| Wind additives (generic) | ½ steady headwind + full gust (max usually 20 kt), or ⅓ wind or gust (max usually 15 kt), or graphical; no additive for tailwind; +5 kt for A/THR; only the highest correction | FSF82 p.2 | high |
| Boeing "VREF + 5, ½ steady + gust, max 20" | FSF82 lists this method without naming the manufacturer. The Boeing attribution exists only in FCTM text or its copies → **not citable** as Boeing | – | – |
| Boeing flap conventions (flaps 30/40, 25/30) | FCOM/FCTM only → **not citable**; MSFS reports the handle index anyway | – | – |
| ATR | gates 1000/500/300 (circling), ±5 kt, ≤ 1000 fpm (ATR's public article, attributed to its FCTM) | ATR | medium |
| Embraer, Bombardier/De Havilland (Q400, CRJ), Textron/Cessna jets | no public stabilised-approach values found | – | – |

## 10. Light GA, turboprop, business jets

| Source | Content | Conf. |
|---|---|---|
| AFH9 p.9-6 | Piston criteria: 3° glide path; bank ≤ 15° on final; +10/−5 kt of AFM speed or 1.3 VSO; gear/flaps set and trimmed; 500–1000 fpm, below 500 fpm by 300 ft; power not below AFM minimum; gates 500 VMC / 1000 IMC, 300 ft AGL hard gate in the pattern | high |
| AFH9 (base leg, final approach) | base leg ≈ 1.4 VSO; final at manufacturer speed or 1.3 VSO | high |
| FSF71 (notice) | notes written for underwing-engine turbine aircraft, adaptable to turboprops and pistons | high |
| IOSA via IATA | lower stabilisation height (500 ft AAL, IMC/VMC) can be authorised for turboprop operations | high |
| ATR | turboprop: as section 9 | medium |
| NBAA / business jets | no NBAA numeric criteria found; business-jet operators are referred to FSF ALAR | low |
| HELI (optional) | helicopter APM guidelines; repeat the FSF 2017 fixed-wing gates; helicopter criteria are operator/IOGP specific | medium |

## Recommended profiles

Only parameters that differ from `ApproachConfig::default()` are listed. "inherit generic"
means no public source supports a different value. Column **VS conv.** = VectaSim
convention (not a published number). The reference speed is the pilot's/flown **Vapp**
in all profiles (`AircraftRef::vapp_kt`, flown median, or `vapp_vs0_factor × VS0`).

### P0 Generic (FSF / EASA) = today's defaults

No change. Basis: continuous S1/S2 from D4S p.14 (speed +20/+35, −5/−10 kt; 1200/1500
fpm; bank 15/30°; GS 1/2 dots; LOC 1/1.5 dots; durations 3–5 s); gates from FSF71 (1000
fpm, ±1 dot, speed window) and EASA-AMC (500/1000 ft). Notes:

| Parameter | Default | Traced to | VS conv. |
|---|---|---|---|
| `speed_s1/s2_above/below_kt` | 20/35, 5/10 | D4S p.14 (relative to **VREF**) | applied to Vapp = VectaSim choice |
| `gate_speed_above/below_kt` | 20 / 5 | FSF71 VREF+20 / ≥VREF, with Vapp ≈ VREF+5 → −5 | the −5 below Vapp is a conversion |
| `vs_s1/s2_fpm` | 1200 / 1500 | D4S | – |
| `gate_max_vs_fpm` | 1000 | FSF71, EASA GM1, AB-STAB | – |
| `bank_s1/s2_deg` | 15 / 30 | D4S; S2 also EASA AMC1 (b)(1) | – |
| `gate_max_bank_deg` | 15 | D4S S1 / AFH9; **not FSF** (FSF71 has no bank number) | yes, as gate value |
| `gate_dots` | 1.0 | FSF71 | – |
| `config_gate_ft`, `window_top_ft` | 1000 | FSF71 IMC gate, AFH16, FSF-GA config gate | single gate, no IMC/VMC |
| `thrust_min_n1_pct` / `thrust_duration_s` | 40 % / 5 s | D4S uses fleet 1st percentile for **10 s** | yes |
| `momentary_s` | 3 | FSF71 "other than transiently" (no number) | yes |

### P1 Airbus-style (A318–A321, A330/A340, A350, A380)

| Parameter | Value | Traced to | VS conv. |
|---|---|---|---|
| reference speed | Vapp = VLS + APPR COR (pilot input; else the flown median) | AB-SF24 | – |
| `gate_speed_above_kt` | **10** | AB-STAB Table 4 (VAPP+10) | callout limit used as gate |
| `gate_speed_below_kt` | 5 (= generic) | AB-STAB Table 4 (VAPP−5) | – |
| `gate_max_bank_deg` | **7** (optional) | AB-STAB Table 4 (> 7° callout) | callout limit used as gate; see open question |
| `gate_dots` | 1.0 (GS); LOC ¼ dot is a callout only → inherit generic for LOC | AB-STAB Table 4 | a separate LOC gate would need a new parameter |
| `gate_max_vs_fpm` | 1000 (= generic) | AB-STAB Table 4 | – |
| `config_gate_ft`, `window_top_ft` | 1000 (= generic) | AB-STAB Table 2, AB-SF24 (VAPP at 1000 ft) | – |
| `stats_speed_above/below_kt` | 10 / 5 (= generic) | AB-STAB Table 4 | – |
| continuous S1/S2, sink, bank S1/S2, thrust, momentary | inherit generic | no Airbus public value | – |

### P2 Boeing-style (737, 747, 757, 767, 777, 787, 717)

| Parameter | Value | Traced to | VS conv. |
|---|---|---|---|
| reference speed | VREF+5 (+ wind additive) when the pilot enters Vapp; else the flown median | FSF82 (generic "typical target"); FAA-9179 | not a Boeing-attributed value |
| all thresholds | **inherit generic** | Boeing's public material (BOE-AERO) points to the FSF ALAR tool kit; no Boeing numbers are public | – |
| optional: `gate_speed_above_kt` | 10 | AFH16 (jets, 0…+10 above target by 500 ft), FSF-GA 2017 | FAA/FSF generic jet value, **not** Boeing |

P2 is identical to P0 unless the optional AFH16 value is adopted. It exists so that the UI
can label the profile and so that a later public Boeing source can be added in one place.

### P3 Turboprop / regional (ATR 42/72, DHC-8, other multi-crew turboprops)

| Parameter | Value | Traced to | VS conv. |
|---|---|---|---|
| `gate_speed_above_kt` | **5** | ATR (±5 kt) | reference speed not stated by ATR |
| `gate_speed_below_kt` | 5 (= generic) | ATR | – |
| `gate_max_vs_fpm` | 1000 (= generic) | ATR, FSF71 | – |
| `config_gate_ft`, `window_top_ft` | 1000 (= generic) | ATR (1000 AAL IMC); IOSA allows 500 ft for turboprops | keep 1000 (no IMC/VMC) |
| `thrust_min_n1_pct` | **disable** (e.g. 0) | turboprop gas-generator N1 stays high at flight idle; no public torque value | yes |
| continuous S1/S2, bank, dots, momentary | inherit generic | no public turboprop-specific value | – |
| possible new parameter: sink-rate variation | ±300 fpm from target | ATR; cf. EASA AMC1 (c) 50 % | needs a new check |

### P4 GA piston (and single-pilot light aircraft)

| Parameter | Value | Traced to | VS conv. |
|---|---|---|---|
| reference speed | AFM approach speed, else 1.3 × VS0 (`vapp_vs0_factor` 1.3 = generic) | AFH9 | – |
| `gate_speed_above_kt` | **10** | AFH9 (+10) | – |
| `gate_speed_below_kt` | 5 (= generic) | AFH9 (−5) | – |
| `speed_s1_above_kt` | **10** | AFH9 tolerance | yes (S1 = AFH limit) |
| `speed_s2_above_kt` | **20** | – | yes (2 × S1) |
| `speed_s1/s2_below_kt` | 5 / 10 (= generic) | AFH9 (−5) | S2 convention |
| `stats_speed_above/below_kt` | 10 / 5 (= generic) | AFH9 | – |
| `vs_s1_fpm` | **1000** | AFH9 (500–1000 fpm) | yes |
| `vs_s2_fpm` | **1200** | – | yes |
| `gate_max_vs_fpm` | 1000 (= generic) | AFH9 upper bound | – |
| `bank_s1_deg`, `gate_max_bank_deg` | 15 (= generic) | AFH9 | – |
| `bank_s2_deg` | 30 (= generic) | EASA AMC1 (b)(1) | – |
| `config_gate_ft` | **500** | AFH9 (500 ft VMC gate; full flaps only once on final) | VMC assumed |
| `window_top_ft` | 1000 (= generic) or 500, see open questions | AFH9 | – |
| thrust check | inherit (already skipped: piston N1 = 0, `n1_valid_min_pct`) | – | – |
| possible new parameter: hard gate | 300 ft AGL ("unstable below 300 ft" instead of 500) | AFH9, FSF-GA | implemented as `hardGateFt` (GA piston: 300) |
| possible new rule | sink > 500 fpm below 300 ft | AFH9 | needs a new check |

## Type mapping (ICAO designator → profile)

| Group | ICAO designators | Profile | Note |
|---|---|---|---|
| Airbus FBW narrow-body | A318, A319, A320, A321, A19N, A20N, A21N | P1 | VLS factor 1.23–1.28 (AB-SF24) |
| Airbus FBW wide-body | A332, A333, A337, A338, A339, A342, A343, A345, A346, A359, A35K, A388 | P1 | – |
| Airbus pre-FBW | A306, A30B, A310 | P1 (stabilisation FOBN applies to all Airbus); VLS rule is FBW-specific | Vapp from the pilot or the flown median |
| A220 (ex-Bombardier CSeries) | BCS1, BCS3 | P0 | not an Airbus FBW design; AB-STAB predates it; no public A220 values |
| Boeing | B712, B732–B739, B37M, B38M, B39M, B3XM, B741–B744, B748, B74S, B752, B753, B762–B764, B772, B773, B77L, B77W, B778, B779, B788, B789, B78X | P2 | – |
| McDonnell Douglas | DC10, MD11, MD81–MD83, MD87, MD88, MD90 | P2 | Boeing heritage; still = generic |
| Embraer E-jets | E170, E75S, E75L, E190, E195, E290, E295 | P0 | no public Embraer values |
| Embraer ERJ | E135, E35L, E145, E45X | P0 | – |
| Bombardier CRJ | CRJ1, CRJ2, CRJ7, CRJ9, CRJX | P0 | – |
| ATR | AT43, AT44, AT45, AT46, AT72, AT73, AT75, AT76 | P3 | – |
| DHC-8 / Q400 | DH8A, DH8B, DH8C, DH8D | P3 | no public De Havilland values; turboprop category only |
| Other multi-crew turboprops | SF34, JS31, JS32, JS41, D328, F50, B190, DHC6, BE20, BE30, BE9L | P3 | category, not manufacturer |
| Business jets | C25A, C25B, C25C, C25M, C510, C525, C550, C560, C56X, C680, C68A, C700, C750, CL30, CL35, CL60, GLEX, GL5T, GL7T, G150, G280, GLF4, GLF5, GLF6, LJ35, LJ45, LJ60, E50P, E55P, E545, E550, FA7X, FA8X, F900, F2TH, PRM1, HDJT, PC24, SF50 | P0 | FSF ALAR applies to turbine aircraft; NBAA has no public numbers |
| Single-engine turboprops | PC12, TBM7, TBM8, TBM9, C208, KODI, M600 | P4 with thrust check disabled (implemented: P4 with the thrust check on, see the status note at the top) | VectaSim convention: flown like light aircraft, single pilot |
| GA piston | C150, C152, C172, C177, C182, C206, C210, P28A, P28B, P28R, P32R, PA34, PA44, PA46, SR20, SR22, S22T, DA20, DV20, DA40, DA42, DA62, BE33, BE35, BE36, BE55, BE58, M20P, M20T, AA5, TB20 | P4 | – |
| Helicopters | any H… type | none (optional) | outside the fixed-wing model; HELI as a pointer |
| Unknown / no designator | – | fallback by sim data: `ENGINE TYPE` jet → P0, turboprop with ≥ 2 engines → P3, turboprop single → P4 (no thrust check), piston → P4; nothing known → P0 (implemented: only piston → P4, recognised from the track; everything else → P0) | VectaSim convention |

Always show the profile in the debrief ("Assessed with: Airbus-style") so it is
transparent, and let the user override it per aircraft in the fleet.

## Open questions (no public source found)

1. **Boeing numbers**: no public Boeing document states its stabilised-approach speed
   band, sink limit, bank callout or wind-additive rule. Known values come from
   FCTM text (also as quoted in a TSB Canada report) → not citable. P2 stays generic.
2. **Embraer, Bombardier (CRJ, Q400/De Havilland), Textron**: no public stabilised
   criteria found.
3. **Reference speed for D4S thresholds**: D4S is relative to VREF; VectaSim applies
   them to Vapp (≈ VREF+5, Airbus VAPP = VLS + 5…15). Should the S1/S2 "below"
   thresholds be shifted by the additive (e.g. −10/−15 from Vapp) when a pilot enters
   Vapp with a large wind additive?
4. **Airbus 7° / ¼ dot**: these are PNF callout criteria, not stated stabilisation
   limits. Using them as gate failures may be too strict; alternative: show them as
   "callout would have been made" hints.
5. **Bank gate 15°**: labelled "FSF" in the code comment, but FSF71 has no bank number;
   the 15° comes from D4S S1 / AFH9. *Done in 0.6.2:* the code comment now names D4S S1 /
   AFH9.
6. **Thrust**: no public N1 value; D4S uses a fleet-specific 1st percentile over 10 s
   (VectaSim: 40 % for 5 s). Turboprop torque/power-lever criteria: none public.
7. **IMC/VMC**: all sources use two gates by weather; VectaSim has no IMC flag. Could
   the sim's visibility/cloud data choose 1000 vs 500 ft? Until then 1000 ft (jets,
   turboprops) and 500 ft (GA) are VectaSim conventions.
8. **FSF 2017 vs 2009**: FSF-GA proposes VREF…VREF+10, a 500 ft stable gate and a 300 ft
   go-around gate for all weather. It is "proposed for industry validation"; the 2009
   BN 7.1 is still the published tool kit. Which one should P0 follow?
9. **GA window top**: 1000 ft (consistent with the jets) or 500 ft (AFH VMC gate; avoids
   counting base-to-final turns)?
10. **New checks not in `ApproachConfig`**: EASA sink-rate variation ≤ 50 % of target;
    ATR ±300 fpm; AFH "below 500 fpm by 300 ft"; D4S pitch S1 > 10°/< −3°, S2 >
    15°/< −10°; a separate LOC gate; a 300 ft hard gate (*done in 0.6.2:* `hardGateFt`,
   300 ft for GA piston; the others are still open).
11. **Business jets / NBAA**: no public numbers; profile stays generic.
12. **AC 91-79B**: the FAA URL for AC 91-79B returned no PDF; this file cites
    AC 91-79A Chg 2. Check whether a newer revision has changed App. 1.
