// Moving map drawn from the same USGS imagery as the world, with airports, runways, towns, dams and the
// active route. North up.

const NM = 1852;

export class MovingMap {
  constructor(assets, w = 560, h = 420) {
    this.assets = assets;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d');
    this.rangeNm = 8;
    this.route = [];
    this.world = assets.world;
  }

  setRange(nm) { this.rangeNm = Math.max(2, Math.min(40, nm)); }

  draw(pos, headingRad, trackRad, extra = {}) {
    const g = this.g, W = this.canvas.width, H = this.canvas.height;
    const world = this.world;
    const mPerPx = (this.rangeNm * NM) / (H * 0.5);
    const toPx = (x, z) => [W / 2 + (x - pos[0]) / mPerPx, H / 2 + (z - pos[2]) / mPerPx];
    g.fillStyle = '#0b1016';
    g.fillRect(0, 0, W, H);
    // imagery: far grid always, near grid on top when in range
    for (const name of ['far', 'near']) {
      const gr = world.grids[name];
      const img = this.assets.images[name];
      const sx = (pos[0] - W / 2 * mPerPx - gr.x0) / gr.w * img.width;
      const sy = (pos[2] - H / 2 * mPerPx - gr.z0) / gr.h * img.height;
      const sw = (W * mPerPx) / gr.w * img.width;
      const sh = (H * mPerPx) / gr.h * img.height;
      if (name === 'near' && this.rangeNm > 25) continue;
      try {
        // clip the source to the image, adjusting the destination to match
        const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy);
        const cx1 = Math.min(img.width, sx + sw), cy1 = Math.min(img.height, sy + sh);
        if (cx1 > cx0 && cy1 > cy0) {
          g.globalAlpha = 0.85;
          g.drawImage(img, cx0, cy0, cx1 - cx0, cy1 - cy0,
            (cx0 - sx) / sw * W, (cy0 - sy) / sh * H, (cx1 - cx0) / sw * W, (cy1 - cy0) / sh * H);
          g.globalAlpha = 1;
        }
      } catch { /* image not decodable yet */ }
    }
    g.fillStyle = 'rgba(5,10,16,0.25)';
    g.fillRect(0, 0, W, H);
    // rivers
    g.strokeStyle = 'rgba(90,170,255,0.7)'; g.lineWidth = 2;
    for (const r of world.rivers) {
      g.beginPath();
      r.pts.forEach(([x, z], i) => { const [a, b] = toPx(x, z); i ? g.lineTo(a, b) : g.moveTo(a, b); });
      g.stroke();
    }
    // runways
    g.strokeStyle = '#fff'; g.lineWidth = 3;
    for (const r of world.runways) {
      const [a, b] = toPx(...r.a), [c, d] = toPx(...r.b);
      g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
    }
    // labels
    g.font = '600 12px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const ad of world.aerodromes) {
      const [a, b] = toPx(ad.x, ad.z);
      if (a < -40 || a > W + 40 || b < -20 || b > H + 20) continue;
      g.strokeStyle = '#d04fd0'; g.lineWidth = 2;
      g.beginPath(); g.arc(a, b, 7, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#f0b8f0'; g.textAlign = 'left';
      g.fillText(ad.icao || ad.name.replace(' Airport', ''), a + 10, b);
    }
    g.fillStyle = '#e8e8e8';
    for (const p of world.places) {
      if (p.kind === 'hamlet' && this.rangeNm > 6) continue;
      const [a, b] = toPx(p.x, p.z);
      if (a < 0 || a > W || b < 0 || b > H) continue;
      g.textAlign = 'center';
      g.font = p.kind === 'town' ? '700 13px system-ui, sans-serif' : '500 11px system-ui, sans-serif';
      g.fillText(p.name, a, b);
    }
    g.fillStyle = '#9fd4ff';
    for (const d of world.dams) {
      if (!/Norfork|Bull Shoals/.test(d.name)) continue;
      const [a, b] = toPx(d.x, d.z);
      g.fillRect(a - 3, b - 3, 6, 6);
      g.textAlign = 'left'; g.font = '600 11px system-ui, sans-serif';
      g.fillText(d.name, a + 6, b + 10);
    }
    // route
    if (this.route.length) {
      g.strokeStyle = '#d04fd0'; g.lineWidth = 2.5; g.setLineDash([]);
      g.beginPath();
      this.route.forEach((w, i) => { const [a, b] = toPx(w.x, w.z); i ? g.lineTo(a, b) : g.moveTo(a, b); });
      g.stroke();
      for (const [i, w] of this.route.entries()) {
        const [a, b] = toPx(w.x, w.z);
        g.fillStyle = i === extra.activeWp ? '#d04fd0' : '#fff';
        g.beginPath(); g.arc(a, b, 4, 0, Math.PI * 2); g.fill();
      }
    }
    // track line and aircraft
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.5; g.setLineDash([6, 6]);
    g.beginPath(); g.moveTo(W / 2, H / 2);
    g.lineTo(W / 2 + Math.sin(trackRad) * H, H / 2 - Math.cos(trackRad) * H); g.stroke();
    g.setLineDash([]);
    g.save(); g.translate(W / 2, H / 2); g.rotate(headingRad);
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -12); g.lineTo(2.5, -4); g.lineTo(12, 0); g.lineTo(12, 3); g.lineTo(2.5, 1); g.lineTo(2, 8);
    g.lineTo(5, 11); g.lineTo(-5, 11); g.lineTo(-2, 8); g.lineTo(-2.5, 1); g.lineTo(-12, 3); g.lineTo(-12, 0); g.lineTo(-2.5, -4);
    g.closePath(); g.fill(); g.stroke();
    g.restore();
    // range ring and label
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.arc(W / 2, H / 2, H / 4, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#fff'; g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'left';
    g.fillText(`${(this.rangeNm / 2).toFixed(this.rangeNm < 4 ? 1 : 0)} NM`, W / 2 + H / 4 + 4, H / 2);
    g.textAlign = 'right';
    g.fillText('N↑', W - 8, 14);
  }
}
