// A G1000-style primary flight display and engine strip, drawn on one canvas. The same canvas is the
// cockpit panel texture and the heads-down overlay in the outside views.

const DEG = Math.PI / 180;
const KT = 0.514444, FT = 0.3048;

export class PFD {
  constructor(width = 1280, height = 400) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.g = this.canvas.getContext('2d');
    this.w = width; this.h = height;
    this.font = '"DejaVu Sans Mono", "Menlo", "Consolas", monospace';
  }

  /**
   * @param o   flight-model outputs
   * @param s   extra state: { ap, apLateral, apVertical, target, baroHpa, localTime, trim, throttle, flapsSel,
   *            fuel, gs, dtk, wpName, wpDist, map: HTMLCanvasElement }
   */
  draw(o, s) {
    const g = this.g, W = this.w, H = this.h;
    g.save();
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, W, H);
    const pw = Math.round(W * 0.62);
    this._pfd(0, 0, pw, H, o, s);
    this._engine(pw + 6, 0, W - pw - 6, H, o, s);
    g.restore();
  }

  _pfd(x0, y0, w, h, o, s) {
    const g = this.g;
    g.save();
    g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    const cx = x0 + w * 0.5, cy = y0 + h * 0.47;
    const pxPerDeg = h / 38;
    // ---- attitude
    g.save();
    g.translate(cx, cy);
    g.rotate(-o.roll);
    const py = (o.pitch / DEG) * pxPerDeg;
    g.fillStyle = '#2a73c9'; g.fillRect(-w * 1.5, -h * 3 + py, w * 3, h * 3);
    const grad = g.createLinearGradient(0, py, 0, py + h);
    grad.addColorStop(0, '#7a5424'); grad.addColorStop(1, '#4d3312');
    g.fillStyle = grad; g.fillRect(-w * 1.5, py, w * 3, h * 3);
    g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-w * 1.5, py); g.lineTo(w * 1.5, py); g.stroke();
    // pitch ladder
    g.font = `600 ${h * 0.04}px ${this.font}`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 2.5) {
      if (p === 0) continue;
      const yy = py - p * pxPerDeg;
      if (Math.abs(yy) > h * 0.36) continue;
      const major = p % 10 === 0, mid = p % 5 === 0;
      const hw = major ? w * 0.1 : mid ? w * 0.055 : w * 0.025;
      g.lineWidth = major ? 2 : 1.5;
      g.beginPath(); g.moveTo(-hw, yy); g.lineTo(hw, yy); g.stroke();
      if (major) { g.fillText(Math.abs(p), -hw - 18, yy); g.fillText(Math.abs(p), hw + 18, yy); }
    }
    g.restore();
    // roll scale
    g.save();
    g.translate(cx, cy);
    const rr = h * 0.33;
    g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 0, rr, -Math.PI / 2 - 60 * DEG, -Math.PI / 2 + 60 * DEG); g.stroke();
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const t = -Math.PI / 2 + a * DEG, l = Math.abs(a) % 30 === 0 ? 14 : 8;
      g.beginPath(); g.moveTo(Math.cos(t) * rr, Math.sin(t) * rr); g.lineTo(Math.cos(t) * (rr + l), Math.sin(t) * (rr + l)); g.stroke();
    }
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(0, -rr); g.lineTo(-7, -rr - 12); g.lineTo(7, -rr - 12); g.fill();
    g.rotate(-o.roll);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(0, -rr + 2); g.lineTo(-8, -rr + 14); g.lineTo(8, -rr + 14); g.fill();
    // slip/skid
    const slip = Math.max(-1, Math.min(1, -(o.slip || 0) * 6));
    g.fillRect(-8 + slip * 12, -rr + 16, 16, 4);
    g.restore();
    // aircraft symbol
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#f5c400'; g.strokeStyle = '#000'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(-w * 0.12, h * 0.06); g.lineTo(-w * 0.07, h * 0.06); g.lineTo(0, h * 0.025);
    g.lineTo(w * 0.07, h * 0.06); g.lineTo(w * 0.12, h * 0.06); g.closePath(); g.fill(); g.stroke();
    g.fillRect(-w * 0.2, -2, w * 0.05, 5); g.fillRect(w * 0.15, -2, w * 0.05, 5);
    g.restore();

    // stall warning
    if (o.stallWarn) {
      g.fillStyle = '#e02020'; g.font = `700 ${h * 0.06}px ${this.font}`; g.textAlign = 'center';
      g.fillText('STALL', cx, y0 + h * 0.2);
    }

    // ---- airspeed tape
    this._tape(x0 + w * 0.02, y0 + h * 0.1, w * 0.13, h * 0.66, o.ias / KT, 10, 5, 'kt', true, s);
    // ---- altitude tape
    this._tape(x0 + w * 0.8, y0 + h * 0.1, w * 0.14, h * 0.66, o.indAlt / FT, 100, 20, 'ft', false, s);
    // ---- VSI
    const vx = x0 + w * 0.945, vy = y0 + h * 0.1, vh = h * 0.66;
    g.fillStyle = 'rgba(40,44,52,0.85)'; g.fillRect(vx, vy, w * 0.05, vh);
    g.strokeStyle = '#ccc'; g.lineWidth = 1;
    for (const v of [-2000, -1000, -500, 500, 1000, 2000]) {
      const yy = vy + vh / 2 - Math.sign(v) * Math.sqrt(Math.abs(v) / 2000) * vh * 0.45;
      g.beginPath(); g.moveTo(vx, yy); g.lineTo(vx + 8, yy); g.stroke();
    }
    const fpm = o.vs / 0.00508;
    const vyy = vy + vh / 2 - Math.sign(fpm) * Math.sqrt(Math.min(1, Math.abs(fpm) / 2000)) * vh * 0.45;
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(vx + 2, vyy); g.lineTo(vx + w * 0.05, vyy - 8); g.lineTo(vx + w * 0.05, vyy + 8); g.fill();
    g.font = `600 ${h * 0.035}px ${this.font}`; g.textAlign = 'center';
    if (Math.abs(fpm) > 100) g.fillText(String(Math.round(fpm / 50) * 50), vx + w * 0.025, fpm > 0 ? vy - 8 : vy + vh + 12);

    // ---- HSI
    this._hsi(cx, y0 + h * 1.02, h * 0.3, o, s);

    // ---- top bar
    g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(x0, y0, w, h * 0.075);
    g.font = `600 ${h * 0.04}px ${this.font}`; g.textAlign = 'left'; g.textBaseline = 'middle';
    const ap = s.ap ? '#29d65a' : '#666';
    g.fillStyle = ap; g.fillText(`AP ${s.ap ? s.apLateral : ''}`, x0 + 8, y0 + h * 0.04);
    g.fillStyle = s.ap ? '#29d65a' : '#666';
    let vtext = s.ap ? s.apVertical : '';
    if (s.ap && s.apVertical === 'ALT') vtext += ` ${Math.round(s.target.alt / FT / 10) * 10}FT`;
    if (s.ap && s.apVertical === 'VS') vtext += ` ${Math.round(s.target.vs / 0.00508 / 50) * 50}FPM`;
    if (s.ap && s.apVertical === 'IAS') vtext += ` ${Math.round(s.target.ias / KT)}KT`;
    g.fillText(vtext, x0 + w * 0.22, y0 + h * 0.04);
    g.fillStyle = '#d0d0d0';
    g.textAlign = 'right';
    g.fillText(`GS ${Math.round(o.gs / KT)}KT  TRK ${String(Math.round(((o.track / DEG) + 360) % 360)).padStart(3, '0')}°`, x0 + w - 8, y0 + h * 0.04);
    if (s.wpName) {
      g.fillStyle = '#d04fd0'; g.textAlign = 'center';
      g.fillText(`${s.wpName} ${s.wpDist != null ? (s.wpDist / 1852).toFixed(1) + 'NM' : ''}`, x0 + w * 0.6, y0 + h * 0.04);
    }
    // bottom bar
    g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(x0, y0 + h * 0.93, w, h * 0.07);
    g.fillStyle = '#d0d0d0'; g.textAlign = 'left';
    g.fillText(`OAT ${Math.round(o.oat)}°C`, x0 + 8, y0 + h * 0.965);
    g.textAlign = 'right';
    g.fillText(`${s.localTime || ''}  ${(s.baroHpa / 33.8639).toFixed(2)}IN`, x0 + w - 8, y0 + h * 0.965);
    g.restore();
  }

  _tape(x, y, w, h, value, step, minor, unit, left, s) {
    const g = this.g;
    g.save();
    g.fillStyle = 'rgba(40,44,52,0.82)'; g.fillRect(x, y, w, h);
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    const pxPer = h / (left ? 60 : 600);
    const mid = y + h / 2;
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 1.5;
    g.font = `600 ${h * 0.06}px ${this.font}`; g.textBaseline = 'middle';
    // colour arcs for airspeed
    if (left) {
      const band = (a, b, col, xo, wd) => { g.fillStyle = col; g.fillRect(x + w - xo, mid - (b - value) * pxPer, wd, (b - a) * pxPer); };
      band(40, 85, '#fff', 14, 5);
      band(48, 129, '#1fb33a', 8, 7);
      band(129, 163, '#e6c700', 8, 7);
      band(163, 200, '#d11', 8, 7);
    }
    const start = Math.floor((value - (left ? 35 : 350)) / minor) * minor;
    for (let v = start; v < value + (left ? 35 : 350); v += minor) {
      if (left && v < 20) continue;
      const yy = mid - (v - value) * pxPer;
      const major = v % step === 0;
      g.strokeStyle = '#fff';
      g.beginPath();
      if (left) { g.moveTo(x + w - (major ? 16 : 8), yy); g.lineTo(x + w, yy); } else { g.moveTo(x, yy); g.lineTo(x + (major ? 14 : 7), yy); }
      g.stroke();
      if (major) {
        g.fillStyle = '#fff';
        g.textAlign = left ? 'right' : 'left';
        g.fillText(left ? v : v, left ? x + w - 20 : x + 18, yy);
      }
    }
    // selected altitude bug
    if (!left && s.ap && s.apVertical === 'ALT') {
      const yy = mid - (s.target.alt / FT - value) * pxPer;
      g.fillStyle = '#29c9e6'; g.fillRect(x, yy - 6, 6, 12);
    }
    g.restore();
    // readout box
    g.save();
    g.fillStyle = '#000'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    const bh = h * 0.12;
    g.beginPath();
    if (left) { g.moveTo(x, mid - bh / 2); g.lineTo(x + w - 6, mid - bh / 2); g.lineTo(x + w + 6, mid); g.lineTo(x + w - 6, mid + bh / 2); g.lineTo(x, mid + bh / 2); }
    else { g.moveTo(x + w, mid - bh / 2); g.lineTo(x + 6, mid - bh / 2); g.lineTo(x - 6, mid); g.lineTo(x + 6, mid + bh / 2); g.lineTo(x + w, mid + bh / 2); }
    g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.font = `700 ${h * 0.085}px ${this.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const txt = left ? (value < 20 ? '---' : String(Math.round(value))) : String(Math.round(value / 10) * 10);
    g.fillText(txt, x + w / 2, mid + 1);
    g.font = `600 ${h * 0.045}px ${this.font}`;
    g.fillStyle = '#29c9e6';
    if (left && s.ap && s.apVertical === 'IAS') g.fillText(`${Math.round(s.target.ias / KT)}KT`, x + w / 2, y - 12);
    if (!left) g.fillText(s.ap && s.apVertical === 'ALT' ? `${Math.round(s.target.alt / FT / 10) * 10}` : '', x + w / 2, y - 12);
    g.restore();
  }

  _hsi(cx, cy, r, o, s) {
    const g = this.g;
    g.save();
    g.translate(cx, cy);
    g.fillStyle = 'rgba(20,24,30,0.9)';
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    g.rotate(-o.heading);
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 1.5;
    g.font = `600 ${r * 0.14}px ${this.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 5) {
      const t = a * DEG;
      const l = a % 10 === 0 ? r * 0.1 : r * 0.05;
      g.beginPath(); g.moveTo(Math.sin(t) * r, -Math.cos(t) * r); g.lineTo(Math.sin(t) * (r - l), -Math.cos(t) * (r - l)); g.stroke();
      if (a % 30 === 0) {
        g.save(); g.rotate(t);
        g.fillText(a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10), 0, -r * 0.78);
        g.restore();
      }
    }
    if (s.dtk != null) {
      g.save(); g.rotate(s.dtk);
      g.strokeStyle = '#d04fd0'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(0, -r * 0.62); g.lineTo(0, r * 0.62); g.stroke();
      g.fillStyle = '#d04fd0';
      g.beginPath(); g.moveTo(0, -r * 0.68); g.lineTo(-9, -r * 0.54); g.lineTo(9, -r * 0.54); g.fill();
      g.restore();
    }
    if (s.ap && (s.apLateral === 'HDG' || s.apLateral === 'TRK')) {
      g.save(); g.rotate(s.target.heading);
      g.fillStyle = '#29c9e6'; g.fillRect(-8, -r, 16, 8);
      g.restore();
    }
    g.restore();
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#000'; g.strokeStyle = '#fff';
    g.fillRect(-r * 0.22, -r - r * 0.2, r * 0.44, r * 0.17);
    g.strokeRect(-r * 0.22, -r - r * 0.2, r * 0.44, r * 0.17);
    g.fillStyle = '#fff'; g.font = `700 ${r * 0.13}px ${this.font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(Math.round(((o.heading / DEG) + 360) % 360) % 360).padStart(3, '0') + '°', 0, -r - r * 0.11);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(0, -r * 0.2); g.lineTo(-r * 0.08, r * 0.1); g.lineTo(r * 0.08, r * 0.1); g.fill();
    g.restore();
  }

  _engine(x, y, w, h, o, s) {
    const g = this.g;
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = '#080a0d'; g.fillRect(x, y, w, h);
    // moving map occupies the right part
    const ew = w * 0.36;
    if (s.map) g.drawImage(s.map, x + ew + 4, y, w - ew - 4, h);
    g.fillStyle = '#0c0f13'; g.fillRect(x, y, ew, h);
    g.font = `600 ${h * 0.042}px ${this.font}`; g.textBaseline = 'middle';
    let yy = y + h * 0.07;
    const row = (label, val, frac, col = '#1fb33a') => {
      g.fillStyle = '#bbb'; g.textAlign = 'left'; g.fillText(label, x + 8, yy);
      g.fillStyle = '#fff'; g.textAlign = 'right'; g.fillText(val, x + ew - 8, yy);
      yy += h * 0.045;
      g.fillStyle = '#333'; g.fillRect(x + 8, yy - 4, ew - 16, 7);
      g.fillStyle = col; g.fillRect(x + 8, yy - 4, (ew - 16) * Math.max(0, Math.min(1, frac)), 7);
      yy += h * 0.07;
    };
    // RPM arc
    const rpm = o.rpm || 0;
    g.save();
    const rcx = x + ew / 2, rcy = y + h * 0.2, rr = h * 0.14;
    g.lineWidth = 7;
    const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    const ang = (v) => a0 + (a1 - a0) * v / 3000;
    g.strokeStyle = '#1fb33a'; g.beginPath(); g.arc(rcx, rcy, rr, ang(2100), ang(2700)); g.stroke();
    g.strokeStyle = '#d11'; g.beginPath(); g.arc(rcx, rcy, rr, ang(2700), ang(2760)); g.stroke();
    g.strokeStyle = '#555'; g.beginPath(); g.arc(rcx, rcy, rr, a0, ang(2100)); g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = 3;
    const ra = ang(Math.min(3000, rpm));
    g.beginPath(); g.moveTo(rcx, rcy); g.lineTo(rcx + Math.cos(ra) * rr, rcy + Math.sin(ra) * rr); g.stroke();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = `700 ${h * 0.05}px ${this.font}`;
    g.fillText(String(Math.round(rpm / 10) * 10), rcx, rcy + rr * 0.55);
    g.font = `600 ${h * 0.035}px ${this.font}`; g.fillStyle = '#bbb';
    g.fillText('RPM', rcx, rcy - rr * 0.35);
    g.restore();
    yy = y + h * 0.4;
    const gph = (o.fuelFlow || 0) * 3600 / 0.72 / 3.785;
    row('FFLOW GPH', gph.toFixed(1), gph / 20);
    const gal = (o.fuel || 0) / 0.72 / 3.785;
    row('FUEL GAL', gal.toFixed(0), gal / 56, gal < 8 ? '#e6c700' : '#1fb33a');
    row('THR', `${Math.round((s.throttle || 0) * 100)}%`, s.throttle || 0, '#29c9e6');
    const flap = o.flaps || 0;
    row('FLAPS', `${Math.round(flap)}°`, flap / 30, '#fff');
    row('TRIM', (s.trim || 0) > 0.02 ? 'UP' : (s.trim || 0) < -0.02 ? 'DN' : 'TO', 0.5 + (s.trim || 0) / 2, '#fff');
    g.restore();
  }
}
