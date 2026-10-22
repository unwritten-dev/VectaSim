//! Who may read: the access rules of the local server (DEVELOPMENT.md → Security).
//!
//! * Without the LAN switch the server listens on `127.0.0.1` only and needs no token.
//! * With it (`0.0.0.0`) every request from another device needs the token: `?token=…`, the
//!   header `Authorization: Bearer …`, `X-VectaSim-Token: …` or the cookie [`cookie_name`]
//!   (`vectasim_token_<port>`).
//!   Requests from this PC stay token-free, so the OBS URLs keep working.
//! * The query form is for the first load (OBS browser sources and WebSockets cannot send
//!   headers): a request authorised by `?token=` gets the token back as an `HttpOnly`,
//!   `SameSite=Strict` cookie, and `overlay.js` then takes the token out of the address bar
//!   (`history.replaceState`), so it does not stay in the browser history or in bookmarks;
//!   a bookmark without it keeps working through the cookie. A cookie with a token that is
//!   no longer valid (Regenerate, LAN access off) is deleted by the next answer (`Max-Age=0`).
//! * The start page (`/`) of a request that sent the valid token itself (query, header or
//!   cookie) carries it in a `<meta>` element while LAN access is on, so its copy URLs for OBS
//!   on another PC work even when the page was opened from a bookmark through the cookie (the
//!   JS reads and removes it). A token-free loopback request gets the empty element, so a local
//!   process cannot read the LAN token with a plain `GET /`.
//! * Token-free means: the peer is a loopback address **and** the `Host` header names the
//!   loopback (`127.0.0.1`, `localhost`, `[::1]`). A web page that rebinds its own domain to
//!   127.0.0.1 (DNS rebinding) sends its own `Host` and is refused.
//! * An `Origin` header (browsers send it on cross-origin fetches and on every WebSocket
//!   handshake) must be the server's own origin, a loopback origin (`http://localhost:…`,
//!   `http://127.0.0.1:…`, `http://[::1]:…`) or OBS's local-file origin `http://absolute`;
//!   anything else is refused (no data for foreign web pages, no cross-site WebSockets).
//! * Read-only: GET/HEAD (and the CORS preflight OPTIONS) – every other method is 405.

use std::net::{IpAddr, SocketAddr};

/// Length of a generated token (characters of [`TOKEN_ALPHABET`], ~119 bits).
pub const TOKEN_LEN: usize = 24;
/// No look-alikes (0/O, 1/l/I), URL-safe.
const TOKEN_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Random bytes from the OS; should that ever fail, from std's randomly keyed SipHash (also OS-seeded).
fn random_bytes(buf: &mut [u8]) {
    if getrandom::fill(buf).is_ok() {
        return;
    }
    use std::hash::{BuildHasher, Hasher};
    for (i, chunk) in buf.chunks_mut(8).enumerate() {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_usize(i);
        chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
    }
}

/// A new random token ([`TOKEN_LEN`] characters of [`TOKEN_ALPHABET`]).
pub fn generate_token() -> String {
    let n = TOKEN_ALPHABET.len();
    // rejection sampling keeps the distribution uniform over the alphabet
    let limit = (256 / n) * n;
    let mut out = String::with_capacity(TOKEN_LEN);
    while out.len() < TOKEN_LEN {
        let mut buf = [0u8; 32];
        random_bytes(&mut buf);
        for b in buf.iter().map(|&b| b as usize).filter(|&b| b < limit).take(TOKEN_LEN - out.len()) {
            out.push(TOKEN_ALPHABET[b % n] as char);
        }
    }
    out
}

/// A usable token: [`TOKEN_LEN`]-ish, only alphabet characters (a hand-edited setting is not trusted).
pub fn valid_token(t: &str) -> bool {
    (16..=128).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Constant-time comparison (no early exit on the first differing byte).
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Host part of a `Host` header (`[::1]:8095` → `[::1]`, `localhost:8095` → `localhost`).
fn host_name(host: &str) -> &str {
    let h = host.trim();
    if h.starts_with('[') {
        return h.find(']').map(|i| &h[..=i]).unwrap_or(h);
    }
    h.rsplit_once(':').map(|(n, _)| n).unwrap_or(h)
}

/// `Host` names the loopback.
pub fn is_loopback_host(host: &str) -> bool {
    let n = host_name(host).to_ascii_lowercase();
    n == "localhost" || n == "127.0.0.1" || n == "[::1]"
}

pub(crate) fn is_loopback_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    }
}

/// `Origin` allowed (see the module doc). `host` is the request's `Host` header.
pub fn origin_allowed(origin: &str, host: Option<&str>) -> bool {
    let o = origin.trim().to_ascii_lowercase();
    if o == "http://absolute" {
        return true;
    }
    if let Some(h) = host
        && o == format!("http://{}", h.trim().to_ascii_lowercase())
    {
        return true;
    }
    let Some(rest) = o.strip_prefix("http://") else { return false };
    if rest.contains('/') {
        return false;
    }
    let (name, port) = if rest.starts_with('[') {
        match rest.find(']') {
            Some(i) => (&rest[..=i], rest[i + 1..].strip_prefix(':')),
            None => return false,
        }
    } else {
        match rest.split_once(':') {
            Some((n, p)) => (n, Some(p)),
            None => (rest, None),
        }
    };
    if rest.starts_with('[') && port.is_none() && !rest.ends_with(']') {
        return false;
    }
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    port_ok && matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

/// Prefix of the cookie that carries the token after a first load with `?token=` (module doc);
/// the full name ends in the server's port ([`cookie_name`]).
pub const TOKEN_COOKIE: &str = "vectasim_token";

/// The cookie name for the server on `port` (`vectasim_token_8095`). Browsers do not tie
/// cookies to a port (every port of the address gets them sent; nothing on the server side can
/// change that), so the port in the name at least keeps two VectaSim ports, or a port change,
/// from reading each other's token, and it lets a new port start without a stale cookie.
pub fn cookie_name(port: u16) -> String {
    format!("{TOKEN_COOKIE}_{port}")
}

/// How long the browser keeps the token cookie (a year; a new token replaces it, a refused
/// one is cleared, see [`clear_cookie`]).
pub const TOKEN_COOKIE_MAX_AGE_S: u64 = 365 * 24 * 3600;

/// The `token` parameter of a query string.
pub fn query_token(query: Option<&str>) -> Option<&str> {
    query?.split('&').find_map(|kv| kv.strip_prefix("token=")).filter(|t| !t.is_empty())
}

/// The value of the cookie `name` in a `Cookie` header (exact name match).
pub fn cookie_token<'a>(cookie: Option<&'a str>, name: &str) -> Option<&'a str> {
    cookie?
        .split(';')
        .find_map(|kv| kv.trim().strip_prefix(name).and_then(|r| r.strip_prefix('=')))
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

/// The `Set-Cookie` value that hands `token` to the browser as cookie `name` (only alphabet
/// characters, see [`valid_token`], so nothing needs quoting). No `Secure`: plain HTTP.
pub fn token_cookie(name: &str, token: &str) -> String {
    format!("{name}={token}; Path=/; Max-Age={TOKEN_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict")
}

/// The `Set-Cookie` value that deletes cookie `name` (a stale token after Regenerate or after
/// LAN access was switched off, or the port-less cookie of older versions).
pub fn clear_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
}

/// The token a request carries: `X-VectaSim-Token`, `Authorization: Bearer`, query `token`,
/// cookie `cookie_name` – in that order, so a new token in the URL beats a stale cookie.
pub fn request_token<'a>(
    query: Option<&'a str>,
    authorization: Option<&'a str>,
    header: Option<&'a str>,
    cookie: Option<&'a str>,
    cookie_name: &str,
) -> Option<&'a str> {
    if let Some(h) = header.map(str::trim).filter(|h| !h.is_empty()) {
        return Some(h);
    }
    if let Some(b) = authorization.and_then(|a| a.trim().strip_prefix("Bearer ")).map(str::trim).filter(|b| !b.is_empty()) {
        return Some(b);
    }
    query_token(query).or_else(|| cookie_token(cookie, cookie_name))
}

/// The cookies an answer deletes: the port cookie when it carries a token that is not (or no
/// longer) the configured one, and the port-less cookie of older versions whenever it is sent.
/// `expected` is the LAN token, `None` while LAN access is off.
pub fn stale_cookies(cookie: Option<&str>, name: &str, expected: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(c) = cookie_token(cookie, name)
        && !expected.is_some_and(|e| token_eq(c, e))
    {
        out.push(name.to_string());
    }
    if cookie_token(cookie, TOKEN_COOKIE).is_some() {
        out.push(TOKEN_COOKIE.to_string());
    }
    out
}

/// The request comes from this PC: loopback peer **and** loopback `Host` (module doc).
pub fn is_local(peer: SocketAddr, host: Option<&str>) -> bool {
    is_loopback_peer(peer.ip()) && host.is_some_and(is_loopback_host)
}

/// Why a request is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denied {
    /// 405: only reading methods.
    Method,
    /// 403: foreign `Origin`.
    Origin,
    /// 401: token missing or wrong.
    Token,
    /// 403: not a loopback `Host` and no LAN access configured.
    Host,
}

impl Denied {
    pub fn status(self) -> u16 {
        match self {
            Denied::Method => 405,
            Denied::Origin | Denied::Host => 403,
            Denied::Token => 401,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Denied::Method => "Nur lesender Zugriff (GET).",
            Denied::Origin => "Ursprung (Origin) nicht erlaubt.",
            Denied::Token => "Token fehlt oder ist falsch (?token=… aus Einstellungen → Overlay & Schnittstelle).",
            Denied::Host => "Nur über 127.0.0.1 / localhost erreichbar.",
        }
    }
}

/// What [`check`] looks at, taken from one request.
#[derive(Clone, Copy, Debug, Default)]
pub struct RequestInfo<'a> {
    pub method: &'a str,
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    /// Token from [`request_token`].
    pub token: Option<&'a str>,
}

/// The access decision for one request (module doc). `token` is the configured LAN token,
/// `None` while LAN access is off.
pub fn check(req: &RequestInfo<'_>, peer: SocketAddr, token: Option<&str>) -> Result<(), Denied> {
    if !matches!(req.method, "GET" | "HEAD" | "OPTIONS") {
        return Err(Denied::Method);
    }
    if let Some(o) = req.origin
        && !origin_allowed(o, req.host)
    {
        return Err(Denied::Origin);
    }
    if is_local(peer, req.host) {
        return Ok(());
    }
    // the CORS preflight carries no credentials; it only reaches here with an allowed Origin
    if req.method == "OPTIONS" && req.origin.is_some() {
        return Ok(());
    }
    match token {
        Some(expected) if !expected.is_empty() => match req.token {
            Some(t) if token_eq(t, expected) => Ok(()),
            _ => Err(Denied::Token),
        },
        _ => Err(Denied::Host),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: &str = "127.0.0.1:50000";
    const LAN: &str = "192.168.1.20:50000";

    fn req<'a>(host: &'a str, origin: Option<&'a str>, token: Option<&'a str>) -> RequestInfo<'a> {
        RequestInfo { method: "GET", host: Some(host), origin, token }
    }

    #[test]
    fn tokens() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), TOKEN_LEN);
        assert_ne!(a, b);
        assert!(valid_token(&a), "{a}");
        assert!(!valid_token("short"));
        assert!(!valid_token("abc def ghi jkl mno pqr"));
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
    }

    #[test]
    fn token_sources() {
        let n = cookie_name(8095);
        let n = n.as_str();
        assert_eq!(n, "vectasim_token_8095");
        assert_eq!(request_token(Some("scale=2&token=XyZ"), None, None, None, n), Some("XyZ"));
        assert_eq!(request_token(Some("token="), None, None, None, n), None);
        assert_eq!(request_token(None, Some("Bearer abc"), None, None, n), Some("abc"));
        assert_eq!(request_token(Some("token=q"), Some("Bearer b"), Some("h"), None, n), Some("h"));
        assert_eq!(request_token(Some("xtoken=q"), Some("Basic abc"), None, None, n), None);
        // the cookie only when nothing else is there; a token in the URL beats a stale cookie
        assert_eq!(request_token(None, None, None, Some("a=1; vectasim_token_8095=Ck; b=2"), n), Some("Ck"));
        assert_eq!(request_token(Some("token=new"), None, None, Some("vectasim_token_8095=old"), n), Some("new"));
        assert_eq!(request_token(None, None, None, Some("vectasim_token_8095x=no; vectasim_token_8095="), n), None);
        // the cookie of another port (or the port-less one of older versions) is not ours
        assert_eq!(request_token(None, None, None, Some("vectasim_token_8096=Other; vectasim_token=Old"), n), None);
        assert_eq!(token_cookie(n, "abc"), "vectasim_token_8095=abc; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict");
        assert_eq!(clear_cookie(n), "vectasim_token_8095=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
    }

    #[test]
    fn stale_cookies_are_cleared() {
        let n = "vectasim_token_8095";
        let tok = "t0k3nt0k3nt0k3nt0k3n";
        // the right token: nothing to clear
        assert!(stale_cookies(Some("vectasim_token_8095=t0k3nt0k3nt0k3nt0k3n"), n, Some(tok)).is_empty());
        // Regenerate: the old cookie goes
        assert_eq!(stale_cookies(Some("vectasim_token_8095=oldoldoldoldoldold"), n, Some(tok)), [n]);
        // LAN switched off: the cookie goes too
        assert_eq!(stale_cookies(Some("vectasim_token_8095=t0k3nt0k3nt0k3nt0k3n"), n, None), [n]);
        // the port-less cookie of older versions always goes
        assert_eq!(stale_cookies(Some("vectasim_token=t0k3nt0k3nt0k3nt0k3n"), n, Some(tok)), [TOKEN_COOKIE]);
        assert!(stale_cookies(None, n, Some(tok)).is_empty());
        assert!(stale_cookies(Some("other=1"), n, None).is_empty());
    }

    #[test]
    fn loopback_needs_no_token() {
        let peer = LOCAL.parse().unwrap();
        assert_eq!(check(&req("127.0.0.1:8095", None, None), peer, None), Ok(()));
        assert_eq!(check(&req("localhost:8095", None, None), peer, Some("t0k3nt0k3nt0k3nt0k3n")), Ok(()));
        assert_eq!(check(&req("[::1]:8095", None, None), "[::1]:5000".parse().unwrap(), None), Ok(()));
    }

    #[test]
    fn dns_rebinding_is_refused() {
        let peer = LOCAL.parse().unwrap();
        // a page on evil.example rebinding its name to 127.0.0.1
        assert_eq!(check(&req("evil.example:8095", None, None), peer, None), Err(Denied::Host));
        assert_eq!(check(&req("evil.example:8095", Some("http://evil.example:8095"), None), peer, Some("t0k3nt0k3nt0k3nt0k3n")), Err(Denied::Token));
    }

    #[test]
    fn lan_needs_the_token() {
        let peer = LAN.parse().unwrap();
        let tok = "t0k3nt0k3nt0k3nt0k3n";
        assert_eq!(check(&req("192.168.1.5:8095", None, None), peer, Some(tok)), Err(Denied::Token));
        assert_eq!(check(&req("192.168.1.5:8095", None, Some("wrong")), peer, Some(tok)), Err(Denied::Token));
        assert_eq!(check(&req("192.168.1.5:8095", None, Some(tok)), peer, Some(tok)), Ok(()));
        // a LAN peer faking a loopback Host header still needs the token
        assert_eq!(check(&req("127.0.0.1:8095", None, None), peer, Some(tok)), Err(Denied::Token));
        // LAN off: nothing from outside (cannot happen with the 127.0.0.1 bind, checked anyway)
        assert_eq!(check(&req("192.168.1.5:8095", None, Some(tok)), peer, None), Err(Denied::Host));
    }

    #[test]
    fn origins() {
        assert!(origin_allowed("http://localhost", None));
        assert!(origin_allowed("http://localhost:3000", None));
        assert!(origin_allowed("http://127.0.0.1:8095", None));
        assert!(origin_allowed("http://[::1]:8095", None));
        assert!(origin_allowed("http://absolute", None));
        assert!(origin_allowed("http://192.168.1.5:8095", Some("192.168.1.5:8095")));
        assert!(!origin_allowed("http://192.168.1.5:8095", Some("192.168.1.6:8095")));
        assert!(!origin_allowed("https://evil.example", Some("127.0.0.1:8095")));
        assert!(!origin_allowed("http://localhost.evil.example", None));
        assert!(!origin_allowed("http://localhost:80x", None));
        assert!(!origin_allowed("null", None));
        let peer = LOCAL.parse().unwrap();
        assert_eq!(check(&req("127.0.0.1:8095", Some("https://evil.example"), None), peer, None), Err(Denied::Origin));
        assert_eq!(check(&req("127.0.0.1:8095", Some("http://localhost:5173"), None), peer, None), Ok(()));
    }

    #[test]
    fn read_only() {
        let peer = LOCAL.parse().unwrap();
        for m in ["POST", "PUT", "DELETE", "PATCH"] {
            assert_eq!(check(&RequestInfo { method: m, host: Some("127.0.0.1:8095"), ..Default::default() }, peer, None), Err(Denied::Method));
        }
        // preflight from an allowed origin on the LAN address passes without credentials
        let pre = RequestInfo { method: "OPTIONS", host: Some("192.168.1.5:8095"), origin: Some("http://localhost:3000"), token: None };
        assert_eq!(check(&pre, LAN.parse().unwrap(), Some("t0k3nt0k3nt0k3nt0k3n")), Ok(()));
    }
}
