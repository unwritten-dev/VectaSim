//! The route field of an ICAO flight plan (item 15) as online pilots file it, reduced to what
//! can be drawn: points (fixes, navaids, airports, coordinates) and the airways between them.
//!
//! Grammar, applied token by token after splitting on whitespace and upper-casing:
//!
//! * a coordinate in one of the ICAO forms – `50N008E`, `5020N00830E`, `502000N0083000E`, also
//!   with a slash between latitude and longitude (`5020N/00830E`) – is a point;
//! * `X/…` keeps only `X`: speed/level changes (`ANEKI/N0450F350`), runway suffixes
//!   (`EDDF/25C`) and the like; a token starting with `/` or `C/` (cruise climb) is dropped;
//! * dropped outright: speed/level groups (`N0450F350`, `M082F370`, `K0850S1130`, `N0120VFR`),
//!   bare levels (`F350`, `A045`, `S1130`), `DCT`, `DIRECT`, `VFR`, `IFR`, `OAT`, `GAT`,
//!   `IFPSTOP`, `IFPSTART`, `SID`, `STAR` and `STAY…` (`STAY1/0030`), and anything with
//!   characters other than A–Z and 0–9, shorter than 2 or longer than 12;
//! * the departure as first and the arrival as last token are dropped (they are added from the
//!   airport index anyway);
//! * an airway-shaped token – 1 to 3 letters, 1 to 4 digits, an optional letter (`UZ650`,
//!   `L603`, `Y163`, `T180`, `J80`, `UN866`, `Q100`) – is an airway when a point precedes it in
//!   the list; there it joins the points on both sides. Without a point before it (right after a
//!   SID, at the start) it is kept as a point, so a fix that only looks like an airway still
//!   gets a chance;
//! * everything else is a point (5-letter fix, 2–3-letter navaid, 4-letter airport, terminal
//!   fixes like `DF432`, and SID/STAR names such as `ANEKI1L`, which the resolver later skips
//!   when they sit unresolved right after the departure or right before the arrival).

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    /// A named point to look up.
    Point(String),
    /// A coordinate given in the route itself: (latitude, longitude), the text as filed.
    Coord(f64, f64, String),
    /// An airway between the point before and the point after it.
    Airway(String),
}

const DROP: &[&str] = &["DCT", "DIRECT", "VFR", "IFR", "OAT", "GAT", "IFPSTOP", "IFPSTART", "SID", "STAR"];

/// Split a filed route into points and airways (see the module doc). `dep`/`arr` are the
/// ICAO codes from the flight plan.
pub fn tokenize(route: &str, dep: &str, arr: &str) -> Vec<Token> {
    let (dep, arr) = (dep.trim().to_ascii_uppercase(), arr.trim().to_ascii_uppercase());
    let mut words: Vec<Token> = Vec::new();
    for raw in route.split_whitespace() {
        let w = raw.to_ascii_uppercase();
        if let Some((lat, lon)) = parse_coord(&w) {
            words.push(Token::Coord(lat, lon, w));
            continue;
        }
        if w.starts_with("C/") || w.starts_with('/') || w.starts_with("STAY") {
            continue;
        }
        let w = w.split('/').next().unwrap_or_default();
        if w.len() < 2 || w.len() > 12 || !w.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
            continue;
        }
        if DROP.contains(&w) || is_speed_level(w) || is_level(w) {
            continue;
        }
        // a coordinate behind a slash prefix (`N0450F350/5020N00830E` does not occur, but the
        // left part of `5020N/00830E` was handled above)
        if let Some((lat, lon)) = parse_coord(w) {
            words.push(Token::Coord(lat, lon, w.to_owned()));
            continue;
        }
        words.push(Token::Point(w.to_owned()));
    }
    // departure/arrival repeated in the route
    if matches!(words.first(), Some(Token::Point(p)) if !dep.is_empty() && *p == dep) {
        words.remove(0);
    }
    if matches!(words.last(), Some(Token::Point(p)) if !arr.is_empty() && *p == arr) {
        words.pop();
    }
    // airways: only with a point before them
    let mut out: Vec<Token> = Vec::with_capacity(words.len());
    for t in words {
        if let Token::Point(p) = &t
            && is_airway_shape(p)
            && matches!(out.last(), Some(Token::Point(_) | Token::Coord(..)))
        {
            out.push(Token::Airway(p.clone()));
            continue;
        }
        out.push(t);
    }
    // a trailing airway has no point after it: nothing to join
    while matches!(out.last(), Some(Token::Airway(_))) {
        out.pop();
    }
    out
}

/// `UZ650`, `L603`, `J80`, `UN866`, `Q100`, `T180` …: 1–3 letters, 1–4 digits, optional letter.
pub fn is_airway_shape(s: &str) -> bool {
    let b = s.as_bytes();
    let letters = b.iter().take_while(|c| c.is_ascii_uppercase()).count();
    let digits = b[letters..].iter().take_while(|c| c.is_ascii_digit()).count();
    let rest = &b[letters + digits..];
    (1..=3).contains(&letters) && (1..=4).contains(&digits) && (rest.is_empty() || (rest.len() == 1 && rest[0].is_ascii_uppercase()))
}

/// `N0450F350`, `M082F370`, `K0850S1130`, `N0120VFR`, `N0450A045`, `M084`/`N0450` alone.
fn is_speed_level(s: &str) -> bool {
    let b = s.as_bytes();
    let speed_len = match b.first() {
        Some(b'N' | b'K') => 4,
        Some(b'M') => 3,
        _ => return false,
    };
    if b.len() < 1 + speed_len || !b[1..1 + speed_len].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let rest = &s[1 + speed_len..];
    rest.is_empty() || rest == "VFR" || is_level(rest)
}

/// `F350`, `A045`, `S1130`, `M0890`.
fn is_level(s: &str) -> bool {
    let b = s.as_bytes();
    let n = match b.first() {
        Some(b'F' | b'A') => 3,
        Some(b'S' | b'M') => 4,
        _ => return false,
    };
    b.len() == 1 + n && b[1..].iter().all(u8::is_ascii_digit)
}

/// ICAO coordinate forms: `50N008E`, `5020N00830E`, `502000N0083000E`, optionally with a `/`
/// between latitude and longitude. Degrees, minutes, seconds; minutes/seconds must be < 60.
pub fn parse_coord(s: &str) -> Option<(f64, f64)> {
    let s = s.trim();
    let ns = s.find(['N', 'S'])?;
    let (lat_digits, rest) = (&s[..ns], &s[ns + 1..]);
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let ew_char = rest.chars().last()?;
    if !matches!(ew_char, 'E' | 'W') {
        return None;
    }
    let lon_digits = &rest[..rest.len() - 1];
    let lat = dms(lat_digits, 2)?;
    let lon = dms(lon_digits, 3)?;
    if lat > 90.0 || lon > 180.0 {
        return None;
    }
    let lat = if &s[ns..=ns] == "S" { -lat } else { lat };
    let lon = if ew_char == 'W' { -lon } else { lon };
    Some((lat, lon))
}

/// `deg_len` digits of degrees, then optional 2 digits of minutes and 2 of seconds.
fn dms(d: &str, deg_len: usize) -> Option<f64> {
    if !d.bytes().all(|b| b.is_ascii_digit()) || ![deg_len, deg_len + 2, deg_len + 4].contains(&d.len()) {
        return None;
    }
    let num = |a: usize, b: usize| d[a..b].parse::<f64>().ok();
    let deg = num(0, deg_len)?;
    let min = if d.len() > deg_len { num(deg_len, deg_len + 2)? } else { 0.0 };
    let sec = if d.len() > deg_len + 2 { num(deg_len + 2, deg_len + 4)? } else { 0.0 };
    (min < 60.0 && sec < 60.0).then(|| deg + min / 60.0 + sec / 3600.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(t: &[Token]) -> Vec<String> {
        t.iter()
            .map(|t| match t {
                Token::Point(p) => p.clone(),
                Token::Coord(_, _, s) => format!("@{s}"),
                Token::Airway(a) => format!("~{a}"),
            })
            .collect()
    }

    #[test]
    fn typical_european_route() {
        let t = tokenize("N0450F350 ANEKI1L ANEKI/N0450F350 UZ650 DIBIR DCT KPT Y163 NATOR STAR1A EGLL", "EDDF", "EGLL");
        assert_eq!(names(&t), ["ANEKI1L", "ANEKI", "~UZ650", "DIBIR", "KPT", "~Y163", "NATOR", "STAR1A"]);
    }

    #[test]
    fn drops_levels_dct_rules_and_stay() {
        let t = tokenize(
            "EDDF DCT M082F370 SOBRA C/RIDSU/N0480F370F390 IFR VFR STAY1/0030 K0850S1130 F350 A045 RIDSU DCT EDDM",
            "EDDF",
            "EDDM",
        );
        assert_eq!(names(&t), ["SOBRA", "RIDSU"]);
        assert!(tokenize("DCT", "EDDF", "EDDM").is_empty());
        assert!(tokenize("", "EDDF", "EDDM").is_empty());
        assert!(tokenize("N0120VFR", "EDDF", "EDDM").is_empty());
    }

    #[test]
    fn airways_need_a_point_before_and_after() {
        // after a SID name the shape stays a point (could be a terminal fix like DF432)
        assert_eq!(names(&tokenize("DF432 L603 ABC T180", "", "")), ["DF432", "~L603", "ABC"]);
        assert_eq!(names(&tokenize("UL607", "", "")), ["UL607"]);
    }

    #[test]
    fn coordinates_in_all_icao_forms() {
        let near = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9;
        assert!(near(parse_coord("50N008E").unwrap(), (50.0, 8.0)));
        assert!(near(parse_coord("5020N00830E").unwrap(), (50.0 + 20.0 / 60.0, 8.5)));
        assert!(near(parse_coord("5020N/00830E").unwrap(), (50.0 + 20.0 / 60.0, 8.5)));
        assert!(near(parse_coord("502000N0083000E").unwrap(), (50.0 + 20.0 / 60.0, 8.5)));
        assert!(near(parse_coord("4530S07015W").unwrap(), (-45.5, -70.25)));
        assert!(near(parse_coord("62N020W").unwrap(), (62.0, -20.0)));
        for bad in ["5070N00830E", "95N008E", "50N181E", "ANEKI", "N0450F350", "5020N", "50N08E", "5020N00830"] {
            assert_eq!(parse_coord(bad), None, "{bad}");
        }
        let t = tokenize("ANEKI 5020N/00830E 50N010E DIBIR", "", "");
        assert_eq!(names(&t), ["ANEKI", "@5020N/00830E", "@50N010E", "DIBIR"]);
        // a coordinate before an airway lets the airway through
        assert_eq!(names(&tokenize("50N010E UL607 DIBIR", "", "")), ["@50N010E", "~UL607", "DIBIR"]);
    }

    #[test]
    fn shapes() {
        for a in ["UZ650", "L603", "Y163", "T180", "J80", "UN866", "Q100", "A1", "UM871", "J174A"] {
            assert!(is_airway_shape(a), "{a}");
        }
        for p in ["ANEKI", "KPT", "EDDF", "ANEKI1L", "12AB", "A12345", ""] {
            assert!(!is_airway_shape(p), "{p}");
        }
        assert!(is_speed_level("N0450F350") && is_speed_level("M082F370") && is_speed_level("K0850S1130") && is_speed_level("N0450"));
        assert!(!is_speed_level("NATOR") && !is_speed_level("KPT") && !is_speed_level("MAG"));
    }

    #[test]
    fn junk_is_ignored() {
        assert_eq!(names(&tokenize("ANEKI -- *X* T/O ÄÖÜ DIBIR", "", "")), ["ANEKI", "DIBIR"]);
    }
}
