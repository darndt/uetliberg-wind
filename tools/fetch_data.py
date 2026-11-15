#!/usr/bin/env python3
"""Fetch and stitch the terrain data used by the simulator (run once).

  python3 tools/fetch_data.py

Outputs (in data/):
  dem.png    Terrarium-encoded elevation mosaic  (Mapzen / AWS Terrain Tiles)
  ortho.jpg  aerial imagery mosaic               (SWISSIMAGE, (c) swisstopo)
  meta.json  georeferencing of both mosaics

Needs ImageMagick (`magick`) for stitching.
"""
import json, math, os, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

LAT0, LON0 = 47.350, 8.515      # domain centre
SIZE_M = 14000.0                # domain edge length
MARGIN_M = 300.0
DEM_Z, IMG_Z = 12, 14
DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
IMG_URL = "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TMP = os.path.join(DATA, "_tiles")


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def tile_range(z):
    half = SIZE_M / 2 + MARGIN_M
    dlat = half / 111320.0
    dlon = half / (111320.0 * math.cos(math.radians(LAT0)))
    x0, y0 = tile_xy(LAT0 + dlat, LON0 - dlon, z)   # NW corner
    x1, y1 = tile_xy(LAT0 - dlat, LON0 + dlon, z)   # SE corner
    return int(x0), int(y0), int(x1), int(y1)


def fetch(args):
    url, path = args
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    req = urllib.request.Request(url, headers={"User-Agent": "terrain-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r, open(path, "wb") as f:
        f.write(r.read())


def mosaic(name, url, z, ext, out, extra):
    x0, y0, x1, y1 = tile_range(z)
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    jobs, files = [], []
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            p = os.path.join(TMP, f"{name}_{z}_{x}_{y}.{ext}")
            jobs.append((url.format(z=z, x=x, y=y), p))
            files.append(p)
    print(f"{name}: {cols}x{rows} tiles at z{z}")
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(fetch, jobs))
    cmd = ["magick"]
    for r in range(rows):
        cmd += ["(", *files[r * cols:(r + 1) * cols], "+append", ")"]
    subprocess.run(cmd + ["-append", *extra, out], check=True)
    return {"z": z, "x0": x0, "y0": y0, "cols": cols, "rows": rows}


def main():
    os.makedirs(TMP, exist_ok=True)
    meta = {"lat0": LAT0, "lon0": LON0, "size": SIZE_M}
    meta["dem"] = mosaic("dem", DEM_URL, DEM_Z, "png", os.path.join(DATA, "dem.png"),
                         ["-depth", "8", "-define", "png:color-type=2"])
    meta["ortho"] = mosaic("img", IMG_URL, IMG_Z, "jpeg", os.path.join(DATA, "ortho.jpg"),
                           ["-quality", "88"])
    with open(os.path.join(DATA, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("done ->", DATA)


if __name__ == "__main__":
    sys.exit(main())
