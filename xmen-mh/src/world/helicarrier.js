// S.H.I.E.L.D.-style flying carrier: grey panelled hull, flat runway deck with
// painted markings, four huge ducted rotor rings, a lit superstructure tower,
// and deck-edge railings with an open bow jump zone.
//
// Everything is procedural (canvas textures + primitive geometry) and merged
// into a small number of InstancedMesh/Mesh objects to keep draw calls low.
import * as THREE from '../../vendor/three.module.js';

const LENGTH = 250; // bow-to-stern, along local Z (bow at -Z)
const WIDTH = 58; // port-to-starboard, along local X
const HULL_H = 20;
const DECK_Y = 600;
const BOW_GAP = 34; // width of the open jump-off gap in the bow railing
const YAXIS = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Pure layout math (no THREE/DOM) — kept separate so it can be unit tested.
// ---------------------------------------------------------------------------
export function computeDeckLayout(opts = {}) {
  const length = opts.length ?? LENGTH;
  const width = opts.width ?? WIDTH;
  const deckY = opts.deckY ?? DECK_Y;
  const gap = opts.gap ?? BOW_GAP;
  const halfL = length / 2;
  const halfW = width / 2;
  return {
    deckY,
    deckBounds: { minX: -halfW, maxX: halfW, minZ: -halfL, maxZ: halfL },
    jumpPoint: { x: 0, y: deckY, z: -halfL },
    gapHalfWidth: gap / 2,
  };
}

// ---------------------------------------------------------------------------
// Canvas texture helpers (only ever called at runtime, inside createHelicarrier)
// ---------------------------------------------------------------------------
function makeCanvas(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hullTexture() {
  const tex = makeCanvas(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#4c525a';
    ctx.fillRect(0, 0, w, h);
    const cell = 64;
    ctx.strokeStyle = 'rgba(15,17,20,0.55)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= w; x += cell) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += cell) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.fillStyle = 'rgba(8,9,11,0.5)';
    for (let x = 0; x < w; x += cell) for (let y = 0; y < h; y += cell) {
      ctx.beginPath(); ctx.arc(x + 5, y + 5, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + cell - 5, y + cell - 5, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0.06)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 3);
  return tex;
}

function deckTexture(length, width, gapHalfWidth) {
  const w = 1024;
  const h = 2048;
  const sx = w / width;
  const sz = h / length;
  return makeCanvas(w, h, (ctx) => {
    ctx.fillStyle = '#3a3e40';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    const cx = w / 2;
    // centerline (dashed), stops short of the bow chevron zone
    ctx.fillStyle = '#e8c93a';
    for (let y = 260; y < h - 60; y += 70) ctx.fillRect(cx - 6, y, 12, 40);
    // runway edge hazard stripes, both sides, skipping the bow zone
    for (const x of [26, w - 26 - 22]) {
      for (let y = 260; y < h - 40; y += 46) ctx.fillRect(x, y, 22, 24);
    }
    // ID roundel
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, h * 0.58, 140, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = 'bold 150px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('07', cx, h * 0.58 + 8);
    // four landing-pad rings roughly over the rotor pylons
    ctx.strokeStyle = 'rgba(232,201,58,0.55)';
    ctx.lineWidth = 5;
    const padZ = length * 0.27 * sz;
    const padX = (width / 2 - 9) * sx;
    for (const dz of [-padZ, padZ]) for (const dx of [-padX, padX]) {
      ctx.beginPath(); ctx.arc(cx + dx, h / 2 + dz, 60, 0, Math.PI * 2); ctx.stroke();
    }
    // bow chevrons pointing off the open jump zone (top of the texture = bow)
    ctx.fillStyle = '#f2c11f';
    const gapPx = gapHalfWidth * sx;
    for (let i = 0; i < 5; i++) {
      const yy = 14 + i * 32;
      const spread = gapPx * 0.9;
      ctx.beginPath();
      ctx.moveTo(cx - spread, yy);
      ctx.lineTo(cx, yy + 34);
      ctx.lineTo(cx + spread, yy);
      ctx.lineTo(cx + spread - 16, yy + 2);
      ctx.lineTo(cx, yy + 26);
      ctx.lineTo(cx - spread + 16, yy + 2);
      ctx.closePath();
      ctx.fill();
    }
    // diagonal hazard border around the gap edge
    ctx.fillStyle = '#171818';
    ctx.fillRect(cx - gapPx - 30, 0, 30, 8);
    ctx.fillRect(cx + gapPx, 0, 30, 8);
  });
}

function windowTexture() {
  return makeCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, w, h);
    const cols = 8, rows = 8;
    const cw = w / cols, ch = h / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const lit = Math.random() < 0.4;
      ctx.fillStyle = lit ? (Math.random() < 0.5 ? '#ffe9a8' : '#bfe4ff') : '#12151a';
      const pad = 4;
      ctx.fillRect(c * cw + pad, r * ch + pad, cw - pad * 2, ch - pad * 2);
    }
  });
}

function dotTexture(color) {
  return makeCanvas(32, 32, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

// ---------------------------------------------------------------------------
export function createHelicarrier(scene) {
  const layout = computeDeckLayout({ length: LENGTH, width: WIDTH, deckY: DECK_Y, gap: BOW_GAP });
  const group = new THREE.Group();
  group.name = 'helicarrier';
  group.position.set(0, layout.deckY, 0);

  const hullMat = new THREE.MeshStandardMaterial({ map: hullTexture(), color: 0xffffff, roughness: 0.75, metalness: 0.4 });

  // Hull
  const hull = new THREE.Mesh(new THREE.BoxGeometry(WIDTH, HULL_H, LENGTH), hullMat);
  hull.position.set(0, -HULL_H / 2, 0);
  group.add(hull);

  // Deck
  const deckGeo = new THREE.PlaneGeometry(WIDTH, LENGTH).rotateX(-Math.PI / 2);
  const deckMat = new THREE.MeshStandardMaterial({ map: deckTexture(LENGTH, WIDTH, layout.gapHalfWidth), roughness: 0.95, metalness: 0.05 });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.y = 0.05;
  group.add(deck);

  // Superstructure tower (stern, offset from centerline is unnecessary — keep it central)
  const towerW = 26, towerD = 20, towerH = 42;
  const towerZ = LENGTH / 2 - 34;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(towerW, towerH, towerD), hullMat);
  tower.position.set(0, towerH / 2, towerZ);
  group.add(tower);

  const winMat = new THREE.MeshBasicMaterial({ map: windowTexture() });
  const winGeo = new THREE.PlaneGeometry(towerW * 0.82, towerH * 0.6);
  const winFront = new THREE.Mesh(winGeo, winMat);
  winFront.position.set(0, towerH * 0.55, towerZ - towerD / 2 - 0.15);
  group.add(winFront);
  const winBack = new THREE.Mesh(winGeo, winMat);
  winBack.position.set(0, towerH * 0.55, towerZ + towerD / 2 + 0.15);
  winBack.rotation.y = Math.PI;
  group.add(winBack);

  // Mast + blinking beacon
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 10, 8), hullMat);
  mast.position.set(0, towerH + 5, towerZ);
  group.add(mast);
  const beaconMat = new THREE.SpriteMaterial({ map: dotTexture('rgba(255,60,50,1)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const beacon = new THREE.Sprite(beaconMat);
  beacon.scale.set(3, 3, 3);
  beacon.position.set(0, towerH + 10.2, towerZ);
  group.add(beacon);

  // Rotor pods (pylon + duct ring + spinning blades), instanced across 4 corners
  const rotorR = 15;
  const podOffsetX = WIDTH / 2 - 9;
  const podOffsetZ = LENGTH * 0.27;
  const rotorCenters = [
    new THREE.Vector3(podOffsetX, -HULL_H * 0.55, -podOffsetZ),
    new THREE.Vector3(podOffsetX, -HULL_H * 0.55, podOffsetZ),
    new THREE.Vector3(-podOffsetX, -HULL_H * 0.55, -podOffsetZ),
    new THREE.Vector3(-podOffsetX, -HULL_H * 0.55, podOffsetZ),
  ];

  const pylonMat = new THREE.MeshStandardMaterial({ color: 0x53585f, roughness: 0.7, metalness: 0.5 });
  const pylons = new THREE.InstancedMesh(new THREE.CylinderGeometry(2.4, 3.2, HULL_H * 0.7, 8), pylonMat, 4);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.5, metalness: 0.6, emissive: 0x2255aa, emissiveIntensity: 0.6 });
  const rings = new THREE.InstancedMesh(new THREE.TorusGeometry(rotorR, 1.3, 8, 24), ringMat, 4);
  const bladeGeo = new THREE.BoxGeometry(rotorR * 0.92, 0.16, 1.6).translate(rotorR * 0.46, 0, 0);
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.4, metalness: 0.6 });
  const blades = new THREE.InstancedMesh(bladeGeo, bladeMat, 16);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const ringQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  rotorCenters.forEach((c, i) => {
    m4.compose(c, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    pylons.setMatrixAt(i, m4);
    m4.compose(c, ringQ, new THREE.Vector3(1, 1, 1));
    rings.setMatrixAt(i, m4);
  });
  pylons.instanceMatrix.needsUpdate = true;
  rings.instanceMatrix.needsUpdate = true;
  group.add(pylons, rings, blades);

  // Deck-edge railings, skipping the bow gap
  const halfL = LENGTH / 2, halfW = WIDTH / 2, gapHalf = layout.gapHalfWidth;
  const segments = [
    [[-halfW, halfL], [halfW, halfL]], // stern
    [[halfW, halfL], [halfW, -halfL]], // starboard
    [[-halfW, halfL], [-halfW, -halfL]], // port
    [[halfW, -halfL], [gapHalf, -halfL]], // bow return, starboard side
    [[-halfW, -halfL], [-gapHalf, -halfL]], // bow return, port side
  ];
  const postSpacing = 4;
  let postCount = 0;
  const postPositions = [];
  for (const [[x0, z0], [x1, z1]] of segments) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.round(len / postSpacing));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      postPositions.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
      postCount++;
    }
  }
  const railMat = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.5, metalness: 0.3 });
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.07, 1.2, 6), railMat, postCount);
  postPositions.forEach(([x, z], i) => {
    m4.compose(new THREE.Vector3(x, 0.6, z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    posts.setMatrixAt(i, m4);
  });
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);

  for (const [[x0, z0], [x1, z1]] of segments) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, 0.1), railMat);
    rail.position.set((x0 + x1) / 2, 1.15, (z0 + z1) / 2);
    // BoxGeometry's length axis is local X; align it along the segment direction.
    rail.rotation.y = -Math.atan2(dz, dx);
    group.add(rail);
  }

  scene.add(group);

  let spin = 0;
  const scratchScale = new THREE.Vector3(1, 1, 1);
  return {
    group,
    deckY: layout.deckY,
    deckBounds: layout.deckBounds,
    jumpPoint: layout.jumpPoint,
    update(dt) {
      spin += dt * 10;
      for (let r = 0; r < rotorCenters.length; r++) {
        const c = rotorCenters[r];
        for (let b = 0; b < 4; b++) {
          q.setFromAxisAngle(YAXIS, spin + (r % 2 === 0 ? 1 : -1) * (b * Math.PI / 2));
          m4.compose(c, q, scratchScale);
          blades.setMatrixAt(r * 4 + b, m4);
        }
      }
      blades.instanceMatrix.needsUpdate = true;
      beaconMat.opacity = 0.5 + 0.5 * Math.sin(spin * 0.3);
    },
  };
}

const YAXIS = new THREE.Vector3(0, 1, 0);
