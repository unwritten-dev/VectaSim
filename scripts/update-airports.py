#!/usr/bin/env python3
"""Refresh crates/vectasim-data/data/{airports,runways}.csv from OurAirports (public domain).

Usage: python scripts/update-airports.py [download-dir]
Downloads the nightly CSVs, keeps large/medium/small airports and seaplane bases, drops closed
runways and unused columns, and rewrites the two embedded files.
"""
import csv
import pathlib
import sys
import tempfile
import urllib.request

BASE = "https://davidmegginson.github.io/ourairports-data/"
KEEP = {"large_airport", "medium_airport", "small_airport", "seaplane_base"}
ROOT = pathlib.Path(__file__).resolve().parents[1]
DST = ROOT / "crates" / "vectasim-data" / "data"


def download(dst: pathlib.Path) -> None:
    for name in ("airports.csv", "runways.csv"):
        print("downloading", name)
        urllib.request.urlretrieve(BASE + name, dst / name)


def preferred_ident(row: dict) -> str:
    return (row["icao_code"] or row["gps_code"] or row["ident"]).strip()


def num(v: str, nd: int = 5):
    try:
        return round(float(v), nd)
    except ValueError:
        return ""


def main() -> None:
    src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.mkdtemp(prefix="ourairports-"))
    src.mkdir(parents=True, exist_ok=True)
    if not (src / "airports.csv").exists():
        download(src)

    idents: set[str] = set()
    remap: dict[str, str] = {}
    with open(src / "airports.csv", encoding="utf-8", newline="") as f, open(DST / "airports.csv", "w", encoding="utf-8", newline="") as out:
        w = csv.writer(out, lineterminator="\n")
        w.writerow(["ident", "type", "name", "lat", "lon", "elev_ft", "country", "municipality", "iata"])
        for row in csv.DictReader(f):
            if row["type"] not in KEEP:
                continue
            ident = preferred_ident(row)
            remap[row["ident"]] = ident
            if not ident or ident in idents:
                continue
            idents.add(ident)
            w.writerow([ident, row["type"].replace("_airport", ""), row["name"], num(row["latitude_deg"]), num(row["longitude_deg"]),
                        row["elevation_ft"], row["iso_country"], row["municipality"], row["iata_code"]])

    n = 0
    with open(src / "runways.csv", encoding="utf-8", newline="") as f, open(DST / "runways.csv", "w", encoding="utf-8", newline="") as out:
        w = csv.writer(out, lineterminator="\n")
        w.writerow(["airport", "length_ft", "width_ft", "surface", "le_ident", "le_lat", "le_lon", "le_hdg", "he_ident", "he_lat", "he_lon", "he_hdg"])
        for row in csv.DictReader(f):
            ident = remap.get(row["airport_ident"])
            if not ident or ident not in idents or row["closed"] == "1":
                continue
            w.writerow([ident, row["length_ft"], row["width_ft"], row["surface"][:12], row["le_ident"], num(row["le_latitude_deg"]),
                        num(row["le_longitude_deg"]), num(row["le_heading_degT"], 1), row["he_ident"], num(row["he_latitude_deg"]),
                        num(row["he_longitude_deg"]), num(row["he_heading_degT"], 1)])
            n += 1
    print(f"airports {len(idents)}, runways {n} -> {DST}")


if __name__ == "__main__":
    main()
