//! Shared recorder: one per process, fed by the SimConnect session thread, controlled
//! from the app (switch in Einstellungen → Diagnose, "Dump jetzt speichern").
//!
//! Two outputs, both fed from the same serialised line:
//! * a file per SimConnect session (`<dir>/<start>.vsdump`) while the switch is on, or a
//!   single fixed file (probe tool `--dump`);
//! * a RAM ring of the last 30 minutes (≤ 64 MB) in 60-s chunks, each a finished zstd
//!   frame, so [`DumpRecorder::dump_ring`] only concatenates frames.

use crate::delta::DeltaEncoder;
use crate::{Body, EXTENSION, Header, Line, file_stamp};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// zstd level of session files and ring chunks: plenty for ~20 KB/s of JSON, cheap on CPU.
const LEVEL: i32 = 6;
/// A session file is flushed this often, so a crash of the app loses at most this much.
const FLUSH_EVERY: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RingConfig {
    /// Lines older than this (by `t`) are dropped.
    pub max_age_ms: u64,
    /// Upper bound for the compressed chunks plus the open chunk.
    pub max_bytes: usize,
    /// Length of one chunk; the open chunk is kept as text, closed ones compressed.
    pub chunk_ms: u64,
}

impl Default for RingConfig {
    fn default() -> Self {
        Self { max_age_ms: 30 * 60_000, max_bytes: 64 * 1024 * 1024, chunk_ms: 60_000 }
    }
}

/// Where the per-session file goes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum FileTarget {
    #[default]
    Off,
    /// One file per session, `<dir>/<start>.vsdump`.
    Dir(PathBuf),
    /// One fixed file for everything (sessions follow each other in it).
    Path(PathBuf),
}

/// What the Diagnose view shows about the recorder.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpStatus {
    /// Session files are being written (switch on).
    pub enabled: bool,
    /// The file currently written, if any.
    pub file: Option<String>,
    /// Uncompressed bytes written to it.
    pub file_bytes: u64,
    /// Time span the RAM ring covers, seconds.
    pub ring_seconds: f64,
    /// Memory the RAM ring holds.
    pub ring_bytes: usize,
    pub ring_lines: u64,
    /// Last write error (the recording then stops until the next session).
    pub last_error: Option<String>,
}

fn line_text(enc: &mut DeltaEncoder, line: &Line) -> Option<String> {
    match serde_json::to_string(&enc.encode(line)) {
        Ok(mut s) => {
            s.push('\n');
            Some(s)
        }
        Err(e) => {
            log::warn!("raw dump: line not serialisable: {e}");
            None
        }
    }
}

struct FileSink {
    path: PathBuf,
    delta: DeltaEncoder,
    enc: zstd::Encoder<'static, BufWriter<File>>,
    bytes: u64,
    last_flush: Instant,
}

impl FileSink {
    fn create(path: PathBuf, header: &Header) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut enc = zstd::Encoder::new(BufWriter::new(File::create(&path)?), LEVEL)?;
        let line = header_line(header);
        enc.write_all(line.as_bytes())?;
        Ok(Self { path, delta: DeltaEncoder::default(), bytes: line.len() as u64, enc, last_flush: Instant::now() })
    }

    fn write(&mut self, line: &Line) -> io::Result<()> {
        let Some(line) = line_text(&mut self.delta, line) else { return Ok(()) };
        self.enc.write_all(line.as_bytes())?;
        self.bytes += line.len() as u64;
        if self.last_flush.elapsed() >= FLUSH_EVERY {
            self.enc.flush()?;
            self.last_flush = Instant::now();
        }
        Ok(())
    }

    fn finish(self) -> io::Result<PathBuf> {
        let mut w = self.enc.finish()?;
        w.flush()?;
        Ok(self.path)
    }
}

struct Chunk {
    header: Header,
    first_t: u64,
    last_t: u64,
    lines: u64,
    /// One complete zstd frame.
    bytes: Vec<u8>,
}

struct OpenChunk {
    header: Header,
    delta: DeltaEncoder,
    first_t: u64,
    last_t: u64,
    lines: u64,
    text: String,
}

#[derive(Default)]
struct Ring {
    cfg: RingConfig,
    sealed: VecDeque<Chunk>,
    open: Option<OpenChunk>,
    sealed_bytes: usize,
}

impl Ring {
    fn push(&mut self, header: Option<&Header>, line: &Line) {
        let t = line.t;
        if self.open.as_ref().is_some_and(|c| t.saturating_sub(c.first_t) >= self.cfg.chunk_ms) {
            self.seal();
        }
        let chunk = self.open.get_or_insert_with(|| OpenChunk {
            header: header.cloned().unwrap_or_else(|| Header::new("", "", Default::default(), Default::default())),
            delta: DeltaEncoder::default(),
            first_t: t,
            last_t: t,
            lines: 0,
            text: String::new(),
        });
        let Some(text) = line_text(&mut chunk.delta, line) else { return };
        chunk.text.push_str(&text);
        chunk.last_t = t;
        chunk.lines += 1;
        self.evict(t);
    }

    fn seal(&mut self) {
        let Some(c) = self.open.take() else { return };
        match zstd::encode_all(c.text.as_bytes(), LEVEL) {
            Ok(bytes) => {
                self.sealed_bytes += bytes.len();
                self.sealed.push_back(Chunk { header: c.header, first_t: c.first_t, last_t: c.last_t, lines: c.lines, bytes });
            }
            Err(e) => log::warn!("raw dump ring: compressing a chunk failed: {e}"),
        }
    }

    fn open_bytes(&self) -> usize {
        self.open.as_ref().map_or(0, |c| c.text.len())
    }

    fn evict(&mut self, now_t: u64) {
        while let Some(front) = self.sealed.front() {
            let too_old = front.last_t.saturating_add(self.cfg.max_age_ms) < now_t;
            let too_big = self.sealed_bytes + self.open_bytes() > self.cfg.max_bytes;
            if !(too_old || too_big) {
                break;
            }
            self.sealed_bytes -= front.bytes.len();
            self.sealed.pop_front();
        }
    }

    fn first(&self) -> Option<(&Header, u64)> {
        self.sealed.front().map(|c| (&c.header, c.first_t)).or_else(|| self.open.as_ref().map(|c| (&c.header, c.first_t)))
    }

    fn last_t(&self) -> Option<u64> {
        self.open.as_ref().map(|c| c.last_t).or_else(|| self.sealed.back().map(|c| c.last_t))
    }

    fn lines(&self) -> u64 {
        self.sealed.iter().map(|c| c.lines).sum::<u64>() + self.open.as_ref().map_or(0, |c| c.lines)
    }
}

struct Inner {
    /// Header of the running session (defs, DLL, sim once known, dropped variables).
    header: Option<Header>,
    target: FileTarget,
    file: Option<FileSink>,
    /// The file target failed for this session; retried with the next one.
    file_failed: bool,
    ring: Ring,
    last_error: Option<String>,
    /// Lines of a session whose file waits for `OPEN` (so the header names the sim).
    pending: Vec<Line>,
}

/// Process-wide raw recorder (see module doc). All methods are cheap and never fail the
/// caller: write errors are logged and shown in [`DumpStatus::last_error`].
pub struct DumpRecorder {
    app: String,
    epoch: Instant,
    epoch_wall_ms: u64,
    inner: Mutex<Inner>,
}

fn header_line(h: &Header) -> String {
    let mut s = serde_json::to_string(h).unwrap_or_default();
    s.push('\n');
    s
}

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl DumpRecorder {
    /// `app`: version written into every header.
    pub fn new(app: impl Into<String>, ring: RingConfig) -> Self {
        Self {
            app: app.into(),
            epoch: Instant::now(),
            epoch_wall_ms: wall_ms(),
            inner: Mutex::new(Inner {
                header: None,
                target: FileTarget::Off,
                file: None,
                file_failed: false,
                ring: Ring { cfg: ring, ..Default::default() },
                last_error: None,
                pending: Vec::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Monotonic ms of `now` since the recorder started (the `t` of a line).
    pub fn t_of(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.epoch).as_millis() as u64
    }

    /// Switch session files on/off (or to a fixed path). Turning it off closes the file.
    pub fn set_target(&self, target: FileTarget) {
        let mut g = self.lock();
        if g.target == target {
            return;
        }
        flush_pending(&mut g);
        g.target = target;
        g.file_failed = false;
        close_file(&mut g);
    }

    /// A new SimConnect session starts: its header (defs, DLL; sim fields once known).
    /// A previous session's file is closed (a fixed-path target stays open).
    pub fn begin_session(&self, mut header: Header) {
        header.app = self.app.clone();
        header.started_wall_ms = self.epoch_wall_ms;
        let mut g = self.lock();
        flush_pending(&mut g);
        if matches!(g.target, FileTarget::Dir(_)) {
            close_file(&mut g);
        }
        g.file_failed = false;
        g.header = Some(header);
    }

    /// Change the running session's header (sim info after `OPEN`, a dropped variable).
    /// Affects files and ring chunks started from now on; the change itself is in the lines.
    pub fn update_header(&self, f: impl FnOnce(&mut Header)) {
        if let Some(h) = self.lock().header.as_mut() {
            f(h);
        }
    }

    /// The session ended (after its `end` line). Closes a per-session file.
    pub fn end_session(&self) {
        let mut g = self.lock();
        flush_pending(&mut g);
        if matches!(g.target, FileTarget::Dir(_)) {
            close_file(&mut g);
        }
    }

    /// Record one message handled at `now` (wall clock `w`).
    pub fn record(&self, now: Instant, w: u64, body: Body) {
        let line = Line { t: self.t_of(now), w, body };
        let mut g = self.lock();
        let g = &mut *g;
        g.ring.push(g.header.as_ref(), &line);
        if g.file.is_none() && !g.file_failed && g.target != FileTarget::Off && g.header.is_some() {
            let ready = matches!(line.body, Body::Open { .. })
                || g.header.as_ref().is_some_and(|h| h.sim.is_some())
                || g.pending.len() >= PENDING_MAX
                || g.pending.first().is_some_and(|p| line.t.saturating_sub(p.t) > PENDING_MAX_MS);
            if !ready {
                g.pending.push(line);
                return;
            }
            open_file(g, w);
        }
        write_line(g, &line);
    }

    /// Write the RAM ring (last ≤ 30 min) to `path`. Returns the number of lines written.
    pub fn dump_ring(&self, path: &Path) -> io::Result<u64> {
        let g = self.lock();
        let Some((header, _)) = g.ring.first() else {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no raw data recorded yet"));
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut out = BufWriter::new(File::create(path)?);
        out.write_all(&zstd::encode_all(header_line(header).as_bytes(), LEVEL)?)?;
        for c in &g.ring.sealed {
            out.write_all(&c.bytes)?;
        }
        if let Some(c) = &g.ring.open {
            out.write_all(&zstd::encode_all(c.text.as_bytes(), LEVEL)?)?;
        }
        out.flush()?;
        Ok(g.ring.lines())
    }

    pub fn status(&self) -> DumpStatus {
        let g = self.lock();
        let span = match (g.ring.first(), g.ring.last_t()) {
            (Some((_, a)), Some(b)) => b.saturating_sub(a) as f64 / 1000.0,
            _ => 0.0,
        };
        DumpStatus {
            enabled: g.target != FileTarget::Off,
            file: g.file.as_ref().map(|f| f.path.display().to_string()),
            file_bytes: g.file.as_ref().map_or(0, |f| f.bytes),
            ring_seconds: span,
            ring_bytes: g.ring.sealed_bytes + g.ring.open_bytes(),
            ring_lines: g.ring.lines(),
            last_error: g.last_error.clone(),
        }
    }

    /// Push buffered data of the session file to disk now (normally done every second).
    pub fn flush(&self) {
        let mut g = self.lock();
        if let Some(f) = g.file.as_mut() {
            let _ = f.enc.flush();
            f.last_flush = Instant::now();
        }
    }

    /// Close the current file (app exit); the next record opens a new one if still enabled.
    pub fn flush_and_close(&self) {
        let mut g = self.lock();
        flush_pending(&mut g);
        close_file(&mut g);
    }
}

impl Drop for DumpRecorder {
    fn drop(&mut self) {
        self.flush_and_close();
    }
}

/// Most lines held back while waiting for `OPEN`, and for how long.
const PENDING_MAX: usize = 512;
const PENDING_MAX_MS: u64 = 10_000;

/// Create the session file and write the lines held back for it.
fn open_file(g: &mut Inner, w: u64) {
    let path = match &g.target {
        FileTarget::Off => return,
        FileTarget::Dir(dir) => dir.join(format!("{}.{EXTENSION}", file_stamp(w))),
        FileTarget::Path(p) => p.clone(),
    };
    let Some(header) = g.header.as_ref() else { return };
    match FileSink::create(path.clone(), header) {
        Ok(f) => {
            log::info!("raw dump: writing {}", path.display());
            g.file = Some(f);
            for l in std::mem::take(&mut g.pending) {
                write_line(g, &l);
            }
        }
        Err(e) => {
            let msg = format!("raw dump: cannot create {}: {e}", path.display());
            log::warn!("{msg}");
            g.last_error = Some(msg);
            g.file_failed = true;
            g.pending.clear();
        }
    }
}

fn write_line(g: &mut Inner, line: &Line) {
    if let Some(f) = g.file.as_mut()
        && let Err(e) = f.write(line)
    {
        let msg = format!("raw dump: write to {} failed: {e}", f.path.display());
        log::warn!("{msg}");
        g.last_error = Some(msg);
        g.file = None;
        g.file_failed = true;
    }
}

/// A session that ended before `OPEN` still gets its file.
fn flush_pending(g: &mut Inner) {
    if g.file.is_none() && !g.pending.is_empty() && !g.file_failed {
        let w = g.pending[0].w;
        open_file(g, w);
    }
    g.pending.clear();
}

fn close_file(g: &mut Inner) {
    if let Some(f) = g.file.take() {
        match f.finish() {
            Ok(p) => log::info!("raw dump: closed {}", p.display()),
            Err(e) => {
                let msg = format!("raw dump: closing the file failed: {e}");
                log::warn!("{msg}");
                g.last_error = Some(msg);
            }
        }
    }
}
