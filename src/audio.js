// audio.js: procedural music and effects with the Web Audio API. No asset files needed.

export function createAudio() {
  let ctx = null, master, musicBus, sfxBus, noiseBuf;
  const vol = { music: 0.6, sfx: 0.8, muted: false };
  let intensity = 0, playing = false, timer = null, step = 0, nextT = 0, bar = 0;

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const jit = (a = 0.06) => 1 + (Math.random() - 0.5) * a * 2;
  const ROOTS = [45, 41, 48, 43]; // Am F C G
  const THIRD = [3, 4, 4, 4];

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    musicBus = ctx.createGain();
    sfxBus = ctx.createGain();
    musicBus.connect(master); sfxBus.connect(master);
    master.connect(comp); comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    applyVolumes();
  }

  function applyVolumes() {
    if (!ctx) return;
    master.gain.value = vol.muted ? 0 : 1;
    musicBus.gain.value = vol.music * 0.5;
    sfxBus.gain.value = vol.sfx * 0.9;
  }

  function tone(type, f0, f1, t, dur, gain, dest, attack = 0.005) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noise(t, dur, gain, dest, f0, f1, q = 1, type = 'lowpass') {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; s.loop = true;
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t); s.stop(t + dur + 0.05);
  }

  // ---- music: layers fade in as intensity (speed) rises ----
  function scheduleStep(s, t, b) {
    const root = ROOTS[b % 4], third = THIRD[b % 4];
    const i = intensity;
    // pad on the first step of each bar
    if (s === 0) {
      for (const iv of [0, third, 7]) tone('triangle', mtof(root + 12 + iv), mtof(root + 12 + iv), t, 16 * stepLen(), 0.07, musicBus, 0.25);
    }
    // bass
    if (s % 2 === 0) tone('sawtooth', mtof(root + (s % 8 === 6 ? 12 : 0)), mtof(root) * 0.98, t, stepLen() * 1.6, 0.16, musicBus);
    // kick
    if ((i > 0.15 && s % 4 === 0) || s === 0 || s === 8) tone('sine', 150, 42, t, 0.18, 0.5, musicBus);
    // hats
    if (i > 0.25 && s % 2 === 1) noise(t, 0.05, 0.12, musicBus, 7000, 9000, 1, 'highpass');
    // clap
    if (i > 0.5 && (s === 4 || s === 12)) noise(t, 0.12, 0.22, musicBus, 2200, 900, 1.2, 'bandpass');
    // arp
    if (i > 0.45) {
      const tones = [0, third, 7, 12, 7, third, 12, 7];
      tone('square', mtof(root + 24 + tones[s % 8]), mtof(root + 24 + tones[s % 8]), t, stepLen() * 0.9, 0.05, musicBus);
    }
    // lead
    if (i > 0.8 && s % 4 === 2) tone('sawtooth', mtof(root + 36 + (s % 8 === 2 ? 0 : 7)), mtof(root + 36), t, stepLen() * 2.2, 0.045, musicBus);
  }
  const bpm = () => 104 + 40 * intensity;
  const stepLen = () => 60 / bpm() / 4;

  function tick() {
    if (!ctx || !playing) return;
    while (nextT < ctx.currentTime + 0.15) {
      scheduleStep(step, Math.max(nextT, ctx.currentTime), bar);
      nextT += stepLen();
      step = (step + 1) % 16;
      if (step === 0) bar++;
    }
  }

  return {
    state: vol,
    unlock: init,
    startMusic() {
      init();
      if (!ctx || playing) return;
      playing = true; step = 0; bar = 0; nextT = ctx.currentTime + 0.05;
      timer = setInterval(tick, 40);
    },
    stopMusic() { playing = false; clearInterval(timer); },
    setIntensity(v) { intensity = Math.max(0, Math.min(1, v)); },
    setVolumes(m, s, muted) {
      vol.music = m; vol.sfx = s; vol.muted = muted;
      applyVolumes();
    },
    sfx(name) {
      if (!ctx || vol.muted) return;
      const t = ctx.currentTime, o = sfxBus;
      switch (name) {
        case 'jump': tone('square', 280 * jit(), 720 * jit(), t, 0.16, 0.16, o); break;
        case 'land': noise(t, 0.09, 0.3, o, 600, 120); break;
        case 'slide': noise(t, 0.3, 0.2, o, 3000, 500, 0.8, 'bandpass'); break;
        case 'lane': noise(t, 0.07, 0.07, o, 1800, 900, 0.6, 'bandpass'); break;
        case 'coin': {
          const j = jit(0.04);
          tone('sine', 988 * j, 988 * j, t, 0.09, 0.22, o);
          tone('sine', 1319 * j, 1319 * j, t + 0.07, 0.18, 0.2, o);
          break;
        }
        case 'power': [523, 659, 784, 1047].forEach((f, k) => tone('triangle', f * jit(0.02), f, t + k * 0.06, 0.16, 0.2, o)); break;
        case 'shield': tone('sawtooth', 500, 1500, t, 0.3, 0.12, o); noise(t, 0.3, 0.12, o, 4000, 8000, 1, 'highpass'); break;
        case 'break': noise(t, 0.25, 0.4, o, 2500, 200); tone('square', 220, 60, t, 0.2, 0.2, o); break;
        case 'near': tone('sine', 700, 1400, t, 0.12, 0.18, o); break;
        case 'crash':
          noise(t, 0.7, 0.8, o, 1800, 80);
          tone('sine', 140, 30, t, 0.6, 0.7, o);
          tone('sawtooth', 220, 55, t, 0.5, 0.25, o);
          break;
        case 'tick': tone('square', 660 * jit(0.01), 660, t, 0.06, 0.12, o); break;
        case 'go': tone('square', 990, 990, t, 0.28, 0.18, o); tone('triangle', 1980, 1980, t, 0.28, 0.1, o); break;
        case 'ui': tone('triangle', 520 * jit(0.03), 700, t, 0.07, 0.12, o); break;
        case 'buy': [660, 880, 1320].forEach((f, k) => tone('triangle', f, f, t + k * 0.07, 0.2, 0.2, o)); break;
        case 'win': [523, 659, 784, 1047, 1319].forEach((f, k) => tone('triangle', f, f, t + k * 0.08, 0.3, 0.2, o)); break;
        case 'no': tone('square', 200, 140, t, 0.18, 0.12, o); break;
      }
    },
  };
}
