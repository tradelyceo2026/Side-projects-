// Ozark Orbital — canvas renderer.
import { EARTH, MOON, orbitPath, moonState } from './physics.js';
import { body, elements, altitude, moonRel, radialDir, progradeAngle } from './sim.js';
import { stage, vehicleLength } from './vehicle.js';
import { predictMoonApproach } from './autopilot.js';

export function createCamera() {
  return { zoom: 2.5, targetZoom: 2.5, mode: 'auto', cx: 0, cy: 0, followBody: false, rot: 0, targetRot: 0, snap: true };
}

export function fitZoom(canvas, radiusMetres) {
  return Math.min(canvas.width, canvas.height) / (2.3 * radiusMetres);
}

export function updateCamera(cam, sim, canvas, dt) {
  const b = body(sim);
  const alt = Math.max(altitude(sim), 90);
  // rotate the view so local "up" points to the top of the screen while close to the ground
  const u = radialDir(sim);
  const upAng = Math.atan2(u.y, u.x);
  cam.targetRot = (cam.mode === 'auto' && sim.bodyName === 'Earth' && alt < 400000) ? Math.PI / 2 - upAng : 0;
  if (cam.mode === 'auto') {
    if (sim.bodyName === 'Moon') {
      const el = elements(sim);
      const r = el.e < 1 ? Math.max(el.ra, Math.hypot(sim.ship.x, sim.ship.y)) : Math.hypot(sim.ship.x, sim.ship.y) * 1.2;
      cam.targetZoom = fitZoom(canvas, Math.min(r * 1.05, MOON.soi));
      cam.followBody = true;
    } else if (alt < 400000) {
      cam.targetZoom = (canvas.height * 0.32) / alt;
      cam.followBody = false;
    } else {
      const el = elements(sim);
      const r = el.e < 1 ? el.ra : Math.hypot(sim.ship.x, sim.ship.y) * 1.3;
      cam.targetZoom = fitZoom(canvas, Math.min(Math.max(r, EARTH.radius * 1.2), MOON.orbitRadius * 1.25));
      cam.followBody = true;
    }
  } else if (cam.mode === 'map') {
    const el = elements(sim);
    let r;
    if (sim.bodyName === 'Moon') r = Math.min(el.e < 1 ? el.ra * 1.1 : MOON.soi, MOON.soi);
    else r = el.e < 1 ? Math.max(el.ra * 1.1, b.radius * 1.3) : MOON.orbitRadius * 1.25;
    if (sim.bodyName === 'Earth' && el.ra > MOON.orbitRadius * 0.6) r = MOON.orbitRadius * 1.25;
    cam.targetZoom = fitZoom(canvas, r);
    cam.followBody = true;
  }
  // smooth zoom (log-space) and rotation
  const k = 1 - Math.exp(-dt * 4);
  let dr = cam.targetRot - cam.rot;
  dr = ((dr + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  cam.rot += dr * k;
  if (cam.snap) { cam.snap = false; cam.rot = cam.targetRot; cam.zoom = cam.targetZoom; }
  cam.zoom = Math.exp(Math.log(cam.zoom) + (Math.log(cam.targetZoom) - Math.log(cam.zoom)) * k);
  if (cam.followBody) { cam.cx = 0; cam.cy = 0; }
  else { cam.cx = sim.ship.x; cam.cy = sim.ship.y; }
}

const stars = [];
function seedStars() {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < 400; i++) stars.push([rnd(), rnd(), rnd() * 1.4 + 0.3, rnd()]);
}
seedStars();

export function render(ctx, canvas, sim, cam, ui) {
  const W = canvas.width, H = canvas.height;
  const b = body(sim);
  const zoom = cam.zoom;
  const alt = altitude(sim);
  // world -> screen (y up), with camera rotation
  const cr = Math.cos(cam.rot), sr = Math.sin(cam.rot);
  const sx = (x, y) => { const dx = x - cam.cx, dy = y - cam.cy; return W / 2 + (dx * cr - dy * sr) * zoom; };
  const sy = (y, x) => { const dx = x - cam.cx, dy = y - cam.cy; return H / 2 - (dx * sr + dy * cr) * zoom; };

  // sky / space background
  let skyMix = 0;
  if (sim.bodyName === 'Earth') skyMix = Math.max(0, Math.min(1, 1 - alt / 90000));
  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, W, H);
  // stars
  ctx.save();
  for (const [fx, fy, r, tw] of stars) {
    const a = (0.35 + 0.65 * tw) * (1 - skyMix);
    if (a <= 0.02) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = '#dfe7ff';
    ctx.fillRect(fx * W, fy * H, r, r);
  }
  ctx.restore();
  if (skyMix > 0) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `rgba(72,132,224,${skyMix * 0.85})`);
    g.addColorStop(1, `rgba(150,196,245,${skyMix})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // helper: draw a body (circle) whose centre in world coords is (bx,by)
  function drawBody(bd, bx, by, isPrimary) {
    const R = bd.radius * zoom;
    const cxp = sx(bx, by), cyp = sy(by, bx);
    if (R < 4000) {
      if (bd.atmosphere) {
        const ra = (bd.radius + bd.atmosphere.top) * zoom;
        const g = ctx.createRadialGradient(cxp, cyp, R * 0.98, cxp, cyp, ra);
        g.addColorStop(0, 'rgba(120,180,255,0.55)');
        g.addColorStop(1, 'rgba(120,180,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cxp, cyp, ra, 0, Math.PI * 2); ctx.fill();
      }
      const g2 = ctx.createRadialGradient(cxp - R * 0.3, cyp - R * 0.3, R * 0.1, cxp, cyp, R);
      if (bd === EARTH) { g2.addColorStop(0, '#5aa0ff'); g2.addColorStop(0.7, '#1f5fc4'); g2.addColorStop(1, '#0b2c66'); }
      else { g2.addColorStop(0, '#d8d8d0'); g2.addColorStop(0.7, '#9a9a92'); g2.addColorStop(1, '#4a4a44'); }
      ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(cxp, cyp, Math.max(R, 2), 0, Math.PI * 2); ctx.fill();
      if (bd === EARTH && R > 30) {
        // a few "continents" for orientation, rotating with the planet
        ctx.save(); ctx.translate(cxp, cyp); ctx.rotate(-(sim.padAngle + cam.rot));
        ctx.fillStyle = 'rgba(80,160,90,0.55)';
        const blobs = [[0.2, 0.5, 0.25], [-0.5, 0.2, 0.2], [0.1, -0.55, 0.18], [-0.2, -0.2, 0.12], [0.6, -0.1, 0.1]];
        for (const [bx2, by2, br] of blobs) { ctx.beginPath(); ctx.arc(bx2 * R, by2 * R, br * R, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
    } else {
      // huge: draw the visible arc as a polygon
      const ang0 = Math.atan2(cam.cy - by, cam.cx - bx);
      const span = Math.min(Math.PI, (Math.hypot(W, H) / R) * 1.5);
      const N = 160;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const a = ang0 - span + (2 * span * i) / N;
        { const wx = bx + bd.radius * Math.cos(a), wy = by + bd.radius * Math.sin(a); pts.push([sx(wx, wy), sy(wy, wx)]); }
      }
      // atmosphere band above the ground
      if (bd.atmosphere && skyMix < 1) {
        const top = bd.radius + bd.atmosphere.top;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) { const a = ang0 - span + (2 * span * i) / N; const wx = bx + top * Math.cos(a), wy = by + top * Math.sin(a); const X = sx(wx, wy), Y = sy(wy, wx); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); }
        for (let i = N; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        const gg = ctx.createRadialGradient(sx(bx, by), sy(by, bx), R, sx(bx, by), sy(by, bx), top * zoom);
        gg.addColorStop(0, `rgba(110,170,255,${0.6 * (1 - skyMix)})`); gg.addColorStop(1, 'rgba(110,170,255,0)');
        ctx.fillStyle = gg; ctx.fill();
      }
      const inward = Math.hypot(W, H) * 3;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      const last = pts[pts.length - 1], first = pts[0];
      const cxs = sx(bx, by), cys = sy(by, bx);
      const dirIn = (p) => { const dx = cxs - p[0], dy = cys - p[1]; const d = Math.hypot(dx, dy) || 1; return [p[0] + dx / d * inward, p[1] + dy / d * inward]; };
      const a1 = dirIn(last), a2 = dirIn(first);
      ctx.lineTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath();
      ctx.fillStyle = bd === EARTH ? '#2c5a2e' : '#7d7d76';
      ctx.fill();
      if (bd === EARTH) {
        ctx.strokeStyle = '#4d8b46'; ctx.lineWidth = Math.max(2, Math.min(12, zoom * 8)); ctx.stroke();
      }
    }
  }

  // world objects depend on which frame we are in
  const m = moonRel(sim);
  if (sim.bodyName === 'Earth') {
    // Moon orbit + SOI
    if (MOON.orbitRadius * zoom < Math.hypot(W, H) * 2) {
      ctx.strokeStyle = 'rgba(200,200,220,0.18)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(sx(0, 0), sy(0, 0), MOON.orbitRadius * zoom, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(200,200,220,0.25)'; ctx.beginPath(); ctx.arc(sx(m.x, m.y), sy(m.y, m.x), MOON.soi * zoom, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    drawBody(EARTH, 0, 0, true);
    if (MOON.radius * zoom > 0.5 || MOON.orbitRadius * zoom < Math.hypot(W, H)) drawBody(MOON, m.x, m.y, false);
    // launch pad marker
    if (zoom > 0.002) {
      const px = EARTH.radius * Math.cos(sim.padAngle), py = EARTH.radius * Math.sin(sim.padAngle);
      const X = sx(px, py), Y = sy(py, px);
      if (X > -200 && X < W + 200 && Y > -200 && Y < H + 200) {
        ctx.save(); ctx.translate(X, Y); ctx.rotate(-(sim.padAngle + cam.rot) + Math.PI / 2);
        const s = Math.max(1, Math.min(zoom * 1.0, 3));
        ctx.fillStyle = '#8a8f99'; ctx.fillRect(-18 * s, -3 * s, 36 * s, 4 * s);
        ctx.fillStyle = '#c0392b'; ctx.fillRect(12 * s, -60 * s, 5 * s, 60 * s);
        ctx.restore();
        if (zoom > 0.05) { ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('OZARK SPACEPORT', X, Y + 18); }
      }
    }
  } else {
    // Moon frame: Earth is at -m
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(200,200,220,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(sx(0, 0), sy(0, 0), MOON.soi * zoom, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    drawBody(MOON, 0, 0, true);
    drawBody(EARTH, -m.x, -m.y, false);
  }

  // trail
  if (ui.trail && ui.trail.length > 1) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    for (const p of ui.trail) {
      if (p.body !== sim.bodyName) { started = false; continue; }
      const X = sx(p.x, p.y), Y = sy(p.y, p.x);
      if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
    }
    ctx.stroke();
  }

  // orbit prediction
  const el = elements(sim);
  if (sim.status === 'flying' && (alt > 5000 || el.ra > b.radius + 5000)) {
    const pts = orbitPath(el, b.mu, { samples: 360, maxRadius: sim.bodyName === 'Moon' ? MOON.soi : MOON.orbitRadius * 3 });
    ctx.strokeStyle = el.e < 1 ? 'rgba(90,220,255,0.75)' : 'rgba(255,170,80,0.8)';
    ctx.lineWidth = 1.5; ctx.beginPath();
    let first = true;
    for (const [x, y] of pts) {
      if (Math.hypot(x, y) < b.radius * 0.98 && first) continue;
      const X = sx(x, y), Y = sy(y, x);
      if (first) { ctx.moveTo(X, Y); first = false; } else ctx.lineTo(X, Y);
    }
    ctx.stroke();
    // Ap / Pe markers
    const dir = el.direction;
    const mark = (r, nu, label, color) => {
      if (!isFinite(r)) return;
      const th = el.argPe + dir * nu;
      const wx = r * Math.cos(th), wy = r * Math.sin(th); const X = sx(wx, wy), Y = sy(wy, wx);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`${label} ${((r - b.radius) / 1000).toFixed(0)} km`, X + 7, Y + 4);
    };
    if (el.rp > b.radius) mark(el.rp, 0, 'Pe', '#9ff');
    mark(el.ra, Math.PI, 'Ap', '#fda');
    // lunar encounter preview
    if (sim.bodyName === 'Earth' && el.ra > MOON.orbitRadius * 0.5 && sim.throttle === 0) {
      const p = ui.approach || predictMoonApproach(sim);
      if (p.dist < MOON.soi * 1.5) {
        const mm = moonState(sim.t + p.t, sim.moonPhase0);
        ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(sx(mm.x, mm.y), sy(mm.y, mm.x), Math.max(MOON.radius * zoom, 6), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`Moon at encounter · ${(p.dist / 1000).toFixed(0)} km`, sx(mm.x, mm.y), sy(mm.y, mm.x) - 12);
      }
    }
  }

  // ship
  const shipX = sx(sim.ship.x, sim.ship.y), shipY = sy(sim.ship.y, sim.ship.x);
  const v = sim.vehicle;
  const L = vehicleLength(v) * zoom;
  ctx.save();
  ctx.translate(shipX, shipY);
  ctx.rotate(-(sim.heading + cam.rot) + Math.PI / 2); // nose up in local frame
  if (L >= 14) {
    const s = zoom;
    let yBottom = 0;
    for (let i = v.stageIndex; i < v.def.stages.length; i++) {
      const st = v.def.stages[i];
      const w = st.width * s, h = st.length * s;
      const yTop = yBottom - st.length;
      ctx.fillStyle = i === v.stageIndex ? '#e8e8ee' : '#cfd3dc';
      ctx.fillRect(-w / 2, yTop * s, w, h);
      ctx.strokeStyle = '#4a5060'; ctx.lineWidth = Math.max(1, s * 0.3); ctx.strokeRect(-w / 2, yTop * s, w, h);
      if (i === 0) { // fins
        ctx.fillStyle = '#3b4252'; ctx.beginPath(); ctx.moveTo(-w / 2, yBottom * s); ctx.lineTo(-w / 2 - 1.5 * s, yBottom * s); ctx.lineTo(-w / 2, (yBottom - 6) * s); ctx.fill();
        ctx.beginPath(); ctx.moveTo(w / 2, yBottom * s); ctx.lineTo(w / 2 + 1.5 * s, yBottom * s); ctx.lineTo(w / 2, (yBottom - 6) * s); ctx.fill();
      }
      if (i === v.def.stages.length - 1) { // nose
        ctx.fillStyle = '#d64545'; ctx.beginPath(); ctx.moveTo(-w / 2, yTop * s); ctx.lineTo(0, (yTop - 4) * s); ctx.lineTo(w / 2, yTop * s); ctx.fill();
      }
      yBottom = yTop;
    }
    // flame
    const st = stage(v);
    if (sim.throttle > 0 && st && v.prop[v.stageIndex] > 0) {
      const w = st.width * s;
      const flick = 0.8 + Math.random() * 0.4;
      const fl = (st.length * 0.9) * sim.throttle * s * flick;
      const g = ctx.createLinearGradient(0, 0, 0, fl);
      g.addColorStop(0, 'rgba(255,240,180,0.95)'); g.addColorStop(0.4, 'rgba(255,140,40,0.8)'); g.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-w * 0.45, 0); ctx.lineTo(0, fl); ctx.lineTo(w * 0.45, 0); ctx.fill();
    }
  } else {
    // icon
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 8); ctx.lineTo(0, 4); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
    if (sim.throttle > 0 && stage(v) && v.prop[v.stageIndex] > 0) { ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.moveTo(-3, 7); ctx.lineTo(0, 16 + Math.random() * 6); ctx.lineTo(3, 7); ctx.fill(); }
  }
  ctx.restore();

  // navball-ish heading indicator (bottom-centre)
  drawNavball(ctx, sim, W, H, ui);
}

function drawNavball(ctx, sim, W, H, ui) {
  const r = 34, cx = W / 2, cy = H - 92;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(10,14,28,0.8)'; ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  const u = radialDir(sim); const up = Math.atan2(u.y, u.x);
  const b = body(sim);
  const pro = progradeAngle(sim, altitude(sim) < (b.atmosphere ? b.atmosphere.top : 0));
  const put = (ang, color, size, label) => {
    // display relative so that "up" (radial out) is at top
    const rel = ang - up + Math.PI / 2;
    const X = cx + Math.cos(rel) * (r - 6), Y = cy - Math.sin(rel) * (r - 6);
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X, Y, size, 0, Math.PI * 2); ctx.fill();
    if (label) { ctx.font = '9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(label, X, Y - 6); }
  };
  // horizon line
  ctx.strokeStyle = 'rgba(120,200,255,0.5)'; ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
  put(pro, '#7fe0a0', 4, 'PRO');
  put(pro + Math.PI, '#ff8a80', 4, 'RET');
  // heading needle
  const rel = sim.heading - up + Math.PI / 2;
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(rel) * r, cy - Math.sin(rel) * r); ctx.stroke();
  ctx.restore();
}
