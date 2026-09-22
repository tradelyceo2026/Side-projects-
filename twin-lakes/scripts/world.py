"""World definition shared by the data scripts. src/world.js mirrors the projection and grids.

Local frame: metres from the Baxter County Airport (KBPK) reference point.
  x = east, z = south (Three.js: y up, -z north).
"""
import math

LAT0 = 36.3691443
LON0 = -92.4693810
KX = math.cos(math.radians(LAT0)) * 111320.0
KZ = 110540.0


def to_local(lat, lon):
    return (lon - LON0) * KX, -(lat - LAT0) * KZ


def to_latlon(x, z):
    return LAT0 - z / KZ, LON0 + x / KX


# h = height-grid spacing, i = imagery spacing (metres). Width/height in metres.
GRIDS = {
    'far':   dict(x0=-62268, z0=-69960, w=131072, h=131072, h_res=256, i_res=64, dem_zoom=9, img_zoom=11),
    'near':  dict(x0=-29500, z0=-29000, w=65536, h=49152, h_res=32, i_res=16, dem_zoom=12, img_zoom=13),
    'inset': dict(x0=-3600, z0=-2600, w=12288, h=7680, h_res=8, i_res=4, dem_zoom=14, img_zoom=15),
}

OSM_BOX = (-92.80, 36.18, -92.06, 36.64)  # w, s, e, n

LAKE_RELATIONS = {'norfork': 8452802, 'bull_shoals': 6265485}
