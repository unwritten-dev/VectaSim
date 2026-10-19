//! Landing rate inside the simulator: after a touchdown's outcome is decided (full stop or
//! touch-and-go) a one-line summary goes to MSFS via `SimConnect_Text`
//! (`vectasim_simconnect::text`), e.g.
//!
//! `VectaSim · Gelandet −142 fpm (sanft) · 1,18 g · keine Bounces · 27L: 412 m hinter der Schwelle, 1 m links`
//!
//! Setting `sim_text_landing` (default on; "0" = off), *Einstellungen → Simulator*. Only the
//! SimConnect provider sends it (the queue is drained by its session; nothing is queued for
//! X-Plane, the mock or a replay). Whether MSFS shows it depends on the sim version – a
//! rejected call is only logged. The text carries no registration or callsign.

use crate::lang::Lang;
use vectasim_core::landing::{Band, vs_band};
use vectasim_store::Store;
use vectasim_store::store::LandingFactCache;

pub const SETTING: &str = "sim_text_landing";
/// How long the line stays in the sim, seconds.
pub const SECONDS: f32 = 20.0;

pub fn enabled(store: &Store) -> bool {
    store.get_setting(SETTING).ok().flatten().as_deref() != Some("0")
}

fn band_label(lang: Lang, b: Band) -> &'static str {
    vectasim_server::api::band_label_in(b, lang)
}

fn metres(m: f64) -> String {
    format!("{:.0} m", m.abs().round())
}

/// The line for one touchdown; `fact` adds runway, touchdown point and centreline offset
/// when a runway was matched.
pub fn landing_line(lang: Lang, rate_fpm: f64, peak_g: f64, bounces: u32, touch_and_go: bool, fact: Option<&LandingFactCache>) -> String {
    let n = rate_fpm.round();
    let minus = lang.tr("\u{2212}", "-");
    let rate = if n < 0.0 { format!("{minus}{:.0} fpm", -n) } else { format!("{n:.0} fpm") };
    let what = if touch_and_go { "Touch-and-go" } else { lang.tr("Gelandet", "Landed") };
    let bounce = match bounces {
        0 => lang.tr("keine Bounces", "no bounces").to_owned(),
        1 => "1 Bounce".to_owned(),
        n => format!("{n} Bounces"),
    };
    let mut parts = vec![
        "VectaSim".to_owned(),
        format!("{what} {rate} ({})", band_label(lang, vs_band(rate_fpm))),
        format!("{} g", lang.decimal(peak_g, 2)),
        bounce,
    ];
    if let Some(f) = fact.filter(|f| f.matched) {
        let mut rwy = f.runway_ident.clone().unwrap_or_default();
        if let Some(d) = f.touchdown_distance_m.filter(|d| d.is_finite()) {
            let where_ = if d < 0.0 { lang.tr("vor der Schwelle", "before the threshold") } else { lang.tr("hinter der Schwelle", "past the threshold") };
            rwy = format!("{rwy}: {} {where_}", metres(d)).trim_start_matches(": ").to_owned();
        }
        if let Some(c) = f.centerline_offset_m.filter(|c| c.is_finite()) {
            let side = if c.abs() < 0.5 {
                lang.tr("auf der Mittellinie", "on the centreline").to_owned()
            } else if c > 0.0 {
                format!("{} {}", metres(c), lang.tr("rechts", "right"))
            } else {
                format!("{} {}", metres(c), lang.tr("links", "left"))
            };
            rwy = if rwy.is_empty() { side } else { format!("{rwy}, {side}") };
        }
        if !rwy.is_empty() {
            parts.push(rwy);
        }
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(d: f64, c: f64) -> LandingFactCache {
        LandingFactCache {
            matched: true,
            runway_ident: Some("27L".into()),
            touchdown_distance_m: Some(d),
            centerline_offset_m: Some(c),
            ..Default::default()
        }
    }

    #[test]
    fn german_full_line() {
        let s = landing_line(Lang::De, -142.4, 1.183, 0, false, Some(&fact(412.3, -1.4)));
        assert_eq!(s, "VectaSim · Gelandet \u{2212}142 fpm (sanft) · 1,18 g · keine Bounces · 27L: 412 m hinter der Schwelle, 1 m links");
    }

    #[test]
    fn english_touch_and_go_without_runway() {
        let s = landing_line(Lang::En, -455.0, 1.62, 2, true, None);
        assert_eq!(s, "VectaSim · Touch-and-go -455 fpm (firm) · 1.62 g · 2 Bounces");
        // an unmatched fact adds nothing
        let unmatched = LandingFactCache { matched: false, ..fact(10.0, 0.0) };
        assert_eq!(landing_line(Lang::En, -455.0, 1.62, 2, true, Some(&unmatched)), s);
    }

    #[test]
    fn short_and_on_the_centreline() {
        let s = landing_line(Lang::En, -95.0, 1.05, 1, false, Some(&fact(-20.0, 0.2)));
        assert!(s.ends_with("1 Bounce · 27L: 20 m before the threshold, on the centreline"), "{s}");
        assert!(s.contains("(smooth)"));
    }

    #[test]
    fn fits_the_simconnect_buffer() {
        let s = landing_line(Lang::De, -1234.0, 2.55, 12, true, Some(&fact(1834.0, -23.0)));
        assert!(s.len() < vectasim_simconnect::text::MAX_BYTES, "{} bytes: {s}", s.len());
    }
}
