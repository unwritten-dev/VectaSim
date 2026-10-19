//! Turn (part of) the mock flight into a `.vsdump`, e.g. to refresh the replay fixture:
//!
//! ```text
//! cargo run -p vectasim-simconnect --example mock-to-vsdump -- crates/vectasim-core/tests/fixtures/mock-circuit.vsdump
//! cargo run -p vectasim-simconnect --example mock-to-vsdump -- out.vsdump --variant bounce --from 0 --to 600 --hz 60
//! ```
//!
//! Without options it writes the fixture span (60 s final + landing + 20 s rollout, 60 Hz).

use std::path::PathBuf;
use vectasim_core::MockVariant;
use vectasim_simconnect::mockdump::{MockDumpSpec, mock_lines, write_dump};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out) = args.next().map(PathBuf::from) else {
        eprintln!("usage: mock-to-vsdump <out.vsdump> [--variant standard|circuit|bounce|goaround|teleport|reconnect] [--from s] [--to s] [--hz n]");
        std::process::exit(2);
    };
    let mut spec = MockDumpSpec::final_and_landing();
    while let Some(flag) = args.next() {
        let value = args.next().unwrap_or_default();
        let num = || value.parse::<f64>().unwrap_or_else(|_| panic!("{flag}: not a number: {value}"));
        match flag.as_str() {
            "--variant" => spec.variant = MockVariant::parse(&value),
            "--from" => spec.from_s = num(),
            "--to" => spec.to_s = num(),
            "--hz" => spec.hz = num(),
            other => panic!("unknown option {other}"),
        }
    }
    let (header, lines) = mock_lines(&spec);
    let raw = write_dump(&out, &header, &lines, 19).expect("write dump");
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    println!("{}: {} lines, {} KB raw, {} KB compressed", out.display(), lines.len(), raw / 1024, size / 1024);
}
