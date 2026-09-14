import { bus } from './core/bus.js';

// Frequency table for notes (A440 tuning)
export function getNoteFrequency(semitones) {
  return 440 * Math.pow(2, semitones / 12);
}

// Calculate pan value from 3D position and camera yaw (-1 = left, 1 = right)
export function calculatePan(fromPos, playerPos, playerYaw) {
  if (!fromPos || !playerPos) return 0;
  const dx = fromPos.x - playerPos.x;
  const dz = fromPos.z - playerPos.z;
  // Rotate to camera-relative coordinates
  const cosY = Math.cos(playerYaw);
  const sinY = Math.sin(playerYaw);
  const relX = dx * cosY - dz * sinY;
  // Clamp pan to [-1, 1] with soft falloff
  return Math.max(-1, Math.min(1, relX * 0.05));
}

// Calculate attenuation based on distance (0 = silent, 1 = full volume)
export function calculateAttenuation(fromPos, playerPos, maxDist = 100) {
  if (!fromPos || !playerPos) return 1;
  const dx = fromPos.x - playerPos.x;
  const dz = fromPos.z - playerPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist >= maxDist) return 0;
  // Inverse square law with smooth falloff
  return Math.max(0, 1 - (dist / maxDist) ** 1.5);
}

// Crossfade between two moods (0 = mood1, 1 = mood2)
export function calculateMoodCrossfade(phase, duration = 2) {
  return Math.max(0, Math.min(1, phase / duration));
}

// Calculate sequencer step timing
export function getSequencerStepTime(stepIndex, bpm = 120) {
  const beatDuration = 60 / bpm;
  return (stepIndex * beatDuration) / 4; // 16 steps per beat
}

export class Audio {
  constructor(state, eventBus = bus) {
    this.state = state;
    this.bus = eventBus;
    this.ctx = null;
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;

    // Music sequencer state
    this.mood = 'title';
    this.moodCrossfadeTimer = 0;
    this.nextMood = null;
    this.sequencerTime = 0;
    this.lastScheduledStep = -1;

    // Active sources tracking
    this.activeSources = [];
    this.activeOscillators = [];
    this.droneCount = 0;
    this.droneOscillator = null;
    this.droneGain = null;

    // Ability tracking
    this.tkActive = false;
    this.slowmoActive = false;
    this.opticBlastActive = false;
    this.opticGain = null;
    this.tkHumGain = null;

    this._setupBusListeners();
  }

  _setupBusListeners() {
    this.bus.on('sfx', (payload) => this._onSfx(payload));
    this.bus.on('ability', (payload) => this._onAbility(payload));
    this.bus.on('hit', (payload) => this._onHit(payload));
    this.bus.on('footstep', (payload) => this._onFootstep(payload));
    this.bus.on('land', (payload) => this._onLand(payload));
    this.bus.on('jump', (payload) => this._onJump(payload));
    this.bus.on('enemy_dead', (payload) => this._onEnemyDead(payload));
    this.bus.on('phase', (payload) => this._onPhase(payload));
    this.bus.on('collect', () => this._playCollectSparkle());
    this.bus.on('toast', () => this._playUiClick());
    this.bus.on('mission_complete', () => this._playMissionFanfare());
  }

  resume() {
    if (this.ctx) return; // Already initialized

    const AudioContext = typeof window !== 'undefined' && window.AudioContext;
    if (!AudioContext) return; // No audio context available

    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();

    this.masterGain.gain.value = this.state.settings.mute ? 0 : 0.7;
    this.musicGain.gain.value = 0.4;
    this.sfxGain.gain.value = 0.6;

    this.musicGain.connect(this.masterGain);
    this.sfxGain.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this._startAmbient();
    this._startDroneLoop();
  }

  play(name, opts = {}) {
    if (!this.ctx) return;

    const { pos = null, gain = 1, character = null, ability = null } = opts;

    // Legacy name handling: map some sfx names to synthesis functions
    const map = {
      'claw-snikt': () => this._playClawSnikt(pos, gain),
      'slash': () => this._playSlash(pos, gain),
      'dash': () => this._playDashWhoosh(pos, gain),
      'click': () => this._playUiClick(),
      'confirm': () => this._playUiConfirm(),
      'sparkle': () => this._playCollectSparkle(),
    };

    if (map[name]) {
      map[name]();
    }
  }

  setMusic(mood) {
    if (this.mood === mood) return;
    this.nextMood = mood;
    this.moodCrossfadeTimer = 0;
  }

  mute(state) {
    if (!this.ctx) return;
    this.state.settings.mute = state;
    this.masterGain.gain.value = state ? 0 : 0.7;
  }

  update(dt) {
    if (!this.ctx) return;

    // Update music sequencer
    this.sequencerTime += dt * this.state.timeScale;

    // Handle mood crossfade
    if (this.nextMood) {
      this.moodCrossfadeTimer += dt;
      if (this.moodCrossfadeTimer >= 2) {
        this.mood = this.nextMood;
        this.nextMood = null;
        this.moodCrossfadeTimer = 0;
      }
    }

    // Schedule music notes ahead by 0.2s
    const lookAhead = 0.2;
    const currentStep = Math.floor(this.sequencerTime * 8); // 16 steps per 2 seconds
    const lookaheadStep = Math.floor((this.sequencerTime + lookAhead) * 8);

    while (this.lastScheduledStep < lookaheadStep) {
      this.lastScheduledStep++;
      const stepTime = getSequencerStepTime(this.lastScheduledStep % 16, 120);
      const scheduleTime = this.ctx.currentTime + (stepTime - (this.sequencerTime % 2));
      if (scheduleTime > this.ctx.currentTime) {
        this._scheduleSequencerNote(this.lastScheduledStep, scheduleTime);
      }
    }

    // Clean up finished sources
    this.activeSources = this.activeSources.filter(src => {
      if (src.endTime && this.ctx.currentTime >= src.endTime) {
        try { src.node?.stop(); src.node?.disconnect(); } catch(e) {}
        return false;
      }
      return true;
    });
  }

  // ========== Sound Synthesis ==========

  _playClawSnikt(pos, gain) {
    // Metallic triple click
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const envGain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        filter.type = 'highpass';
        filter.frequency.value = 4000 + i * 1000;
        osc.frequency.value = 200 + i * 150;

        envGain.gain.setValueAtTime(gain, this.ctx.currentTime);
        envGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.05);

        osc.connect(filter);
        filter.connect(envGain);
        envGain.connect(this.sfxGain);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.05);

        this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.05 });
      }, i * 30);
    }
  }

  _playSlash(pos, gain) {
    // Noise sweep
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 0.3;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = this.ctx.createBufferSource();
    const envGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'highpass';
    filter.frequency.setValueAtTime(500, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(3000, this.ctx.currentTime + 0.15);

    envGain.gain.setValueAtTime(gain, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.2);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(envGain);
    envGain.connect(this.sfxGain);

    source.start();
    source.stop(this.ctx.currentTime + 0.2);

    this.activeSources.push({ node: source, endTime: this.ctx.currentTime + 0.2 });
  }

  _playDashWhoosh(pos, gain) {
    // Soft whoosh using filtered noise
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 0.4;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }

    const source = this.ctx.createBufferSource();
    const envGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(6000, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(2000, this.ctx.currentTime + 0.3);

    envGain.gain.setValueAtTime(gain, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.3);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(envGain);
    envGain.connect(this.sfxGain);

    source.start();
    source.stop(this.ctx.currentTime + 0.3);

    this.activeSources.push({ node: source, endTime: this.ctx.currentTime + 0.3 });
  }

  _playJumpWhoosh(pos, gain) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const envGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'highpass';
    filter.frequency.value = 100;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, this.ctx.currentTime + 0.15);

    envGain.gain.setValueAtTime(gain * 0.3, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15);

    osc.connect(filter);
    filter.connect(envGain);
    envGain.connect(this.sfxGain);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);

    this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.15 });
  }

  _playLandThump(impact = 1, pos, gain) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const envGain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(150 * impact, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.2);

    envGain.gain.setValueAtTime(gain * 0.4 * impact, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.2);

    osc.connect(envGain);
    envGain.connect(this.sfxGain);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.2);

    this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.2 });
  }

  _playHitImpact(kind = 'thug', pos, gain) {
    if (!this.ctx) return;

    if (kind === 'thug') {
      // Punch impact
      const osc = this.ctx.createOscillator();
      const envGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.1);
      envGain.gain.setValueAtTime(gain * 0.3, this.ctx.currentTime);
      envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.1);
      osc.connect(envGain);
      envGain.connect(this.sfxGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.1);
      this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.1 });
    } else if (kind === 'drone') {
      // Zap sound
      const osc = this.ctx.createOscillator();
      const envGain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 2000;
      osc.type = 'square';
      osc.frequency.setValueAtTime(600, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, this.ctx.currentTime + 0.08);
      envGain.gain.setValueAtTime(gain * 0.4, this.ctx.currentTime);
      envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.08);
      osc.connect(filter);
      filter.connect(envGain);
      envGain.connect(this.sfxGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.08);
      this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.08 });
    } else if (kind === 'sentinel') {
      // Big stomp
      const sub = this.ctx.createOscillator();
      const subGain = this.ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(80, this.ctx.currentTime);
      sub.frequency.exponentialRampToValueAtTime(20, this.ctx.currentTime + 0.3);
      subGain.gain.setValueAtTime(gain * 0.5, this.ctx.currentTime);
      subGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.3);
      sub.connect(subGain);
      subGain.connect(this.sfxGain);
      sub.start();
      sub.stop(this.ctx.currentTime + 0.3);
      this.activeSources.push({ node: sub, endTime: this.ctx.currentTime + 0.3 });
    }
  }

  _playExplosion(pos, gain) {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 0.5;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
    }

    const source = this.ctx.createBufferSource();
    const envGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(8000, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.4);

    envGain.gain.setValueAtTime(gain * 0.7, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.4);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(envGain);
    envGain.connect(this.sfxGain);

    source.start();
    source.stop(this.ctx.currentTime + 0.4);

    this.activeSources.push({ node: source, endTime: this.ctx.currentTime + 0.4 });
  }

  _playDiamondChime(pos, gain) {
    if (!this.ctx) return;
    // Bell-like harmonics
    const notes = [1046.5, 1318.5, 1864.7, 2637.0]; // C6, E6, B6, E7
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const envGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const delay = i * 0.05;
      const duration = 0.3;
      envGain.gain.setValueAtTime(0, this.ctx.currentTime + delay);
      envGain.gain.linearRampToValueAtTime(gain * 0.25, this.ctx.currentTime + delay + 0.02);
      envGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + delay + duration);
      osc.connect(envGain);
      envGain.connect(this.sfxGain);
      osc.start(this.ctx.currentTime + delay);
      osc.stop(this.ctx.currentTime + delay + duration);
      this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + delay + duration });
    });
  }

  _playPsychicShimmer(pos, gain) {
    if (!this.ctx) return;
    const baseFreq = 880;
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const envGain = this.ctx.createGain();
      const depth = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = baseFreq * (1 + i * 0.05);

      lfo.type = 'sine';
      lfo.frequency.value = 5 + i;
      depth.gain.value = 30;

      lfo.connect(depth);
      depth.connect(osc.frequency);

      envGain.gain.setValueAtTime(gain * 0.15, this.ctx.currentTime);
      envGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);

      osc.connect(envGain);
      envGain.connect(this.sfxGain);

      osc.start();
      osc.stop(this.ctx.currentTime + 0.5);
      lfo.start();
      lfo.stop(this.ctx.currentTime + 0.5);

      this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.5 });
    }
  }

  _playUiClick() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const envGain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(600, this.ctx.currentTime + 0.05);
    envGain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.05);
    osc.connect(envGain);
    envGain.connect(this.sfxGain);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.05);
    this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.05 });
  }

  _playUiConfirm() {
    if (!this.ctx) return;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const envGain = this.ctx.createGain();
    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(800, this.ctx.currentTime);
    osc2.frequency.setValueAtTime(1200, this.ctx.currentTime);
    envGain.gain.setValueAtTime(0.25, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.1);
    osc1.connect(envGain);
    osc2.connect(envGain);
    envGain.connect(this.sfxGain);
    osc1.start();
    osc2.start();
    osc1.stop(this.ctx.currentTime + 0.1);
    osc2.stop(this.ctx.currentTime + 0.1);
    this.activeSources.push({ node: osc1, endTime: this.ctx.currentTime + 0.1 });
  }

  _playCollectSparkle() {
    if (!this.ctx) return;
    // Rising arpeggio
    const notes = [1046.5, 1318.5, 1567.98, 1975.53]; // C6, E6, G6, B6
    notes.forEach((freq, i) => {
      setTimeout(() => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const envGain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        envGain.gain.setValueAtTime(0.2, this.ctx.currentTime);
        envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.15);
        osc.connect(envGain);
        envGain.connect(this.sfxGain);
        osc.start();
        osc.stop(this.ctx.currentTime + 0.15);
        this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + 0.15 });
      }, i * 50);
    });
  }

  _playMissionFanfare() {
    if (!this.ctx) return;
    // 4-note brass-ish fanfare
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const envGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const delay = i * 0.1;
      const duration = 0.4;
      envGain.gain.setValueAtTime(0, this.ctx.currentTime + delay);
      envGain.gain.linearRampToValueAtTime(0.4, this.ctx.currentTime + delay + 0.05);
      envGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + delay + duration);
      osc.connect(envGain);
      envGain.connect(this.sfxGain);
      osc.start(this.ctx.currentTime + delay);
      osc.stop(this.ctx.currentTime + delay + duration);
      this.activeSources.push({ node: osc, endTime: this.ctx.currentTime + delay + duration });
    });
  }

  _startAmbient() {
    if (!this.ctx) return;
    // Ambient wind + occasional bird chirps + traffic rumble
    // Wind noise (low-freq noise loop)
    const bufferSize = this.ctx.sampleRate * 4;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const windSource = this.ctx.createBufferSource();
    windSource.buffer = buffer;
    windSource.loop = true;
    windSource.playbackRate.value = 0.8;

    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 400;
    windFilter.Q.value = 0.5;

    const windGain = this.ctx.createGain();
    windGain.gain.value = 0.1;

    windSource.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.musicGain);
    windSource.start();

    this.activeSources.push({ node: windSource, endTime: Infinity });
  }

  _startDroneLoop() {
    // Will be activated when enemies spawn
  }

  _scheduleSequencerNote(stepIndex, scheduleTime) {
    if (!this.ctx || scheduleTime <= this.ctx.currentTime) return;

    const step = stepIndex % 16;
    const moodPhase = this.moodCrossfadeTimer / 2;
    const crossfade = calculateMoodCrossfade(moodPhase, 1);

    // Define mood note patterns (simplified)
    const patterns = {
      title: [349.23, 392.00, 440.00, 494.00], // F4, G4, A4, B4
      explore: [293.66, 349.23, 440.00, 392.00], // D4, F4, A4, G4
      combat: [329.63, 440.00, 493.88, 329.63], // E4, A4, B4, E4
      boss: [261.63, 329.63, 392.00, 493.88], // C4, E4, G4, B4
    };

    const currentPattern = patterns[this.mood] || patterns.title;
    const nextPattern = this.nextMood ? patterns[this.nextMood] : currentPattern;

    const noteIdx = step % 4;
    const freq1 = currentPattern[noteIdx];
    const freq2 = nextPattern[noteIdx];
    const freq = freq1 * (1 - crossfade) + freq2 * crossfade;

    const osc = this.ctx.createOscillator();
    const envGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.value = 5000;

    osc.type = 'sine';
    osc.frequency.value = freq;

    const noteDuration = 0.15;
    envGain.gain.setValueAtTime(0.15, scheduleTime);
    envGain.gain.linearRampToValueAtTime(0.1, scheduleTime + 0.02);
    envGain.gain.exponentialRampToValueAtTime(0.01, scheduleTime + noteDuration);

    osc.connect(filter);
    filter.connect(envGain);
    envGain.connect(this.musicGain);

    osc.start(scheduleTime);
    osc.stop(scheduleTime + noteDuration);

    this.activeSources.push({ node: osc, endTime: scheduleTime + noteDuration });
  }

  // ========== Bus Listeners ==========

  _onSfx(payload) {
    const { name, pos, gain = 1 } = payload;
    const attenuation = pos ? calculateAttenuation(pos, this.state.player?.pos, 100) : 1;
    if (attenuation > 0) {
      this.play(name, { pos, gain: gain * attenuation });
    }
  }

  _onAbility(payload) {
    const { character, name } = payload;

    if (name === 'snikt') {
      this.play('claw-snikt', { gain: 0.7 });
    } else if (name === 'dash') {
      this.play('dash', { gain: 0.6 });
    } else if (name === 'slowmo') {
      this.slowmoActive = true;
      if (this.musicGain) {
        this.musicGain.gain.exponentialRampToValueAtTime(0.05, this.ctx.currentTime + 0.1);
      }
    } else if (name === 'slowmo-end') {
      this.slowmoActive = false;
      if (this.musicGain) {
        this.musicGain.gain.exponentialRampToValueAtTime(0.4, this.ctx.currentTime + 0.2);
      }
    } else if (name === 'telekinesis') {
      this.tkActive = true;
      if (!this.tkHumGain) this._startTkHum();
    } else if (name === 'telekinesis-end') {
      this.tkActive = false;
      if (this.tkHumGain) {
        this.tkHumGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.2);
      }
    } else if (name === 'blast-start') {
      this.opticBlastActive = true;
      if (!this.opticGain) this._startOpticBlast();
    } else if (name === 'blast-end') {
      this.opticBlastActive = false;
      if (this.opticGain) {
        this.opticGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
      }
    }
  }

  _onHit(payload) {
    const { targetId, damage } = payload;
    const attenuation = payload.pos ? calculateAttenuation(payload.pos, this.state.player?.pos, 100) : 1;
    if (attenuation > 0) {
      // Determine impact type (simplified)
      let kind = 'thug';
      this._playHitImpact(kind, payload.pos, 0.5 * attenuation);
    }
  }

  _onFootstep(payload) {
    if (!this.ctx) return;
    const { speed = 1, pos } = payload;
    const attenuation = pos ? calculateAttenuation(pos, this.state.player?.pos, 100) : 1;
    if (attenuation < 0.1) return;

    // Filtered noise tick with pitch variation by speed
    const bufferSize = this.ctx.sampleRate * 0.1;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      const envelope = 1 - i / bufferSize;
      data[i] = (Math.random() * 2 - 1) * envelope;
    }

    const source = this.ctx.createBufferSource();
    const envGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.value = 3000 * speed;

    source.playbackRate.value = speed;
    envGain.gain.setValueAtTime(0.2 * attenuation, this.ctx.currentTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.1);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(envGain);
    envGain.connect(this.sfxGain);

    source.start();
    source.stop(this.ctx.currentTime + 0.1);

    this.activeSources.push({ node: source, endTime: this.ctx.currentTime + 0.1 });
  }

  _onLand(payload) {
    if (!this.ctx) return;
    const { impact = 1, pos } = payload;
    const attenuation = pos ? calculateAttenuation(pos, this.state.player?.pos, 100) : 1;
    if (attenuation > 0) {
      this._playLandThump(impact, pos, attenuation);
    }
  }

  _onJump(payload) {
    if (!this.ctx) return;
    const { pos } = payload;
    const attenuation = pos ? calculateAttenuation(pos, this.state.player?.pos, 100) : 1;
    if (attenuation > 0) {
      this._playJumpWhoosh(pos, attenuation);
    }
  }

  _onEnemyDead(payload) {
    if (!this.ctx) return;
    const { enemy } = payload;
    if (enemy?.kind === 'drone') {
      this.droneCount--;
      if (this.droneCount <= 0) {
        this.droneCount = 0;
        if (this.droneOscillator) {
          this.droneOscillator.stop();
          this.droneOscillator.disconnect();
          this.droneOscillator = null;
        }
      }
    }
  }

  _onPhase(payload) {
    const { phase } = payload;
    if (phase === 'title') {
      this.setMusic('title');
    } else if (phase === 'intro' || phase === 'skydive') {
      this.setMusic('explore');
    } else if (phase === 'play') {
      this.setMusic('explore');
    }
  }

  _startTkHum() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    this.tkHumGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.value = 2000;

    osc.type = 'sine';
    osc.frequency.value = 220;

    this.tkHumGain.gain.value = 0.2;

    osc.connect(filter);
    filter.connect(this.tkHumGain);
    this.tkHumGain.connect(this.sfxGain);

    osc.start();
    this.activeOscillators.push(osc);
  }

  _startOpticBlast() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const noise = this.ctx.createBufferSource();
    const bufferSize = this.ctx.sampleRate * 0.5;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    this.opticGain = this.ctx.createGain();
    const oscGain = this.ctx.createGain();
    const noiseGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = 'highpass';
    filter.frequency.value = 1000;

    osc.type = 'sawtooth';
    osc.frequency.value = 440;

    this.opticGain.gain.value = 0.3;
    oscGain.gain.value = 0.5;
    noiseGain.gain.value = 0.3;

    osc.connect(oscGain);
    noise.buffer = buffer;
    noise.loop = true;
    noise.connect(filter);
    filter.connect(noiseGain);

    oscGain.connect(this.opticGain);
    noiseGain.connect(this.opticGain);
    this.opticGain.connect(this.sfxGain);

    osc.start();
    noise.start();

    this.activeOscillators.push(osc);
    this.activeSources.push({ node: noise, endTime: Infinity });
  }
}
