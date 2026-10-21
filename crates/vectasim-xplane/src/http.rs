//! Minimal blocking HTTP/1.1 GET for the X-Plane Web API (plain HTTP on localhost, a few
//! small JSON documents per session – not worth an HTTP client stack). Handles
//! `Content-Length`, `Transfer-Encoding: chunked` and read-to-close bodies.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

/// Largest response accepted (the full dataref list of X-Plane is ~1 MB). Also the
/// limit of a single chunk – a bogus size (`ffffffffffffffff`) is an error, not a panic.
pub const MAX_BODY: usize = 4 * 1024 * 1024;

/// Whole-request deadline as a multiple of the per-read `timeout` (a server trickling
/// one byte per read must not hold the call open indefinitely).
const TOTAL_TIMEOUT_FACTOR: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// `host:port` for a `Host` header or a URL; an IPv6 address goes in brackets (`[fe80::1]:8086`).
pub fn authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// Opens the TCP connection for a request or the WebSocket. Only addresses of this PC or the
/// local network ([`crate::ip_scope`]) are dialled: a host name that resolves to public
/// addresses only is refused (the Web API is plain HTTP without a password, never across the
/// internet). The name is resolved and checked again on every connect and reconnect.
pub fn connect(host: &str, port: u16, timeout: Duration) -> io::Result<TcpStream> {
    connect_with(host, port, timeout, |h, p| Ok((h, p).to_socket_addrs()?.collect()))
}

/// [`connect`] with its own resolver (tests).
pub fn connect_with(
    host: &str,
    port: u16,
    timeout: Duration,
    resolve: impl FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
) -> io::Result<TcpStream> {
    let all = resolve(host, port)?;
    let local: Vec<SocketAddr> = all.iter().copied().filter(|a| crate::ip_scope(a.ip()).is_ok()).collect();
    if local.is_empty()
        && let Some(first) = all.first()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{host} resolves to the public address {} – the X-Plane Web API is unencrypted, only this PC or the local network", first.ip()),
        ));
    }
    let mut last = io::Error::new(io::ErrorKind::NotFound, format!("{host}:{port}: no address"));
    for addr in local {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(s) => return Ok(s),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// `GET path` (path incl. query, sent as is).
pub fn get(host: &str, port: u16, path: &str, timeout: Duration) -> io::Result<Response> {
    let mut s = connect(host, port, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n", authority(host, port));
    s.write_all(req.as_bytes())?;
    let deadline = Instant::now() + timeout * TOTAL_TIMEOUT_FACTOR;
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 16 * 1024];
    loop {
        if let Some(r) = parse(&buf, false)? {
            return Ok(r);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "response took too long"));
        }
        s.set_read_timeout(Some(left.min(timeout)))?;
        let n = s.read(&mut chunk)?;
        if n == 0 {
            return parse(&buf, true)?.ok_or_else(|| invalid("connection closed before the response was complete"));
        }
        buf.extend_from_slice(&chunk[..n]);
        // body plus head and chunk framing
        if buf.len() > MAX_BODY + 64 * 1024 {
            return Err(invalid("response too large"));
        }
    }
}

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_owned())
}

/// A complete response in `buf`, `None` if more bytes are needed (`eof`: no more will come).
pub fn parse(buf: &[u8], eof: bool) -> io::Result<Option<Response>> {
    let Some(head_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return if eof { Err(invalid("no HTTP header")) } else { Ok(None) };
    };
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| invalid(&format!("bad status line: {status_line}")))?;
    let (mut length, mut chunked) = (None, false);
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if k.eq_ignore_ascii_case("content-length") {
            length = v.parse::<usize>().ok();
        } else if k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    let body = &buf[head_end + 4..];
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    if chunked {
        return match dechunk(body)? {
            Some(b) => Ok(Some(Response { status, body: text(&b) })),
            None if eof => Err(invalid("chunked body cut off")),
            None => Ok(None),
        };
    }
    match length {
        Some(n) if n > MAX_BODY => Err(invalid("response too large")),
        Some(n) if body.len() >= n => Ok(Some(Response { status, body: text(&body[..n]) })),
        Some(_) if eof => Err(invalid("body shorter than Content-Length")),
        Some(_) => Ok(None),
        None if eof => Ok(Some(Response { status, body: text(body) })),
        None => Ok(None),
    }
}

/// Decoded chunked body, `None` while the terminating chunk is missing.
fn dechunk(mut b: &[u8]) -> io::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    loop {
        let Some(eol) = b.windows(2).position(|w| w == b"\r\n") else { return Ok(None) };
        let size_text = String::from_utf8_lossy(&b[..eol]);
        let size_hex = size_text.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| invalid("bad chunk size"))?;
        b = &b[eol + 2..];
        if size == 0 {
            return Ok(Some(out));
        }
        if size > MAX_BODY || out.len() + size > MAX_BODY {
            return Err(invalid("chunk too large"));
        }
        let Some(end) = size.checked_add(2) else { return Err(invalid("chunk too large")) };
        if b.len() < end {
            return Ok(None);
        }
        out.extend_from_slice(&b[..size]);
        b = &b[end..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_length_and_partial() {
        let r = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"data\":1}";
        assert_eq!(parse(r, false).unwrap(), None, "one byte missing");
        let full = [&r[..], b"\n"].concat();
        assert_eq!(parse(&full, false).unwrap().unwrap(), Response { status: 200, body: "{\"data\":1}\n".into() });
        assert!(parse(r, true).is_err());
    }

    #[test]
    fn chunked_and_read_to_close() {
        let r = b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
        assert_eq!(parse(r, false).unwrap().unwrap(), Response { status: 404, body: "{\"a\":1}".into() });
        assert_eq!(parse(&r[..r.len() - 5], false).unwrap(), None);
        let c = b"HTTP/1.0 200 OK\r\n\r\nhello";
        assert_eq!(parse(c, false).unwrap(), None);
        assert_eq!(parse(c, true).unwrap().unwrap().body, "hello");
    }

    #[test]
    fn huge_chunk_size_is_an_error_not_a_panic() {
        let r = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\nabc";
        let e = parse(r, false).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::InvalidData);
        assert!(parse(r, true).is_err());
        // just above the limit (would otherwise wait for 4 MiB + 1 bytes)
        let over = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\nabc", MAX_BODY + 1);
        assert!(parse(over.as_bytes(), false).is_err());
        // several chunks that together exceed the limit
        let half = MAX_BODY / 2 + 1;
        let mut many = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{half:x}\r\n").into_bytes();
        many.extend(std::iter::repeat_n(b'a', half));
        many.extend(format!("\r\n{half:x}\r\n").bytes());
        assert!(parse(&many, false).is_err());
        // a chunk at the limit itself is fine
        let mut ok = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{MAX_BODY:x}\r\n").into_bytes();
        ok.extend(std::iter::repeat_n(b'a', MAX_BODY));
        ok.extend(b"\r\n0\r\n\r\n");
        assert_eq!(parse(&ok, false).unwrap().unwrap().body.len(), MAX_BODY);
        // Content-Length above the limit
        assert!(parse(b"HTTP/1.1 200 OK\r\nContent-Length: 99999999999\r\n\r\n", false).is_err());
    }
}
