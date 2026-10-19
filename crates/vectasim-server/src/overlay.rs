//! The overlay pages and their shared CSS/JS, compiled into the binary (no files on disk to
//! tamper with, nothing to install next to the app).

pub(crate) const INDEX_HTML: &str = include_str!("../overlay/index.html");
pub(crate) const HUD_HTML: &str = include_str!("../overlay/hud.html");
pub(crate) const LANDING_HTML: &str = include_str!("../overlay/landing.html");
pub(crate) const ROUTE_HTML: &str = include_str!("../overlay/route.html");
pub(crate) const OVERLAY_CSS: &str = include_str!("../overlay/overlay.css");
pub(crate) const OVERLAY_JS: &str = include_str!("../overlay/overlay.js");
