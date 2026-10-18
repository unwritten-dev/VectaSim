//! Streaming reader. A file that was cut off (app killed while recording) yields every
//! complete line before the cut and then ends with an error item.

use crate::delta::DeltaDecoder;
use crate::{Header, Line};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

pub struct DumpReader {
    pub header: Header,
    lines: Box<dyn BufRead + Send>,
    line_no: usize,
    buf: String,
    done: bool,
    delta: DeltaDecoder,
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

impl DumpReader {
    pub fn open(path: &Path) -> io::Result<Self> {
        let f = File::open(path).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
        Self::from_reader(f)
    }

    /// zstd-compressed (any number of frames) or plain NDJSON.
    pub fn from_reader<R: Read + Send + 'static>(r: R) -> io::Result<Self> {
        let mut r = BufReader::new(r);
        let compressed = r.fill_buf()?.starts_with(&ZSTD_MAGIC);
        let mut lines: Box<dyn BufRead + Send> =
            if compressed { Box::new(BufReader::new(zstd::Decoder::with_buffer(r)?)) } else { Box::new(r) };
        let mut first = String::new();
        if lines.read_line(&mut first)? == 0 {
            return Err(invalid("empty dump".into()));
        }
        let header: Header = serde_json::from_str(first.trim_end()).map_err(|e| invalid(format!("header: {e}")))?;
        if header.kind != "header" {
            return Err(invalid("first line is not a header".into()));
        }
        if header.format > crate::FORMAT {
            return Err(invalid(format!("dump format {} is newer than this build ({})", header.format, crate::FORMAT)));
        }
        Ok(Self { header, lines, line_no: 1, buf: String::new(), done: false, delta: DeltaDecoder::default() })
    }

    /// 1-based number of the last line read (the header is line 1).
    pub fn line_no(&self) -> usize {
        self.line_no
    }
}

impl Iterator for DumpReader {
    type Item = io::Result<Line>;

    fn next(&mut self) -> Option<Self::Item> {
        while !self.done {
            self.buf.clear();
            match self.lines.read_line(&mut self.buf) {
                Ok(0) => self.done = true,
                Ok(_) => {
                    self.line_no += 1;
                    let s = self.buf.trim_end();
                    if s.is_empty() {
                        continue;
                    }
                    if !self.buf.ends_with('\n') {
                        // last line without newline: a cut-off write unless it parses
                        self.done = true;
                    }
                    let n = self.line_no;
                    let parsed = serde_json::from_str::<Line>(s).map_err(|e| invalid(format!("line {n}: {e}")));
                    return Some(parsed.and_then(|l| self.delta.decode(l).map_err(|e| invalid(format!("line {n}: {e}")))));
                }
                Err(e) => {
                    self.done = true;
                    return Some(Err(io::Error::new(e.kind(), format!("after line {}: {e}", self.line_no))));
                }
            }
        }
        None
    }
}

/// Header and all lines; stops at the first unreadable line and returns it as the error part.
pub fn read_all(path: &Path) -> io::Result<(Header, Vec<Line>, Option<io::Error>)> {
    let mut r = DumpReader::open(path)?;
    let header = r.header.clone();
    let mut out = Vec::new();
    for l in r.by_ref() {
        match l {
            Ok(l) => out.push(l),
            Err(e) => return Ok((header, out, Some(e))),
        }
    }
    Ok((header, out, None))
}
