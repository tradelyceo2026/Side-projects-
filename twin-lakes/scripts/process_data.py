#!/usr/bin/env python3
"""Turn the raw cache into the compact world files in data/.

For each grid (far, near, inset):
  <grid>.jpg      aerial imagery, one texel per i_res metres
  <grid>_h.bin    terrain height, uint16 (1/32 m), row-delta coded, zlib
  <grid>_w.bin    water surface height, same encoding
  <grid>_lc.bin   land cover, 2 x uint8 per texel at the height grid x2: R = water signed distance, G = forest density
plus world.json (grids, runways, lakes, towns, dams, rivers) and buildings.bin.

Requires: numpy, scipy, pillow.
"""
import glob
import json
import math
import os
import sys
import xml.etree.ElementTree as ET
import zlib

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, os.path.dirname(__file__))
from fetch_data import CACHE, tile_range  # noqa: E402
from world import GRIDS, LAT0, LON0, KX, KZ, to_local, to_latlon  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data')
H_UNIT = 32.0          # height quantisation: 1/32 m
SDF_SCALE = {'far': 16.0, 'near': 2.0, 'inset': 0.5}   # metres per SDF unit (128 = shoreline)
LC_RES = {'far': 64, 'near': 16, 'inset': 4}         # land-cover texel size, metres
RIVER_WIDTH = {'White River': 105.0, 'North Fork River': 55.0, 'Norfork River': 55.0}

Image.MAX_IMAGE_PIXELS = None


# ---------------------------------------------------------------- mosaics
def mosaic(kind, z, rng):
    tx0, ty0, tx1, ty1 = rng
    ext = 'png' if kind == 'dem' else 'jpg'
    W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    arr = np.zeros((H, W, 3), np.uint8)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = os.path.join(CACHE, kind, str(z), f'{tx}_{ty}.{ext}')
            im = Image.open(p).convert('RGB')
            if im.size != (256, 256):
                im = im.resize((256, 256))
            arr[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = np.asarray(im)
    return arr


def mercator_px(lat, lon, z, tx0, ty0):
    n = 256 * 2 ** z
    px = (lon + 180) / 360 * n - tx0 * 256
    r = np.radians(lat)
    py = (1 - np.log(np.tan(r) + 1 / np.cos(r)) / np.pi) / 2 * n - ty0 * 256
    return px, py


def grid_latlon(g, res):
    nx, nz = int(g['w'] / res), int(g['h'] / res)
    xs = g['x0'] + (np.arange(nx) + 0.5) * res
    zs = g['z0'] + (np.arange(nz) + 0.5) * res
    X, Z = np.meshgrid(xs, zs)
    lat, lon = to_latlon(X, Z)
    return lat, lon, X, Z


def resample(src, lat, lon, z, rng, order=1):
    px, py = mercator_px(lat, lon, z, rng[0], rng[1])
    coords = np.array([py - 0.5, px - 0.5])
    if src.ndim == 2:
        return ndimage.map_coordinates(src, coords, order=order, mode='nearest')
    return np.stack([ndimage.map_coordinates(src[..., c].astype(np.float32), coords, order=order, mode='nearest')
                     for c in range(src.shape[2])], -1)


# ---------------------------------------------------------------- OSM
def load_osm():
    nodes, ways, rels = {}, {}, {}
    files = sorted(glob.glob(os.path.join(CACHE, 'osm', '*.xml')))
    for f in files:
        for _, el in ET.iterparse(f):
            t = el.tag
            if t == 'node':
                nid = int(el.get('id'))
                nodes[nid] = (float(el.get('lat')), float(el.get('lon')))
                tags = {c.get('k'): c.get('v') for c in el if c.tag == 'tag'}
                if tags:
                    nodes[nid] = nodes[nid] + (tags,)
                el.clear()
            elif t == 'way':
                ways[int(el.get('id'))] = ([int(c.get('ref')) for c in el if c.tag == 'nd'],
                                           {c.get('k'): c.get('v') for c in el if c.tag == 'tag'})
                el.clear()
            elif t == 'relation':
                rels[int(el.get('id'))] = ([(c.get('type'), int(c.get('ref')), c.get('role')) for c in el if c.tag == 'member'],
                                           {c.get('k'): c.get('v') for c in el if c.tag == 'tag'})
                el.clear()
    print(f'  osm: {len(nodes)} nodes, {len(ways)} ways, {len(rels)} relations from {len(files)} files')
    return nodes, ways, rels


def way_coords(nodes, ids):
    out = []
    for i in ids:
        n = nodes.get(i)
        if n is None:
            return None
        out.append(to_local(n[0], n[1]))
    return out


def assemble_rings(parts):
    """Join open node-id chains into closed rings."""
    parts = [list(p) for p in parts if len(p) > 1]
    rings = []
    while parts:
        cur = parts.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, p in enumerate(parts):
                if p[0] == cur[-1]:
                    cur += p[1:]
                elif p[-1] == cur[-1]:
                    cur += p[::-1][1:]
                elif p[-1] == cur[0]:
                    cur = p + cur[1:]
                elif p[0] == cur[0]:
                    cur = p[::-1] + cur[1:]
                else:
                    continue
                parts.pop(i)
                changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def is_water(tags):
    return (tags.get('natural') == 'water' or tags.get('landuse') == 'reservoir'
            or tags.get('waterway') == 'riverbank' or tags.get('landuse') == 'basin')


def extract(nodes, ways, rels):
    feats = dict(lakes=[], ponds=[], rivers=[], runways=[], buildings=[], dams=[], places=[], aerodromes=[])
    used_ways = set()
    for rid, (members, tags) in rels.items():
        if tags.get('type') != 'multipolygon':
            continue
        if not is_water(tags) and tags.get('building') is None:
            continue
        outer = [ways[r][0] for (t, r, role) in members if t == 'way' and r in ways and role in ('outer', '')]
        inner = [ways[r][0] for (t, r, role) in members if t == 'way' and r in ways and role == 'inner']
        orings = [way_coords(nodes, r) for r in assemble_rings(outer)]
        irings = [way_coords(nodes, r) for r in assemble_rings(inner)]
        poly = dict(name=tags.get('name', ''), outer=[r for r in orings if r], inner=[r for r in irings if r])
        if not poly['outer']:
            continue
        for (t, r, role) in members:
            if t == 'way':
                used_ways.add(r)
        if is_water(tags):
            big = tags.get('name') in ('Norfork Lake', 'Bull Shoals Lake')
            (feats['lakes'] if big else feats['ponds']).append(poly)
    for wid, (ids, tags) in ways.items():
        closed = len(ids) > 3 and ids[0] == ids[-1]
        if is_water(tags) and closed and wid not in used_ways:
            c = way_coords(nodes, ids)
            if c:
                feats['ponds'].append(dict(name=tags.get('name', ''), outer=[c], inner=[]))
        elif tags.get('waterway') == 'river':
            c = way_coords(nodes, ids)
            if c:
                feats['rivers'].append(dict(name=tags.get('name', ''), pts=c))
        elif tags.get('aeroway') == 'runway':
            c = way_coords(nodes, ids)
            if c:
                feats['runways'].append(dict(ref=tags.get('ref', ''), width=tags.get('width'), surface=tags.get('surface', ''),
                                             closed=closed, pts=c))
        elif tags.get('building') and closed:
            c = way_coords(nodes, ids)
            if c:
                h = None
                try:
                    h = float(tags['height'].split()[0])
                except (KeyError, ValueError):
                    try:
                        h = float(tags['building:levels']) * 3.2 + 1.5
                    except (KeyError, ValueError):
                        pass
                feats['buildings'].append(dict(kind=tags['building'], h=h, pts=c))
        elif tags.get('waterway') == 'dam' or tags.get('man_made') == 'dam':
            c = way_coords(nodes, ids)
            if c and tags.get('name'):
                feats['dams'].append(dict(name=tags['name'], pts=c))
        elif tags.get('aeroway') == 'aerodrome':
            c = way_coords(nodes, ids)
            if c:
                cx = sum(p[0] for p in c) / len(c)
                cz = sum(p[1] for p in c) / len(c)
                feats['aerodromes'].append(dict(name=tags.get('name', ''), icao=tags.get('icao', tags.get('faa', '')),
                                                x=cx, z=cz))
    for nid, n in nodes.items():
        if len(n) == 3:
            tags = n[2]
            if tags.get('place') in ('city', 'town', 'village', 'hamlet') and tags.get('name'):
                x, z = to_local(n[0], n[1])
                feats['places'].append(dict(name=tags['name'], kind=tags['place'], x=round(x), z=round(z),
                                            pop=int(tags.get('population', '0').replace(',', '') or 0)))
            elif tags.get('aeroway') == 'aerodrome':
                x, z = to_local(n[0], n[1])
                feats['aerodromes'].append(dict(name=tags.get('name', ''), icao=tags.get('icao', tags.get('faa', '')), x=x, z=z))
    for k, v in feats.items():
        print(f'  {k}: {len(v)}')
    return feats


# ---------------------------------------------------------------- rasterising
def to_px(pts, g, res, ss=1):
    return [((x - g['x0']) / res * ss, (z - g['z0']) / res * ss) for x, z in pts]


def raster_water(feats, g, res, ss=2):
    """Return (lake mask, river mask, pond mask) at res/ss, as bool arrays at res x ss."""
    nx, nz = int(g['w'] / res) * ss, int(g['h'] / res) * ss
    out = {}
    for key in ('lakes', 'ponds'):
        im = Image.new('L', (nx, nz), 0)
        dr = ImageDraw.Draw(im)
        for p in feats[key]:
            for r in p['outer']:
                dr.polygon(to_px(r, g, res, ss), fill=255)
            for r in p['inner']:
                dr.polygon(to_px(r, g, res, ss), fill=0)
        out[key] = np.asarray(im) > 127
    im = Image.new('L', (nx, nz), 0)
    dr = ImageDraw.Draw(im)
    for rv in feats['rivers']:
        wm = RIVER_WIDTH.get(rv['name'])
        if not wm:
            continue
        wpx = max(1, wm / res * ss)
        pts = to_px(rv['pts'], g, res, ss)
        dr.line(pts, fill=255, width=int(round(wpx)))
        rr = wpx / 2
        for x, y in pts:
            dr.ellipse((x - rr, y - rr, x + rr, y + rr), fill=255)
    out['rivers'] = (np.asarray(im) > 127) & ~out['lakes']
    return out


def signed_distance(mask, px_m):
    """Metres; negative inside the mask."""
    inside = ndimage.distance_transform_edt(mask)
    outside = ndimage.distance_transform_edt(~mask)
    return (outside - inside) * px_m


def down(a, f):
    h, w = a.shape[0] // f, a.shape[1] // f
    return a[:h * f, :w * f].reshape(h, f, w, f).mean(axis=(1, 3))


# ---------------------------------------------------------------- imagery tone
TARGET_RGB = np.array([88.0, 104.0, 76.0])   # mean land colour the whole world is normalised to


def flatten_colour(rgb, g, ires, sdf, lres, sigma_m=700.0):
    """Remove low-frequency tone differences between source orthophotos (different years and seasons).

    Divides each channel by its land-only local mean (normalised Gaussian convolution, water excluded) and
    multiplies by one target colour, so seams between acquisitions fade while fields, forest and towns keep
    their contrast."""
    f = rgb.astype(np.float32)
    # land mask at imagery resolution
    k = lres // ires
    land = (sdf > 0)
    if k > 1:
        land = np.repeat(np.repeat(land, k, 0), k, 1)
    land = land[:f.shape[0], :f.shape[1]].astype(np.float32)
    # work on a 4x reduced copy for speed
    r = 4
    small = np.stack([down(f[..., c], r) for c in range(3)], -1)
    lm = down(land, r)
    sig = sigma_m / (ires * r)
    den = ndimage.gaussian_filter(lm, sig) + 1e-4
    means = np.stack([ndimage.gaussian_filter(small[..., c] * lm, sig) / den for c in range(3)], -1)
    means = np.maximum(means, 8)
    gain = TARGET_RGB / means
    # soften: keep 25% of the original regional variation so it does not look synthetic
    gain = gain ** 0.8
    gain = np.stack([ndimage.zoom(gain[..., c], r, order=1)[:f.shape[0], :f.shape[1]] for c in range(3)], -1)
    if gain.shape[:2] != f.shape[:2]:
        pad = ((0, f.shape[0] - gain.shape[0]), (0, f.shape[1] - gain.shape[1]), (0, 0))
        gain = np.pad(gain, pad, mode='edge')
    return np.clip(f * gain, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- encoding
def pack_u16(arr):
    q = np.clip(np.round(arr * H_UNIT), 0, 65535).astype(np.int32)
    d = np.diff(q, axis=1, prepend=0)                      # row delta
    d = (d & 0xFFFF).astype('<u2')
    return zlib.compress(d.tobytes(), 9)


def pack_u8(arr):
    return zlib.compress(np.ascontiguousarray(arr, np.uint8).tobytes(), 9)


def write(name, data):
    p = os.path.join(OUT, name)
    with open(p, 'wb') as f:
        f.write(data)
    print(f'    {name}: {len(data) / 1024:.0f} KB')


# ---------------------------------------------------------------- runways
def runway_geometry(rw):
    pts = np.array(rw['pts'])
    if rw['closed']:
        # polygon: principal axis
        c = pts[:-1].mean(0)
        u, s, vt = np.linalg.svd(pts[:-1] - c)
        ax = vt[0]
        t = (pts[:-1] - c) @ ax
        n = (pts[:-1] - c) @ vt[1]
        a, b = c + ax * t.min(), c + ax * t.max()
        width = float(n.max() - n.min())
    else:
        a, b = pts[0], pts[-1]
        try:
            width = float(str(rw['width']).split()[0])
        except (TypeError, ValueError):
            width = 23.0
    return a, b, width


def flatten_runways(H, g, res, rwys):
    nz, nx = H.shape
    xs = g['x0'] + (np.arange(nx) + 0.5) * res
    zs = g['z0'] + (np.arange(nz) + 0.5) * res
    X, Z = np.meshgrid(xs, zs)
    for r in rwys:
        a, b, w = np.array(r['a']), np.array(r['b']), r['width']
        L = np.linalg.norm(b - a)
        u = (b - a) / L
        t = (X - a[0]) * u[0] + (Z - a[1]) * u[1]
        n = -(X - a[0]) * u[1] + (Z - a[1]) * u[0]
        prof = r['elev_a'] + (r['elev_b'] - r['elev_a']) * np.clip(t / L, 0, 1)
        # distance outside the rectangle (runway + 60 m ends, + 40 m sides) for blending
        dt = np.maximum(np.maximum(-t - 60, t - L - 60), 0)
        dn = np.maximum(np.abs(n) - (w / 2 + 40), 0)
        d = np.hypot(dt, dn)
        wgt = np.clip(1 - d / 120.0, 0, 1)
        wgt = wgt * wgt * (3 - 2 * wgt)
        H[:] = H * (1 - wgt) + prof * wgt


# ---------------------------------------------------------------- main
def main():
    os.makedirs(OUT, exist_ok=True)
    nodes, ways, rels = load_osm()
    feats = extract(nodes, ways, rels)
    del nodes, ways, rels

    # ---- runways: geometry + elevation from the near DEM
    g = GRIDS['near']
    dem_rng = tile_range(g, g['dem_zoom'])
    dem_rgb = mosaic('dem', g['dem_zoom'], dem_rng).astype(np.float32)
    dem_near = dem_rgb[..., 0] * 256 + dem_rgb[..., 1] + dem_rgb[..., 2] / 256 - 32768
    gi = GRIDS['inset']
    dem_rng_i = tile_range(gi, gi['dem_zoom'])
    dem_rgb_i = mosaic('dem', gi['dem_zoom'], dem_rng_i).astype(np.float32)
    dem_inset = dem_rgb_i[..., 0] * 256 + dem_rgb_i[..., 1] + dem_rgb_i[..., 2] / 256 - 32768

    def dem_at(x, z):
        lat, lon = to_latlon(np.array([x]), np.array([z]))
        return float(resample(dem_inset, lat, lon, gi['dem_zoom'], dem_rng_i)[0]) if (
            gi['x0'] < x < gi['x0'] + gi['w'] and gi['z0'] < z < gi['z0'] + gi['h']) else \
            float(resample(dem_near, lat, lon, g['dem_zoom'], dem_rng)[0])

    aerodromes = feats['aerodromes']
    runways = []
    for rw in feats['runways']:
        a, b, w = runway_geometry(rw)
        if not (g['x0'] < a[0] < g['x0'] + g['w'] and g['z0'] < a[1] < g['z0'] + g['h']):
            continue
        L = float(np.linalg.norm(b - a))
        if L < 300:
            continue
        # elevation: mean of the DEM over 5 samples near each end, with the line fit through all samples
        ts = np.linspace(0, 1, 21)
        el = np.array([dem_at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) for t in ts])
        k, c0 = np.polyfit(ts, el, 1)
        hdg = (math.degrees(math.atan2(b[0] - a[0], -(b[1] - a[1]))) + 360) % 360
        mid = (a + b) / 2
        near_ad = min(aerodromes, key=lambda d: (d['x'] - mid[0]) ** 2 + (d['z'] - mid[1]) ** 2) if aerodromes else None
        runways.append(dict(ref=rw['ref'], surface=rw['surface'], width=round(w, 1), length=round(L, 1),
                            a=[round(float(a[0]), 2), round(float(a[1]), 2)], b=[round(float(b[0]), 2), round(float(b[1]), 2)],
                            elev_a=round(float(c0), 2), elev_b=round(float(c0 + k), 2), heading_true=round(hdg, 2),
                            airport=near_ad['name'] if near_ad else '', icao=near_ad['icao'] if near_ad else ''))
    for r in runways:
        print(f"  runway {r['ref']:>6} {r['airport']:<40} {r['length']:.0f} x {r['width']:.0f} m  "
              f"hdg {r['heading_true']:.1f}  elev {r['elev_a']:.1f}/{r['elev_b']:.1f}")

    lake_levels = {}
    meta_grids = {}
    only = os.environ.get('ONLY', '').split(',') if os.environ.get('ONLY') else None
    for name in ('near', 'far', 'inset'):
        if only and name not in only:
            continue
        g = GRIDS[name]
        print(f'grid {name}')
        hres, ires, lres = g['h_res'], g['i_res'], LC_RES[name]
        # ---- heights
        rng = tile_range(g, g['dem_zoom'])
        rgb = mosaic('dem', g['dem_zoom'], rng).astype(np.float32)
        dem = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
        lat, lon, X, Z = grid_latlon(g, hres)
        H = resample(dem, lat, lon, g['dem_zoom'], rng).astype(np.float64)
        # despike: a few source tiles carry bogus samples (hundreds of metres off); Ozark relief is gentler
        med = ndimage.median_filter(H, size=5)
        spikes = np.abs(H - med) > 120
        H[spikes] = med[spikes]
        if spikes.any():
            print(f'    despiked {int(spikes.sum())} samples')

        # ---- water masks at the land-cover resolution (supersampled x2), reduced to height res too
        ss = 2
        wm = raster_water(feats, g, lres, ss)
        water_hi = wm['lakes'] | wm['ponds'] | wm['rivers']
        sdf = down(signed_distance(water_hi, lres / ss), ss)
        f = hres // lres
        lake_h = down(wm['lakes'].astype(np.float32), ss * f) > 0.5
        pond_h = down(wm['ponds'].astype(np.float32), ss * f) > 0.5
        river_h = (down(wm['rivers'].astype(np.float32), ss * f) > 0.35) & ~lake_h & ~pond_h
        water_h = lake_h | pond_h | river_h

        # ---- water surface level
        Wl = np.full(H.shape, np.nan)
        lab, nlab = ndimage.label(lake_h | pond_h)
        if nlab:
            idx = np.arange(1, nlab + 1)
            # shoreline ring: the land cells touching each water body (the DEM under water is not trusted)
            ring_lab = ndimage.grey_dilation(lab, size=3)
            ring_lab = np.where(water_h, 0, ring_lab)
            ring_lvl = np.array([np.nan] * nlab)
            if ring_lab.any():
                vals = ndimage.labeled_comprehension(H, ring_lab, idx, lambda v: np.percentile(v, 15), float, np.nan)
                ring_lvl = np.asarray(vals)
            er = ndimage.binary_erosion(lake_h | pond_h)
            flat_lvl = np.asarray(ndimage.median(H, np.where(er, lab, 0), idx), float)
            sizes = ndimage.sum(np.ones_like(H), lab, idx)
            for i, sz in zip(idx, sizes):
                cells = lab == i
                is_lake = lake_h[cells].mean() > 0.5
                big = is_lake and sz * hres * hres > 2e6
                if big:
                    cx = X[cells].mean()
                    key = 'norfork' if cx > -3000 else 'bull_shoals'
                    if name == 'near' and key not in lake_levels:
                        lake_levels[key] = float(flat_lvl[i - 1])
                    lvl = lake_levels.get(key, flat_lvl[i - 1])
                else:
                    lvl = ring_lvl[i - 1] - 0.5
                    if name != 'far' and not np.isnan(flat_lvl[i - 1]) and abs(flat_lvl[i - 1] - lvl) < 4:
                        lvl = flat_lvl[i - 1]
                if np.isnan(lvl):
                    lvl = np.nanmedian(H[cells])
                Wl[cells] = lvl
        if river_h.any():
            sig = 400.0 / hres
            if name == 'far':
                # coarse DEM is unreliable on water: use the banks, lower envelope
                bank = ndimage.binary_dilation(river_h, iterations=1) & ~water_h
                src = np.where(bank, H, 1e4)
                src = ndimage.minimum_filter(src, size=3)
                mask = (src < 1e4) & (ndimage.binary_dilation(river_h, iterations=2))
                num = ndimage.gaussian_filter(np.where(mask, src, 0), sig)
                den = ndimage.gaussian_filter(mask.astype(np.float64), sig)
                rw = np.where(den > 0.05, num / np.maximum(den, 1e-6) - 2.0, np.nan)
                Wl[river_h] = rw[river_h]
            else:
                # smoothed DEM along the river (lower envelope so banks do not lift it)
                rv = np.where(river_h, H, np.nan)
                rv_min = ndimage.minimum_filter(np.nan_to_num(rv, nan=1e4), size=3)
                rv_min = np.where(river_h, np.minimum(rv_min, H), 0)
                num = ndimage.gaussian_filter(rv_min, sig)
                den = ndimage.gaussian_filter(river_h.astype(np.float64), sig)
                Wl[river_h] = (num / np.maximum(den, 1e-6))[river_h]
        dbg = lambda tag, a: os.environ.get('DEBUG') and print('   ', tag, np.nanmin(a), np.nanmax(a), np.isnan(a).sum())
        dbg('Wl before fill', Wl)
        # nearest-fill so the water surface is defined past the shore
        have = ~np.isnan(Wl)
        if have.any():
            _, (iy, ix) = ndimage.distance_transform_edt(~have, return_indices=True)
            Wl = Wl[iy, ix]
        else:
            Wl = np.zeros_like(H)

        # ---- carve lake and river beds under the water surface
        dist_in = ndimage.distance_transform_edt(water_h) * hres
        maxd = np.where(lake_h, 55.0, np.where(river_h, 5.0, 4.0))
        depth = np.minimum(maxd, 1.0 + 0.09 * dist_in)
        H = np.where(water_h, Wl - depth, H)
        assert np.isfinite(H).all() and np.isfinite(Wl).all(), name
        print(f'    heights {H.min():.1f}..{H.max():.1f} m, water {Wl.min():.1f}..{Wl.max():.1f} m')

        # ---- runways
        flatten_runways(H, g, hres, runways)

        write(f'{name}_h.bin', pack_u16(H))
        write(f'{name}_w.bin', pack_u16(Wl))

        # ---- imagery
        irng = tile_range(g, g['img_zoom'])
        img = mosaic('img', g['img_zoom'], irng)
        ilat, ilon, _, _ = grid_latlon(g, ires)
        rgb = np.clip(resample(img, ilat, ilon, g['img_zoom'], irng), 0, 255).astype(np.uint8)
        del img
        rgb = flatten_colour(rgb, g, ires, sdf, lres)
        Image.fromarray(rgb).save(os.path.join(OUT, f'{name}.jpg'), quality=82 if name != 'far' else 85,
                                  optimize=True, progressive=False, subsampling=2)
        print(f"    {name}.jpg: {os.path.getsize(os.path.join(OUT, name + '.jpg')) / 1024:.0f} KB  {rgb.shape[1]}x{rgb.shape[0]}")

        # ---- land cover: water signed distance only (forest is classified from the imagery in the shader)
        sdf_u8 = np.clip(np.round(128 + sdf / SDF_SCALE[name]), 0, 255).astype(np.uint8)
        lc = sdf_u8
        write(f'{name}_lc.bin', pack_u8(lc))
        Image.fromarray(sdf_u8).save(os.path.join(CACHE, f'debug_{name}_lc.png'))
        hv = (H - H.min()) / (H.max() - H.min()) * 255
        Image.fromarray(hv.astype(np.uint8)).save(os.path.join(CACHE, f'debug_{name}_h.png'))

        meta_grids[name] = dict(x0=g['x0'], z0=g['z0'], w=g['w'], h=g['h'], h_res=hres, i_res=ires, lc_res=lres,
                                hn=[H.shape[1], H.shape[0]], lcn=[lc.shape[1], lc.shape[0]], sdf_scale=SDF_SCALE[name],
                                hmin=round(float(H.min()), 1), hmax=round(float(H.max()), 1))

    # ---- buildings (near grid), compact binary: count, then per building: kind, height*10, npts, pts (int16 x2 at 0.5 m
    # relative to a per-building origin stored as int32 x2 at 0.1 m)
    blds = []
    gn = GRIDS['near']
    for b in feats['buildings']:
        pts = b['pts'][:-1]
        if len(pts) < 3:
            continue
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        if not (gn['x0'] < cx < gn['x0'] + gn['w'] and gn['z0'] < cz < gn['z0'] + gn['h']):
            continue
        area = 0.5 * abs(sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts))))
        if area < 12:
            continue
        kind = b['kind']
        h = b['h']
        if h is None:
            h = 4.5 if area < 250 else (6.0 if area < 1500 else 8.5)
            if kind in ('hangar', 'warehouse', 'industrial', 'retail', 'commercial'):
                h = max(h, 7.0)
            if kind in ('church',):
                h = 11.0
        blds.append((cx, cz, h, [(p[0] - cx, p[1] - cz) for p in pts], kind))
    buf = bytearray(np.array([len(blds)], '<u4').tobytes())
    kinds = ['house', 'residential', 'detached', 'garage', 'shed', 'commercial', 'retail', 'industrial', 'warehouse',
             'hangar', 'church', 'school', 'hospital', 'apartments', 'yes']
    for cx, cz, h, rel, kind in blds:
        rel = rel[:250]
        k = kinds.index(kind) if kind in kinds else len(kinds) - 1
        buf += np.array([round(cx * 10), round(cz * 10)], '<i4').tobytes()
        buf += np.array([k, min(255, round(h * 4)), len(rel)], '<u1').tobytes()
        buf += np.array([v for p in rel for v in (round(p[0] * 2), round(p[1] * 2))], '<i2').tobytes()
    write('buildings.bin', zlib.compress(bytes(buf), 9))
    print(f'  buildings kept: {len(blds)}')

    # ---- map vectors (simplified) and metadata
    def simplify(pts, tol):
        pts = np.asarray(pts)
        if len(pts) < 3:
            return pts.tolist()
        keep = np.zeros(len(pts), bool)
        keep[0] = keep[-1] = True
        stack = [(0, len(pts) - 1)]
        while stack:
            i, j = stack.pop()
            a, b = pts[i], pts[j]
            ab = b - a
            L = np.hypot(*ab) or 1e-9
            seg = pts[i + 1:j]
            if len(seg) == 0:
                continue
            d = np.abs(ab[0] * (seg[:, 1] - a[1]) - ab[1] * (seg[:, 0] - a[0])) / L
            k = int(np.argmax(d))
            if d[k] > tol:
                keep[i + 1 + k] = True
                stack += [(i, i + 1 + k), (i + 1 + k, j)]
        return [[round(float(x)), round(float(z))] for x, z in pts[keep]]

    rivers = [dict(name=r['name'], pts=simplify(r['pts'], 30)) for r in feats['rivers'] if r['name'] in RIVER_WIDTH]
    dams = []
    for d in feats['dams']:
        p = np.array(d['pts'])
        c = p.mean(0)
        if abs(c[0]) < 70000 and abs(c[1]) < 70000:
            dams.append(dict(name=d['name'], x=round(float(c[0])), z=round(float(c[1]))))
    places = [p for p in feats['places'] if abs(p['x']) < 65000 and abs(p['z']) < 65000]
    ads = []
    for a in aerodromes:
        if a['name'] and not any(abs(a['x'] - b['x']) < 800 and abs(a['z'] - b['z']) < 800 for b in ads):
            ads.append(dict(name=a['name'], icao=a['icao'], x=round(a['x']), z=round(a['z'])))
    world = dict(
        origin=dict(lat=LAT0, lon=LON0, kx=KX, kz=KZ, name='Baxter County Regional Airport (KBPK)'),
        h_unit=H_UNIT, grids=meta_grids, runways=runways, lake_levels={k: round(v, 2) for k, v in lake_levels.items()},
        rivers=rivers, dams=dams, places=places, aerodromes=ads,
        attribution=['Elevation: USGS 3DEP via AWS Terrain Tiles', 'Imagery: USGS National Map (public domain)',
                     'Vectors: © OpenStreetMap contributors (ODbL)'])
    with open(os.path.join(OUT, 'world.json'), 'w') as f:
        json.dump(world, f, separators=(',', ':'))
    print(f"  world.json: {os.path.getsize(os.path.join(OUT, 'world.json')) / 1024:.0f} KB")
    print('  lake levels:', world['lake_levels'])
    total = sum(os.path.getsize(p) for p in glob.glob(os.path.join(OUT, '*')))
    print(f'total data: {total / 1024 / 1024:.2f} MB')


if __name__ == '__main__':
    main()
