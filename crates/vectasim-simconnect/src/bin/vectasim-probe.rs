//! `vectasim-probe`: SimConnect without the app. Connects with exactly the definitions and
//! the session code VectaSim uses, prints the raw values once per second and every event,
//! exception and log line to the console and `probe.log`, and optionally records a dump.
//! If the app misbehaves on the sim PC, this tells whether the problem is in SimConnect or
//! in the app logic. Not bundled; build with
//! `cargo build -p vectasim-simconnect --bin vectasim-probe --release`.
//!
//! ```text
//! vectasim-probe [--dump <file.vsdump>] [--log <probe.log>] [--index <SimConnect.cfg index>] [--seconds <n>]
//! ```

#[cfg(not(windows))]
fn main() {
    eprintln!("vectasim-probe needs Windows (SimConnect.dll)");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    probe::main();
}

#[cfg(windows)]
mod probe {
    use std::fs::File;
    use std::io::{BufWriter, Write};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::{RecvTimeoutError, channel};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use vectasim_core::{ProviderEvent, SimProvider, now_ms};
    use vectasim_dump::{DumpRecorder, FileTarget, RingConfig};
    use vectasim_simconnect::SimConnectProvider;

    static OUT: OnceLock<Mutex<BufWriter<File>>> = OnceLock::new();

    /// Console + probe.log, with a wall-clock stamp.
    fn out(line: &str) {
        let now = now_ms();
        let s = now / 1000 % 86_400;
        let text = format!("{:02}:{:02}:{:02}.{:03}Z {line}", s / 3600, s / 60 % 60, s % 60, now % 1000);
        println!("{text}");
        if let Some(f) = OUT.get() {
            let mut f = f.lock().unwrap_or_else(|e| e.into_inner());
            let _ = writeln!(f, "{text}");
            let _ = f.flush();
        }
    }

    /// The session's own log lines (exceptions, dropped SimVars, watchdog) go to the same place.
    struct ProbeLogger;
    impl log::Log for ProbeLogger {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Debug
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                out(&format!("[{} {}] {}", r.level(), r.target(), r.args()));
            }
        }
        fn flush(&self) {}
    }

    fn fmt_value(v: Option<f64>) -> String {
        v.map_or_else(|| "–".into(), |x| if x.fract() == 0.0 && x.abs() < 1e15 { format!("{x:.0}") } else { format!("{x:.6}") })
    }

    pub fn main() {
        let mut args = std::env::args().skip(1);
        let (mut dump, mut log_path, mut index, mut seconds) = (None::<PathBuf>, PathBuf::from("probe.log"), 0u32, None::<u64>);
        while let Some(a) = args.next() {
            let mut val = || args.next().unwrap_or_else(|| panic!("{a} needs a value"));
            match a.as_str() {
                "--dump" => dump = Some(PathBuf::from(val())),
                "--log" => log_path = PathBuf::from(val()),
                "--index" => index = val().parse().expect("--index: number"),
                "--seconds" => seconds = Some(val().parse().expect("--seconds: number")),
                "-h" | "--help" => {
                    println!("vectasim-probe [--dump <file.vsdump>] [--log <probe.log>] [--index <n>] [--seconds <n>]");
                    return;
                }
                other => panic!("unknown option {other} (see --help)"),
            }
        }
        let file = File::create(&log_path).unwrap_or_else(|e| panic!("{}: {e}", log_path.display()));
        let _ = OUT.set(Mutex::new(BufWriter::new(file)));
        let _ = log::set_logger(&ProbeLogger);
        log::set_max_level(log::LevelFilter::Debug);
        out(&format!("vectasim-probe {} · log {}", env!("CARGO_PKG_VERSION"), log_path.display()));

        let rec = Arc::new(DumpRecorder::new(format!("probe-{}", env!("CARGO_PKG_VERSION")), RingConfig::default()));
        if let Some(p) = &dump {
            rec.set_target(FileTarget::Path(p.clone()));
            out(&format!("raw dump → {}", p.display()));
        }
        let provider = SimConnectProvider { client_name: "VectaSim Probe".into(), config_index: index, dump: Some(rec.clone()), ..Default::default() };
        let diag = provider.diag.clone();
        let (tx, rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let _thread = Box::new(provider).start(tx, stop.clone());

        let started = Instant::now();
        let mut next_print = Instant::now() + Duration::from_secs(1);
        let mut events_seen = 0u64;
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(ProviderEvent::Telemetry(_)) | Err(RecvTimeoutError::Timeout) => {}
                Ok(ProviderEvent::Aircraft(a)) => out(&format!("aircraft: {a:?}")),
                Ok(other) => out(&format!("provider: {other:?}")),
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if Instant::now() < next_print {
                continue;
            }
            next_print += Duration::from_secs(1);
            let d = diag.lock().unwrap_or_else(|e| e.into_inner()).snapshot(now_ms());
            // new events/exceptions since the last print (the log keeps the last 100)
            let new = (d.events_total - events_seen).min(d.events.len() as u64) as usize;
            for e in d.events.iter().skip(d.events.len() - new) {
                out(&format!("{:<11} {:<18} {} {}", e.kind, e.name, e.data_hex.as_deref().unwrap_or(""), e.detail));
            }
            events_seen = d.events_total;
            for def in &d.defs {
                let age = def.age_ms.map_or_else(|| "nie".into(), |a| format!("{a} ms"));
                let vals: Vec<String> = def
                    .vars
                    .iter()
                    .map(|v| {
                        let raw = v.raw_text.clone().unwrap_or_else(|| fmt_value(v.raw));
                        format!("{}{}={raw}", if v.active { "" } else { "✗" }, v.name)
                    })
                    .collect();
                out(&format!("{} {:.1} Hz, Alter {age}, {} Updates: {}", def.label, def.rate_hz, def.updates, vals.join(" | ")));
            }
            if seconds.is_some_and(|s| started.elapsed().as_secs() >= s) {
                break;
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(300));
        rec.flush_and_close();
        out("probe finished");
    }
}
