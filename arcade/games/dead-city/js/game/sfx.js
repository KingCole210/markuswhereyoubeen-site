// Small synthesized sound effects (no audio files): blasts, missiles, explosions, punches, ice, zombie screams,
// plus looping wind / thruster / beam beds driven by the hero's state.

class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  start() {
    if (this.ctx) {
      this.ctx.resume?.();
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
    } catch {
      this.ctx = null;
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.loops = {
      wind: this.loop('lowpass', 500, 0.7),
      thrust: this.loop('bandpass', 380, 1.4),
      beam: this.beamLoop(),
      freeze: this.loop('highpass', 2600, 0.6)
    };
  }

  loop(type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    return { g, f };
  }

  beamLoop() {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    for (const hz of [174, 177.5, 351]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.connect(f);
      o.start();
    }
    f.connect(g).connect(this.master);
    return { g, f };
  }

  setLoop(name, level, freq) {
    if (!this.ctx || !this.loops) return;
    const l = this.loops[name];
    const t = this.ctx.currentTime;
    l.g.gain.setTargetAtTime(this.enabled ? level : 0, t, 0.08);
    if (freq) l.f.frequency.setTargetAtTime(freq, t, 0.1);
  }

  env(node, peak, attack, decay, t0) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  noiseHit(type, freq, q, peak, attack, decay, vol = 1, sweepTo = null) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, peak * vol, attack, decay, t);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + attack + decay + 0.05);
  }

  tone(type, from, to, peak, attack, decay, vol = 1) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + attack + decay);
    const g = ctx.createGain();
    this.env(g, peak * vol, attack, decay, t);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  // vol: 0..1 distance attenuation from the caller
  play(name, vol = 1) {
    if (!this.ctx || !this.enabled || vol < 0.02) return;
    switch (name) {
      case 'repulsor':
        this.tone('square', 1300, 240, 0.16, 0.005, 0.14, vol);
        this.noiseHit('highpass', 3000, 0.7, 0.18, 0.003, 0.09, vol);
        break;
      case 'missile':
        this.noiseHit('bandpass', 500, 1.2, 0.35, 0.02, 0.45, vol, 2400);
        break;
      case 'boom':
        this.noiseHit('lowpass', 900, 0.8, 0.9, 0.005, 0.9, vol, 120);
        this.tone('sine', 85, 35, 0.8, 0.005, 0.6, vol);
        break;
      case 'pulse':
        this.tone('sine', 160, 40, 0.7, 0.01, 0.4, vol);
        this.noiseHit('bandpass', 1800, 0.8, 0.4, 0.01, 0.35, vol, 300);
        break;
      case 'punch':
        this.noiseHit('lowpass', 1200, 0.9, 0.7, 0.003, 0.14, vol);
        this.tone('sine', 120, 50, 0.7, 0.003, 0.16, vol);
        break;
      case 'slam':
        this.noiseHit('lowpass', 600, 0.8, 1, 0.005, 1.1, vol, 90);
        this.tone('sine', 70, 28, 1, 0.005, 0.8, vol);
        break;
      case 'nova':
        this.noiseHit('highpass', 2500, 0.6, 0.5, 0.01, 0.8, vol, 6000);
        this.tone('triangle', 2200, 900, 0.18, 0.01, 0.7, vol);
        break;
      case 'shatter':
        this.noiseHit('highpass', 3800, 0.8, 0.45, 0.002, 0.22, vol);
        for (let i = 0; i < 3; i++) this.tone('sine', 2400 + Math.random() * 2600, 1800, 0.06, 0.002, 0.18 + i * 0.05, vol);
        break;
      case 'scream':
        this.tone('sawtooth', 420 + Math.random() * 120, 170, 0.12, 0.03, 0.42, vol);
        this.noiseHit('bandpass', 1100, 3, 0.2, 0.03, 0.4, vol, 500);
        break;
      case 'hurt':
        this.tone('sine', 110, 55, 0.5, 0.004, 0.18, vol);
        this.noiseHit('lowpass', 500, 0.7, 0.4, 0.004, 0.12, vol);
        break;
      case 'splat':
        this.noiseHit('lowpass', 700, 0.6, 0.35, 0.004, 0.12, vol);
        break;
      case 'm4':
        this.noiseHit('highpass', 1400, 0.7, 0.7, 0.001, 0.07, vol);
        this.noiseHit('lowpass', 900, 0.8, 0.6, 0.002, 0.16, vol);
        this.tone('sine', 140, 55, 0.5, 0.002, 0.09, vol);
        break;
      case 'pistol':
        this.noiseHit('highpass', 1800, 0.7, 0.6, 0.001, 0.06, vol);
        this.noiseHit('lowpass', 1300, 0.8, 0.45, 0.002, 0.12, vol);
        this.tone('sine', 190, 70, 0.4, 0.002, 0.07, vol);
        break;
      case 'reload':
        this.noiseHit('bandpass', 2600, 4, 0.25, 0.002, 0.04, vol);
        setTimeout(() => this.ctx && this.noiseHit('bandpass', 1900, 4, 0.3, 0.002, 0.05, vol), 260);
        break;
      case 'empty':
        this.noiseHit('bandpass', 3200, 6, 0.2, 0.001, 0.025, vol);
        break;
      case 'ui':
        this.tone('triangle', 880, 1320, 0.15, 0.004, 0.09, vol);
        break;
      case 'alarm':
        this.tone('square', 660, 640, 0.12, 0.01, 0.25, vol);
        break;
      default: break;
    }
  }
}

export { Sfx };
