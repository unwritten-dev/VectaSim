//! The server with a made-up flight, for working on the overlays without the app or a sim:
//! `cargo run -p vectasim-server --example demo [port] [--lan] [--privacy]`, then open
//! http://127.0.0.1:8095/. A 60 s loop: descent → approach → final → touchdown at 30 s →
//! taxi in → saved at 50 s.

use std::sync::Arc;
use std::time::Instant;
use vectasim_core::{FlightPhase, FlightState, LandingRateSource, TouchdownReport};
use vectasim_server::api::{Aircraft, Flight, Fuel, Landing, LogbookEntry, Snapshot, Status, Telemetry};
use vectasim_server::{Config, DEFAULT_PORT, Server, Source};

struct Demo {
    start: Instant,
    privacy: bool,
}

const CYCLE_S: f64 = 60.0;
const TOUCHDOWN_S: f64 = 30.0;
const SAVED_S: f64 = 50.0;

fn now_ms() -> u64 {
    vectasim_core::now_ms()
}

fn aircraft() -> Aircraft {
    Aircraft {
        title: Some("Airbus A320neo Lufthansa D-AINA".into()),
        icao_type: Some("A20N".into()),
        registration: Some("D-AINA".into()),
        airline: Some("Lufthansa".into()),
    }
}

impl Demo {
    fn t(&self) -> f64 {
        self.start.elapsed().as_secs_f64() % CYCLE_S
    }

    fn report(&self) -> TouchdownReport {
        let cycle_start = now_ms() - (self.t() * 1000.0) as u64;
        TouchdownReport {
            timestamp_ms: cycle_start + (TOUCHDOWN_S * 1000.0) as u64,
            vs_fpm_measured: -151.0,
            vs_fpm_sim: -142.0,
            vs_fpm_hardest: -151.0,
            peak_g: 1.18,
            pitch_deg: 3.1,
            bank_deg: 0.4,
            ground_speed_kt: 131.0,
            heading_true_deg: 270.0,
            latitude: 51.4775,
            longitude: -0.4614,
            bounces: 0,
            touch_and_go: false,
            landing_rate_fpm: -142.0,
            landing_rate_source: LandingRateSource::Sim,
        }
    }
}

impl Source for Demo {
    fn snapshot(&self) -> Snapshot {
        let t = self.t();
        let landed = t >= TOUCHDOWN_S;
        let phase = match t {
            t if t < 10.0 => FlightPhase::Descent,
            t if t < 20.0 => FlightPhase::Approach,
            t if t < TOUCHDOWN_S => FlightPhase::Final,
            t if t < 35.0 => FlightPhase::Landing,
            t if t < SAVED_S => FlightPhase::TaxiIn,
            _ => FlightPhase::Shutdown,
        };
        let alt = if landed { 83.0 } else { 6000.0 * (1.0 - t / TOUCHDOWN_S) + 83.0 };
        let gs = if landed { (131.0 - (t - TOUCHDOWN_S) * 8.0).max(15.0) } else { 250.0 - t * 4.0 };
        let rem = if landed { None } else { Some(20.0 * (1.0 - t / TOUCHDOWN_S)) };
        let now = now_ms();
        let off_block = now - 5_400_000 - (t * 1000.0) as u64;
        Snapshot {
            status: Status { version: env!("CARGO_PKG_VERSION").into(), provider: "mock".into(), connection: "connected".into(), detail: "Demo".into(), sim_name: Some("Demo".into()), recording: t < SAVED_S, ..Default::default() },
            flight: Some(Flight {
                id: Some("demo-flight".into()),
                state: if t < SAVED_S { FlightState::Active } else { FlightState::Completed },
                phase,
                off_block_ms: Some(off_block),
                takeoff_ms: Some(off_block + 900_000),
                landing_ms: landed.then(|| self.report().timestamp_ms),
                on_block_ms: None,
                block_time_ms: Some(now - off_block),
                flight_time_ms: Some(now - off_block - 900_000),
                departure: Some("EDDF".into()),
                arrival: landed.then(|| "EGLL".into()),
                destination: Some("EGLL".into()),
                callsign: Some("DLH4YA".into()),
                aircraft: aircraft(),
                distance_nm: 352.0 - rem.unwrap_or(0.0),
                max_altitude_ft: 36_000.0,
                remaining_nm: rem,
                eta_ms: rem.map(|r| now + (r / gs * 3_600_000.0) as u64),
                fuel: Fuel { start_kg: Some(9100.0), current_kg: Some(4200.0), used_kg: Some(4900.0), planned_ramp_kg: Some(9100.0), planned_landing_kg: Some(4000.0) },
                landing_rate_fpm: landed.then_some(-142.0),
                touchdowns: u32::from(landed),
                max_g: Some(1.21),
                min_g: Some(0.86),
            }),
            telemetry: Some(Telemetry {
                timestamp_ms: now,
                latitude: 51.47,
                longitude: -0.30 - t * 0.005,
                altitude_msl_ft: alt,
                altitude_agl_ft: alt - 83.0,
                ias_kt: gs - 5.0,
                tas_kt: gs,
                ground_speed_kt: gs,
                vertical_speed_fpm: if landed { 0.0 } else { -700.0 - t * 10.0 },
                heading_mag_deg: 270.0,
                heading_true_deg: 269.0,
                g_force: 1.0,
                on_ground: landed,
                gear_pct: if t > 15.0 { 100.0 } else { 0.0 },
                fuel_total_kg: 4200.0,
                sim_rate: 1.0,
                ..Default::default()
            }),
        }
    }

    fn landing(&self) -> Option<Landing> {
        let mut l = Landing::from_report(&self.report(), 0);
        l.flight_id = Some("demo-flight".into());
        l.aircraft = aircraft();
        l.airport = Some("EGLL".into());
        l.runway = Some("27L".into());
        l.touchdown_distance_m = Some(412.0);
        l.centerline_offset_m = Some(-1.4);
        l.in_touchdown_zone = Some(true);
        l.stable_from_ft = Some(1000.0);
        l.approach_band = Some("stable".into());
        l.live = self.t() >= TOUCHDOWN_S;
        Some(l)
    }

    fn logbook(&self, limit: usize) -> Vec<LogbookEntry> {
        (0..limit.min(3))
            .map(|i| LogbookEntry {
                id: format!("demo-{i}"),
                state: "completed".into(),
                departure: Some("EDDF".into()),
                arrival: Some("EGLL".into()),
                block_time_ms: Some(5_820_000),
                distance_nm: 352.0,
                callsign: Some("DLH4YA".into()),
                aircraft: aircraft(),
                landing_rate_fpm: Some(-142.0 - i as f64 * 40.0),
                landings: 1,
                ..Default::default()
            })
            .collect()
    }

    fn privacy(&self) -> bool {
        self.privacy
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port = args.iter().find_map(|a| a.parse().ok()).unwrap_or(DEFAULT_PORT);
    let lan = args.iter().any(|a| a == "--lan");
    let privacy = args.iter().any(|a| a == "--privacy");
    let token = vectasim_server::auth::generate_token();
    let server = Server::start(Config { port, lan, token: token.clone() }, Arc::new(Demo { start: Instant::now(), privacy })).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1)
    });
    println!("VectaSim overlay demo on http://{} (token for other devices: {token}) – Ctrl+C ends", server.local_addr());
    loop {
        std::thread::park();
    }
}
