//! Approach assessment against the mock circuit (EDDF 25C) and synthetic straight-ins.

use vectasim_core::approach::{
    self, AircraftRef, ApproachAnalysis, ApproachBand, ApproachConfig, ApproachOutcome, ApproachSample, ElevationSource, GateKind, GoAroundSource,
    LateralBand, MarkerKind, PhaseMark, VappSource,
};
use vectasim_core::landing::{CheckStatus, CriterionKind, M_PER_FT, M_PER_NM, RunwayEnd, RunwayFrame, RunwayGeometry, RunwayGeometrySource};
use vectasim_core::{FlightEvent, FlightSession, LandingRateSource, MockFlight, MockVariant, Telemetry, TouchdownReport};

fn to_sample(t: &Telemetry) -> ApproachSample {
    ApproachSample {
        t_ms: t.timestamp_ms,
        latitude: t.latitude,
        longitude: t.longitude,
        altitude_msl_ft: t.altitude_msl_ft,
        altitude_agl_ft: t.altitude_agl_ft,
        ground_speed_kt: t.ground_speed_kt,
        ias_kt: t.ias_kt,
        vertical_speed_fpm: t.vertical_speed_fpm,
        heading_true_deg: t.heading_true_deg,
        pitch_deg: t.pitch_deg,
        bank_deg: t.bank_deg,
        g_force: t.g_force,
        on_ground: t.on_ground,
        flaps_index: t.flaps_index,
        gear_pct: t.gear_pct,
        ..Default::default()
    }
}

struct Flown {
    track: Vec<ApproachSample>,
    phases: Vec<PhaseMark>,
    touchdowns: Vec<TouchdownReport>,
}

/// One loop of the mock at 20 Hz through a session, 1 Hz track as the recorder keeps it.
fn fly_loop(variant: MockVariant, n: u64) -> Flown {
    fly_loop_with(variant, n, to_sample)
}

/// [`fly_loop`] with another sample conversion (v1 fields only / track v2).
fn fly_loop_with(variant: MockVariant, n: u64, to_sample: fn(&Telemetry) -> ApproachSample) -> Flown {
    let mut flight = MockFlight::with_variant(variant);
    let mut session = FlightSession::new();
    let mut f = Flown { track: Vec::new(), phases: Vec::new(), touchdowns: Vec::new() };
    let hz = 20.0;
    let loop_s = variant.loop_seconds();
    let start = n as f64 * loop_s;
    for i in 1..=((loop_s + 10.0) * hz) as u64 {
        let t_s = start + i as f64 / hz;
        let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
        if i % 20 == 0 {
            f.track.push(to_sample(&t));
        }
        for ev in session.update(&t) {
            match ev {
                FlightEvent::Touchdown(r) => f.touchdowns.push(r),
                FlightEvent::PhaseChanged(tr) => f.phases.push(PhaseMark { from: tr.from, to: tr.to, t_ms: tr.timestamp_ms }),
                _ => {}
            }
        }
    }
    f
}

fn both_ends(r: RunwayEnd) -> Vec<RunwayEnd> {
    let b = RunwayEnd {
        ident: r.opposite_ident.clone(),
        opposite_ident: r.ident.clone(),
        threshold_lat: r.end_lat,
        threshold_lon: r.end_lon,
        end_lat: r.threshold_lat,
        end_lon: r.threshold_lon,
        ..r.clone()
    };
    vec![r, b]
}

fn gate_ok(a: &ApproachAnalysis, kind: GateKind) {
    let g = approach::gate(a, kind).unwrap();
    assert!(g.reached, "gate {kind:?} not reached");
    for c in &g.criteria {
        assert_ne!(c.status, CheckStatus::Fail, "gate {kind:?}: {c:?}");
    }
}

fn status(a: &ApproachAnalysis, kind: GateKind, c: CriterionKind) -> CheckStatus {
    approach::gate(a, kind).unwrap().criteria.iter().find(|x| x.kind == c).unwrap().status
}

#[test]
fn mock_circuit_is_a_stable_approach_to_25c() {
    // the standard variant is the demo flight: stable, with small errors (see mock_demo_*)
    let cfg = ApproachConfig::default();
    let ends = both_ends(MockFlight::runway());
    for n in 0..4 {
        let f = fly_loop(MockVariant::Standard, n);
        let all = approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &ends, &AircraftRef::default(), &cfg);
        assert_eq!(all.len(), 1, "loop {n}: {:?}", all.iter().map(|a| a.outcome).collect::<Vec<_>>());
        let a = &all[0];
        assert_eq!(a.outcome, ApproachOutcome::Landed { touchdown_index: 0 });
        assert_eq!(a.runway.as_ref().unwrap().ident, "25C");
        assert_eq!(a.elevation_source, ElevationSource::Touchdown);
        assert!((a.elevation_ft - 364.0).abs() < 1.0);
        assert_eq!(a.band, Some(ApproachBand::Stable), "loop {n}: {:#?}", a.exceedances);
        assert!(a.exceedances.is_empty());
        let sf = a.stability.stable_from_ft.expect("stable");
        assert!(sf >= 1000.0, "loop {n}: stable from {sf}");
        for k in [GateKind::TenNm, GateKind::Faf, GateKind::Ft1000, GateKind::Ft500] {
            gate_ok(a, k);
        }
        assert!(approach::gate(a, GateKind::Ft50).unwrap().reached);
        // within the gate limits at 1000 and 500 ft, measurable lateral/glidepath at both
        for k in [GateKind::Ft1000, GateKind::Ft500] {
            assert_eq!(status(a, k, CriterionKind::Glidepath), CheckStatus::Pass);
            assert_eq!(status(a, k, CriterionKind::Localizer), CheckStatus::Pass);
            assert_eq!(status(a, k, CriterionKind::Speed), CheckStatus::Pass);
        }
        // reference: flown Vapp from 500 → 100 ft
        assert_eq!(a.reference.vapp_source, VappSource::Flown);
        let v = a.reference.vapp_kt.unwrap();
        assert!((120.0..=135.0).contains(&v), "vapp {v}");
        assert_eq!(a.reference.landing_flaps_index, Some(4));
        // established on the 9 km final
        let est = a.established.as_ref().expect("established");
        assert!(est.dist_nm > 3.5 && est.dist_nm < 5.5, "established at {} nm", est.dist_nm);
        let kinds: Vec<MarkerKind> = a.markers.iter().map(|m| m.kind).collect();
        for k in [MarkerKind::Faf, MarkerKind::Gate1000, MarkerKind::Gate500, MarkerKind::Gate50, MarkerKind::Threshold, MarkerKind::Touchdown] {
            assert!(kinds.contains(&k), "loop {n}: no {k:?} in {kinds:?}");
        }
        assert!(a.markers.windows(2).all(|w| w[0].t_ms <= w[1].t_ms));
        // stability numbers exist and are small
        let st = &a.stability;
        assert!(st.gp_rms_dots.unwrap() < 0.5 && st.lat_rms_m.unwrap() < 35.0 && st.ias_mad_kt.unwrap() < 5.0, "{st:?}");
        assert!(st.vs_sd_fpm.is_some() && st.bank_max_deg.unwrap() < 10.0);
        let e = a.energy.as_ref().expect("energy");
        assert!(e.at_1000.as_ref().unwrap().total_ft.abs() < 400.0, "{e:?}");
        // profile: monotonic track distance, thinned above 3000 ft only
        assert!(a.samples.windows(2).all(|w| w[1].track_dist_m <= w[0].track_dist_m + 1e-6));
        assert!(a.samples.iter().any(|p| p.on_ground));
        assert!(a.go_around.is_none());
        // gear down and flaps 4 set before 1000 ft (the demo: flaps 4 only at ~1 100 ft)
        assert!(a.config_events.iter().all(|c| c.hat_ft > 1000.0), "{:?}", a.config_events);
    }
}

#[test]
fn mock_bounce_approach_is_stable_too() {
    let f = fly_loop(MockVariant::Bounce, 0);
    let all = approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &both_ends(MockFlight::runway()), &AircraftRef::default(), &ApproachConfig::default());
    assert_eq!(all.len(), 1);
    let a = &all[0];
    assert_eq!(a.outcome, ApproachOutcome::Landed { touchdown_index: 0 });
    assert_eq!(a.band, Some(ApproachBand::Stable), "{:#?}", a.exceedances);
    gate_ok(a, GateKind::Ft1000);
    gate_ok(a, GateKind::Ft500);
    assert!(a.stability.stable_from_ft.unwrap() >= 1000.0);
}

#[test]
fn mock_go_around_then_landing() {
    let f = fly_loop(MockVariant::GoAround, 0);
    assert_eq!(f.touchdowns.len(), 1, "{:?}", f.touchdowns);
    let all = approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &both_ends(MockFlight::runway()), &AircraftRef::default(), &ApproachConfig::default());
    let outcomes: Vec<ApproachOutcome> = all.iter().map(|a| a.outcome).collect();
    assert_eq!(outcomes, vec![ApproachOutcome::GoAround, ApproachOutcome::Landed { touchdown_index: 0 }]);
    let ga = &all[0];
    let g = ga.go_around.as_ref().unwrap();
    assert_eq!(g.detected_by, GoAroundSource::Both, "{g:?}");
    assert!((250.0..=310.0).contains(&g.lowest_hat_ft), "lowest {}", g.lowest_hat_ft);
    assert!(g.climb_ft >= 400.0 && g.climb_t_ms.is_some());
    assert_eq!(ga.runway.as_ref().map(|r| r.ident.as_str()), Some("25C"));
    assert_eq!(ga.elevation_source, ElevationSource::Database);
    assert_eq!(ga.band, Some(ApproachBand::Stable), "{:#?}", ga.exceedances);
    gate_ok(ga, GateKind::Ft1000);
    gate_ok(ga, GateKind::Ft500);
    assert!(!approach::gate(ga, GateKind::Ft50).unwrap().reached);
    assert!(ga.markers.iter().any(|m| m.kind == MarkerKind::GoAround));
    assert_eq!(all[1].index, 1);
    assert_eq!(all[1].band, Some(ApproachBand::Stable), "{:#?}", all[1].exceedances);
    assert!(all[1].start_t_ms > g.lowest_t_ms);
}

// ---- synthetic straight-ins on runway 09 --------------------------------------------------

const ELEV: f64 = 400.0;

fn runway09() -> RunwayEnd {
    let f = RunwayFrame::new(&RunwayEnd { threshold_lat: 50.0, threshold_lon: 8.0, end_lat: 50.0, end_lon: 8.03, ..Default::default() });
    let (end_lat, end_lon) = f.unproject(3000.0, 0.0);
    RunwayEnd {
        airport: "TEST".into(),
        ident: "09".into(),
        opposite_ident: "27".into(),
        threshold_lat: 50.0,
        threshold_lon: 8.0,
        end_lat,
        end_lon,
        length_m: 3000.0,
        width_m: 45.0,
        surface: "ASP".into(),
        elevation_ft: Some(ELEV),
    }
}

/// 3° straight-in from 6 nm at 1 Hz. `speed(hat, current)` gives the next IAS (= GS, no wind).
/// `go_around_ft`: climb away at 1500 fpm once the path is this low, no touchdown.
fn straight_in(speed: impl Fn(f64, f64) -> f64, go_around_ft: Option<f64>) -> (Vec<ApproachSample>, Vec<TouchdownReport>) {
    straight_in_y(speed, go_around_ft, |_| 0.0)
}

/// [`straight_in`] with a lateral offset `y(x)` (m, + = right) along the runway axis.
fn straight_in_y(speed: impl Fn(f64, f64) -> f64, go_around_ft: Option<f64>, y_of: impl Fn(f64) -> f64) -> (Vec<ApproachSample>, Vec<TouchdownReport>) {
    let f = RunwayFrame::new(&runway09());
    let tan = 3f64.to_radians().tan();
    let gpip = 50.0 * M_PER_FT / tan;
    let mut x = -6.0 * M_PER_NM;
    let mut kt = speed((gpip - x) * tan / M_PER_FT, 0.0);
    let mut h_ft = (gpip - x) * tan / M_PER_FT;
    let (mut flaring, mut on_ground, mut climbing) = (false, false, false);
    let mut out: Vec<ApproachSample> = Vec::new();
    let mut tds = Vec::new();
    let mut climb_s = 0;
    for t in 0..600u64 {
        let prev_h = h_ft;
        if climbing {
            h_ft += 25.0;
            climb_s += 1;
        } else if !on_ground {
            let line = ((gpip - x) * tan / M_PER_FT).max(0.0);
            if go_around_ft.is_some_and(|g| line <= g) {
                climbing = true;
            }
            if !flaring && line <= 20.0 {
                flaring = true;
            }
            h_ft = if flaring { (h_ft - 250.0 / 60.0).max(0.0) } else { line };
            on_ground = h_ft <= 0.0;
        } else {
            kt = (kt - 5.0).max(0.0);
        }
        if !on_ground && !climbing {
            kt = speed(h_ft, kt);
        }
        let vs = if on_ground && prev_h <= 0.0 { 0.0 } else { (h_ft - prev_h) * 60.0 };
        let (lat, lon) = f.unproject(x, y_of(x));
        let s = ApproachSample {
            t_ms: 1_000_000 + t * 1000,
            latitude: lat,
            longitude: lon,
            altitude_msl_ft: ELEV + h_ft,
            altitude_agl_ft: h_ft,
            ground_speed_kt: kt,
            ias_kt: kt,
            vertical_speed_fpm: vs,
            heading_true_deg: 90.0,
            pitch_deg: if climbing { 12.0 } else { 2.0 },
            bank_deg: 0.0,
            g_force: 1.0,
            on_ground,
            flaps_index: 3,
            gear_pct: 100.0,
            ..Default::default()
        };
        if on_ground && tds.is_empty() {
            tds.push(TouchdownReport {
                timestamp_ms: s.t_ms,
                vs_fpm_measured: -250.0,
                vs_fpm_sim: -250.0,
                vs_fpm_hardest: -250.0,
                peak_g: 1.1,
                pitch_deg: 3.0,
                bank_deg: 0.0,
                ground_speed_kt: kt,
                heading_true_deg: 90.0,
                latitude: lat,
                longitude: lon,
                bounces: 0,
                touch_and_go: false,
                landing_rate_fpm: -250.0,
                landing_rate_source: LandingRateSource::Sim,
            });
        }
        out.push(s);
        x += kt * 0.514_444;
        if (on_ground && kt <= 0.0) || climb_s > 90 {
            break;
        }
    }
    (out, tds)
}

#[test]
fn synthetic_go_around_from_300_ft_is_found_and_assessed() {
    let (track, tds) = straight_in(|_, _| 140.0, Some(300.0));
    assert!(tds.is_empty());
    let all = approach::analyze_flight(&track, &[], &tds, &both_ends(runway09()), &AircraftRef::default(), &ApproachConfig::default());
    assert_eq!(all.len(), 1);
    let a = &all[0];
    assert_eq!(a.outcome, ApproachOutcome::GoAround);
    let g = a.go_around.as_ref().unwrap();
    assert_eq!(g.detected_by, GoAroundSource::Track);
    assert!((280.0..=310.0).contains(&g.lowest_hat_ft), "lowest {}", g.lowest_hat_ft);
    assert!(g.lowest_x_m.unwrap() < 0.0 && g.max_pitch_deg >= 12.0);
    assert_eq!(a.runway.as_ref().unwrap().ident, "09");
    assert!(!a.runway.as_ref().unwrap().on_runway);
    assert_eq!(a.elevation_source, ElevationSource::Database);
    // the approach before it is assessed like any other
    assert_eq!(a.band, Some(ApproachBand::Stable), "{:#?}", a.exceedances);
    assert_eq!(a.stability.stable_from_ft, Some(1500.0));
    gate_ok(a, GateKind::Ft1000);
    gate_ok(a, GateKind::Ft500);
    assert!(!approach::gate(a, GateKind::Ft50).unwrap().reached);
    assert_eq!(a.reference.vapp_source, VappSource::Flown);
    assert!((a.reference.vapp_kt.unwrap() - 140.0).abs() < 0.01);
    // no landing flaps known without a touchdown: "≥ 1" fallback
    assert_eq!(a.reference.landing_flaps_index, None);
}

#[test]
fn too_fast_until_500_ft_violates_speed_s1() {
    // 170 kt until 500 ft, then −3 kt/s to 140 kt
    let (track, tds) = straight_in(|h, cur| if h > 500.0 { 170.0 } else { (cur - 3.0).max(140.0) }, None);
    assert_eq!(tds.len(), 1);
    let all = approach::analyze_flight(&track, &[], &tds, &both_ends(runway09()), &AircraftRef::default(), &ApproachConfig::default());
    let a = &all[0];
    assert!((a.reference.vapp_kt.unwrap() - 140.0).abs() < 1.0, "{:?}", a.reference);
    let speed: Vec<_> = a.exceedances.iter().filter(|e| e.kind == CriterionKind::Speed).collect();
    assert!(!speed.is_empty(), "{:#?}", a.exceedances);
    assert!(speed.iter().all(|e| e.peak > 20.0 && e.limit == 20.0));
    assert!(matches!(a.band, Some(ApproachBand::UnstableBelow500 | ApproachBand::Deviations)), "{:?}", a.band);
    assert!(a.stability.stable_from_ft.is_none_or(|s| s < 500.0), "{:?}", a.stability.stable_from_ft);
    assert_eq!(status(a, GateKind::Ft1000, CriterionKind::Speed), CheckStatus::Fail);
    // a pilot Vapp of 140 kt gives the same result, with its source named
    let ac = AircraftRef { vapp_kt: Some(140.0), vs0_kt: Some(105.0), ..Default::default() };
    let b = &approach::analyze_flight(&track, &[], &tds, &both_ends(runway09()), &ac, &ApproachConfig::default())[0];
    assert_eq!(b.reference.vapp_source, VappSource::User);
    assert_eq!(b.reference.vapp_plausible, Some(true));
    assert!(b.stability.stable_from_ft.is_none_or(|s| s < 500.0));
}

#[test]
fn without_runway_path_criteria_are_not_measurable() {
    let (track, tds) = straight_in(|_, _| 140.0, None);
    let a = &approach::analyze_flight(&track, &[], &tds, &[], &AircraftRef::default(), &ApproachConfig::default())[0];
    assert!(a.runway.is_none() && a.established.is_none() && a.energy.is_none());
    for k in [GateKind::Ft1000, GateKind::Ft500] {
        assert_eq!(status(a, k, CriterionKind::Glidepath), CheckStatus::Unavailable);
        assert_eq!(status(a, k, CriterionKind::Localizer), CheckStatus::Unavailable);
        assert_eq!(status(a, k, CriterionKind::VerticalSpeed), CheckStatus::Pass);
    }
    assert_eq!(a.band, Some(ApproachBand::Stable));
    assert!(a.stability.gp_rms_dots.is_none() && a.stability.lat_rms_m.is_none());
}

// ---- lateral guidance (extended centreline) ------------------------------------------------

fn lateral_of(y_of: impl Fn(f64) -> f64) -> ApproachAnalysis {
    let (track, tds) = straight_in_y(|_, _| 140.0, None, y_of);
    assert_eq!(tds.len(), 1);
    approach::analyze_flight(&track, &[], &tds, &both_ends(runway09()), &AircraftRef::default(), &ApproachConfig::default()).remove(0)
}

#[test]
fn lateral_on_the_centreline_is_its_own_clean_band() {
    let a = lateral_of(|_| 0.0);
    let l = &a.lateral;
    assert!(l.measurable);
    assert_eq!(l.lateral_band, Some(LateralBand::OnCentreline), "{l:?}");
    assert!(l.loc_max_dots.unwrap().abs() < 0.05, "{l:?}");
    assert!(l.lat_at_500_m.unwrap().abs() < 1.0 && l.lat_at_threshold_m.unwrap().abs() < 1.0, "{l:?}");
    assert!(l.loc_at_500_dots.unwrap().abs() < 0.05);
    assert_eq!(l.lateral_reversals, Some(0));
    assert_eq!(l.intercept_overshoot_m, None);
    assert_eq!(a.stability.loc_rms_dots.map(|r| r < 0.05), Some(true));
}

#[test]
fn constant_offset_right_is_a_marked_band_with_signed_values() {
    let a = lateral_of(|_| 100.0);
    let l = &a.lateral;
    assert_eq!(l.lateral_band, Some(LateralBand::Marked), "{l:?}");
    assert!((l.lat_at_500_m.unwrap() - 100.0).abs() < 1.0, "{l:?}");
    assert!((l.lat_at_threshold_m.unwrap() - 100.0).abs() < 1.0, "{l:?}");
    assert!(l.loc_max_dots.unwrap() > 1.0, "{l:?}");
    assert_eq!(l.lateral_reversals, Some(0));
    // flown in from the right and stayed there: no overshoot
    assert_eq!(l.intercept_overshoot_m, None);
    // the localizer gate criterion (±1 dot) fails at 500 ft
    assert_eq!(status(&a, GateKind::Ft500, CriterionKind::Localizer), CheckStatus::Fail);
}

#[test]
fn intercept_from_the_left_overshoots_to_the_right() {
    // 20° intercept from the left until 30 m left at x = −9000 m, then 0.15 m/m to 150 m
    // right (overshoot) and back to the centreline with 0.1 m/m – all above 1000 ft
    let x1 = -9000.0;
    let y = move |x: f64| {
        let u = x - x1;
        if u < 0.0 {
            -30.0 + 20f64.to_radians().tan() * u
        } else if u < 1200.0 {
            -30.0 + 0.15 * u
        } else {
            (150.0 - 0.1 * (u - 1200.0)).max(0.0)
        }
    };
    let a = lateral_of(y);
    let est = a.established.as_ref().expect("established");
    assert!(est.dist_nm < 9000.0 / M_PER_NM + 0.1 && est.dist_nm > 4.0, "established at {} nm", est.dist_nm);
    let l = &a.lateral;
    let m = l.intercept_overshoot_m.expect("overshoot");
    assert!((140.0..=151.0).contains(&m), "{l:?}");
    assert!(l.intercept_overshoot_dots.unwrap() > 0.5, "{l:?}");
    // the band window (1000 → 50 ft) is clean again
    assert_eq!(l.lateral_band, Some(LateralBand::OnCentreline), "{l:?}");
}

#[test]
fn s_turns_are_counted_as_reversals() {
    // ±50 m with a 2 km wavelength: several side changes between 1000 and 100 ft
    let a = lateral_of(|x| if x < -200.0 { 50.0 * (2.0 * std::f64::consts::PI * x / 2000.0).sin() } else { 0.0 });
    let l = &a.lateral;
    assert!(l.lateral_reversals.unwrap() >= 3, "{l:?}");
    assert!(matches!(l.lateral_band, Some(LateralBand::Slight | LateralBand::Marked)), "{l:?}");
    assert!(a.stability.loc_rms_dots.unwrap() > 0.3, "{:?}", a.stability);
}

#[test]
fn lateral_is_not_measurable_without_runway_or_with_a_derived_one() {
    let (track, tds) = straight_in(|_, _| 140.0, None);
    let a = &approach::analyze_flight(&track, &[], &tds, &[], &AircraftRef::default(), &ApproachConfig::default())[0];
    assert!(!a.lateral.measurable);
    assert_eq!(a.lateral.lateral_band, None);
    assert!(a.lateral.loc_max_dots.is_none() && a.lateral.lat_at_500_m.is_none() && a.lateral.lat_at_threshold_m.is_none());
    assert!(a.lateral.lateral_reversals.is_none() && a.lateral.intercept_overshoot_m.is_none());

    let mut b = lateral_of(|_| 0.0);
    assert_eq!(b.lateral.lateral_band, Some(LateralBand::OnCentreline));
    approach::apply_runway_geometry(&mut b, &RunwayGeometry { source: RunwayGeometrySource::Derived, ..Default::default() });
    assert!(!b.lateral.measurable);
    assert_eq!(b.lateral.lateral_band, None);
    assert_eq!(b.runway.as_ref().unwrap().geometry.source, RunwayGeometrySource::Derived);
    // database / user geometry keeps the band
    let mut c = lateral_of(|_| 0.0);
    approach::apply_runway_geometry(&mut c, &RunwayGeometry { source: RunwayGeometrySource::User, ..Default::default() });
    assert_eq!(c.lateral.lateral_band, Some(LateralBand::OnCentreline));
}

#[test]
fn lateral_band_thresholds() {
    let cfg = ApproachConfig::default();
    assert_eq!(approach::lateral_band_of(0.3, 0.5, &cfg), LateralBand::OnCentreline);
    assert_eq!(approach::lateral_band_of(0.2, 0.7, &cfg), LateralBand::Slight);
    assert_eq!(approach::lateral_band_of(0.6, 1.0, &cfg), LateralBand::Slight);
    assert_eq!(approach::lateral_band_of(0.4, 1.2, &cfg), LateralBand::Marked);
    assert_eq!(approach::lateral_band_of(0.7, 0.9, &cfg), LateralBand::Marked);
}

#[test]
fn mock_circuit_lateral_guidance() {
    let f = fly_loop(MockVariant::Standard, 0);
    let all = approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &both_ends(MockFlight::runway()), &AircraftRef::default(), &ApproachConfig::default());
    let l = &all[0].lateral;
    assert!(l.measurable);
    assert_eq!(l.lateral_band, Some(LateralBand::OnCentreline), "{l:?}");
    assert!(l.lat_at_500_m.unwrap().abs() < 15.0 && l.lat_at_threshold_m.unwrap().abs() < 15.0, "{l:?}");
    // the demo's gentle S (two side changes beyond 0.3 dot) and the intercept overshoot
    assert_eq!(l.lateral_reversals, Some(2), "{l:?}");
    assert!(l.intercept_overshoot_dots.is_some_and(|d| d > 0.5), "{l:?}");
}

/// The demo flight (standard variant) is stable but shows the assessment at work: the values
/// behind the debrief's hints (app/src/landing/facts.ts) – "Bei FAF … schneller", intercept
/// overshoot (> 0.5 dot), S-turns (≥ 2 side changes), landing flaps at ~1 100 ft – and the
/// targets of mock.rs `DEMO_*`.
#[test]
fn mock_demo_approach_shows_small_errors() {
    let cfg = ApproachConfig::default();
    for n in 0..4 {
        let f = fly_loop(MockVariant::Standard, n);
        let all = approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &both_ends(MockFlight::runway()), &AircraftRef::default(), &cfg);
        let a = &all[0];
        assert_eq!(a.band, Some(ApproachBand::Stable), "loop {n}: {:#?}", a.exceedances);
        assert_eq!(a.stability.stable_from_ft, Some(1500.0));
        let sample = |k: GateKind| approach::gate(a, k).unwrap().sample.clone().unwrap();
        // speed: ≈ +12 kt at the FAF (fafNote names it from 10 kt), ≈ +4 kt at 500 ft
        let (faf, g1000, g500) = (sample(GateKind::Faf), sample(GateKind::Ft1000), sample(GateKind::Ft500));
        assert!((10.5..=13.5).contains(&faf.ias_dev_kt.unwrap()), "loop {n}: FAF {:?}", faf.ias_dev_kt);
        assert!((2.5..=5.0).contains(&g500.ias_dev_kt.unwrap()), "loop {n}: 500 ft {:?}", g500.ias_dev_kt);
        let st = &a.stability;
        assert!(st.ias_mad_kt.unwrap() > 1.5 && st.ias_p95_abs_dev_kt.unwrap() > 5.0, "{st:?}");
        // glidepath: +0.5 dot at 1000 ft, captured at 500 ft, briefly −0.3 dot below 300 ft
        assert!((0.4..=0.55).contains(&g1000.gs_dots.unwrap()), "loop {n}: {:?}", g1000.gs_dots);
        assert!(g500.gs_dots.unwrap().abs() < 0.05, "loop {n}: {:?}", g500.gs_dots);
        assert!((-0.35..=-0.25).contains(&st.gp_max_below_dots.unwrap()), "{st:?}");
        // lateral: overshoot to the right after the left base turn, then the S, on the centreline band
        let l = &a.lateral;
        let od = l.intercept_overshoot_dots.expect("overshoot");
        assert!((0.55..=0.7).contains(&od) && l.intercept_overshoot_m.unwrap() > 70.0, "loop {n}: {l:?}");
        assert_eq!(l.lateral_reversals, Some(2), "loop {n}: {l:?}");
        assert_eq!(l.lateral_band, Some(LateralBand::OnCentreline), "loop {n}: {l:?}");
        assert!(l.loc_max_dots.unwrap().abs() <= 0.5, "{l:?}");
        assert!((7.5..=10.5).contains(&l.lat_at_threshold_m.unwrap()), "{l:?}");
        // landing flaps (4) late, but above the 1000 ft configuration gate
        let full = a.config_events.iter().find(|c| c.flaps_to == Some(4)).expect("flaps 4");
        assert!((1_000.0..=1_200.0).contains(&full.hat_ft), "{full:?}");
        // the landing: about −230 fpm
        assert!((-245.0..=-215.0).contains(&f.touchdowns[0].landing_rate_fpm), "{:?}", f.touchdowns[0]);
    }
}

#[test]
fn tas_from_ias_follows_isa() {
    assert!((approach::tas_from_ias(140.0, 0.0) - 140.0).abs() < 1e-9);
    // ~ +1.5 % per 1000 ft low down
    let t = approach::tas_from_ias(140.0, 10_000.0);
    assert!((t / 140.0 - 1.16).abs() < 0.01, "{t}");
}

// ---- stage 2: track v2 (sim ILS, wind, thrust, spoilers, landing flaps, automation) --------

use vectasim_core::approach::{EnergyBand, GlidepathSource, LandingFlapsSource, LocalizerSource, TasSource, nav_flags};

/// What the recorder keeps of a v2 sample (mirrors `TrackSample::to_approach_sample`).
fn to_sample_v2(t: &Telemetry) -> ApproachSample {
    let bits = [
        (t.nav_has_localizer, nav_flags::HAS_LOCALIZER),
        (t.nav_has_glide_slope, nav_flags::HAS_GLIDE_SLOPE),
        (t.nav_gs_flag, nav_flags::GLIDE_SLOPE_VALID),
        (t.autopilot_master, nav_flags::AUTOPILOT_MASTER),
        (t.autopilot_approach_hold, nav_flags::APPROACH_HOLD),
        (t.autopilot_glideslope_hold, nav_flags::GLIDE_SLOPE_HOLD),
        (t.autothrottle_active, nav_flags::AUTOTHRUST),
        (t.spoilers_armed, nav_flags::SPOILERS_ARMED),
    ];
    let recorded = bits.iter().any(|(v, _)| v.is_some());
    let flags = bits.iter().filter(|(v, _)| *v == Some(true)).fold(0, |a, (_, b)| a | b);
    let gs = flags & nav_flags::HAS_GLIDE_SLOPE != 0;
    ApproachSample {
        tas_kt: Some(t.tas_kt),
        wind_dir_true_deg: t.wind_dir_true_deg,
        wind_kt: t.wind_kt,
        gs_error_deg: t.nav_gs_error_deg.filter(|_| gs),
        loc_cdi: t.nav_cdi.filter(|_| flags & nav_flags::HAS_LOCALIZER != 0),
        gs_angle_deg: t.nav_gs_angle_deg.filter(|_| gs),
        nav_flags: flags,
        nav_recorded: recorded,
        n1_pct: t.n1_pct,
        spoilers_pct: t.spoilers_pct,
        alpha_deg: t.alpha_deg,
        ..to_sample(t)
    }
}

/// The mock's aircraft constants (track v2): VS0 104 kt, five flap handle positions.
fn mock_aircraft() -> AircraftRef {
    AircraftRef { vs0_kt: Some(104.0), flap_positions: Some(5), ..Default::default() }
}

fn has(a: &ApproachAnalysis, kind: GateKind, c: CriterionKind) -> bool {
    approach::gate(a, kind).unwrap().criteria.iter().any(|x| x.kind == c)
}

#[test]
fn v2_mock_takes_the_sim_ils_wind_thrust_and_automation() {
    let cfg = ApproachConfig::default();
    for n in 0..2 {
        let f = fly_loop_with(MockVariant::Standard, n, to_sample_v2);
        let all = approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &both_ends(MockFlight::runway()), &mock_aircraft(), &cfg);
        assert_eq!(all.len(), 1);
        let a = &all[0];
        // the demo stays stable with the new criteria
        assert_eq!(a.band, Some(ApproachBand::Stable), "loop {n}: {:#?}", a.exceedances);
        // ILS 25C: reference angle and deviations from the sim, the geometry agrees
        assert_eq!(a.reference.glidepath_source, GlidepathSource::Ils);
        assert!((a.reference.glidepath_deg - 3.0).abs() < 0.01);
        assert_eq!(a.reference.localizer_source, LocalizerSource::Ils);
        let ils = a.ils.as_ref().expect("ils");
        assert!(ils.gs_used && ils.loc_used && !ils.gs_rejected && !ils.loc_rejected && !ils.mismatch, "{ils:?}");
        assert!(ils.gs_share.unwrap() >= 0.95 && ils.loc_share.unwrap() >= 0.95, "{ils:?}");
        assert!(ils.gs_diff_dots.unwrap() < 0.1 && ils.loc_diff_dots.unwrap() < 0.15, "{ils:?}");
        assert!(ils.gs_rms_sim_dots.is_some() && ils.gs_rms_geo_dots.is_some() && ils.loc_rms_sim_dots.is_some());
        // the demo's errors are still seen through the sim's needles
        let g1000 = approach::gate(a, GateKind::Ft1000).unwrap().sample.clone().unwrap();
        assert!((0.4..=0.55).contains(&g1000.gs_dots.unwrap()), "{:?}", g1000.gs_dots);
        assert_eq!(a.lateral.lateral_reversals, Some(2), "{:?}", a.lateral);
        // wind 250°/8 kt on 25C (≈ 249° true): headwind, no crosswind, no shear
        let w = a.wind.as_ref().expect("wind");
        assert!((7.5..=8.1).contains(&w.headwind_kt.unwrap()) && w.crosswind_kt.unwrap().abs() < 1.0, "{w:?}");
        assert!(w.shear_kt.unwrap() < 0.5 && w.gust_spread_kt.unwrap() < 0.5 && (w.dir_true_deg.unwrap() - 250.0).abs() < 1.0, "{w:?}");
        // energy with the sim's TAS, band "good"
        let e = a.energy.as_ref().unwrap();
        assert_eq!(e.tas_source, TasSource::Recorded);
        assert_eq!(e.band, Some(EnergyBand::Good), "{e:?}");
        // configuration and thrust at the gates: landing flaps 4 (last handle position), N1, spoilers
        assert_eq!((a.reference.landing_flaps_index, a.reference.landing_flaps_source), (Some(4), LandingFlapsSource::AircraftPositions));
        for k in [GateKind::Ft1000, GateKind::Ft500] {
            assert_eq!(status(a, k, CriterionKind::LandingFlaps), CheckStatus::Pass);
            assert_eq!(status(a, k, CriterionKind::Thrust), CheckStatus::Pass);
            assert_eq!(status(a, k, CriterionKind::Spoilers), CheckStatus::Pass);
            assert!(!has(a, k, CriterionKind::Flaps), "landing flaps replace the >= 1 check");
            gate_ok(a, k);
        }
        // automation (informative): AP off at ~800 ft, A/THR down to the flare
        let au = a.automation.as_ref().expect("automation");
        assert!(au.autopilot_used && !au.autopilot_at_end && au.approach_mode, "{au:?}");
        assert!((700.0..=850.0).contains(&au.autopilot_off_hat_ft.unwrap()), "{au:?}");
        assert!(au.autothrust_used && au.autothrust_off_hat_ft.is_none_or(|h| h < 60.0), "{au:?}");
        // Vapp: the flown median, plausible against VS0
        assert_eq!(a.reference.vapp_source, VappSource::Flown);
        assert_eq!(a.reference.vapp_plausible, Some(true));
        // profile carries both sources and the engine values
        assert!(a.samples.iter().any(|p| p.gs_dots_sim.is_some() && p.gs_dots_geo.is_some() && p.n1_pct.is_some() && p.spoilers_pct.is_some()));
    }
}

#[test]
fn v1_track_falls_back_to_the_geometry_and_assumptions() {
    let f = fly_loop(MockVariant::Standard, 0);
    let a = &approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &both_ends(MockFlight::runway()), &AircraftRef::default(), &ApproachConfig::default())[0];
    assert_eq!((a.reference.glidepath_source, a.reference.localizer_source), (GlidepathSource::Assumed, LocalizerSource::Geometric));
    assert!(a.ils.is_none() && a.wind.is_none() && a.automation.is_none());
    assert_eq!(a.energy.as_ref().unwrap().tas_source, TasSource::Derived);
    for k in [GateKind::Ft1000, GateKind::Ft500] {
        assert!(!has(a, k, CriterionKind::Thrust) && !has(a, k, CriterionKind::Spoilers));
        // landing flaps from the touchdown on a v1 track
        assert_eq!(status(a, k, CriterionKind::LandingFlaps), CheckStatus::Pass);
    }
    assert_eq!(a.reference.landing_flaps_source, LandingFlapsSource::Touchdown);
    assert!(a.samples.iter().all(|p| p.gs_dots_sim.is_none() && p.n1_pct.is_none()));
}

#[test]
fn v2_mock_go_around_uses_the_ils_on_both_approaches() {
    let f = fly_loop_with(MockVariant::GoAround, 0, to_sample_v2);
    let all = approach::analyze_flight(&f.track, &f.phases, &f.touchdowns, &both_ends(MockFlight::runway()), &mock_aircraft(), &ApproachConfig::default());
    let outcomes: Vec<ApproachOutcome> = all.iter().map(|a| a.outcome).collect();
    assert_eq!(outcomes, vec![ApproachOutcome::GoAround, ApproachOutcome::Landed { touchdown_index: 0 }]);
    for a in &all {
        assert_eq!(a.band, Some(ApproachBand::Stable), "{:#?}", a.exceedances);
        assert_eq!(a.reference.glidepath_source, GlidepathSource::Ils);
        assert!(a.wind.is_some() && a.automation.is_some());
        gate_ok(a, GateKind::Ft1000);
        gate_ok(a, GateKind::Ft500);
    }
    // the go-around's thrust increase is no "idle" exceedance; landing flaps from the handle positions
    assert_eq!(all[0].reference.landing_flaps_source, LandingFlapsSource::AircraftPositions);
    assert!(all[0].exceedances.iter().all(|e| e.kind != CriterionKind::Thrust));
}

// synthetic straight-ins on 09 with v2 values

const GS_DOT_DEG: f64 = 0.35;

/// Adds v2 values to a synthetic straight-in: the sim's ILS from the true geometry plus
/// `gs_off` / `loc_off` dots, TAS = IAS, the wind and N1/spoilers from the closures (by HAT).
fn with_v2(track: &mut [ApproachSample], gs_off: f64, loc_off: f64, wind: impl Fn(f64) -> (f64, f64), n1: impl Fn(f64) -> f64, spoilers: impl Fn(f64) -> f64) {
    let f = RunwayFrame::new(&runway09());
    let gpip = 50.0 * M_PER_FT / 3f64.to_radians().tan();
    let ant = f.length_m + 300.0;
    let dot = 52f64.atan2(ant).to_degrees();
    for s in track.iter_mut() {
        let (x, y) = f.project(s.latitude, s.longitude);
        let h = s.altitude_msl_ft - ELEV;
        let gs_err = (h * M_PER_FT).atan2(gpip - x).to_degrees() - 3.0 + gs_off * GS_DOT_DEG;
        let loc_dots = y.atan2(ant - x).to_degrees() / dot + loc_off;
        let (wd, wk) = wind(h);
        s.tas_kt = Some(s.ias_kt);
        s.wind_dir_true_deg = Some(wd);
        s.wind_kt = Some(wk);
        s.nav_recorded = true;
        s.nav_flags = nav_flags::HAS_LOCALIZER | nav_flags::HAS_GLIDE_SLOPE | nav_flags::GLIDE_SLOPE_VALID;
        s.gs_error_deg = Some(gs_err);
        s.gs_angle_deg = Some(3.0);
        s.loc_cdi = Some((-loc_dots / 2.0 * 127.0).clamp(-127.0, 127.0));
        s.n1_pct = Some(n1(h));
        s.spoilers_pct = Some(spoilers(h));
    }
}

fn analyze_v2(track: &[ApproachSample], tds: &[TouchdownReport], ac: &AircraftRef) -> ApproachAnalysis {
    approach::analyze_flight(track, &[], tds, &both_ends(runway09()), ac, &ApproachConfig::default()).remove(0)
}

#[test]
fn sim_ils_close_to_the_geometry_is_used_with_a_mismatch_note_above_half_a_dot() {
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 0.0, 0.0, |_| (90.0, 10.0), |_| 55.0, |_| 0.0);
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    let ils = a.ils.as_ref().unwrap();
    assert!(ils.gs_used && ils.loc_used && !ils.mismatch, "{ils:?}");
    assert_eq!(a.band, Some(ApproachBand::Stable), "{:#?}", a.exceedances);
    // 0.7 dot high on the sim's glideslope: still used (≤ 1°), the gates see it, a mismatch note
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 0.7, 0.0, |_| (90.0, 10.0), |_| 55.0, |_| 0.0);
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    let ils = a.ils.as_ref().unwrap();
    assert!(ils.gs_used && ils.mismatch && (ils.gs_diff_dots.unwrap() - 0.7).abs() < 0.05, "{ils:?}");
    let g = approach::gate(&a, GateKind::Ft1000).unwrap().sample.clone().unwrap();
    assert!((g.gs_dots.unwrap() - 0.7).abs() < 0.05, "{:?}", g.gs_dots);
}

#[test]
fn foreign_ils_is_rejected_and_the_geometry_used() {
    // glideslope 4 dots (1.4°) and localizer 3 dots off the geometry: another runway's ILS
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 4.0, 3.0, |_| (90.0, 10.0), |_| 55.0, |_| 0.0);
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    let ils = a.ils.as_ref().unwrap();
    assert!(!ils.gs_used && !ils.loc_used && ils.gs_rejected && ils.loc_rejected && ils.mismatch, "{ils:?}");
    assert_eq!((a.reference.glidepath_source, a.reference.localizer_source), (GlidepathSource::Assumed, LocalizerSource::Geometric));
    assert_eq!(a.band, Some(ApproachBand::Stable), "geometry: on the path – {:#?}", a.exceedances);
}

#[test]
fn ils_without_enough_valid_glideslope_stays_geometric() {
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 0.0, 0.0, |_| (90.0, 10.0), |_| 55.0, |_| 0.0);
    // glideslope flag lost below 700 ft: well under 60 % of 1000 → 200 ft valid
    for s in track.iter_mut().filter(|s| s.altitude_msl_ft - ELEV < 700.0) {
        s.nav_flags &= !nav_flags::GLIDE_SLOPE_VALID;
    }
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    let ils = a.ils.as_ref().unwrap();
    assert!(ils.gs_share.unwrap() < 0.6 && !ils.gs_used && !ils.gs_rejected && ils.loc_used, "{ils:?}");
    assert_eq!(a.reference.glidepath_source, GlidepathSource::Assumed);
}

#[test]
fn wind_in_the_final_tailwind_crosswind_and_shear() {
    // runway 09: wind from 270° = tailwind; 20 kt at 1000 ft veering to 360°/18 kt near the ground
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 0.0, 0.0, |h| if h > 500.0 { (270.0, 20.0) } else { (360.0, 18.0) }, |_| 55.0, |_| 0.0);
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    let w = a.wind.as_ref().unwrap();
    assert!(w.top_kt.unwrap() > 19.0 && w.bottom_kt.unwrap() > 17.0, "{w:?}");
    assert!(w.shear_kt.unwrap() > 25.0, "{w:?}");
    assert!(w.headwind_change_kt.unwrap() > 15.0, "tailwind 20 → 0 kt: {w:?}");
    assert!(w.gust_spread_kt.unwrap() >= 2.0 - 1e-9, "{w:?}");
    assert!(w.shear_kt.unwrap() > ApproachConfig::default().wind_shear_kt);
    // a steady crosswind from the right
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 0.0, 0.0, |_| (180.0, 17.0), |_| 55.0, |_| 0.0);
    let w = analyze_v2(&track, &tds, &AircraftRef::default()).wind.unwrap();
    assert!((w.crosswind_kt.unwrap() - 17.0).abs() < 0.5 && w.headwind_kt.unwrap().abs() < 0.5 && w.shear_kt.unwrap() < 0.5, "{w:?}");
}

#[test]
fn idle_thrust_and_extended_spoilers_are_criteria_with_their_durations() {
    // idle (25 % N1) from 800 to 400 ft, spoilers 30 % from 900 to 600 ft
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(
        &mut track,
        0.0,
        0.0,
        |_| (90.0, 5.0),
        |h| if (400.0..=800.0).contains(&h) { 25.0 } else { 55.0 },
        |h| if (600.0..=900.0).contains(&h) { 30.0 } else { 0.0 },
    );
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    let kinds: Vec<CriterionKind> = a.exceedances.iter().map(|e| e.kind).collect();
    assert!(kinds.contains(&CriterionKind::Thrust) && kinds.contains(&CriterionKind::Spoilers), "{:#?}", a.exceedances);
    let t = a.exceedances.iter().find(|e| e.kind == CriterionKind::Thrust).unwrap();
    assert!(t.peak < 30.0 && t.limit == 40.0 && t.below_500, "{t:?}");
    assert_eq!(a.band, Some(ApproachBand::UnstableBelow500));
    assert_eq!(status(&a, GateKind::Ft500, CriterionKind::Thrust), CheckStatus::Fail);
    assert_eq!(status(&a, GateKind::Ft1000, CriterionKind::Thrust), CheckStatus::Pass);
    // the retard below 50 ft and a short idle blip (< 5 s) do not count
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 0.0, 0.0, |_| (90.0, 5.0), |h| if h < 45.0 || (600.0..=630.0).contains(&h) { 22.0 } else { 55.0 }, |_| 0.0);
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    assert_eq!(a.band, Some(ApproachBand::Stable), "{:#?}", a.exceedances);
}

#[test]
fn piston_n1_of_zero_is_not_recorded_thrust() {
    let (mut track, tds) = straight_in(|_, _| 140.0, None);
    with_v2(&mut track, 0.0, 0.0, |_| (90.0, 5.0), |_| 0.0, |_| 0.0);
    let a = analyze_v2(&track, &tds, &AircraftRef::default());
    assert!(!has(&a, GateKind::Ft1000, CriterionKind::Thrust) && has(&a, GateKind::Ft1000, CriterionKind::Spoilers));
    assert_eq!(a.band, Some(ApproachBand::Stable));
}

#[test]
fn landing_flaps_of_the_airframe_win_over_the_handle_positions() {
    // the synthetic flies flaps 3: an airframe landing in CONF 3 passes, FULL (4) expected fails
    let (track, tds) = straight_in(|_, _| 140.0, None);
    let ac3 = AircraftRef { landing_flaps_index: Some(3), flap_positions: Some(5), ..Default::default() };
    let a = analyze_v2(&track, &tds, &ac3);
    assert_eq!((a.reference.landing_flaps_index, a.reference.landing_flaps_source), (Some(3), LandingFlapsSource::User));
    assert_eq!(status(&a, GateKind::Ft1000, CriterionKind::LandingFlaps), CheckStatus::Pass);
    let ac = AircraftRef { flap_positions: Some(5), ..Default::default() };
    let b = analyze_v2(&track, &tds, &ac);
    assert_eq!((b.reference.landing_flaps_index, b.reference.landing_flaps_source), (Some(4), LandingFlapsSource::AircraftPositions));
    assert_eq!(status(&b, GateKind::Ft1000, CriterionKind::LandingFlaps), CheckStatus::Fail);
    assert_eq!(status(&b, GateKind::Ft500, CriterionKind::LandingFlaps), CheckStatus::Fail);
}

#[test]
fn vapp_cascade_ends_with_vs0_times_1_3() {
    // go-around from 600 ft: no IAS sample 500 → 100 ft, so no flown median
    let (track, tds) = straight_in(|_, _| 140.0, Some(600.0));
    let a = analyze_v2(&track, &tds, &AircraftRef { vs0_kt: Some(105.0), ..Default::default() });
    assert_eq!(a.reference.vapp_source, VappSource::Design);
    assert!((a.reference.vapp_kt.unwrap() - 136.5).abs() < 1e-9);
    assert_eq!(a.reference.vapp_plausible, None, "VS0-based: no plausibility statement");
    let b = analyze_v2(&track, &tds, &AircraftRef::default());
    assert_eq!((b.reference.vapp_source, b.reference.vapp_kt), (VappSource::Unavailable, None));
    // the pilot's value first
    let c = analyze_v2(&track, &tds, &AircraftRef { vs0_kt: Some(105.0), vapp_kt: Some(132.0), ..Default::default() });
    assert_eq!((c.reference.vapp_source, c.reference.vapp_kt), (VappSource::User, Some(132.0)));
}

#[test]
fn energy_band_high_when_fast_far_out() {
    // 200 kt until 1500 ft – a lot of speed energy far out
    let (mut track, tds) = straight_in(|h, cur| if h > 1500.0 { 200.0 } else { (cur - 2.0).max(140.0) }, None);
    with_v2(&mut track, 0.0, 0.0, |_| (90.0, 5.0), |_| 55.0, |_| 0.0);
    let a = analyze_v2(&track, &tds, &AircraftRef { vapp_kt: Some(140.0), ..Default::default() });
    let e = a.energy.as_ref().unwrap();
    assert_eq!(e.band, Some(EnergyBand::High), "{e:?}");
    assert!(e.band_max_ft.unwrap() >= 500.0, "{e:?}");
}
