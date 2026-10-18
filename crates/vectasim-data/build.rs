//! Precompiles the embedded OurAirports CSVs into the binary index format (`src/binfmt.rs`) so
//! startup does not parse ~5 MB of CSV. The output lives in OUT_DIR (build artefact, never in the
//! repo). If anything goes wrong an empty file is written and the crate falls back to CSV parsing
//! at runtime.

#[allow(dead_code)]
#[path = "src/source.rs"]
mod source;

#[allow(dead_code)]
#[path = "src/binfmt.rs"]
mod binfmt;

use std::path::PathBuf;

fn main() {
    for f in ["data/airports.csv", "data/runways.csv", "src/source.rs", "src/binfmt.rs", "build.rs"] {
        println!("cargo:rerun-if-changed={f}");
    }
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("airports.vsad");
    let blob = match build_blob() {
        Ok(b) => b,
        Err(e) => {
            println!("cargo:warning=airport index not precompiled ({e}); falling back to CSV parsing at runtime");
            Vec::new()
        }
    };
    std::fs::write(&out, blob).expect("write airports.vsad");
}

fn build_blob() -> Result<Vec<u8>, String> {
    let read = |p: &str| std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"));
    let airports = source::parse_airports(&read("data/airports.csv")?);
    let runways = source::parse_runways(&read("data/runways.csv")?);
    if airports.is_empty() {
        return Err("no airports parsed".into());
    }
    let parts = source::IndexParts::build(airports, runways);
    let blob = binfmt::encode(&parts);
    // self-check: the runtime view must accept the blob and read back every record unchanged
    let layout = binfmt::Layout::parse(&blob).ok_or("blob rejected by its own decoder")?;
    let airports_ok = parts.airports.iter().enumerate().all(|(i, a)| layout.airport(&blob, i) == *a);
    let runways_ok = parts.runways.iter().enumerate().all(|(j, r)| layout.runway(&blob, j) == *r);
    if !(airports_ok && runways_ok) {
        return Err("round-trip mismatch".into());
    }
    Ok(blob)
}
