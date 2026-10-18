#!/usr/bin/env python3
"""Refresh crates/vectasim-data/data/{countries.csv,countries.geojson.zst} (the "Länder" view).

Usage: python -I scripts/update-countries.py [download-dir]
Needs Python 3.14+ (stdlib `compression.zstd`); no third-party packages.

Sources (downloaded into download-dir, or a fresh temp dir):
  * Natural Earth 1:110m Admin-0 Countries (public domain), GeoJSON from the
    nvkelso/natural-earth-vector repository
  * OurAirports countries.csv (public domain): continent per ISO code, the codes the
    airport index uses (`iso_country`)
  * Unicode CLDR territory names, German and English (Unicode License v3)

countries.csv: the 249 ISO 3166-1 alpha-2 codes plus Kosovo (XK, used by OurAirports and
Natural Earth) with continent and German/English name.
countries.geojson.zst: the 110m outlines, every property dropped except `iso2`, coordinates
rounded to 0.01° (~1 km, finer than the 1:110m source), zstd-compressed. Special cases:
ISO_A2 "-99" or "CN-TW" falls back to ISO_A2_EH (France, Norway, Kosovo, Taiwan); Northern Cyprus and
Somaliland join CY/SO (the airport index files their airports there); French Guiana is split
off France (GF) and Svalbard off Norway (SJ), because the airport index has its own codes for them.
"""
import csv
import json
import pathlib
import sys
import tempfile
import urllib.request

try:
    from compression import zstd
except ImportError:  # pragma: no cover
    sys.exit("Python 3.14+ needed (compression.zstd)")

NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
OA_URL = "https://davidmegginson.github.io/ourairports-data/countries.csv"
CLDR_URL = "https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-localenames-full/main/{lang}/territories.json"

ROOT = pathlib.Path(__file__).resolve().parents[1]
DST = ROOT / "crates" / "vectasim-data" / "data"

# CLDR two-letter territories that are not ISO 3166-1 countries (exceptional reservations,
# EU/UN groupings, private-use codes); XK (Kosovo) is added back on purpose.
NOT_COUNTRIES = {"AC", "CP", "CQ", "DG", "EA", "EU", "EZ", "IC", "QO", "TA", "UN", "XA", "XB", "XK", "ZZ"}
EXTRA = {"XK"}
# codes OurAirports does not list (no airports there): continent by hand
CONTINENT_FALLBACK = {"AX": "EU", "BV": "AN", "SJ": "EU"}
# Natural Earth units without an ISO code, joined to the country the airport index uses
ADM0_TO_ISO = {"CYN": "CY", "SOL": "SO", "KOS": "XK"}
CONTINENTS = {"AF", "AN", "AS", "EU", "NA", "OC", "SA"}


def download(dst: pathlib.Path) -> None:
    for url, name in [(NE_URL, "ne_110m_admin_0_countries.geojson"), (OA_URL, "countries.csv"),
                      (CLDR_URL.format(lang="de"), "cldr-de.json"), (CLDR_URL.format(lang="en"), "cldr-en.json")]:
        if not (dst / name).exists():
            print("downloading", name)
            urllib.request.urlretrieve(url, dst / name)


def cldr_names(path: pathlib.Path, lang: str) -> dict[str, str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["main"][lang]["localeDisplayNames"]["territories"]


def iso_of(props: dict) -> str | None:
    code = props.get("ISO_A2") or "-99"
    if code == "-99" or len(code) != 2:  # "-99" (France, Norway, Kosovo), "CN-TW" (Taiwan)
        code = props.get("ISO_A2_EH") or "-99"
    if code == "-99" or len(code) != 2:
        code = ADM0_TO_ISO.get(props.get("ADM0_A3", ""), "-99")
    return None if code == "-99" else code


def rnd(ring: list) -> list:
    out: list = []
    for x, y in ring:
        p = [round(x, 2), round(y, 2)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def polygons(geom: dict) -> list:
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def split_off(polys: list, test) -> tuple[list, list]:
    """(polygons whose first ring passes `test`, the rest)."""
    yes, no = [], []
    for p in polys:
        xs = [c[0] for c in p[0]]
        ys = [c[1] for c in p[0]]
        (yes if test(sum(xs) / len(xs), sum(ys) / len(ys)) else no).append(p)
    return yes, no


def main() -> None:
    src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.mkdtemp(prefix="countries-"))
    src.mkdir(parents=True, exist_ok=True)
    download(src)

    de = cldr_names(src / "cldr-de.json", "de")
    en = cldr_names(src / "cldr-en.json", "en")
    with open(src / "countries.csv", encoding="utf-8", newline="") as f:
        oa = {r["code"]: r["continent"] for r in csv.DictReader(f)}
    codes = sorted({k for k in de if len(k) == 2 and k.isalpha() and k.isupper()} - NOT_COUNTRIES | EXTRA)
    assert len(codes) == 250, f"expected 249 ISO codes + XK, got {len(codes)}"

    with open(DST / "countries.csv", "w", encoding="utf-8", newline="") as out:
        w = csv.writer(out, lineterminator="\n")
        w.writerow(["iso2", "continent", "name_de", "name_en"])
        for c in codes:
            cont = oa.get(c) or CONTINENT_FALLBACK.get(c)
            assert cont in CONTINENTS, f"no continent for {c}"
            w.writerow([c, cont, de[c], en[c]])

    ne = json.loads((src / "ne_110m_admin_0_countries.geojson").read_text(encoding="utf-8"))
    parts: dict[str, list] = {}
    for f in ne["features"]:
        iso = iso_of(f["properties"])
        if not iso:
            print("skipped (no ISO code):", f["properties"].get("ADMIN"))
            continue
        polys = polygons(f["geometry"])
        if iso == "FR":
            gf, polys = split_off(polys, lambda x, _y: x < -30)
            parts.setdefault("GF", []).extend(gf)
        if iso == "NO":
            sj, polys = split_off(polys, lambda _x, y: y > 74)
            parts.setdefault("SJ", []).extend(sj)
        parts.setdefault(iso, []).extend(polys)

    features = []
    unknown = sorted(set(parts) - set(codes))
    assert not unknown, f"outline codes missing from the country list: {unknown}"
    for iso in sorted(parts):
        polys = [[rnd(ring) for ring in p] for p in parts[iso]]
        polys = [p for p in polys if len(p[0]) >= 4]
        geom = {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}
        features.append({"type": "Feature", "properties": {"iso2": iso}, "geometry": geom})
    raw = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")).encode()
    packed = zstd.compress(raw, level=19)
    (DST / "countries.geojson.zst").write_bytes(packed)
    print(f"countries {len(codes)}, outlines {len(features)}, geojson {len(raw) // 1024} KiB -> zstd {len(packed) // 1024} KiB -> {DST}")


if __name__ == "__main__":
    main()
