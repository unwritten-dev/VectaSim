//! Which simulator VectaSim connects to (Settings → Simulator): `auto` (MSFS first,
//! then X-Plane), `simconnect` (MSFS only) or `xplane` (X-Plane 12 Web API only), plus the
//! X-Plane host/port. Stored as settings; `VECTASIM_PROVIDER` / `VECTASIM_XPLANE_HOST|PORT`
//! override them for a run.
//!
//! Automatic choice: SimConnect runs first. A supervisor thread checks once per second; while
//! no simulator is connected and no flight is open it switches to X-Plane when the SimConnect
//! DLL cannot be loaded or SimConnect found no MSFS for [`AUTO_GRACE`], *and* an X-Plane Web
//! API answers (probe every [`PROBE_EVERY`]) – so a pilot without X-Plane never sees the status
//! flip. Back to SimConnect when X-Plane has been gone for [`AUTO_GRACE`]. Every switch is logged.

use crate::manager::ProviderManager;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use vectasim_data::AirportIndex;
use vectasim_store::{AirportResolver, Store};
use vectasim_xplane::XPlaneConfig;

pub const SETTING_SIM_MODE: &str = "sim_provider";
pub const SETTING_XPLANE_HOST: &str = "xplane_host";
pub const SETTING_XPLANE_PORT: &str = "xplane_port";
pub const MODE_AUTO: &str = "auto";
pub const MODES: [&str; 3] = [MODE_AUTO, "simconnect", "xplane"];
/// How long the current simulator may stay unconnected before the other one is tried.
pub const AUTO_GRACE: Duration = Duration::from_secs(10);
/// X-Plane probe interval while waiting.
pub const PROBE_EVERY: Duration = Duration::from_secs(5);
const TICK: Duration = Duration::from_secs(1);

/// What the automatic choice should run next (`None` = keep the current provider).
pub fn auto_next(
    current: &str,
    connected: bool,
    flight_open: bool,
    unconnected_for: Duration,
    dll_ok: bool,
    xplane_up: impl FnOnce() -> bool,
) -> Option<&'static str> {
    if connected || flight_open {
        return None;
    }
    match current {
        "simconnect" if (!dll_ok || unconnected_for >= AUTO_GRACE) && xplane_up() => Some("xplane"),
        "xplane" if dll_ok && unconnected_for >= AUTO_GRACE => Some("simconnect"),
        _ => None,
    }
}

fn dll_ok() -> bool {
    vectasim_simconnect::ffi::SimConnectLib::shared().is_ok()
}

/// `start("auto")`: SimConnect (or X-Plane right away without a DLL when it answers) plus the supervisor.
pub(crate) fn start_auto(
    m: &ProviderManager,
    app: AppHandle,
    store: Store,
    resolver: Arc<dyn AirportResolver>,
    generation: u64,
) -> Result<(), String> {
    let xp = m.xplane_config();
    let first = if !dll_ok() && vectasim_xplane::probe(&xp.host, xp.port, Duration::from_millis(500)).is_some() {
        "xplane"
    } else {
        "simconnect"
    };
    log::info!("simulator: automatic choice (MSFS first, then {}) – starting with {first}", xp.source_label());
    m.start_kind(app.clone(), store.clone(), resolver.clone(), first)?;
    std::thread::Builder::new()
        .name("sim-auto-select".into())
        .spawn(move || supervise(app, store, resolver, generation))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn supervise(app: AppHandle, store: Store, resolver: Arc<dyn AirportResolver>, generation: u64) {
    let mut since = Instant::now();
    let mut last_probe: Option<Instant> = None;
    let mut last_provider = String::new();
    loop {
        std::thread::sleep(TICK);
        let m = app.state::<ProviderManager>();
        if m.auto_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        let snap = m.snapshot();
        let connected = snap.state == "connected";
        if connected || snap.provider != last_provider {
            since = Instant::now();
            last_provider = snap.provider.clone();
        }
        let xp = m.xplane_config();
        let probe_due = last_probe.is_none_or(|t| t.elapsed() >= PROBE_EVERY);
        let next = auto_next(&snap.provider, connected, m.flight_open(), since.elapsed(), dll_ok(), || {
            if !probe_due {
                return false;
            }
            last_probe = Some(Instant::now());
            vectasim_xplane::probe(&xp.host, xp.port, Duration::from_millis(500)).is_some()
        });
        let Some(next) = next else { continue };
        let why = match next {
            "xplane" if !dll_ok() => "SimConnect.dll not loadable and an X-Plane Web API answers".to_string(),
            "xplane" => format!("no MSFS for {} s and an X-Plane Web API answers", since.elapsed().as_secs()),
            _ => format!("no X-Plane for {} s", since.elapsed().as_secs()),
        };
        log::info!("simulator (automatic): {why} → switching from {} to {next}", snap.provider);
        if m.auto_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Err(e) = m.start_kind(app.clone(), store.clone(), resolver.clone(), next) {
            log::warn!("simulator (automatic): could not start {next}: {e}");
        }
        since = Instant::now();
    }
}

/// Mode from the setting (`auto` when unset or unknown).
pub fn stored_mode(store: &Store) -> String {
    store.get_setting(SETTING_SIM_MODE).ok().flatten().filter(|m| MODES.contains(&m.as_str())).unwrap_or_else(|| MODE_AUTO.into())
}

/// X-Plane endpoint: environment first, then the settings, then localhost:8086.
pub fn stored_xplane(store: &Store) -> XPlaneConfig {
    let setting = |k: &str| store.get_setting(k).ok().flatten().filter(|v| !v.trim().is_empty());
    XPlaneConfig::from_lookup(|k| {
        std::env::var(k).ok().filter(|v| !v.trim().is_empty()).or_else(|| match k {
            vectasim_xplane::ENV_HOST => setting(SETTING_XPLANE_HOST),
            vectasim_xplane::ENV_PORT => setting(SETTING_XPLANE_PORT),
            _ => None,
        })
    })
}

/// Load the stored choice into the manager (app start).
pub fn apply_settings(store: &Store, m: &ProviderManager) {
    m.set_sim_mode(&stored_mode(store));
    m.set_xplane_config(stored_xplane(store));
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimSettings {
    /// auto | simconnect | xplane
    mode: String,
    xplane_host: String,
    xplane_port: u16,
    default_host: &'static str,
    default_port: u16,
    /// `VECTASIM_PROVIDER` / `VECTASIM_XPLANE_*` set: they win over the stored values.
    env_override: Vec<String>,
}

fn env_override() -> Vec<String> {
    ["VECTASIM_PROVIDER", vectasim_xplane::ENV_HOST, vectasim_xplane::ENV_PORT]
        .iter()
        .filter_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()).map(|v| format!("{k}={v}")))
        .collect()
}

#[tauri::command]
pub fn get_sim_settings(store: State<Store>) -> SimSettings {
    let xp = stored_xplane(&store);
    SimSettings {
        mode: stored_mode(&store),
        xplane_host: xp.host,
        xplane_port: xp.port,
        default_host: vectasim_xplane::DEFAULT_HOST,
        default_port: vectasim_xplane::DEFAULT_PORT,
        env_override: env_override(),
    }
}

/// Store the choice and apply it: restarts the simulator connection unless a demo/replay runs or
/// a flight is open (then it applies with the next start). Returns whether it restarted.
#[tauri::command]
pub fn set_sim_settings(
    mode: String,
    xplane_host: String,
    xplane_port: u16,
    app: AppHandle,
    manager: State<ProviderManager>,
    store: State<Store>,
    airports: State<Arc<AirportIndex>>,
) -> Result<bool, String> {
    if !MODES.contains(&mode.as_str()) {
        return Err(format!("unknown provider '{mode}'"));
    }
    let host = xplane_host.trim();
    // the Web API is plain HTTP without a password: this PC, the local network or a host name only
    let scope = match vectasim_xplane::check_host(host) {
        Ok(scope) => scope,
        Err(vectasim_xplane::HostError::Public) => {
            return Err(trf!(
                "Öffentliche Adresse „{host}“ abgelehnt: Die X-Plane Web API ist unverschlüsselt – nur dieser PC oder das lokale Netzwerk.",
                "Public address “{host}” refused: the X-Plane Web API is unencrypted – only this PC or the local network."
            ));
        }
        Err(vectasim_xplane::HostError::Syntax) => return Err(trf!("Ungültiger Host: „{host}“", "Invalid host: “{host}”")),
    };
    if scope != vectasim_xplane::HostScope::Loopback {
        log::warn!("X-Plane host {host} is not this PC: the Web API is spoken over unencrypted HTTP");
    }
    if xplane_port == 0 {
        return Err(crate::lang::tr("Ungültiger Port", "Invalid port").into());
    }
    let default = host == vectasim_xplane::DEFAULT_HOST && xplane_port == vectasim_xplane::DEFAULT_PORT;
    store.set_setting(SETTING_SIM_MODE, &mode).map_err(|e| e.to_string())?;
    store.set_setting(SETTING_XPLANE_HOST, if default { "" } else { host }).map_err(|e| e.to_string())?;
    store.set_setting(SETTING_XPLANE_PORT, &if default { String::new() } else { xplane_port.to_string() }).map_err(|e| e.to_string())?;
    apply_settings(&store, &manager);
    log::info!("simulator setting: {mode}, X-Plane {}", manager.xplane_config().source_label());
    let snap = manager.snapshot();
    let demo = snap.provider == "mock" || snap.provider == "replay";
    if demo || manager.flight_open() {
        return Ok(false);
    }
    crate::apply_dll_setting(&store);
    manager.start(app, store.inner().clone(), Arc::new(crate::IndexResolver(airports.inner().clone())), "sim")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Duration = Duration::from_secs(1);

    #[test]
    fn automatic_choice() {
        let up = || true;
        let down = || false;
        // MSFS connected or a flight open: never switch
        assert_eq!(auto_next("simconnect", true, false, 60 * S, true, up), None);
        assert_eq!(auto_next("simconnect", false, true, 60 * S, false, up), None);
        // SimConnect waits its grace period, then X-Plane – only if it answers
        assert_eq!(auto_next("simconnect", false, false, 5 * S, true, up), None);
        assert_eq!(auto_next("simconnect", false, false, 10 * S, true, down), None);
        assert_eq!(auto_next("simconnect", false, false, 10 * S, true, up), Some("xplane"));
        // no DLL: straight to X-Plane when it answers
        assert_eq!(auto_next("simconnect", false, false, Duration::ZERO, false, up), Some("xplane"));
        // X-Plane gone: back to SimConnect after the grace period, not without a DLL
        assert_eq!(auto_next("xplane", false, false, 5 * S, true, up), None);
        assert_eq!(auto_next("xplane", false, false, 10 * S, true, up), Some("simconnect"));
        assert_eq!(auto_next("xplane", false, false, 60 * S, false, up), None);
        assert_eq!(auto_next("xplane", true, false, 60 * S, true, up), None);
        // demo / replay are never touched
        assert_eq!(auto_next("mock", false, false, 60 * S, true, up), None);
    }

    #[test]
    fn the_probe_is_not_called_while_waiting_for_the_grace_period() {
        let called = std::cell::Cell::new(false);
        let _ = auto_next("simconnect", false, false, 2 * S, true, || {
            called.set(true);
            true
        });
        assert!(!called.get());
    }
}
