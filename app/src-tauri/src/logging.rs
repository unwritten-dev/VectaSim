//! File log via tauri-plugin-log and a panic hook that writes panics into it.
//!
//! Every crate logs through the `log` facade, so one global logger covers vectasim_core,
//! _store, _simconnect, … The file is `<app_log_dir>/vectasim.log` (on Windows
//! `%LOCALAPPDATA%\io.vectasim.app\logs`), rotated at 5 MB, 5 files in total.
//!
//! Level: `RUST_LOG` (a level and/or `target=level` pairs, like env_logger) wins; otherwise
//! the `log_level` setting (default `info`), which can change at runtime. The Debug-Modus
//! (Einstellungen → Diagnose) raises every `vectasim*` target to at least `debug` on top of
//! that, without touching the setting – switching it off restores the previous level.

use log::LevelFilter;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::Runtime;
use tauri::plugin::TauriPlugin;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

pub const SETTING_LOG_LEVEL: &str = "log_level";
/// File name without extension; the plugin appends `.log`.
pub const LOG_FILE_STEM: &str = "vectasim";
const MAX_FILE_BYTES: u128 = 5 * 1024 * 1024;
/// Archived files kept besides the active one (5 files in total).
const KEEP_ARCHIVED: usize = 4;
/// Dependencies that are chatty below `warn` (window/webview internals, HTTP stack).
const NOISY: &[&str] = &[
    "tao", "wry", "hyper", "hyper_util", "reqwest", "rustls", "h2", "tungstenite", "tokio_tungstenite", "mio", "want", "tracing",
    "html5ever", "selectors", "polling", "async_io", "zbus", "tauri_plugin_updater",
];

static DEFAULT_LEVEL: AtomicUsize = AtomicUsize::new(LevelFilter::Info as usize);
static DEBUG_MODE: AtomicBool = AtomicBool::new(false);
/// Targets the Debug-Modus raises to `debug` (the app crate is `vectasim_lib`).
const OWN_PREFIX: &str = "vectasim";
static SPEC: OnceLock<Spec> = OnceLock::new();

#[derive(Debug, Default, PartialEq)]
struct Spec {
    default: Option<LevelFilter>,
    /// Longest target first, so the most specific directive wins.
    targets: Vec<(String, LevelFilter)>,
}

/// `RUST_LOG` subset: `debug`, `vectasim_core=trace`, `info,vectasim_simconnect=debug`.
fn parse_spec(s: &str) -> Spec {
    let mut spec = Spec::default();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part.split_once('=') {
            Some((target, level)) => {
                if let Ok(l) = level.trim().parse::<LevelFilter>() {
                    spec.targets.push((target.trim().replace('-', "_"), l));
                }
            }
            None => {
                if let Ok(l) = part.parse::<LevelFilter>() {
                    spec.default = Some(l);
                }
            }
        }
    }
    spec.targets.sort_by_key(|t| std::cmp::Reverse(t.0.len()));
    spec
}

fn matches_target(target: &str, prefix: &str) -> bool {
    target == prefix || (target.starts_with(prefix) && target[prefix.len()..].starts_with("::"))
}

/// Level that applies to one log target.
fn resolve(spec: &Spec, default: LevelFilter, target: &str) -> LevelFilter {
    if let Some((_, l)) = spec.targets.iter().find(|(t, _)| matches_target(target, t)) {
        return *l;
    }
    let base = spec.default.unwrap_or(default);
    if NOISY.iter().any(|n| matches_target(target, n)) { base.min(LevelFilter::Warn) } else { base }
}

/// [`resolve`] plus the Debug-Modus floor for VectaSim's own targets.
fn effective(spec: &Spec, default: LevelFilter, debug_mode: bool, target: &str) -> LevelFilter {
    let level = resolve(spec, default, target);
    if debug_mode && target.starts_with(OWN_PREFIX) { level.max(LevelFilter::Debug) } else { level }
}

fn spec() -> &'static Spec {
    SPEC.get_or_init(|| parse_spec(&std::env::var("RUST_LOG").unwrap_or_default()))
}

fn default_level() -> LevelFilter {
    LevelFilter::iter().nth(DEFAULT_LEVEL.load(Ordering::Relaxed)).unwrap_or(LevelFilter::Info)
}

/// Highest level any target can reach; the `log` macros skip everything above it cheaply.
fn max_level() -> LevelFilter {
    let s = spec();
    let floor = if DEBUG_MODE.load(Ordering::Relaxed) { LevelFilter::Debug } else { LevelFilter::Off };
    s.targets.iter().map(|(_, l)| *l).fold(s.default.unwrap_or(default_level()).max(floor), Ord::max)
}

pub fn parse_level(s: &str) -> Option<LevelFilter> {
    s.trim().parse::<LevelFilter>().ok()
}

/// Apply the `log_level` setting (ignored for targets `RUST_LOG` already decides).
pub fn set_level(level: LevelFilter) {
    DEFAULT_LEVEL.store(level as usize, Ordering::Relaxed);
    log::set_max_level(max_level());
}

/// Debug-Modus on/off: `vectasim*` targets log at least `debug` while it is on.
pub fn set_debug_mode(on: bool) {
    DEBUG_MODE.store(on, Ordering::Relaxed);
    log::set_max_level(max_level());
}

/// `RUST_LOG` as set at start, when it overrides the setting.
pub fn env_override() -> Option<String> {
    std::env::var("RUST_LOG").ok().filter(|s| !s.trim().is_empty())
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: Some(LOG_FILE_STEM.into()) }))
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_ARCHIVED))
        // the filter decides; the dispatch itself lets everything through
        .level(LevelFilter::Trace)
        .filter(|m| m.level() <= effective(spec(), default_level(), DEBUG_MODE.load(Ordering::Relaxed), m.target()));
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder.build()
}

/// Panics go to the log file (with backtrace) before `panic = "abort"` ends the process.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string payload>".into());
        let location = info.location().map(|l| l.to_string()).unwrap_or_else(|| "<unknown>".into());
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let backtrace = std::backtrace::Backtrace::force_capture();
        log::error!(target: "panic", "thread '{name}' panicked at {location}: {payload}\n{backtrace}");
        log::logger().flush();
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_logger_style_specs() {
        let s = parse_spec("info, vectasim-core=trace ,vectasim_simconnect::session=debug,bogus=loud");
        assert_eq!(s.default, Some(LevelFilter::Info));
        assert_eq!(
            s.targets,
            vec![("vectasim_simconnect::session".into(), LevelFilter::Debug), ("vectasim_core".into(), LevelFilter::Trace)]
        );
        assert_eq!(parse_spec(""), Spec::default());
    }

    #[test]
    fn most_specific_target_wins() {
        let s = parse_spec("warn,vectasim_simconnect=info,vectasim_simconnect::session=trace");
        assert_eq!(resolve(&s, LevelFilter::Debug, "vectasim_simconnect::session"), LevelFilter::Trace);
        assert_eq!(resolve(&s, LevelFilter::Debug, "vectasim_simconnect::ffi"), LevelFilter::Info);
        // a prefix only matches at a module boundary
        assert_eq!(resolve(&s, LevelFilter::Debug, "vectasim_simconnectx"), LevelFilter::Warn);
    }

    #[test]
    fn setting_applies_without_env_and_noisy_crates_are_capped() {
        let s = Spec::default();
        assert_eq!(resolve(&s, LevelFilter::Debug, "vectasim_store::recorder"), LevelFilter::Debug);
        assert_eq!(resolve(&s, LevelFilter::Trace, "wry::webview"), LevelFilter::Warn);
        assert_eq!(resolve(&s, LevelFilter::Error, "hyper"), LevelFilter::Error);
        // explicitly requested noisy targets are not capped
        assert_eq!(resolve(&parse_spec("reqwest=debug"), LevelFilter::Info, "reqwest::connect"), LevelFilter::Debug);
    }

    #[test]
    fn debug_mode_raises_only_own_targets() {
        let s = Spec::default();
        assert_eq!(effective(&s, LevelFilter::Info, true, "vectasim_simconnect::session"), LevelFilter::Debug);
        assert_eq!(effective(&s, LevelFilter::Info, true, "vectasim_lib::manager"), LevelFilter::Debug);
        assert_eq!(effective(&s, LevelFilter::Info, true, "tauri::app"), LevelFilter::Info);
        assert_eq!(effective(&s, LevelFilter::Info, false, "vectasim_core"), LevelFilter::Info);
        // never lowers a higher level
        assert_eq!(effective(&s, LevelFilter::Trace, true, "vectasim_core"), LevelFilter::Trace);
    }
}
