// Keyboard, gamepad and touch input, turned into smooth control positions.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const KEYS = [
  ['W / S or ↑ / ↓', 'Pitch (S / ↓ pulls the nose up)'],
  ['A / D or ← / →', 'Roll'],
  ['Q / E', 'Rudder (and nosewheel steering)'],
  ['R / F', 'Throttle up / down'],
  ['[ / ]', 'Flaps up / down one notch'],
  ['< / >  (, .)', 'Elevator trim down / up'],
  ['B', 'Brakes (hold)   Shift+B parking brake'],
  ['Z', 'Autopilot on / off (holds heading and altitude)'],
  ['C', 'Change camera   V: cockpit'],
  ['Mouse drag / wheel', 'Look around / zoom'],
  ['M', 'Map range'],
  ['P', 'Pause'],
  ['Esc', 'Menu'],
];

export class Input {
  constructor(el) {
    this.keys = new Set();
    this.pressed = new Set();
    this.state = { pitch: 0, roll: 0, yaw: 0 };
    this.touch = { stick: null, throttle: null };
    this.onKey = null;
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab'].includes(e.key)) e.preventDefault();
      if (this.onKey) this.onKey(k, e);
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
      if (k === 'Shift') this.keys.forEach((x) => { if (x.length === 1) this.keys.delete(x); });
    });
    window.addEventListener('blur', () => this.keys.clear());
    this.el = el;
  }

  _axis(neg, pos) {
    let v = 0;
    for (const k of neg) if (this.keys.has(k)) v -= 1;
    for (const k of pos) if (this.keys.has(k)) v += 1;
    return clamp(v, -1, 1);
  }

  _gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : v);
      return {
        roll: dz(p.axes[0] || 0), pitch: dz(p.axes[1] || 0), yaw: dz(p.axes[2] || 0), thr: -dz(p.axes[3] || 0),
        brake: p.buttons[0]?.pressed ? 1 : 0,
        flapsDown: p.buttons[5]?.pressed, flapsUp: p.buttons[4]?.pressed,
        ap: p.buttons[2]?.pressed, cam: p.buttons[3]?.pressed,
        rt: p.buttons[7]?.value || 0, lt: p.buttons[6]?.value || 0,
      };
    }
    return null;
  }

  /** Read the frame's input. */
  read(dt) {
    const s = this.state;
    const kPitch = this._axis(['w', 'ArrowUp'], ['s', 'ArrowDown']);
    const kRoll = this._axis(['a', 'ArrowLeft'], ['d', 'ArrowRight']);
    const kYaw = this._axis(['q'], ['e']);
    // keyboard deflections ramp in and spring back, so a tap is a small input and a hold a large one
    const ramp = (cur, target, up, down) => {
      if (target !== 0) return clamp(cur + Math.sign(target - cur) * Math.min(Math.abs(target - cur), up * dt), -1, 1);
      return cur - Math.sign(cur) * Math.min(Math.abs(cur), down * dt);
    };
    s.pitch = ramp(s.pitch, kPitch * 0.75, 1.6, 3.0);
    s.roll = ramp(s.roll, kRoll * 0.8, 2.2, 4.0);
    s.yaw = ramp(s.yaw, kYaw, 2.5, 4.0);
    let pitch = s.pitch, roll = s.roll, yaw = s.yaw;
    let throttleDelta = (this.keys.has('r') || this.keys.has('=') || this.keys.has('+') ? 0.5 : 0)
      - (this.keys.has('f') || this.keys.has('-') ? 0.5 : 0);
    let throttleSet = null;
    let brake = this.keys.has('b') && !this.keys.has('Shift') ? 1 : 0;
    let flapsDelta = 0;
    if (this.pressed.has(']')) flapsDelta += 1;
    if (this.pressed.has('[')) flapsDelta -= 1;
    const trimDelta = (this.keys.has('.') || this.keys.has('>') || this.keys.has('End') ? 0.35 : 0)
      - (this.keys.has(',') || this.keys.has('<') || this.keys.has('Home') ? 0.35 : 0);
    const parkingToggle = this.pressed.has('b') && this.keys.has('Shift');
    const active = { pitch: kPitch !== 0, roll: kRoll !== 0, yaw: kYaw !== 0 };

    const gp = this._gamepad();
    if (gp) {
      if (gp.pitch || gp.roll) { pitch = gp.pitch; roll = gp.roll; active.pitch = active.pitch || !!gp.pitch; active.roll = active.roll || !!gp.roll; }
      if (gp.yaw) { yaw = gp.yaw; active.yaw = true; }
      throttleDelta += gp.thr * 0.6 + (gp.rt - gp.lt) * 0.6;
      brake = Math.max(brake, gp.brake);
      if (gp.flapsDown && !this._gpFD) flapsDelta += 1;
      if (gp.flapsUp && !this._gpFU) flapsDelta -= 1;
      this._gpFD = gp.flapsDown; this._gpFU = gp.flapsUp;
      if (gp.ap && !this._gpAP && this.onKey) this.onKey('z', {});
      if (gp.cam && !this._gpCam && this.onKey) this.onKey('c', {});
      this._gpAP = gp.ap; this._gpCam = gp.cam;
    }
    const t = this.touch;
    if (t.stick) {
      pitch = t.stick.y; roll = t.stick.x;
      active.pitch = Math.abs(t.stick.y) > 0.05; active.roll = Math.abs(t.stick.x) > 0.05;
    }
    if (t.throttleDirty) { throttleSet = t.throttle; t.throttleDirty = false; }
    if (t.brake) brake = 1;
    if (t.flaps) { flapsDelta += t.flaps; t.flaps = 0; }
    this.pressed.clear();
    return { pitch, roll, yaw, throttleDelta, throttleSet, flapsDelta, brake, trimDelta, parkingToggle, active };
  }

  /** Build on-screen touch controls (shown on touch devices). */
  mountTouch(parent) {
    const stick = document.createElement('div');
    stick.className = 'touch-stick';
    stick.innerHTML = '<div class="knob"></div>';
    const thr = document.createElement('div');
    thr.className = 'touch-throttle';
    thr.innerHTML = '<div class="fill"></div><span>THR</span>';
    const btns = document.createElement('div');
    btns.className = 'touch-buttons';
    btns.innerHTML = '<button data-a="fu">FLAP ↑</button><button data-a="fd">FLAP ↓</button><button data-a="br">BRAKE</button>';
    parent.append(stick, thr, btns);
    const knob = stick.querySelector('.knob');
    const setStick = (e) => {
      const r = stick.getBoundingClientRect();
      const x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      const y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
      this.touch.stick = { x, y };
      knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`;
    };
    stick.addEventListener('pointerdown', (e) => { stick.setPointerCapture(e.pointerId); setStick(e); });
    stick.addEventListener('pointermove', (e) => { if (this.touch.stick) setStick(e); });
    const endStick = () => { this.touch.stick = null; knob.style.transform = ''; };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);
    const fill = thr.querySelector('.fill');
    const setThr = (e) => {
      const r = thr.getBoundingClientRect();
      const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      this.touch.throttle = v;
      this.touch.throttleDirty = true;
      fill.style.height = `${v * 100}%`;
    };
    thr.addEventListener('pointerdown', (e) => { thr.setPointerCapture(e.pointerId); setThr(e); });
    thr.addEventListener('pointermove', (e) => { if (e.buttons) setThr(e); });
    btns.addEventListener('pointerdown', (e) => {
      const a = e.target.dataset?.a;
      if (a === 'fu') this.touch.flaps = -1;
      if (a === 'fd') this.touch.flaps = 1;
      if (a === 'br') this.touch.brake = true;
    });
    btns.addEventListener('pointerup', () => { this.touch.brake = false; });
    this.touchThrottleFill = fill;
  }
}
