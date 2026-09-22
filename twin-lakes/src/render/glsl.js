// GLSL shared by the terrain, water, tree and building shaders.
//
// TERRAIN_GLSL mirrors src/world/terrain.js exactly: texel-centred bilinear sampling with texelFetch and the
// same blend bands between the far, near and inset grids.

import { ATMOSPHERE_GLSL, SKYLUT_GLSL } from './atmosphere.js';
import { BLEND } from '../world/terrain.js';

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

export const TERRAIN_GLSL = /* glsl */`
uniform highp sampler2D tHfar;
uniform highp sampler2D tHnear;
uniform highp sampler2D tHinset;
uniform highp sampler2D tWfar;
uniform highp sampler2D tWnear;
uniform highp sampler2D tWinset;
uniform sampler2D tLfar;
uniform sampler2D tLnear;
uniform sampler2D tLinset;
uniform vec4 gFar;     // x0, z0, w, h
uniform vec4 gNear;
uniform vec4 gInset;
uniform vec3 rFar;     // height res, land-cover res, sdf scale
uniform vec3 rNear;
uniform vec3 rInset;

float bilin(highp sampler2D t, vec2 fp) {
  ivec2 sz = textureSize(t, 0);
  fp = clamp(fp, vec2(0.0), vec2(sz - 1));
  ivec2 i0 = ivec2(floor(fp));
  ivec2 i1 = min(i0 + 1, sz - 1);
  vec2 tt = fp - vec2(i0);
  float a = texelFetch(t, i0, 0).r;
  float b = texelFetch(t, ivec2(i1.x, i0.y), 0).r;
  float c = texelFetch(t, ivec2(i0.x, i1.y), 0).r;
  float d = texelFetch(t, i1, 0).r;
  return mix(mix(a, b, tt.x), mix(c, d, tt.x), tt.y);
}

float gridEdge(vec4 g, vec2 p) {
  return min(min(p.x - g.x, g.x + g.z - p.x), min(p.y - g.y, g.y + g.w - p.y));
}
float wNearAt(vec2 p) { return smoothstep(${f(BLEND.near[0])}, ${f(BLEND.near[1])}, gridEdge(gNear, p)); }
float wInsetAt(vec2 p) { return smoothstep(${f(BLEND.inset[0])}, ${f(BLEND.inset[1])}, gridEdge(gInset, p)); }

float sH(highp sampler2D t, vec4 g, vec3 r, vec2 p) { return bilin(t, (p - g.xy) / r.x - 0.5); }
float sL(sampler2D t, vec4 g, vec3 r, vec2 p) { return (bilin(t, (p - g.xy) / r.y - 0.5) * 255.0 - 128.0) * r.z; }

float terrainHeight(vec2 p) {
  float v = sH(tHfar, gFar, rFar, p);
  float wn = wNearAt(p);
  if (wn > 0.0) v = mix(v, sH(tHnear, gNear, rNear, p), wn);
  float wi = wInsetAt(p);
  if (wi > 0.0) v = mix(v, sH(tHinset, gInset, rInset, p), wi);
  return v;
}
float waterLevel(vec2 p) {
  float v = sH(tWfar, gFar, rFar, p);
  float wn = wNearAt(p);
  if (wn > 0.0) v = mix(v, sH(tWnear, gNear, rNear, p), wn);
  float wi = wInsetAt(p);
  if (wi > 0.0) v = mix(v, sH(tWinset, gInset, rInset, p), wi);
  return v;
}
float waterDistance(vec2 p) {
  float v = sL(tLfar, gFar, rFar, p);
  float wn = wNearAt(p);
  if (wn > 0.0) v = mix(v, sL(tLnear, gNear, rNear, p), wn);
  float wi = wInsetAt(p);
  if (wi > 0.0) v = mix(v, sL(tLinset, gInset, rInset, p), wi);
  return v;
}
`;

export const IMAGERY_GLSL = /* glsl */`
uniform sampler2D tImgFar;
uniform sampler2D tImgNear;
uniform sampler2D tImgInset;
vec3 imagery(vec2 p) {
  vec3 c = texture(tImgFar, (p - gFar.xy) / gFar.zw).rgb;
  float wn = wNearAt(p);
  if (wn > 0.0) c = mix(c, texture(tImgNear, (p - gNear.xy) / gNear.zw).rgb, wn);
  float wi = wInsetAt(p);
  if (wi > 0.0) c = mix(c, texture(tImgInset, (p - gInset.xy) / gInset.zw).rgb, wi);
  return c;
}
vec3 imageryLod(vec2 p, float lod) {
  vec3 c = textureLod(tImgFar, (p - gFar.xy) / gFar.zw, max(0.0, lod - 2.0)).rgb;
  float wn = wNearAt(p);
  if (wn > 0.0) c = mix(c, textureLod(tImgNear, (p - gNear.xy) / gNear.zw, lod).rgb, wn);
  return c;
}
// forest likelihood from the orthophoto colour: dark, green, not water
float forestFromColour(vec3 c) {
  vec3 s = pow(c, vec3(1.0 / 2.2));
  float L = dot(s, vec3(0.3, 0.59, 0.11));
  float g = s.g - 0.5 * (s.r + s.b);
  return smoothstep(0.43, 0.30, L) * smoothstep(0.0, 0.05, g);
}
`;

/** Lighting, sky and aerial perspective. */
export const LIGHT_GLSL = /* glsl */`
${SKYLUT_GLSL}
uniform sampler2D tSkyLut;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGroundAmbient;
uniform float uSkyIntensity;
uniform float uFogDensity;
uniform float uTime;
uniform float uNight;

vec3 skyColour(vec3 dir) {
  vec3 c = texture(tSkyLut, skyLutUv(dir)).rgb * uSkyIntensity;
  // twilight and night sky: a blue glow toward the sun after sunset, then moonlit darkness
  float tw = smoothstep(-0.2, -0.01, uSunDir.y) * (1.0 - smoothstep(-0.01, 0.1, uSunDir.y));
  float toward = 0.5 + 0.5 * dot(normalize(vec3(dir.x, 0.0, dir.z) + 1e-4), normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-4));
  float lowSky = 1.0 - smoothstep(0.0, 0.5, dir.y);
  c += tw * (vec3(0.05, 0.075, 0.14) + vec3(0.2, 0.09, 0.04) * toward * toward * lowSky);
  c += vec3(0.006, 0.009, 0.018) * uNight;
  return c;
}

vec3 aerial(vec3 col, vec3 wp) {
  vec3 v = wp - uCam;
  float d = length(v);
  vec3 dir = v / max(d, 1e-3);
  const float H = 1400.0;
  float y0 = max(uCam.y, 0.0), y1 = max(wp.y, 0.0);
  float dy = y1 - y0;
  float od = abs(dy) > 1.0
    ? uFogDensity * H * (exp(-y0 / H) - exp(-y1 / H)) / dy * d
    : uFogDensity * exp(-y0 / H) * d;
  od *= exp(200.0 / H);   // density is specified at 200 m MSL
  float T = exp(-od);
  vec3 dh = normalize(vec3(dir.x, max(dir.y, 0.03), dir.z));
  vec3 fogc = skyColour(dh);
  float mu = max(dot(dir, uSunDir), 0.0);
  fogc += uSunColor * 0.08 * pow(mu, 12.0) * (1.0 - uNight);
  return col * T + fogc * (1.0 - T);
}

// cheap value noise for detail
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;

export { ATMOSPHERE_GLSL };
