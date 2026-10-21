//! Flown track per pilot, built from the feed's snapshots (the networks only publish the
//! current position, every 15 s). The live map draws the selected aircraft's altitude curtain
//! from it (`traffic_track`).
//!
//! Kept here, next to the poller, and not in the webview: every snapshot passes through once
//! (the map re-filters the same snapshot on every pan, so the webview would have to de-duplicate),
//! and the track exists for every aircraft of the feed – not only for those that happened to be
//! in view – so a click on an aircraft that just scrolled in still shows its last two hours.
//!
//! Memory bound: at most [`MAX_FIXES`] fixes (24 bytes each) per pilot, none older than
//! [`MAX_AGE_MS`]; a fix that lies on the straight, level line between its neighbours is replaced
//! by the next one (cruise adds nothing, turns and climbs do), a parked aircraft keeps one fix.
//! Pilots missing from the feed for longer than [`GONE_MS`] are dropped; `stop()` (network
//! disabled) drops all – hiding the traffic on the map does not, the poller keeps recording.
//! Worst case (2 500 pilots, all turning and climbing for two hours) ≈ 2 500 × 480 × 24 B ≈ 29 MB;
//! a typical evening (≈ 1 500 pilots, mostly in cruise or parked) stays well below 5 MB.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};

use crate::model::{Pilot, haversine_nm};

/// Fixes kept per pilot (two hours at the feed's 15 s; at the 60 s background rate the age limit
/// applies first).
pub const MAX_FIXES: usize = 480;
/// Fixes older than this are dropped (ms).
pub const MAX_AGE_MS: u64 = 2 * 3600 * 1000;
/// A pilot missing from the feed for this long is forgotten (a single missed poll is not, also
/// at the 60 s background rate of a feed whose traffic is hidden on the map).
pub const GONE_MS: u64 = 3 * 60 * 1000;
/// A fix this close (nm) to the straight line between its neighbours, at the same level, adds nothing.
const STRAIGHT_NM: f64 = 0.03;
const LEVEL_FT: i32 = 50;
/// No thinning across a gap this long between two polls (ms): the line between would be a guess.
const GAP_MS: u64 = 5 * 60 * 1000;
/// Further than this from the last fix (beyond what the ground speed explains): a reconnect or a
/// slew elsewhere – the track starts again.
const JUMP_MIN_NM: f64 = 20.0;

/// One feed position of a pilot.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackFix {
    /// Fetch time of the snapshot (Unix ms).
    pub t_ms: u64,
    pub latitude: f32,
    pub longitude: f32,
    pub altitude_ft: i32,
    pub ground_speed_kt: i16,
    /// IVAO only (VATSIM: None, as on [`Pilot`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_ground: Option<bool>,
}

impl TrackFix {
    fn of(p: &Pilot, t_ms: u64) -> Self {
        Self {
            t_ms,
            latitude: p.latitude as f32,
            longitude: p.longitude as f32,
            altitude_ft: p.altitude_ft,
            ground_speed_kt: p.ground_speed_kt.clamp(0, i16::MAX as i32) as i16,
            on_ground: p.on_ground,
        }
    }

    fn same_place(&self, o: &TrackFix) -> bool {
        self.latitude == o.latitude && self.longitude == o.longitude && self.altitude_ft == o.altitude_ft
    }
}

struct Entry {
    fixes: VecDeque<TrackFix>,
    last_seen_ms: u64,
}

/// Per-pilot tracks of one network (keyed by CID / VID).
#[derive(Default)]
pub struct TrackHistory {
    tracks: HashMap<u64, Entry>,
}

/// Distance (nm) of `b` from the line a → c (equirectangular; plenty for a few nm).
fn cross_track_nm(a: &TrackFix, b: &TrackFix, c: &TrackFix) -> f64 {
    let k = (f64::from(a.latitude).to_radians()).cos().max(0.01);
    let dl = |x: f32, y: f32| {
        let d = f64::from(y) - f64::from(x);
        ((d + 540.0) % 360.0) - 180.0
    };
    let (cx, cy) = (dl(a.longitude, c.longitude) * k * 60.0, (f64::from(c.latitude) - f64::from(a.latitude)) * 60.0);
    let (bx, by) = (dl(a.longitude, b.longitude) * k * 60.0, (f64::from(b.latitude) - f64::from(a.latitude)) * 60.0);
    let len2 = cx * cx + cy * cy;
    if len2 < 1e-12 {
        return (bx * bx + by * by).sqrt();
    }
    let t = (bx * cx + by * cy) / len2;
    if !(0.0..=1.0).contains(&t) {
        // not between its neighbours (turned back): never "on the line"
        return f64::INFINITY;
    }
    ((bx - t * cx).powi(2) + (by - t * cy).powi(2)).sqrt()
}

/// Is `b` redundant between `a` and `c` (straight, level, same ground state, no gap)?
fn redundant(a: &TrackFix, b: &TrackFix, c: &TrackFix) -> bool {
    if c.t_ms.saturating_sub(b.t_ms) > GAP_MS || a.on_ground != b.on_ground || b.on_ground != c.on_ground {
        return false;
    }
    let span = (c.t_ms.saturating_sub(a.t_ms)).max(1) as f64;
    let f = (b.t_ms.saturating_sub(a.t_ms)) as f64 / span;
    let alt = f64::from(a.altitude_ft) + f64::from(c.altitude_ft - a.altitude_ft) * f;
    (f64::from(b.altitude_ft) - alt).abs() <= f64::from(LEVEL_FT) && cross_track_nm(a, b, c) <= STRAIGHT_NM
}

impl TrackHistory {
    /// Adds the snapshot's positions (fetched at `t_ms`) and forgets pilots gone for GONE_MS.
    pub fn record(&mut self, pilots: &[Pilot], t_ms: u64) {
        for p in pilots {
            if !p.latitude.is_finite() || !p.longitude.is_finite() {
                continue;
            }
            let fix = TrackFix::of(p, t_ms);
            let e = self.tracks.entry(p.cid).or_insert_with(|| Entry { fixes: VecDeque::new(), last_seen_ms: t_ms });
            e.last_seen_ms = t_ms;
            push(&mut e.fixes, fix);
        }
        self.tracks.retain(|_, e| t_ms.saturating_sub(e.last_seen_ms) <= GONE_MS);
    }

    /// The pilot's track, oldest first (empty when unknown).
    pub fn track(&self, cid: u64) -> Vec<TrackFix> {
        self.tracks.get(&cid).map(|e| e.fixes.iter().copied().collect()).unwrap_or_default()
    }

    pub fn clear(&mut self) {
        self.tracks.clear();
    }

    /// Pilots with a track.
    pub fn len(&self) -> usize {
        self.tracks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    /// Fixes over all pilots (the memory the history holds is this × 24 bytes plus the map).
    pub fn fix_count(&self) -> usize {
        self.tracks.values().map(|e| e.fixes.len()).sum()
    }
}

fn push(fixes: &mut VecDeque<TrackFix>, fix: TrackFix) {
    if let Some(last) = fixes.back() {
        if fix.t_ms <= last.t_ms {
            return; // the same snapshot again (or an older one)
        }
        if last.same_place(&fix) {
            // standing still: one fix, its time kept current (the curtain does not grow)
            fixes.back_mut().unwrap().t_ms = fix.t_ms;
            return;
        }
        let d = haversine_nm(f64::from(last.latitude), f64::from(last.longitude), f64::from(fix.latitude), f64::from(fix.longitude));
        let dt_h = (fix.t_ms - last.t_ms) as f64 / 3_600_000.0;
        let gs = f64::from(fix.ground_speed_kt.max(last.ground_speed_kt)).max(250.0);
        if d > JUMP_MIN_NM.max(gs * dt_h * 2.0) {
            fixes.clear();
        }
    }
    if fixes.len() >= 2 {
        let n = fixes.len();
        if redundant(&fixes[n - 2], &fixes[n - 1], &fix) {
            fixes[n - 1] = fix;
            trim(fixes);
            return;
        }
    }
    fixes.push_back(fix);
    trim(fixes);
}

fn trim(fixes: &mut VecDeque<TrackFix>) {
    let newest = fixes.back().map_or(0, |f| f.t_ms);
    while fixes.len() > MAX_FIXES || fixes.front().is_some_and(|f| newest.saturating_sub(f.t_ms) > MAX_AGE_MS) {
        fixes.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pilot(cid: u64, lat: f64, lon: f64, alt: i32) -> Pilot {
        Pilot { cid, latitude: lat, longitude: lon, altitude_ft: alt, ground_speed_kt: 450, ..Pilot::default() }
    }

    #[test]
    fn straight_level_flight_keeps_two_fixes_turns_and_climbs_add() {
        let mut h = TrackHistory::default();
        // 40 polls straight east at FL350: start and newest only
        for i in 0..40u64 {
            h.record(&[pilot(1, 50.0, 8.0 + i as f64 * 0.03, 35_000)], i * 15_000);
        }
        let t = h.track(1);
        assert_eq!(t.len(), 2);
        assert_eq!(t[1].t_ms, 39 * 15_000);
        // a steady climb on the same line is a straight line in 3D too; a changing rate adds fixes
        let alt = |i: u64| 35_000 + ((i as i32 - 39).pow(2)) * 100;
        for i in 40..50u64 {
            h.record(&[pilot(1, 50.0, 8.0 + i as f64 * 0.03, alt(i))], i * 15_000);
        }
        assert!(h.track(1).len() > 5);
        // the same snapshot again changes nothing
        let before = h.track(1);
        h.record(&[pilot(1, 50.0, 8.0 + 49.0 * 0.03, alt(49))], 49 * 15_000);
        assert_eq!(h.track(1), before);
    }

    #[test]
    fn bounded_by_count_and_age() {
        let mut h = TrackHistory::default();
        // zig-zag climb: nothing is redundant
        for i in 0..1000u64 {
            let lat = 50.0 + if i % 2 == 0 { 0.0 } else { 0.05 };
            h.record(&[pilot(7, lat, 8.0 + i as f64 * 0.03, (i as i32) * 100)], i * 15_000);
        }
        let t = h.track(7);
        assert_eq!(t.len(), MAX_FIXES);
        assert!(t.last().unwrap().t_ms - t[0].t_ms <= MAX_AGE_MS);
        // age: fixes 30 s apart, 480 of them would be 4 h
        let mut h = TrackHistory::default();
        for i in 0..480u64 {
            let lat = 50.0 + if i % 2 == 0 { 0.0 } else { 0.05 };
            h.record(&[pilot(8, lat, 8.0 + i as f64 * 0.06, (i as i32) * 100)], i * 30_000);
        }
        let t = h.track(8);
        assert!(t.last().unwrap().t_ms - t[0].t_ms <= MAX_AGE_MS);
        assert!(t.len() <= (MAX_AGE_MS / 30_000) as usize + 1);
    }

    #[test]
    fn parked_aircraft_keeps_one_fix_and_gone_pilots_are_dropped() {
        let mut h = TrackHistory::default();
        for i in 0..20u64 {
            h.record(&[pilot(1, 50.0, 8.0, 364), pilot(2, 51.0, 9.0 + i as f64 * 0.03, 30_000)], i * 15_000);
        }
        assert_eq!(h.track(1).len(), 1);
        assert_eq!(h.len(), 2);
        // pilot 1 logs off: kept through a missed poll, dropped after GONE_MS
        let t0 = 20 * 15_000;
        h.record(&[pilot(2, 51.0, 9.6, 30_000)], t0);
        assert_eq!(h.len(), 2);
        h.record(&[pilot(2, 51.0, 9.7, 30_000)], t0 + GONE_MS + 15_000);
        assert_eq!(h.len(), 1);
        assert!(h.track(1).is_empty());
        h.clear();
        assert!(h.is_empty() && h.fix_count() == 0);
    }

    #[test]
    fn a_jump_restarts_the_track() {
        let mut h = TrackHistory::default();
        h.record(&[pilot(1, 50.0, 8.0, 30_000)], 0);
        h.record(&[pilot(1, 50.0, 8.1, 31_000)], 15_000);
        // reconnected 300 nm away
        h.record(&[pilot(1, 45.0, 8.1, 2_000)], 30_000);
        let t = h.track(1);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].altitude_ft, 2_000);
    }

    #[test]
    fn serializes_camel_case() {
        let mut h = TrackHistory::default();
        h.record(&[pilot(1, 50.0, 8.0, 30_000)], 1_000);
        let json = serde_json::to_value(h.track(1)).unwrap();
        assert_eq!(json[0]["tMs"], 1_000);
        assert_eq!(json[0]["altitudeFt"], 30_000);
        assert_eq!(json[0]["groundSpeedKt"], 450);
        assert!(json[0].get("onGround").is_none());
    }
}
