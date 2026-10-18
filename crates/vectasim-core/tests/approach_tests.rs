//! Approach assessment against the mock circuit (EDDF 25C) and synthetic straight-ins.

use vectasim_core::approach::{
    self, AircraftRef, ApproachAnalysis, ApproachBand, ApproachConfig, ApproachOutcome, ApproachSample, ElevationSource, GateKind, GoAroundSource,
    MarkerKind, PhaseMark, VappSource,
};
use vectasim_core::landing::{CheckStatus, CriterionKind, M_PER_FT, M_PER_NM, RunwayEnd, RunwayFrame};
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
        // on the 3° path at 1000 ft, measurable lateral/glidepath at both gates
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
        assert!(st.gp_rms_dots.unwrap() < 0.5 && st.lat_rms_m.unwrap() < 10.0 && st.ias_mad_kt.unwrap() < 5.0, "{st:?}");
        assert!(st.vs_sd_fpm.is_some() && st.bank_max_deg.unwrap() < 5.0);
        let e = a.energy.as_ref().expect("energy");
        assert!(e.at_1000.as_ref().unwrap().total_ft.abs() < 400.0, "{e:?}");
        // profile: monotonic track distance, thinned above 3000 ft only
        assert!(a.samples.windows(2).all(|w| w[1].track_dist_m <= w[0].track_dist_m + 1e-6));
        assert!(a.samples.iter().any(|p| p.on_ground));
        assert!(a.go_around.is_none());
        // gear down and flaps 4 set before 1000 ft
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
        let (lat, lon) = f.unproject(x, 0.0);
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

#[test]
fn tas_from_ias_follows_isa() {
    assert!((approach::tas_from_ias(140.0, 0.0) - 140.0).abs() < 1e-9);
    // ~ +1.5 % per 1000 ft low down
    let t = approach::tas_from_ias(140.0, 10_000.0);
    assert!((t / 140.0 - 1.16).abs() < 0.01, "{t}");
}
