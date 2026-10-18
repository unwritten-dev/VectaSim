//! The mock flight's landing as the landing debrief sees it: straight-in on EDDF 25C,
//! touchdown in the touchdown zone beside the centreline, stabilised approach.

use vectasim_core::landing::{self, CheckStatus, LandingConfig, LandingSample, RunwayFrame, SpeedReferenceSource};
use vectasim_core::{FlightEvent, FlightSession, MockFlight, MockVariant, Telemetry, TouchdownReport};

fn to_sample(t: &Telemetry) -> LandingSample {
    LandingSample {
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
    }
}

/// One loop (`n`) of the mock at 20 Hz through a session; returns the 1 Hz track (as the
/// recorder keeps it) and the touchdown reports.
fn fly_loop(variant: MockVariant, n: u64) -> (Vec<LandingSample>, Vec<TouchdownReport>) {
    let mut flight = MockFlight::with_variant(variant);
    let mut session = FlightSession::new();
    let (mut track, mut tds) = (Vec::new(), Vec::new());
    let hz = 20.0;
    let start = n as f64 * MockFlight::loop_seconds();
    let steps = ((MockFlight::loop_seconds() + 10.0) * hz) as u64;
    for i in 1..=steps {
        let t_s = start + i as f64 / hz;
        let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
        if i % 20 == 0 {
            track.push(to_sample(&t));
        }
        for ev in session.update(&t) {
            if let FlightEvent::Touchdown(r) = ev {
                tds.push(r);
            }
        }
    }
    (track, tds)
}

#[test]
fn mock_landing_is_a_stabilised_straight_in_to_25c() {
    let cfg = LandingConfig::default();
    let rwy = MockFlight::runway();
    let frame = RunwayFrame::new(&rwy);
    for n in 0..4 {
        let (track, tds) = fly_loop(MockVariant::Standard, n);
        assert_eq!(tds.len(), 1, "loop {n}: {tds:?}");
        let td = &tds[0];
        assert_eq!(td.bounces, 0);
        assert!((-200.0..=-100.0).contains(&td.landing_rate_fpm), "loop {n}: rate {}", td.landing_rate_fpm);
        assert!(td.vs_fpm_sim < 0.0, "loop {n}: the sim value of this landing is used");
        assert!((td.heading_true_deg - frame.heading_deg).abs() < 0.5);

        let a = landing::analyze(&track, &tds, 0, std::slice::from_ref(&rwy), None, &cfg).expect("analysis");
        let m = a.runway.as_ref().expect("runway matched");
        assert_eq!((m.ident.as_str(), m.on_runway), ("25C", true));
        let p = a.touchdown_point.as_ref().expect("touchdown point");
        assert!((330.0..=380.0).contains(&p.distance_m), "loop {n}: touchdown {} m past the threshold", p.distance_m);
        assert!(p.lateral_m.abs() <= 5.0, "loop {n}: {} m beside the centreline", p.lateral_m);
        // zone from the threshold (0 … 900 m on 4 000 m); 400 m is the aiming point
        assert!(p.in_tdz);
        assert_eq!((p.tdz_start_m, p.tdz_end_m, p.aiming_point_m), (0.0, 900.0, 400.0));
        assert_eq!(m.width_m, Some(60.0));

        // speed reference: the flown median 500 → 100 ft (no Vapp known), not IAS@500 itself
        assert_eq!(a.reference_speed_source, SpeedReferenceSource::Flown);
        let vref = a.reference_speed_kt.expect("reference speed");
        assert!((120.0..=135.0).contains(&vref), "loop {n}: reference {vref}");

        let thr = a.threshold.as_ref().expect("threshold crossing");
        assert!((40.0..=60.0).contains(&thr.height_ft), "loop {n}: TCH {}", thr.height_ft);
        assert!((122.0..=130.0).contains(&thr.ias_kt), "loop {n}: IAS at threshold {}", thr.ias_kt);

        let flare = a.flare.as_ref().expect("flare");
        assert!(flare.approach_vs_fpm < -600.0 && flare.approach_vs_fpm > -800.0, "{flare:?}");
        // the 1 Hz track sees the flare up to ~1 s before contact
        assert!(flare.final_vs_fpm > -350.0 && flare.final_vs_fpm > flare.approach_vs_fpm + 300.0, "{flare:?}");

        let ap = &a.approach;
        assert!(ap.ias_max_kt.unwrap() < 145.0 && ap.ias_min_kt.unwrap() > 115.0, "{ap:?}");
        assert!(ap.glidepath_dev_at_1000_deg.unwrap().abs() < 0.3, "{ap:?}");
        // every gate the approach passed is fully stable
        for g in a.gates.iter().filter(|g| g.reached) {
            for c in &g.criteria {
                assert_ne!(c.status, CheckStatus::Fail, "gate {} ft: {c:?}", g.gate_ft);
            }
        }
        let ro = a.rollout.as_ref().expect("rollout");
        assert!(ro.distance_m > 600.0 && ro.distance_m < 1_300.0, "{ro:?}");
    }
}

#[test]
fn mock_touchdown_value_differs_between_consecutive_landings() {
    // the detector ignores a sim value equal to the previous landing's, so the mock varies it
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let mut rates = Vec::new();
    let hz = 10.0;
    for i in 1..=((2.0 * MockFlight::loop_seconds() + 10.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
        for ev in session.update(&t) {
            if let FlightEvent::Touchdown(r) = ev {
                rates.push((r.landing_rate_fpm, r.landing_rate_source));
            }
        }
    }
    assert_eq!(rates.len(), 2, "{rates:?}");
    assert_ne!(rates[0].0, rates[1].0);
    assert!(rates.iter().all(|r| r.1 == vectasim_core::LandingRateSource::Sim), "{rates:?}");
}

#[test]
fn bounce_variant_bounces_once() {
    let cfg = LandingConfig::default();
    let rwy = MockFlight::runway();
    let (track, tds) = fly_loop(MockVariant::Bounce, 0);
    assert_eq!(tds.len(), 1, "{tds:?}");
    let td = &tds[0];
    assert_eq!((td.bounces, td.touch_and_go), (1, false), "{td:?}");
    assert!(td.landing_rate_fpm <= -250.0, "worst contact: {td:?}");
    let a = landing::analyze(&track, &tds, 0, std::slice::from_ref(&rwy), None, &cfg).expect("analysis");
    assert_eq!(a.bounce_points.len(), 1, "{:?}", a.bounce_points);
    assert!(a.touchdown_point.as_ref().unwrap().in_tdz);
}
