// All sound is synthesised with Web Audio: the Lycoming's firing pulses and exhaust, propeller, wind that
// rises with airspeed, the reed stall horn, tyre rumble and chirp, the flap motor and the crash.

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.7;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.volume;
    this.master = master;
    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'lowpass';
    this.cabin.frequency.value = 4000;
    this.cabin.connect(master);
    master.connect(ctx.destination);

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.5 + b * 2; }
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s; };
    this._noise = noise;

    // engine: firing pulses (sawtooth) through a soft clipper and a low-pass that opens with rpm
    this.fire = ctx.createOscillator(); this.fire.type = 'sawtooth';
    this.sub = ctx.createOscillator(); this.sub.type = 'triangle';
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 3); }
    shaper.curve = curve;
    this.engLP = ctx.createBiquadFilter(); this.engLP.type = 'lowpass'; this.engLP.Q.value = 2;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.subGain = ctx.createGain(); this.subGain.gain.value = 0;
    this.fire.connect(shaper); shaper.connect(this.engLP); this.engLP.connect(this.engGain); this.engGain.connect(this.cabin);
    this.sub.connect(this.subGain); this.subGain.connect(this.cabin);
    // exhaust roar: noise amplitude-modulated at the firing frequency
    this.exh = noise();
    this.exhBP = ctx.createBiquadFilter(); this.exhBP.type = 'bandpass'; this.exhBP.Q.value = 0.8;
    this.exhGain = ctx.createGain(); this.exhGain.gain.value = 0;
    this.exhMod = ctx.createGain(); this.exhMod.gain.value = 0.5;
    this.fire2 = ctx.createOscillator(); this.fire2.type = 'square';
    const modDepth = ctx.createGain(); modDepth.gain.value = 0.5;
    this.fire2.connect(modDepth); modDepth.connect(this.exhMod.gain);
    this.exh.connect(this.exhBP); this.exhBP.connect(this.exhMod); this.exhMod.connect(this.exhGain); this.exhGain.connect(this.cabin);
    // wind
    this.wind = noise();
    this.windLP = ctx.createBiquadFilter(); this.windLP.type = 'lowpass';
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    this.wind.connect(this.windLP); this.windLP.connect(this.windGain); this.windGain.connect(this.master);
    // tyres
    this.tyre = noise();
    this.tyreLP = ctx.createBiquadFilter(); this.tyreLP.type = 'lowpass'; this.tyreLP.frequency.value = 180;
    this.tyreGain = ctx.createGain(); this.tyreGain.gain.value = 0;
    this.tyre.connect(this.tyreLP); this.tyreLP.connect(this.tyreGain); this.tyreGain.connect(this.master);
    // stall horn: a reed, about 1.6 kHz with a warble
    this.horn = ctx.createOscillator(); this.horn.type = 'square'; this.horn.frequency.value = 1580;
    const hornBP = ctx.createBiquadFilter(); hornBP.type = 'bandpass'; hornBP.frequency.value = 1600; hornBP.Q.value = 6;
    this.hornGain = ctx.createGain(); this.hornGain.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 11; const lfoG = ctx.createGain(); lfoG.gain.value = 25;
    lfo.connect(lfoG); lfoG.connect(this.horn.frequency); lfo.start();
    this.horn.connect(hornBP); hornBP.connect(this.hornGain); this.hornGain.connect(this.master);
    // flap motor
    this.flapOsc = ctx.createOscillator(); this.flapOsc.type = 'sawtooth'; this.flapOsc.frequency.value = 190;
    const flapLP = ctx.createBiquadFilter(); flapLP.type = 'lowpass'; flapLP.frequency.value = 900;
    this.flapGain = ctx.createGain(); this.flapGain.gain.value = 0;
    this.flapOsc.connect(flapLP); flapLP.connect(this.flapGain); this.flapGain.connect(this.cabin);
    for (const o of [this.fire, this.sub, this.fire2, this.horn, this.flapOsc]) o.start();
    this.enabled = true;
    this._lastFlap = 0;
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  /** Per-frame update from the flight model. */
  update(o, a, inside, paused) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const k = 0.08;
    const set = (param, v) => param.setTargetAtTime(v, t, k);
    const rpm = paused ? 0 : (o.rpm || 0);
    const firing = rpm / 60 * 2;
    const running = a.engineOn && rpm > 300;
    set(this.fire.frequency, Math.max(20, firing));
    set(this.fire2.frequency, Math.max(20, firing));
    set(this.sub.frequency, Math.max(10, rpm / 60));
    const load = Math.min(1, Math.max(0.15, (o.fuelFlow || 0) / 0.0085));
    set(this.engLP.frequency, 180 + rpm * 0.35 * (0.6 + 0.4 * load));
    set(this.engGain.gain, running ? 0.10 + 0.14 * load : 0);
    set(this.subGain.gain, running ? 0.22 : rpm > 60 ? 0.05 : 0);
    set(this.exhBP.frequency, 300 + rpm * 0.25);
    set(this.exhGain.gain, running ? 0.25 * load : 0);
    const ias = paused ? 0 : (o.ias || 0);
    set(this.windLP.frequency, 300 + ias * 30);
    set(this.windGain.gain, Math.min(0.5, (ias / 70) ** 2 * (inside ? 0.25 : 0.5)));
    set(this.cabin.frequency, inside ? 2200 : 6000);
    const rolling = o.onGround && !paused ? Math.min(1, (o.gs || 0) / 25) : 0;
    set(this.tyreGain.gain, rolling * 0.35);
    set(this.hornGain.gain, o.stallWarn && !paused ? 0.07 : 0);
    const flapMoving = Math.abs((a.flapDeg || 0) - this._lastFlap) > 1e-3;
    this._lastFlap = a.flapDeg || 0;
    set(this.flapGain.gain, flapMoving && !paused ? 0.05 : 0);
  }

  /** One-shot: touchdown chirp scaled by sink rate, or a crash. */
  bang(kind, strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this._noise();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    if (kind === 'chirp') {
      f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 3;
      g.gain.setValueAtTime(0.25 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    } else {
      f.type = 'lowpass'; f.frequency.value = 700;
      g.gain.setValueAtTime(1.0, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
      this.enabled = false;
      setTimeout(() => { this.enabled = true; }, 2000);
      for (const p of [this.engGain.gain, this.exhGain.gain, this.subGain.gain]) p.setTargetAtTime(0, t, 0.05);
    }
    src.connect(f); f.connect(g); g.connect(this.master);
    setTimeout(() => src.stop(), 2500);
  }
}
