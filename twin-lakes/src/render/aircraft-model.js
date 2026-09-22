// A procedural Cessna 172S: lofted fuselage with real glass, NACA 2412 wings with dihedral and a tapered
// outer panel, moving ailerons, flaps, elevator and rudder, spring-steel gear with wheel pants, a spinning
// propeller, navigation lights and strobes, and a cockpit with a G1000-style panel for the inside view.
// Model frame: +x right wing, +y up, -z nose, origin at the centre of gravity (matches src/fdm).

import * as THREE from '../../vendor/three.module.js';

const WHITE = new THREE.Color(0.93, 0.93, 0.91);
const NAVY = new THREE.Color(0.06, 0.1, 0.24);
const RED = new THREE.Color(0.6, 0.06, 0.07);

// fuselage stations: z, half width, top y, bottom y
const STATIONS = [
  [-2.26, 0.26, 0.06, -0.30],
  [-2.12, 0.40, 0.16, -0.44],
  [-1.85, 0.49, 0.22, -0.56],
  [-1.50, 0.53, 0.27, -0.64],
  [-1.36, 0.54, 0.30, -0.67],
  [-1.10, 0.56, 0.56, -0.70],
  [-0.86, 0.57, 0.79, -0.72],
  [-0.40, 0.58, 0.83, -0.72],
  [0.20, 0.57, 0.83, -0.69],
  [0.70, 0.54, 0.80, -0.62],
  [1.20, 0.45, 0.66, -0.49],
  [1.80, 0.35, 0.50, -0.36],
  [2.60, 0.25, 0.38, -0.20],
  [3.50, 0.17, 0.31, -0.06],
  [4.30, 0.11, 0.27, 0.03],
  [4.95, 0.05, 0.24, 0.08],
];
const SEG = 28;

function superellipse(t, hw, top, bot, n = 2.6) {
  const c = Math.cos(t), s = Math.sin(t);
  const x = hw * Math.sign(c) * Math.abs(c) ** (2 / n);
  const cy = (top + bot) / 2, hh = (top - bot) / 2;
  const y = cy + hh * Math.sign(s) * Math.abs(s) ** (2 / n);
  return [x, y];
}

function isGlass(z, x, y, top, bot) {
  const up = (y - (top + bot) / 2) / ((top - bot) / 2);   // -1 bottom .. 1 top
  // windshield: the sloping top between cowling and roof
  if (z > -1.34 && z < -0.88 && up > 0.25) return true;
  // side windows, with a door post
  const post = (z > -0.2 && z < -0.12);
  if (z > -0.84 && z < 0.62 && !post && up > 0.18 && up < 0.86 && Math.abs(x) > 0.3) return true;
  // rear "omni-vision" window
  if (z > 0.78 && z < 1.35 && up > 0.45) return true;
  return false;
}

function stripe(z, y, top, bot) {
  const up = (y - (top + bot) / 2) / ((top - bot) / 2);
  if (z > -2.0 && up > -0.18 && up < -0.02) return NAVY;
  if (z > -2.0 && up > -0.28 && up < -0.2) return RED;
  return WHITE;
}

function buildFuselage() {
  const body = { pos: [], col: [], idx: [] };
  const glass = { pos: [], idx: [] };
  const ring = [];
  for (const [z, hw, top, bot] of STATIONS) {
    const r = [];
    for (let i = 0; i < SEG; i++) {
      const t = (i / SEG) * Math.PI * 2;
      const [x, y] = superellipse(t, hw, top, bot);
      r.push([x, y, z, top, bot]);
    }
    ring.push(r);
  }
  const push = (tgt, v, c) => {
    tgt.pos.push(v[0], v[1], v[2]);
    if (c) tgt.col.push(c.r, c.g, c.b);
    return tgt.pos.length / 3 - 1;
  };
  for (let s = 0; s < ring.length - 1; s++) {
    for (let i = 0; i < SEG; i++) {
      const a = ring[s][i], b = ring[s][(i + 1) % SEG], c = ring[s + 1][i], d = ring[s + 1][(i + 1) % SEG];
      const mz = (a[2] + c[2]) / 2, mx = (a[0] + b[0] + c[0] + d[0]) / 4, my = (a[1] + b[1] + c[1] + d[1]) / 4;
      const top = (a[3] + c[3]) / 2, bot = (a[4] + c[4]) / 2;
      if (isGlass(mz, mx, my, top, bot)) {
        const i0 = push(glass, a), i1 = push(glass, b), i2 = push(glass, c), i3 = push(glass, d);
        glass.idx.push(i0, i2, i1, i1, i2, i3);
      } else {
        const col = stripe(mz, my, top, bot);
        const i0 = push(body, a, col), i1 = push(body, b, col), i2 = push(body, c, col), i3 = push(body, d, col);
        body.idx.push(i0, i2, i1, i1, i2, i3);
      }
    }
  }
  // close the tail and the cowling face
  for (const [s, dir] of [[0, 1], [ring.length - 1, -1]]) {
    const cz = ring[s][0][2];
    const cy = (ring[s][0][3] + ring[s][0][4]) / 2;
    const ci = push(body, [0, cy, cz], WHITE);
    for (let i = 0; i < SEG; i++) {
      const a = push(body, ring[s][i], WHITE), b = push(body, ring[s][(i + 1) % SEG], WHITE);
      if (dir > 0) body.idx.push(ci, b, a); else body.idx.push(ci, a, b);
    }
  }
  const mk = (t, withCol) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    if (withCol) g.setAttribute('color', new THREE.Float32BufferAttribute(t.col, 3));
    g.setIndex(t.idx);
    g.computeVertexNormals();
    return g;
  };
  return { body: mk(body, true), glass: mk(glass, false) };
}

/** NACA 4-digit section (upper and lower surfaces) with n points each, chord 1, leading edge at 0. */
function naca(n = 18, m = 0.02, p = 0.4, t = 0.12) {
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = x < p ? m / (p * p) * (2 * p * x - x * x) : m / ((1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x);
    up.push([x, yc + yt]);
    lo.push([x, yc - yt]);
  }
  return { up, lo };
}

/**
 * Extrude an airfoil between two spanwise stations. Each station: {x, y, zLE, chord}. Chord runs toward +z
 * (the trailing edge). xFrom/xTo of the chord fraction lets control surfaces be cut out.
 */
function wingPanel(s0, s1, c0 = 0, c1 = 1, n = 16) {
  const af = naca(n);
  const pts = [...af.up.slice().reverse(), ...af.lo.slice(1)].filter(([x]) => x >= c0 - 1e-6 && x <= c1 + 1e-6);
  const pos = [], idx = [];
  const row = (s) => pts.map(([x, y]) => [s.x, s.y + y * s.chord, s.zLE + x * s.chord]);
  const r0 = row(s0), r1 = row(s1);
  for (const r of [r0, r1]) for (const v of r) pos.push(...v);
  const n0 = pts.length;
  for (let i = 0; i < n0 - 1; i++) {
    idx.push(i, i + 1, n0 + i, i + 1, n0 + i + 1, n0 + i);
  }
  // end caps
  for (const [base, flip] of [[0, false], [n0, true]]) {
    for (let i = 1; i < n0 - 1; i++) flip ? idx.push(base, base + i + 1, base + i) : idx.push(base, base + i, base + i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function flatSurface(span, chord, thick, sweep = 0) {
  // a symmetric thin surface in the x-z plane (for the tail), leading edge at z = 0
  const g = new THREE.BoxGeometry(span, thick, chord, 1, 1, 1);
  g.translate(0, 0, chord / 2);
  if (sweep) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + Math.abs(p.getX(i)) * sweep);
  }
  g.computeVertexNormals();
  return g;
}

function textTexture(text, w = 512, h = 128, color = '#1a2340') {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  g.font = `700 ${h * 0.78}px "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class AircraftModel {
  /** @param {HTMLCanvasElement} panelCanvas the G1000 canvas shown on the instrument panel */
  constructor(panelCanvas) {
    const root = new THREE.Group();
    this.root = root;
    const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.05 });
    const white = new THREE.MeshStandardMaterial({ color: WHITE, roughness: 0.4, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.8 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x223038, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
    });
    this.materials = { paint, white, dark, metal, glassMat };

    const fus = buildFuselage();
    const body = new THREE.Mesh(fus.body, paint);
    body.material.side = THREE.DoubleSide;
    const glass = new THREE.Mesh(fus.glass, glassMat);
    glass.renderOrder = 20;
    root.add(body, glass);
    this.body = body; this.glass = glass;

    // ---- wings: constant-chord inner panel to 2.5 m, tapered outer panel to the tip, 1.7° dihedral
    const dih = Math.tan(1.73 * Math.PI / 180);
    const wingY = 0.84;
    const st = (x, chord, zLE) => ({ x, y: wingY + Math.abs(x) * dih, zLE, chord });
    const wingParts = [];
    for (const side of [-1, 1]) {
      const root_ = st(side * 0.55, 1.63, -0.95), mid = st(side * 2.55, 1.63, -0.95), tip = st(side * 5.45, 1.13, -0.83);
      const a = (s0, s1, c0, c1) => { const m = new THREE.Mesh(wingPanel(side < 0 ? s1 : s0, side < 0 ? s0 : s1, c0, c1), white); root.add(m); return m; };
      wingParts.push(a(root_, mid, 0, 0.72));             // inner panel ahead of the flap
      wingParts.push(a(mid, st(side * 3.3, 1.54, -0.93), 0, 1));
      wingParts.push(a(st(side * 3.3, 1.54, -0.93), tip, 0, 0.76)); // outer panel ahead of the aileron
      // flap: inner trailing 28 % of chord, hinged at its leading edge
      const flapPivot = new THREE.Group();
      flapPivot.position.set(0, wingY + 1.5 * dih * side * side, -0.95 + 1.63 * 0.72);
      const flap = new THREE.Mesh(wingPanel(
        { x: side < 0 ? side * 2.55 : side * 0.6, y: 0, zLE: 0, chord: 1.63 },
        { x: side < 0 ? side * 0.6 : side * 2.55, y: 0, zLE: 0, chord: 1.63 }, 0.72, 1), white);
      flap.position.set(0, 0, -1.63 * 0.72);
      flapPivot.add(flap);
      root.add(flapPivot);
      // aileron: outer trailing 24 %
      const ailPivot = new THREE.Group();
      ailPivot.position.set(0, wingY + 4.4 * dih, -0.88 + 1.33 * 0.76);
      const ail = new THREE.Mesh(wingPanel(
        { x: side < 0 ? side * 5.4 : side * 3.3, y: 0, zLE: 0, chord: side < 0 ? 1.16 : 1.54 },
        { x: side < 0 ? side * 3.3 : side * 5.4, y: 0, zLE: 0, chord: side < 0 ? 1.54 : 1.16 }, 0.76, 1), white);
      ail.position.set(0, 0, -1.33 * 0.76);
      ailPivot.add(ail);
      root.add(ailPivot);
      if (side < 0) { this.flapL = flapPivot; this.ailL = ailPivot; } else { this.flapR = flapPivot; this.ailR = ailPivot; }
      // strut: from the lower fuselage to the wing
      const a0 = new THREE.Vector3(side * 0.5, -0.5, -0.35), a1 = new THREE.Vector3(side * 2.6, wingY + 2.6 * dih - 0.05, -0.55);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, a0.distanceTo(a1), 8), white);
      strut.position.copy(a0).add(a1).multiplyScalar(0.5);
      strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a1.clone().sub(a0).normalize());
      strut.scale.set(1.8, 1, 0.7);
      root.add(strut);
      // navigation light
      const nav = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: side < 0 ? 0xff2020 : 0x20ff40 }));
      nav.position.set(side * 5.47, wingY + 5.45 * dih, -0.8);
      root.add(nav);
      if (side < 0) this.navL = nav; else this.navR = nav;
    }

    // ---- empennage
    const hstab = new THREE.Mesh(flatSurface(3.45, 0.72, 0.07, 0.12), white);
    hstab.position.set(0, 0.26, 4.05);
    root.add(hstab);
    this.elevPivot = new THREE.Group();
    this.elevPivot.position.set(0, 0.26, 4.05 + 0.72 + 0.2);
    const elev = new THREE.Mesh(flatSurface(3.3, 0.42, 0.05, 0.02), white);
    this.elevPivot.add(elev);
    root.add(this.elevPivot);
    // fin: a swept trapezoid
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0); finShape.lineTo(1.35, 0); finShape.lineTo(1.35, 0.25); finShape.lineTo(0.95, 1.45); finShape.lineTo(0.55, 1.45); finShape.lineTo(-0.9, 0.05);
    const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: 0.07, bevelEnabled: false }), paint);
    fin.geometry.translate(0, 0, -0.035);
    fin.geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Array(fin.geometry.attributes.position.count).fill(0).flatMap(() => [WHITE.r, WHITE.g, WHITE.b]), 3));
    fin.rotation.y = -Math.PI / 2;
    fin.position.set(0, 0.25, 3.35);
    root.add(fin);
    this.rudderPivot = new THREE.Group();
    this.rudderPivot.position.set(0, 0.25, 4.72);
    const rudShape = new THREE.Shape();
    rudShape.moveTo(0, -0.1); rudShape.lineTo(0.45, -0.05); rudShape.lineTo(0.5, 1.2); rudShape.lineTo(0.12, 1.55); rudShape.lineTo(0, 1.5);
    const rud = new THREE.Mesh(new THREE.ExtrudeGeometry(rudShape, { depth: 0.05, bevelEnabled: false }), white);
    rud.geometry.translate(0, 0, -0.025);
    rud.rotation.y = -Math.PI / 2;
    this.rudderPivot.add(rud);
    root.add(this.rudderPivot);
    // registration on the fin (fictitious)
    for (const side of [-1, 1]) {
      const reg = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.3), new THREE.MeshBasicMaterial({ map: textTexture('N172TL'), transparent: true, depthWrite: false }));
      reg.position.set(side * 0.04, 0.72, 3.95);
      reg.rotation.y = side * Math.PI / 2;
      root.add(reg);
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    beacon.position.set(0, 1.72, 4.25);
    root.add(beacon);
    this.beacon = beacon;
    const tailLight = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    tailLight.position.set(0, 0.35, 5.25);
    root.add(tailLight);

    // ---- landing gear: spring-steel mains, wheel pants, nose strut
    const wheelGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.13, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const pantGeo = new THREE.SphereGeometry(1, 16, 10);
    pantGeo.scale(0.12, 0.2, 0.46);
    this.wheels = [];
    const addWheel = (x, z) => {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.position.set(x, -0.93, z);
      root.add(w);
      const p = new THREE.Mesh(pantGeo, white);
      p.position.set(x, -0.9, z + 0.05);
      root.add(p);
      this.wheels.push(w);
    };
    addWheel(-1.27, 0.55); addWheel(1.27, 0.55); addWheel(0, -1.1);
    for (const side of [-1, 1]) {
      const a0 = new THREE.Vector3(side * 0.35, -0.62, 0.45), a1 = new THREE.Vector3(side * 1.22, -0.93, 0.55);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, a0.distanceTo(a1), 0.035), metal);
      leg.position.copy(a0).add(a1).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a1.clone().sub(a0).normalize());
      root.add(leg);
    }
    const nstrut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 8), metal);
    nstrut.position.set(0, -0.68, -1.12);
    root.add(nstrut);

    // ---- propeller
    this.prop = new THREE.Group();
    this.prop.position.set(0, -0.12, -2.3);
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 20), white);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -0.12;
    root.add(this.prop);
    this.prop.add(spinner);
    this.blades = new THREE.Group();
    for (const s of [-1, 1]) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.93, 0.025), dark);
      bl.geometry.translate(0, 0.5, 0);
      bl.rotation.z = s > 0 ? 0 : Math.PI;
      bl.rotation.y = 0.35 * s;
      this.blades.add(bl);
    }
    this.prop.add(this.blades);
    const discMat = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(0.96, 40), discMat);
    this.disc.renderOrder = 21;
    this.prop.add(this.disc);

    // ---- strobes (wingtips) as sprites
    this.strobes = [];
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    for (const [pos, col] of [[this.navL.position, 0xffffff], [this.navR.position, 0xffffff], [beacon.position, 0xff3322],
      [this.navL.position, 0xff2222], [this.navR.position, 0x22ff44]]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.position.copy(pos);
      sp.scale.setScalar(0.9);
      root.add(sp);
      this.strobes.push(sp);
    }

    // ---- cockpit
    this.cockpit = new THREE.Group();
    const panelTex = new THREE.CanvasTexture(panelCanvas);
    panelTex.colorSpace = THREE.SRGBColorSpace;
    panelTex.anisotropy = 4;
    this.panelTex = panelTex;
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.8 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.36, 0.08), panelMat);
    panel.position.set(0, 0.14, -1.08);
    panel.rotation.x = -0.12;
    this.cockpit.add(panel);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.3), new THREE.MeshBasicMaterial({ map: panelTex, toneMapped: false }));
    screen.position.set(-0.07, 0.15, -1.035);
    screen.rotation.x = -0.12;
    this.cockpit.add(screen);
    this.screen = screen;
    const glare = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.03, 0.3), dark);
    glare.position.set(0, 0.33, -1.1);
    this.cockpit.add(glare);
    // yokes
    this.yokes = [];
    for (const x of [-0.3, 0.3]) {
      const y = new THREE.Group();
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.12, 8), metal);
      col.rotation.x = Math.PI / 2; col.position.z = 0.06;
      const hw = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.017, 8, 20, Math.PI * 0.9), dark);
      hw.rotation.z = Math.PI * 1.05; hw.position.z = 0.12;
      y.add(col, hw);
      y.position.set(x, 0.0, -1.02);
      this.cockpit.add(y);
      this.yokes.push(y);
    }
    // seats and floor
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.9 });
    for (const x of [-0.28, 0.28]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.12, 0.5), seatMat); s.position.set(x, -0.32, -0.1);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.6, 0.1), seatMat); b.position.set(x, 0.0, 0.2);
      this.cockpit.add(s, b);
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.02, 2.0), dark);
    floor.position.set(0, -0.62, -0.3);
    this.cockpit.add(floor);
    root.add(this.cockpit);
    this.eye = new THREE.Vector3(-0.28, 0.44, -0.3);

    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    this.glass.castShadow = false;
    this.disc.castShadow = false;
    this._propAngle = 0;
  }

  /** Animate from the flight model state. */
  update(dt, a, c, time, inside, night = 0) {
    const deg = Math.PI / 180;
    const pitchIn = c.pitch ?? 0, rollIn = c.roll ?? 0, yawIn = c.yaw ?? 0;
    this.ailL.rotation.x = rollIn * 18 * deg;
    this.ailR.rotation.x = -rollIn * 14 * deg;
    this.flapL.rotation.x = this.flapR.rotation.x = a.flapDeg * deg;
    this.elevPivot.rotation.x = -pitchIn * 22 * deg;
    this.rudderPivot.rotation.y = -yawIn * 16 * deg;
    const rps = (a.out.rpm || 0) / 60;
    this._propAngle = (this._propAngle + rps * 2 * Math.PI * dt) % (2 * Math.PI);
    this.blades.rotation.z = rps > 18 ? this._propAngle * 0.07 : this._propAngle;
    const blur = THREE.MathUtils.smoothstep(rps, 6, 22);
    this.disc.material.opacity = inside ? 0 : blur * 0.3;
    this.blades.visible = blur < 0.97 || !inside;
    for (const b of this.blades.children) b.material.opacity = 1;
    // yokes: pull and turn
    for (const y of this.yokes) { y.position.z = -1.02 + pitchIn * 0.06; y.children[1].rotation.z = Math.PI * 1.05 - rollIn * 0.6; }
    // strobes: double flash every 1.2 s, beacon rotating
    const t = time % 1.2;
    const on = (t < 0.05 || (t > 0.12 && t < 0.17)) ? 1 : 0;
    this.strobes[0].material.opacity = this.strobes[1].material.opacity = on;
    this.strobes[0].scale.setScalar(on ? 2.2 : 0.01); this.strobes[1].scale.setScalar(on ? 2.2 : 0.01);
    const bea = Math.max(0, Math.sin(time * 5)) ** 6;
    this.strobes[2].material.opacity = bea; this.strobes[2].scale.setScalar((0.6 + bea) * (0.4 + 0.6 * night));
    const navGlow = 0.15 + 0.85 * night;
    for (const k of [3, 4]) { this.strobes[k].material.opacity = navGlow; this.strobes[k].scale.setScalar(0.35 + 0.8 * night); }
    if (!night) { this.strobes[0].scale.multiplyScalar(0.6); this.strobes[1].scale.multiplyScalar(0.6); }
    this.cockpit.visible = inside;
    this.panelTex.needsUpdate = true;
  }
}
