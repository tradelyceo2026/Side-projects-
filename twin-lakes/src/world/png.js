// Minimal PNG reader for the world's greyscale heightmaps (8- and 16-bit, non-interlaced). Browsers decode
// PNG to 8-bit canvas pixels, which would throw away the 16-bit heights, so the IDAT stream is inflated
// (by the caller: zlib in Node, DecompressionStream in the browser) and unfiltered here.

/** Split a PNG into its header and concatenated IDAT (zlib) stream. */
export function parsePNG(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8;
  let ihdr = null;
  const parts = [];
  while (o < bytes.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: dv.getUint32(o + 8), height: dv.getUint32(o + 12), depth: bytes[o + 16], colorType: bytes[o + 17], interlace: bytes[o + 20] };
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ihdr || ihdr.colorType !== 0 || ihdr.interlace !== 0) throw new Error('expected a non-interlaced greyscale PNG');
  const total = parts.reduce((s, p) => s + p.length, 0);
  const idat = new Uint8Array(total);
  let k = 0;
  for (const p of parts) { idat.set(p, k); k += p.length; }
  return { ...ihdr, idat };
}

/** Undo the PNG scanline filters; returns Uint8Array (8-bit) or Uint16Array (16-bit) samples. */
export function unfilterPNG(info, raw) {
  const { width: w, height: h, depth } = info;
  const bpp = depth / 8;
  const stride = w * bpp;
  const out = new Uint8Array(h * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 255;
    }
    prev = row;
  }
  if (depth === 8) return out;
  const u16 = new Uint16Array(w * h);
  for (let i = 0; i < u16.length; i++) u16[i] = (out[2 * i] << 8) | out[2 * i + 1];
  return u16;
}

export function heightsFromU16(u16, unit) {
  const f = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) f[i] = u16[i] / unit;
  return f;
}
