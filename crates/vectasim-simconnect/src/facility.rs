//! Navigation facilities from the running simulator (`SimConnect_RequestFacilityData`, MSFS 2020
//! SU10+ and MSFS 2024): position of a waypoint, VOR, NDB or airport by ident, and for a waypoint
//! the airways through it (ROUTE children: airway name plus previous and next fix). The live map
//! uses it to draw the filed route of a clicked online aircraft.
//!
//! Like the in-sim texts ([`crate::text`]), the app never touches SimConnect itself: it queues
//! [`FacilityQuery`]s in the process-wide [`FacilityBroker`] and blocks (off the UI thread) in
//! [`FacilityBroker::lookup`]; the running SimConnect session sends them with its next pump
//! iteration over its own handle, collects the answers in its dispatch loop and hands them back.
//! No session, a DLL without the facility exports, a rejected definition or no answer within the
//! caller's timeout all end in `None` – the caller then uses its other sources.
//!
//! Layout: every facility message is a `SIMCONNECT_RECV_FACILITY_DATA` header followed by the
//! fields of the definition in the order they were added, packed (FLOAT64 8 bytes, CHAR[n] n
//! bytes). The ROUTE children of a waypoint arrive as messages of their own (same request id,
//! type ROUTE), `SIMCONNECT_RECV_FACILITY_DATA_END` closes the request, and an ident that exists
//! in several regions answers with `SIMCONNECT_RECV_FACILITY_MINIMAL_LIST` (ident, region and
//! position of every candidate) instead. The SDK documents `IsListItem` as a C++ `bool`, while
//! the other members are DWORDs; [`classify`] accepts the payload at either offset (40 or 37)
//! by checking it against the known payload size, and the message ids in both numberings
//! (see `ffi::recv_id::FACILITY_FIRST`).

use crate::ffi::{self, facility_data_type as fdt};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// Facility definitions get their own ids, far from the data definitions (`decoder::DEF_*`).
const DEF_BASE: u32 = 0x4656_0000;
/// Request ids of facility requests: `REQ_BASE + n`, n wrapping at 0x10000.
pub const REQ_BASE: u32 = 0x4656_0000;
/// A request the sim has not answered after this long is given up (answered "not found").
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Requests in flight at most; more wait in the broker's queue.
pub const MAX_PENDING: usize = 48;

/// Which facility a query is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FacKind {
    Airport,
    Waypoint,
    Vor,
    Ndb,
}

impl FacKind {
    pub const ALL: [FacKind; 4] = [FacKind::Airport, FacKind::Waypoint, FacKind::Vor, FacKind::Ndb];

    pub(crate) fn def_id(self) -> u32 {
        DEF_BASE
            + match self {
                FacKind::Airport => 0,
                FacKind::Waypoint => 1,
                FacKind::Vor => 2,
                FacKind::Ndb => 3,
            }
    }

    /// Type byte of `RequestFacilityData_EX1` (MSFS 2024); airports need none.
    pub(crate) fn type_byte(self) -> Option<u8> {
        match self {
            FacKind::Airport => None,
            FacKind::Waypoint => Some(b'W'),
            FacKind::Vor => Some(b'V'),
            FacKind::Ndb => Some(b'N'),
        }
    }

    fn data_type(self) -> u32 {
        match self {
            FacKind::Airport => fdt::AIRPORT,
            FacKind::Waypoint => fdt::WAYPOINT,
            FacKind::Vor => fdt::VOR,
            FacKind::Ndb => fdt::NDB,
        }
    }

    fn from_type_byte(c: u8) -> Option<FacKind> {
        match c {
            b'A' => Some(FacKind::Airport),
            b'W' => Some(FacKind::Waypoint),
            b'V' => Some(FacKind::Vor),
            b'N' => Some(FacKind::Ndb),
            _ => None,
        }
    }

    /// The fields of the facility definition, in order (names as in the SDK's facility tables).
    /// Kept to the few that are needed: every extra field is a chance for a rejected name.
    pub fn fields(self) -> &'static [&'static str] {
        match self {
            FacKind::Airport => &["OPEN AIRPORT", "LATITUDE", "LONGITUDE", "CLOSE AIRPORT"],
            FacKind::Waypoint => &[
                "OPEN WAYPOINT",
                "LATITUDE",
                "LONGITUDE",
                "REGION",
                "OPEN ROUTE",
                "NAME",
                "NEXT_ICAO",
                "NEXT_REGION",
                "NEXT_LATITUDE",
                "NEXT_LONGITUDE",
                "PREV_ICAO",
                "PREV_REGION",
                "PREV_LATITUDE",
                "PREV_LONGITUDE",
                "CLOSE ROUTE",
                "CLOSE WAYPOINT",
            ],
            FacKind::Vor => &["OPEN VOR", "VOR_LATITUDE", "VOR_LONGITUDE", "CLOSE VOR"],
            FacKind::Ndb => &["OPEN NDB", "LATITUDE", "LONGITUDE", "CLOSE NDB"],
        }
    }
}

/// Payload bytes of the top-level record: LATITUDE + LONGITUDE (FLOAT64), the waypoint also REGION (CHAR[8]).
pub const POSITION_LEN: usize = 16;
pub const WAYPOINT_LEN: usize = 24;
/// NAME CHAR[32], NEXT_ICAO/NEXT_REGION CHAR[8], NEXT_LATITUDE/LONGITUDE FLOAT64, the same for PREV.
pub const ROUTE_LEN: usize = 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8;
/// `SIMCONNECT_RECV` + UserRequestId, UniqueRequestId, ParentUniqueRequestId, Type, IsListItem,
/// ItemIndex, ListSize as DWORDs.
pub const DATA_OFFSET: usize = 40;
/// The same with `IsListItem` as a one-byte `bool` (as the SDK documents it).
pub const DATA_OFFSET_BOOL: usize = 37;
/// `SIMCONNECT_RECV_FACILITY_MINIMAL_LIST`: header + RequestID, ArraySize, EntryNumber, OutOf.
pub const MINIMAL_LIST_OFFSET: usize = 28;
/// `SIMCONNECT_FACILITY_MINIMAL`: `SIMCONNECT_ICAO` (Type, Ident[9], Region[3], Airport[5]) + lat/lon/alt.
pub const MINIMAL_ENTRY_LEN: usize = 18 + 24;
const END_LEN: usize = 16;

fn payload_len(data_type: u32) -> Option<usize> {
    match data_type {
        fdt::WAYPOINT => Some(WAYPOINT_LEN),
        fdt::AIRPORT | fdt::VOR | fdt::NDB => Some(POSITION_LEN),
        fdt::ROUTE => Some(ROUTE_LEN),
        _ => None,
    }
}

/// What the app asks for. `region` (ICAO region, "ED", "K2") may be empty: the sim then answers
/// with a candidate list when the ident exists in several regions.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FacilityQuery {
    pub kind: FacKind,
    pub ident: String,
    pub region: String,
}

impl FacilityQuery {
    pub fn new(kind: FacKind, ident: &str, region: &str) -> Self {
        Self { kind, ident: ident.trim().to_ascii_uppercase(), region: region.trim().to_ascii_uppercase() }
    }
}

/// Neighbour of a waypoint along an airway.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkFix {
    pub ident: String,
    pub region: String,
    pub lat: f64,
    pub lon: f64,
}

/// One airway through a waypoint (a ROUTE child).
#[derive(Debug, Clone, PartialEq)]
pub struct RouteLink {
    pub airway: String,
    pub next: Option<LinkFix>,
    pub prev: Option<LinkFix>,
}

/// One candidate of an ambiguous ident.
#[derive(Debug, Clone, PartialEq)]
pub struct MinimalFacility {
    pub kind: Option<FacKind>,
    pub ident: String,
    pub region: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FacilityAnswer {
    Found {
        lat: f64,
        lon: f64,
        region: String,
        routes: Vec<RouteLink>,
    },
    /// The ident exists in several regions; ask again with one of them for the details.
    Ambiguous(Vec<MinimalFacility>),
    NotFound,
    /// The session cannot answer (no facility exports, definition rejected, session ended).
    Unavailable,
}

/// A facility message, decoded.
#[derive(Debug, Clone, PartialEq)]
pub enum FacilityMsg {
    Data { request: u32, data_type: u32, payload: Vec<u8> },
    End { request: u32 },
    Minimal { request: u32, entry: u32, out_of: u32, items: Vec<MinimalFacility> },
}

fn dword(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn f64_at(b: &[u8], at: usize) -> f64 {
    b.get(at..at + 8).map_or(f64::NAN, |s| f64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

fn str_at(b: &[u8], at: usize, len: usize) -> String {
    b.get(at..at + len).map(ffi::cstr_buf).unwrap_or_default()
}

fn usable(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0 && (lat != 0.0 || lon != 0.0)
}

/// Decode a message with an id in `FACILITY_FIRST..=FACILITY_LAST` (both numberings, see the
/// module doc). `None` for anything that does not look like a facility message.
pub fn classify(id: u32, bytes: &[u8]) -> Option<FacilityMsg> {
    let len = bytes.len();
    if len < END_LEN {
        return None;
    }
    if len == END_LEN && matches!(id, 29 | 30) {
        return Some(FacilityMsg::End { request: dword(bytes, 12)? });
    }
    if matches!(id, 28 | 29) && len >= DATA_OFFSET_BOOL {
        let request = dword(bytes, 12)?;
        let data_type = dword(bytes, 24)?;
        let want = payload_len(data_type)?;
        let at = if len >= DATA_OFFSET + want {
            DATA_OFFSET
        } else if len >= DATA_OFFSET_BOOL + want {
            DATA_OFFSET_BOOL
        } else {
            return None;
        };
        return Some(FacilityMsg::Data { request, data_type, payload: bytes[at..at + want].to_vec() });
    }
    if matches!(id, 30 | 31) && len >= MINIMAL_LIST_OFFSET {
        let request = dword(bytes, 12)?;
        let count = dword(bytes, 16)? as usize;
        let entry = dword(bytes, 20)?;
        let out_of = dword(bytes, 24)?;
        let room = len - MINIMAL_LIST_OFFSET;
        // entry size from the message where it divides evenly, else the documented 42 bytes
        let size =
            if count > 0 && room.is_multiple_of(count) && room / count >= MINIMAL_ENTRY_LEN { room / count } else { MINIMAL_ENTRY_LEN };
        let items = (0..count.min(room / size))
            .filter_map(|i| {
                let e = &bytes[MINIMAL_LIST_OFFSET + i * size..MINIMAL_LIST_OFFSET + (i + 1) * size];
                let (lat, lon) = (f64_at(e, size - 24), f64_at(e, size - 16));
                let ident = str_at(e, 1, 9);
                (usable(lat, lon) && !ident.is_empty()).then(|| MinimalFacility {
                    kind: FacKind::from_type_byte(e[0]),
                    ident,
                    region: str_at(e, 10, 3),
                    lat,
                    lon,
                })
            })
            .collect();
        return Some(FacilityMsg::Minimal { request, entry, out_of, items });
    }
    None
}

fn link(p: &[u8], at: usize) -> Option<LinkFix> {
    let ident = str_at(p, at, 8);
    let (lat, lon) = (f64_at(p, at + 16), f64_at(p, at + 24));
    (!ident.is_empty() && usable(lat, lon)).then(|| LinkFix { ident, region: str_at(p, at + 8, 8), lat, lon })
}

/// A ROUTE payload ([`ROUTE_LEN`] bytes).
pub fn decode_route(p: &[u8]) -> Option<RouteLink> {
    let airway = str_at(p, 0, 32);
    (!airway.is_empty()).then(|| RouteLink { airway, next: link(p, 32), prev: link(p, 64) })
}

/// A top-level payload: position, and the region for a waypoint.
pub fn decode_position(data_type: u32, p: &[u8]) -> Option<(f64, f64, String)> {
    let (lat, lon) = (f64_at(p, 0), f64_at(p, 8));
    let region = if data_type == fdt::WAYPOINT { str_at(p, 16, 8) } else { String::new() };
    usable(lat, lon).then_some((lat, lon, region))
}

// ---- the session's side: requests in flight ----

#[derive(Debug)]
pub(crate) struct Pending {
    pub ticket: u64,
    kind: FacKind,
    found: Option<(f64, f64, String)>,
    routes: Vec<RouteLink>,
    minimal: Vec<MinimalFacility>,
    pub sent: Instant,
}

impl Pending {
    pub fn new(ticket: u64, kind: FacKind, sent: Instant) -> Self {
        Self { ticket, kind, found: None, routes: Vec::new(), minimal: Vec::new(), sent }
    }

    fn answer(self) -> FacilityAnswer {
        match self.found {
            Some((lat, lon, region)) => FacilityAnswer::Found { lat, lon, region, routes: self.routes },
            None if !self.minimal.is_empty() => FacilityAnswer::Ambiguous(self.minimal),
            None => FacilityAnswer::NotFound,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum DefState {
    #[default]
    Unregistered,
    Ready,
    Broken,
}

/// Facility state of one SimConnect session.
#[derive(Debug, Default)]
pub(crate) struct FacilityState {
    pub defs: DefState,
    next_req: u32,
    pub pending: HashMap<u32, Pending>,
}

impl FacilityState {
    pub fn next_request_id(&mut self) -> u32 {
        let id = REQ_BASE + (self.next_req & 0xFFFF);
        self.next_req = self.next_req.wrapping_add(1);
        id
    }

    /// Feed one message; a finished request comes back with its ticket.
    pub fn on_message(&mut self, msg: FacilityMsg) -> Option<(u64, FacilityAnswer)> {
        match msg {
            FacilityMsg::Data { request, data_type, payload } => {
                let p = self.pending.get_mut(&request)?;
                if data_type == fdt::ROUTE {
                    if p.kind == FacKind::Waypoint
                        && let Some(r) = decode_route(&payload)
                    {
                        p.routes.push(r);
                    }
                } else if data_type == p.kind.data_type() && p.found.is_none() {
                    p.found = decode_position(data_type, &payload);
                }
                None
            }
            FacilityMsg::End { request } => self.pending.remove(&request).map(|p| (p.ticket, p.answer())),
            FacilityMsg::Minimal { request, entry, out_of, items } => {
                let p = self.pending.get_mut(&request)?;
                p.minimal.extend(items);
                if entry + 1 >= out_of { self.pending.remove(&request).map(|p| (p.ticket, p.answer())) } else { None }
            }
        }
    }

    /// Requests older than [`REQUEST_TIMEOUT`], removed: answer them "not found".
    pub fn expired(&mut self, now: Instant) -> Vec<u64> {
        let old: Vec<u32> =
            self.pending.iter().filter(|(_, p)| now.saturating_duration_since(p.sent) > REQUEST_TIMEOUT).map(|(r, _)| *r).collect();
        old.into_iter().filter_map(|r| self.pending.remove(&r)).map(|p| p.ticket).collect()
    }

    /// Everything in flight, removed (session over or definitions rejected).
    pub fn drain(&mut self) -> Vec<u64> {
        self.pending.drain().map(|(_, p)| p.ticket).collect()
    }
}

// ---- the app's side: the broker ----

#[derive(Debug, Default)]
struct Inner {
    /// Connected SimConnect sessions (0 or 1 in practice).
    sessions: u32,
    /// Whether the current session can answer at all; None until it tried.
    supported: Option<bool>,
    queue: VecDeque<(u64, FacilityQuery)>,
    done: HashMap<u64, FacilityAnswer>,
    /// Tickets a caller still waits for; answers for others are dropped.
    waiting: HashSet<u64>,
    next: u64,
}

/// Shared between the app (callers of [`lookup`](FacilityBroker::lookup)) and the SimConnect session.
#[derive(Debug, Clone, Default)]
pub struct FacilityBroker(Arc<(Mutex<Inner>, Condvar)>);

impl FacilityBroker {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify(&self) {
        self.0.1.notify_all();
    }

    /// A session that could answer is connected (it may still turn out not to support facilities).
    pub fn available(&self) -> bool {
        let g = self.lock();
        g.sessions > 0 && g.supported != Some(false)
    }

    /// Ask the running session for `queries` and wait at most `timeout` for all answers (in the
    /// same order). `None` when no session can answer or none of the queries got an answer in
    /// time – the caller skips this source. Queries without an answer read [`FacilityAnswer::NotFound`].
    /// Blocks: never call it on the UI thread.
    pub fn lookup(&self, queries: &[FacilityQuery], timeout: Duration) -> Option<Vec<FacilityAnswer>> {
        if queries.is_empty() {
            return Some(Vec::new());
        }
        let mut g = self.lock();
        if g.sessions == 0 || g.supported == Some(false) {
            return None;
        }
        let tickets: Vec<u64> = queries
            .iter()
            .map(|q| {
                g.next += 1;
                let t = g.next;
                g.queue.push_back((t, q.clone()));
                g.waiting.insert(t);
                t
            })
            .collect();
        let deadline = Instant::now() + timeout;
        loop {
            if tickets.iter().all(|t| g.done.contains_key(t)) || g.sessions == 0 || g.supported == Some(false) {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            g = self.0.1.wait_timeout(g, deadline - now).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
        let answers: Vec<Option<FacilityAnswer>> = tickets.iter().map(|t| g.done.remove(t)).collect();
        for t in &tickets {
            g.waiting.remove(t);
        }
        g.queue.retain(|(t, _)| !tickets.contains(t));
        drop(g);
        if answers.iter().all(|a| matches!(a, None | Some(FacilityAnswer::Unavailable))) {
            return None;
        }
        Some(answers.into_iter().map(|a| a.unwrap_or(FacilityAnswer::NotFound)).collect())
    }

    /// A caller waits for an answer: the session pumps faster meanwhile.
    pub fn busy(&self) -> bool {
        !self.lock().waiting.is_empty()
    }

    /// The session's side from here on (public so other crates can stand in for a session in
    /// their tests): a session connected.
    pub fn attach(&self) {
        let mut g = self.lock();
        g.sessions += 1;
        g.supported = None;
    }

    pub fn detach(&self) {
        let mut g = self.lock();
        g.sessions = g.sessions.saturating_sub(1);
        if g.sessions == 0 {
            g.supported = None;
        }
        drop(g);
        self.notify();
    }

    pub fn set_supported(&self, supported: bool) {
        self.lock().supported = Some(supported);
        self.notify();
    }

    /// Up to `max` queued queries, oldest first.
    pub fn take(&self, max: usize) -> Vec<(u64, FacilityQuery)> {
        let mut g = self.lock();
        let n = max.min(g.queue.len());
        g.queue.drain(..n).collect()
    }

    pub fn complete(&self, ticket: u64, answer: FacilityAnswer) {
        let mut g = self.lock();
        if g.waiting.contains(&ticket) {
            g.done.insert(ticket, answer);
        }
        drop(g);
        self.notify();
    }
}

/// The process-wide broker the SimConnect provider serves.
pub fn global() -> &'static FacilityBroker {
    static B: OnceLock<FacilityBroker> = OnceLock::new();
    B.get_or_init(FacilityBroker::default)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn cbuf(s: &str, n: usize) -> Vec<u8> {
        let mut v = vec![0u8; n];
        v[..s.len()].copy_from_slice(s.as_bytes());
        v
    }

    /// A FACILITY_DATA message as SimConnect.h lays it out (`bool_list_item`: the 1-byte variant).
    pub fn msg_data(id: u32, request: u32, data_type: u32, payload: &[u8], bool_list_item: bool) -> Vec<u8> {
        let mut body: Vec<u8> = [request, 7, 0, data_type].iter().flat_map(|d| d.to_le_bytes()).collect();
        if bool_list_item {
            body.push(0);
        } else {
            body.extend_from_slice(&0u32.to_le_bytes());
        }
        body.extend_from_slice(&0u32.to_le_bytes()); // ItemIndex
        body.extend_from_slice(&0u32.to_le_bytes()); // ListSize
        body.extend_from_slice(payload);
        header(id, &body)
    }

    pub fn header(id: u32, body: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&((12 + body.len()) as u32).to_le_bytes());
        v.extend_from_slice(&6u32.to_le_bytes());
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(body);
        v
    }

    pub fn msg_end(id: u32, request: u32) -> Vec<u8> {
        header(id, &request.to_le_bytes())
    }

    pub fn position(lat: f64, lon: f64) -> Vec<u8> {
        [lat, lon].iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    pub fn waypoint(lat: f64, lon: f64, region: &str) -> Vec<u8> {
        let mut p = position(lat, lon);
        p.extend(cbuf(region, 8));
        p
    }

    pub fn route(airway: &str, next: Option<(&str, &str, f64, f64)>, prev: Option<(&str, &str, f64, f64)>) -> Vec<u8> {
        let mut p = cbuf(airway, 32);
        for f in [next, prev] {
            let (i, r, lat, lon) = f.unwrap_or(("", "", 0.0, 0.0));
            p.extend(cbuf(i, 8));
            p.extend(cbuf(r, 8));
            p.extend(position(lat, lon));
        }
        p
    }

    pub fn msg_minimal(id: u32, request: u32, items: &[(u8, &str, &str, f64, f64)]) -> Vec<u8> {
        let mut body: Vec<u8> = [request, items.len() as u32, 0, 1].iter().flat_map(|d| d.to_le_bytes()).collect();
        for (t, ident, region, lat, lon) in items {
            body.push(*t);
            body.extend(cbuf(ident, 9));
            body.extend(cbuf(region, 3));
            body.extend(cbuf("", 5));
            body.extend(position(*lat, *lon));
            body.extend(0f64.to_le_bytes());
        }
        header(id, &body)
    }

    #[test]
    fn sizes_match_the_definitions() {
        assert_eq!(ROUTE_LEN, 96);
        assert_eq!(route("UZ650", None, None).len(), ROUTE_LEN);
        assert_eq!(waypoint(1.0, 2.0, "ED").len(), WAYPOINT_LEN);
        // every OPEN has its CLOSE, data fields in between
        for k in FacKind::ALL {
            let f = k.fields();
            assert!(f[0].starts_with("OPEN ") && f[f.len() - 1].starts_with("CLOSE "), "{k:?}");
        }
    }

    #[test]
    fn data_decodes_at_either_list_item_width_and_in_both_numberings() {
        for (id, bool_item) in [(29, false), (29, true), (28, false), (28, true)] {
            let m = msg_data(id, REQ_BASE + 3, fdt::WAYPOINT, &waypoint(50.1, 8.6, "ED"), bool_item);
            let Some(FacilityMsg::Data { request, data_type, payload }) = classify(id, &m) else { panic!("{id} {bool_item}") };
            assert_eq!((request, data_type), (REQ_BASE + 3, fdt::WAYPOINT));
            assert_eq!(decode_position(data_type, &payload), Some((50.1, 8.6, "ED".into())));
        }
        // the end message in both numberings
        assert_eq!(classify(30, &msg_end(30, 9)), Some(FacilityMsg::End { request: 9 }));
        assert_eq!(classify(29, &msg_end(29, 9)), Some(FacilityMsg::End { request: 9 }));
        // unknown type / short payload: not a facility message we understand
        assert_eq!(classify(29, &msg_data(29, 1, 18, &[0; 16], false)), None);
        assert_eq!(classify(29, &msg_data(29, 1, fdt::ROUTE, &[0; 20], false)), None);
    }

    #[test]
    fn route_children_and_minimal_list() {
        let r = decode_route(&route("UZ650", Some(("ANEKI", "ED", 50.0, 8.0)), None)).unwrap();
        assert_eq!(r.airway, "UZ650");
        assert_eq!(r.next, Some(LinkFix { ident: "ANEKI".into(), region: "ED".into(), lat: 50.0, lon: 8.0 }));
        assert_eq!(r.prev, None);
        assert_eq!(decode_route(&[0u8; ROUTE_LEN]), None);

        for id in [30, 31] {
            let m = msg_minimal(id, 5, &[(b'W', "ROLIS", "ED", 49.0, 9.0), (b'V', "ROLIS", "LF", 45.0, 2.0)]);
            let Some(FacilityMsg::Minimal { request, entry, out_of, items }) = classify(id, &m) else { panic!() };
            assert_eq!((request, entry, out_of, items.len()), (5, 0, 1, 2));
            assert_eq!(
                items[1],
                MinimalFacility { kind: Some(FacKind::Vor), ident: "ROLIS".into(), region: "LF".into(), lat: 45.0, lon: 2.0 }
            );
        }
    }

    #[test]
    fn every_message_cut_short_never_panics() {
        let msgs = [
            msg_data(29, 1, fdt::WAYPOINT, &waypoint(1.0, 2.0, "K2"), false),
            msg_data(29, 1, fdt::ROUTE, &route("J1", None, None), true),
            msg_minimal(31, 1, &[(b'W', "A", "B", 1.0, 1.0)]),
            msg_end(30, 1),
        ];
        for m in msgs {
            for n in 0..=m.len() {
                for id in 28..=31 {
                    let _ = classify(id, &m[..n]);
                }
            }
        }
    }

    #[test]
    fn pending_collects_routes_and_answers_on_end() {
        let mut s = FacilityState::default();
        let t0 = Instant::now();
        let req = s.next_request_id();
        s.pending.insert(req, Pending::new(11, FacKind::Waypoint, t0));
        let msg = |b: Vec<u8>| classify(u32::from_le_bytes(b[8..12].try_into().unwrap()), &b).unwrap();
        assert_eq!(s.on_message(msg(msg_data(29, req, fdt::WAYPOINT, &waypoint(50.0, 8.0, "ED"), false))), None);
        assert_eq!(s.on_message(msg(msg_data(29, req, fdt::ROUTE, &route("T180", None, Some(("BOMBI", "ED", 49.0, 8.5))), false))), None);
        // an unknown request id is ignored
        assert_eq!(s.on_message(msg(msg_end(30, req + 1))), None);
        let (ticket, answer) = s.on_message(msg(msg_end(30, req))).unwrap();
        assert_eq!(ticket, 11);
        let FacilityAnswer::Found { lat, region, routes, .. } = answer else { panic!() };
        assert_eq!((lat, region.as_str(), routes.len()), (50.0, "ED", 1));
        // nothing arrived: not found; ambiguous ones come back as candidates
        let req = s.next_request_id();
        s.pending.insert(req, Pending::new(12, FacKind::Vor, t0));
        assert_eq!(s.on_message(msg(msg_end(30, req))), Some((12, FacilityAnswer::NotFound)));
        let req = s.next_request_id();
        s.pending.insert(req, Pending::new(13, FacKind::Ndb, t0));
        let (_, a) = s.on_message(msg(msg_minimal(31, req, &[(b'N', "KPT", "ED", 47.7, 10.3)]))).unwrap();
        assert!(matches!(a, FacilityAnswer::Ambiguous(v) if v.len() == 1));
        // and an unanswered one expires
        let req = s.next_request_id();
        s.pending.insert(req, Pending::new(14, FacKind::Ndb, t0));
        assert!(s.expired(t0 + Duration::from_secs(1)).is_empty());
        assert_eq!(s.expired(t0 + REQUEST_TIMEOUT + Duration::from_secs(1)), vec![14]);
    }

    #[test]
    fn broker_without_session_answers_none_at_once() {
        let b = FacilityBroker::default();
        let t = Instant::now();
        assert_eq!(b.lookup(&[FacilityQuery::new(FacKind::Vor, "ffm", "")], Duration::from_secs(3)), None);
        assert!(t.elapsed() < Duration::from_millis(500));
        assert_eq!(b.lookup(&[], Duration::from_secs(3)), Some(vec![]));
    }

    #[test]
    fn broker_round_trip_and_timeout() {
        let b = FacilityBroker::default();
        b.attach();
        let server = b.clone();
        let h = std::thread::spawn(move || {
            // the "session": answer the first query, leave the second unanswered
            loop {
                let got = server.take(8);
                if !got.is_empty() {
                    assert_eq!(got[0].1, FacilityQuery::new(FacKind::Waypoint, "ANEKI", ""));
                    server.complete(got[0].0, FacilityAnswer::Found { lat: 1.0, lon: 2.0, region: "ED".into(), routes: vec![] });
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        let qs = [FacilityQuery::new(FacKind::Waypoint, "aneki", ""), FacilityQuery::new(FacKind::Vor, "XYZ", "")];
        let a = b.lookup(&qs, Duration::from_millis(300)).unwrap();
        h.join().unwrap();
        assert!(matches!(a[0], FacilityAnswer::Found { .. }));
        assert_eq!(a[1], FacilityAnswer::NotFound);
        assert!(!b.busy());
        // nobody answers at all: skipped
        assert_eq!(b.lookup(&qs[..1], Duration::from_millis(50)), None);
        // the session says it cannot: skipped at once from then on
        b.set_supported(false);
        assert!(!b.available());
        assert_eq!(b.lookup(&qs[..1], Duration::from_secs(3)), None);
        b.detach();
        assert!(!b.available());
    }
}
