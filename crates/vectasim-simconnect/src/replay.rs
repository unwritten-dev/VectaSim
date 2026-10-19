//! Replay provider: plays a `.vsdump` back through the same [`Decoder`] the live session
//! uses, so a bug seen on the sim PC can be reproduced (and fixed, and regression-tested)
//! on a machine without a simulator.
//!
//! Configuration (also settable from Einstellungen → Diagnose → Replay):
//! `VECTASIM_PROVIDER=replay`, `VECTASIM_REPLAY=<file>`, `VECTASIM_REPLAY_SPEED=10`
//! (default 1; `0` = as fast as possible), `VECTASIM_REPLAY_LOOP=1`.
//!
//! Time: the engine must see the recorded timeline, or its dwell timers would behave
//! differently than they did live. `Telemetry.timestamp_ms` is therefore
//! `start + (t − t_first)` in *recorded* milliseconds, while the wall-clock pacing is
//! `(t − t_first) / speed` – at speed 10 every dwell elapses ten times faster in real
//! time but identically for the engine. `start` is the wall clock at replay start (the UI
//! looks live); with speed 0 it is the recorded wall clock of the first line, so a
//! replay is fully deterministic (simulated clock, used by tests).

use crate::decode::{expand_f64, expand_str};
use crate::decoder::{self, DefKind, Decoder, N_DEFS, def_by_key, event_id};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use vectasim_core::diag::{DiagEvent, RawDiag, SharedRawDiag};
use vectasim_core::{Lang, ProviderEvent, SimProvider, now_ms, sleep_interruptible};
use vectasim_dump::{Body, DumpReader, Header, Line, f64_vec, parse_hr};

pub const ENV_REPLAY: &str = "VECTASIM_REPLAY";
pub const ENV_REPLAY_SPEED: &str = "VECTASIM_REPLAY_SPEED";
pub const ENV_REPLAY_LOOP: &str = "VECTASIM_REPLAY_LOOP";

/// What to replay; kept by the app between "Start" clicks.
#[derive(Clone, Debug, PartialEq)]
pub struct ReplayConfig {
    pub path: Option<PathBuf>,
    /// Playback speed; 0 = as fast as possible.
    pub speed: f64,
    pub loop_: bool,
}

impl Default for ReplayConfig {
    fn default() -> Self {
        Self { path: None, speed: 1.0, loop_: false }
    }
}

impl ReplayConfig {
    /// From `VECTASIM_REPLAY`, `VECTASIM_REPLAY_SPEED`, `VECTASIM_REPLAY_LOOP`.
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(env: impl Fn(&str) -> Option<String>) -> Self {
        let path = env(ENV_REPLAY).map(|p| p.trim().trim_matches('"').to_owned()).filter(|p| !p.is_empty()).map(PathBuf::from);
        let speed = env(ENV_REPLAY_SPEED).and_then(|s| parse_speed(&s)).unwrap_or(1.0);
        let loop_ = env(ENV_REPLAY_LOOP).is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes" | "on"));
        Self { path, speed, loop_ }
    }

    /// The provider for this configuration; `lang` for its status texts and this error.
    pub fn provider(&self, lang: Lang) -> Result<ReplayProvider, String> {
        let path = self.path.clone().ok_or_else(|| match lang {
            Lang::De => format!("Replay: keine Datei gewählt ({ENV_REPLAY} setzen)"),
            Lang::En => format!("Replay: no file chosen (set {ENV_REPLAY})"),
        })?;
        Ok(ReplayProvider::new(path, self.speed, self.loop_).with_lang(lang))
    }
}

/// `"10"`, `"0.5"`, `"10x"`; negative or non-finite → `None`.
pub fn parse_speed(s: &str) -> Option<f64> {
    let v: f64 = s.trim().trim_end_matches(['x', 'X', '×']).trim().replace(',', ".").parse().ok()?;
    (v.is_finite() && v >= 0.0).then_some(v)
}

pub struct ReplayProvider {
    pub path: PathBuf,
    pub speed: f64,
    pub loop_: bool,
    pub diag: SharedRawDiag,
    /// Language of the end-of-file status texts (`Disconnected` reasons).
    pub lang: Lang,
}

impl ReplayProvider {
    pub fn new(path: impl Into<PathBuf>, speed: f64, loop_: bool) -> Self {
        Self { path: path.into(), speed: speed.max(0.0), loop_, diag: RawDiag::shared("replay"), lang: Lang::default() }
    }

    pub fn with_lang(mut self, lang: Lang) -> Self {
        self.lang = lang;
        self
    }

    pub fn from_env() -> Result<Self, String> {
        ReplayConfig::from_env().provider(Lang::default())
    }
}

impl SimProvider for ReplayProvider {
    fn name(&self) -> &'static str {
        "replay"
    }

    fn start(self: Box<Self>, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
        std::thread::Builder::new()
            .name("replay-provider".into())
            .spawn(move || run(*self, tx, stop))
            .expect("spawn replay provider")
    }

    fn raw_diag(&self) -> Option<SharedRawDiag> {
        Some(self.diag.clone())
    }
}

fn file_label(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

fn note(diag: &SharedRawDiag, kind: &str, name: &str, detail: String) {
    diag.lock().unwrap_or_else(|e| e.into_inner()).push_event(DiagEvent {
        wall_ms: now_ms(),
        kind: kind.into(),
        name: name.into(),
        data_hex: None,
        detail,
    });
}

fn idle(stop: &AtomicBool) {
    while sleep_interruptible(Duration::from_millis(200), stop) {}
}

fn run(cfg: ReplayProvider, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) {
    let _ = tx.send(ProviderEvent::Connecting);
    let label = file_label(&cfg.path);
    let sim_name = format!("Replay {label}");
    cfg.diag.lock().unwrap_or_else(|e| e.into_inner()).connection.dll = Some(cfg.path.display().to_string());
    log::info!("replay of {} at speed {}{}", cfg.path.display(), cfg.speed, if cfg.loop_ { ", looping" } else { "" });

    let start_instant = Instant::now();
    let start_wall = now_ms();
    // recorded ms played so far over all loops (the replay clock)
    let mut offset_ms: u64 = 0;
    let mut base_wall: Option<u64> = None;
    let mut loops = 0u32;
    loop {
        let reader = match DumpReader::open(&cfg.path) {
            Ok(r) => r,
            Err(e) => {
                let message = format!("Replay: {e}");
                log::warn!("{message}");
                let _ = tx.send(ProviderEvent::Error { message });
                idle(&stop);
                return;
            }
        };
        let mut player = AnyPlayer::new(&reader.header, sim_name.clone(), cfg.diag.clone());
        if player.definitions_differ() {
            log::warn!("replay: the dump's definitions differ from this build; values are mapped by SimVar name");
        }
        let sim_version = reader.header.sim_version.clone().unwrap_or_else(|| format!("vsdump {}", reader.header.format));
        if tx.send(ProviderEvent::Connected { sim_name: sim_name.clone(), sim_version }).is_err() {
            return;
        }
        let mut first_t: Option<u64> = None;
        let mut last_rel = 0u64;
        let mut lines = 0u64;
        for item in reader {
            if stop.load(Ordering::Relaxed) {
                let _ = tx.send(ProviderEvent::Disconnected { reason: "stopped".into() });
                return;
            }
            let line = match item {
                Ok(l) => l,
                Err(e) => {
                    let msg = format!("dump unreadable after {lines} lines ({e}); the rest is skipped");
                    log::warn!("replay: {msg}");
                    note(&cfg.diag, "warning", "Replay", msg);
                    break;
                }
            };
            lines += 1;
            let rel = line.t.saturating_sub(*first_t.get_or_insert(line.t));
            last_rel = rel;
            let clock = offset_ms + rel;
            let ts = if cfg.speed > 0.0 {
                let due = start_instant + Duration::from_secs_f64(clock as f64 / 1000.0 / cfg.speed);
                let now = Instant::now();
                if due > now && !sleep_interruptible(due - now, &stop) {
                    let _ = tx.send(ProviderEvent::Disconnected { reason: "stopped".into() });
                    return;
                }
                start_wall + clock
            } else {
                *base_wall.get_or_insert(line.w) + clock
            };
            for ev in player.apply(&line, ts, now_ms()) {
                if tx.send(ev).is_err() {
                    return;
                }
            }
        }
        loops += 1;
        log::info!("replay: end of {} after {lines} lines (pass {loops})", cfg.path.display());
        if !cfg.loop_ || lines == 0 {
            let reason = match cfg.lang {
                Lang::De => format!("Replay beendet ({label}, {lines} Datensätze)"),
                Lang::En => format!("Replay finished ({label}, {lines} records)"),
            };
            let _ = tx.send(ProviderEvent::Disconnected { reason });
            idle(&stop);
            return;
        }
        // the next pass continues the clock one second later
        offset_ms += last_rel + 1_000;
        let reason = cfg.lang.tr("Replay: Dateiende, beginnt von vorn", "Replay: end of file, starting over");
        let _ = tx.send(ProviderEvent::Disconnected { reason: reason.into() });
    }
}

/// Turns dump lines into `ProviderEvent`s via the shared [`Decoder`]. A dump written with
/// other definitions (an older build) is mapped onto the current ones by SimVar name.
pub struct Player {
    decoder: Decoder,
    diag: SharedRawDiag,
    sim_name: String,
    /// Request id in the dump → definition index.
    reqs: BTreeMap<u32, usize>,
    /// The dump's declared variable names per definition.
    dump_vars: [Vec<String>; N_DEFS],
    /// Dump variable index → current variable index, when the layouts differ.
    remap: [Option<Vec<Option<usize>>>; N_DEFS],
    /// Registration state on the dump's side (used with `remap`).
    dump_active: [Vec<bool>; N_DEFS],
    header_inactive: BTreeMap<String, Vec<usize>>,
}

impl Player {
    pub fn new(header: &Header, sim_name: String, diag: SharedRawDiag) -> Self {
        let names = |v: &[(String, String)]| v.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
        let dump_vars = [
            names(&header.defs.fast),
            names(&header.defs.slow),
            header.defs.statics.clone(),
            names(&header.defs.approach),
            names(&header.defs.design),
        ];
        let current = decoder::dump_defs();
        let same = [
            header.defs.fast == current.fast,
            header.defs.slow == current.slow,
            header.defs.statics == current.statics,
            header.defs.approach == current.approach,
            header.defs.design == current.design,
        ];
        let defs = decoder::definitions();
        let remap: [Option<Vec<Option<usize>>>; N_DEFS] = std::array::from_fn(|i| {
            (!same[i]).then(|| dump_vars[i].iter().map(|n| defs[i].vars.iter().position(|(v, _)| v == n)).collect())
        });
        let mut reqs: BTreeMap<u32, usize> = header.reqs.iter().filter_map(|(k, r)| def_by_key(k).map(|i| (*r, i))).collect();
        if reqs.is_empty() {
            reqs = defs.iter().enumerate().map(|(i, d)| (d.req, i)).collect();
        }
        let mut p = Self {
            decoder: Decoder::new(diag.clone()),
            diag,
            sim_name,
            reqs,
            dump_active: std::array::from_fn(|i| vec![true; dump_vars[i].len()]),
            dump_vars,
            remap,
            header_inactive: header.inactive.clone(),
        };
        p.apply_header_inactive();
        p
    }

    /// Any definition the dump recorded differs from this build (a definition an older
    /// build did not have at all – approach, design – does not count).
    pub fn definitions_differ(&self) -> bool {
        self.remap.iter().zip(&self.dump_vars).any(|(r, v)| r.is_some() && !v.is_empty())
    }

    pub fn decoder(&self) -> &Decoder {
        &self.decoder
    }

    fn apply_header_inactive(&mut self) {
        for (key, vars) in self.header_inactive.clone() {
            let Some(d) = def_by_key(&key) else { continue };
            for v in vars {
                if let Some(a) = self.dump_active[d].get_mut(v) {
                    *a = false;
                }
                if let Some(cur) = self.current_var(d, v) {
                    self.decoder.mark_inactive(d, cur);
                }
            }
        }
    }

    /// Current variable index of the dump's variable `v` of definition `d`.
    fn current_var(&self, d: usize, v: usize) -> Option<usize> {
        match &self.remap[d] {
            None => Some(v),
            Some(map) => map.get(v).copied().flatten(),
        }
    }

    /// Events for one line; `ts_ms` stamps telemetry, `wall_ms` the diagnostics.
    pub fn apply(&mut self, line: &Line, ts_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        match &line.body {
            Body::Data { req, v, s, bytes, .. } => {
                let Some(&idx) = self.reqs.get(req) else { return Vec::new() };
                let our_req = self.decoder.defs[idx].req;
                match (self.decoder.defs[idx].kind, &self.remap[idx]) {
                    (DefKind::F64, None) => {
                        let raw = f64_vec(v);
                        let n = bytes.map_or(raw.len() * 8, |b| b as usize);
                        self.decoder.on_data_f64(our_req, &raw, n, ts_ms, line.t, wall_ms)
                    }
                    (DefKind::F64, Some(map)) => {
                        let declared = expand_f64(&f64_vec(v), &self.dump_active[idx]).values;
                        let mut ours = vec![f64::NAN; self.decoder.defs[idx].vars.len()];
                        for (i, val) in declared.into_iter().enumerate() {
                            if let Some(Some(j)) = map.get(i) {
                                ours[*j] = val;
                            }
                        }
                        self.decoder.on_values_f64(idx, &ours, ts_ms, line.t, wall_ms)
                    }
                    (DefKind::Str256, None) => {
                        let n = bytes.map_or(s.len() * crate::decode::STRING256_LEN, |b| b as usize);
                        self.decoder.on_data_str(our_req, s, n, line.t, wall_ms)
                    }
                    (DefKind::Str256, Some(map)) => {
                        let (declared, _) = expand_str(s, &self.dump_active[idx]);
                        let mut ours = vec![None; self.decoder.defs[idx].vars.len()];
                        for (i, val) in declared.into_iter().enumerate() {
                            if let Some(Some(j)) = map.get(i) {
                                ours[*j] = val;
                            }
                        }
                        self.decoder.on_values_str(idx, ours, line.t, wall_ms)
                    }
                }
            }
            Body::Event { id, data } => match parse_event(id) {
                Some(eid) => self.decoder.on_event(eid, *data, wall_ms),
                None => Vec::new(),
            },
            Body::Filename { id, path } => match parse_event(id) {
                Some(eid) => self.decoder.on_filename(eid, path.clone(), wall_ms),
                None => Vec::new(),
            },
            Body::Exception { code, send_id, index, call, def, var, dropped } => {
                let d = def.as_deref().and_then(def_by_key);
                let dump_var = d.and_then(|d| var.as_ref().and_then(|name| self.dump_vars[d].iter().position(|n| n == name)));
                if *dropped && let (Some(d), Some(v)) = (d, dump_var) {
                    self.dump_active[d][v] = false;
                }
                let added = match (d, dump_var) {
                    (Some(d), Some(v)) => self.current_var(d, v).map(|c| (d, c)),
                    _ => None,
                };
                self.decoder.on_exception(*code, *send_id, *index, call.as_deref(), added, wall_ms).0
            }
            Body::Open { sim_version, simconnect, .. } => {
                // a new SimConnect session: everything registered again, telemetry from scratch
                self.decoder = Decoder::new(self.diag.clone());
                self.dump_active = std::array::from_fn(|i| vec![true; self.dump_vars[i].len()]);
                vec![self.decoder.on_open(self.sim_name.clone(), sim_version.clone(), simconnect.clone(), None, wall_ms)]
            }
            Body::Quit => {
                self.decoder.on_quit(wall_ms);
                Vec::new()
            }
            Body::Hr { func, hr } => {
                let code = parse_hr(hr).unwrap_or(0);
                self.decoder.on_hr(func, code, wall_ms);
                if func == "GetNextDispatch" {
                    Vec::new() // the session's `end` line reports it
                } else {
                    vec![ProviderEvent::Error { message: decoder::hr_failed_message(func, code) }]
                }
            }
            Body::SystemState { req, int } => {
                self.decoder.on_system_state(*req, *int, wall_ms);
                Vec::new()
            }
            Body::End { reason } => {
                self.decoder.on_end(reason, wall_ms);
                vec![ProviderEvent::Disconnected { reason: reason.clone() }]
            }
        }
    }
}

/// The player for a dump's `source`: X-Plane dumps (`source: "xplane"`) go through the
/// X-Plane decoder, everything else (SimConnect, mock) through [`Player`].
pub enum AnyPlayer {
    SimConnect(Box<Player>),
    XPlane(Box<vectasim_xplane::XpPlayer>),
}

impl AnyPlayer {
    pub fn new(header: &Header, sim_name: String, diag: SharedRawDiag) -> Self {
        if header.source == vectasim_xplane::DUMP_SOURCE {
            AnyPlayer::XPlane(Box::new(vectasim_xplane::XpPlayer::new(header, sim_name, diag)))
        } else {
            AnyPlayer::SimConnect(Box::new(Player::new(header, sim_name, diag)))
        }
    }

    pub fn definitions_differ(&self) -> bool {
        match self {
            AnyPlayer::SimConnect(p) => p.definitions_differ(),
            AnyPlayer::XPlane(p) => p.definitions_differ(),
        }
    }

    pub fn apply(&mut self, line: &Line, ts_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        match self {
            AnyPlayer::SimConnect(p) => p.apply(line, ts_ms, wall_ms),
            AnyPlayer::XPlane(p) => p.apply(line, ts_ms, wall_ms),
        }
    }
}

/// `"Pause"` or `"#7"` → event id.
fn parse_event(id: &str) -> Option<u32> {
    event_id(id).or_else(|| id.strip_prefix('#').and_then(|n| n.parse().ok()))
}

/// Whole file as events with the simulated clock of speed 0 (`ts = first w + (t − first t)`).
/// For tests and tools; the provider streams instead.
pub fn replay_file(path: &Path) -> std::io::Result<(Vec<ProviderEvent>, Option<std::io::Error>)> {
    let (header, lines, err) = vectasim_dump::read_all(path)?;
    let mut player = AnyPlayer::new(&header, format!("Replay {}", file_label(path)), RawDiag::shared("replay"));
    let (t0, w0) = lines.first().map_or((0, 0), |l| (l.t, l.w));
    let events = lines.iter().flat_map(|l| player.apply(l, w0 + l.t.saturating_sub(t0), l.w)).collect();
    Ok((events, err))
}

#[cfg(test)]
#[path = "replay_tests.rs"]
mod tests;
