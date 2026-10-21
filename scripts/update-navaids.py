#!/usr/bin/env python3
"""Refresh crates/vectasim-data/data/navaids.csv.zst (VOR/NDB/DME positions for drawing filed routes).

Usage: python -I scripts/update-navaids.py [download-dir]
Needs Python 3.14+ (stdlib `compression.zstd`); no third-party packages.

Source: OurAirports navaids.csv (public domain), downloaded into download-dir (or a fresh temp
dir). Kept columns: ident, name, type, latitude_deg, longitude_deg, frequency_khz, iso_country;
rows without an ident or a usable position are dropped, coordinates rounded to 6 decimals.
The result is sorted by ident (the runtime index binary-searches it) and zstd-compressed.
"""
import csv
import io
import pathlib
import sys
import tempfile
import urllib.request

try:
    from compression import zstd
except ImportError:  # pragma: no cover
    sys.exit("Python 3.14+ needed (compression.zstd)")

URL = "https://davidmegginson.github.io/ourairports-data/navaids.csv"
ROOT = pathlib.Path(__file__).resolve().parents[1]
DST = ROOT / "crates" / "vectasim-data" / "data" / "navaids.csv.zst"
COLUMNS = ["ident", "name", "type", "latitude_deg", "longitude_deg", "frequency_khz", "iso_country"]


def main() -> None:
    work = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.mkdtemp(prefix="navaids-"))
    work.mkdir(parents=True, exist_ok=True)
    src = work / "navaids.csv"
    if not src.exists():
        print("downloading navaids.csv")
        urllib.request.urlretrieve(URL, src)
    rows = []
    with src.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            ident = (r.get("ident") or "").strip().upper()
            if not ident or len(ident) > 8:
                continue
            try:
                lat = float(r["latitude_deg"])
                lon = float(r["longitude_deg"])
            except (KeyError, ValueError):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            rows.append([ident, (r.get("name") or "").strip(), (r.get("type") or "").strip(),
                         f"{lat:.6f}", f"{lon:.6f}", (r.get("frequency_khz") or "").strip(),
                         (r.get("iso_country") or "").strip()])
    rows.sort(key=lambda r: (r[0], r[6], r[2]))
    out = io.StringIO(newline="")
    w = csv.writer(out, lineterminator="\n")
    w.writerow(COLUMNS)
    w.writerows(rows)
    raw = out.getvalue().encode("utf-8")
    packed = zstd.compress(raw, level=19)
    DST.write_bytes(packed)
    print(f"navaids {len(rows)}, csv {len(raw) // 1024} KiB -> zstd {len(packed) // 1024} KiB -> {DST}")


if __name__ == "__main__":
    main()
