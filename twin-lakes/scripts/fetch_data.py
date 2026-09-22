#!/usr/bin/env python3
"""Download every raw input the world is built from, into twin-lakes/.cache/.

Sources (all public):
  - Elevation: AWS Terrain Tiles (Mapzen "terrarium" encoding), derived in the US from USGS 3DEP.
  - Imagery:   USGS National Map "USGSImageryOnly" (NAIP / orthoimagery), public domain.
  - Vectors:   OpenStreetMap API (lake relations, rivers, runway, dams, towns), ODbL.

Downloads are cached; re-running only fetches what is missing. process_data.py turns the cache into data/.
"""
import concurrent.futures as cf
import json
import math
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from world import GRIDS, OSM_BOX, LAKE_RELATIONS, to_latlon  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache')
UA = 'twin-lakes-flightsim/0.1 (side project build script)'

DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
IMG_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'
OSM_MAP = 'https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}'
OSM_REL = 'https://api.openstreetmap.org/api/0.6/relation/{id}/full'


def get(url, path, tries=5):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            tmp = path + '.part'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, path)
            return path
        except Exception as e:  # noqa: BLE001
            if getattr(e, 'code', None) == 400:
                raise
            time.sleep(2 ** i)
            last = e
    raise RuntimeError(f'failed {url}: {last}')


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    r = math.radians(lat)
    y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n
    return x, y


def tile_range(grid, z):
    """Inclusive web-mercator tile range covering a local-metre grid, with a one-tile margin."""
    x0, z0, w, h = grid['x0'], grid['z0'], grid['w'], grid['h']
    lat_n, lon_w = to_latlon(x0, z0)
    lat_s, lon_e = to_latlon(x0 + w, z0 + h)
    ax, ay = tile_xy(lat_n, lon_w, z)
    bx, by = tile_xy(lat_s, lon_e, z)
    return int(ax) - 1, int(ay) - 1, int(bx) + 1, int(by) + 1


def fetch_tiles(kind, url_tpl, z, rng):
    tx0, ty0, tx1, ty1 = rng
    jobs = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            ext = 'png' if kind == 'dem' else 'jpg'
            path = os.path.join(CACHE, kind, str(z), f'{tx}_{ty}.{ext}')
            jobs.append((url_tpl.format(z=z, x=tx, y=ty), path))
    todo = [j for j in jobs if not os.path.exists(j[1])]
    print(f'  {kind} z{z}: {len(jobs)} tiles, {len(todo)} to download')
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda j: get(*j), todo))


def fetch_osm():
    for name, rid in LAKE_RELATIONS.items():
        get(OSM_REL.format(id=rid), os.path.join(CACHE, 'osm', f'rel_{name}.xml'))
        print(f'  relation {name} ok')
    w, s, e, n = OSM_BOX
    step = 0.1
    cells = []
    lat = s
    while lat < n - 1e-9:
        lon = w
        while lon < e - 1e-9:
            cells.append((round(lon, 4), round(lat, 4), round(min(lon + step, e), 4), round(min(lat + step, n), 4)))
            lon += step
        lat += step
    print(f'  osm map cells: {len(cells)}')
    done = 0
    while cells:
        c = cells.pop()
        path = os.path.join(CACHE, 'osm', 'map_{}_{}_{}_{}.xml'.format(*c))
        if os.path.exists(path):
            done += 1
            continue
        try:
            get(OSM_MAP.format(w=c[0], s=c[1], e=c[2], n=c[3]), path, tries=3)
            done += 1
            time.sleep(0.5)
        except Exception:  # too many nodes: split into quarters
            mx, my = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
            for q in [(c[0], c[1], mx, my), (mx, c[1], c[2], my), (c[0], my, mx, c[3]), (mx, my, c[2], c[3])]:
                cells.append(tuple(round(v, 5) for v in q))
            print(f'  split {c}')
    print(f'  osm map cells done: {done}')


def main():
    t = time.time()
    for g in GRIDS.values():
        fetch_tiles('dem', DEM_URL, g['dem_zoom'], tile_range(g, g['dem_zoom']))
        fetch_tiles('img', IMG_URL, g['img_zoom'], tile_range(g, g['img_zoom']))
    fetch_osm()
    print(f'done in {time.time() - t:.0f} s')


if __name__ == '__main__':
    main()
