// ---- src/prelude.js ----
// prelude.js: loads three.js and the post-processing add-ons from the CDN.

const $ = (id) => document.getElementById(id);
function setProgress(p, msg) {
  const b = $('loadbar'); if (b) b.style.transform = `scaleX(${p})`;
  if (msg && $('loadmsg')) $('loadmsg').textContent = msg;
}
function fatal(msg) {
  if ($('loadmsg')) $('loadmsg').textContent = msg;
  const l = $('loading'); if (l) l.classList.add('failed');
}

let THREE, EffectComposer = null, RenderPass = null, UnrealBloomPass = null, ShaderPass = null, OutputPass = null;
setProgress(0.1, 'Loading 3D engine');
try {
  THREE = await import('three');
} catch (e) {
  console.error(e);
  fatal('The 3D engine could not be loaded. Check your connection and reload the page.');
  throw e;
}
setProgress(0.45, 'Loading effects');
try {
  ({ EffectComposer } = await import('three/addons/postprocessing/EffectComposer.js'));
  ({ RenderPass } = await import('three/addons/postprocessing/RenderPass.js'));
  ({ UnrealBloomPass } = await import('three/addons/postprocessing/UnrealBloomPass.js'));
  ({ ShaderPass } = await import('three/addons/postprocessing/ShaderPass.js'));
  ({ OutputPass } = await import('three/addons/postprocessing/OutputPass.js'));
} catch (e) {
  // The game still runs without bloom and speed effects.
  console.warn('Post-processing unavailable, using plain rendering', e);
  EffectComposer = null;
}
setProgress(0.7, 'Building the world');


// ---- src/logic.js ----
// logic.js: pure game rules. No DOM, no three.js, so it can be tested in Node.

const LANES = [-2.2, 0, 2.2];
const CELL = { EMPTY: 0, LOW: 1, TALL: 2, BIRD: 3 };

const BASE_SPEED = 14;
const MAX_SPEED = 38;
const MIN_GAP_SEC = 1.0;

// Jump arc: apex height and airtime fix gravity and launch speed.
const JUMP_H = 2.6;
const JUMP_T = 0.68;
const GRAV = (8 * JUMP_H) / (JUMP_T * JUMP_T);
const JUMP_V = (4 * JUMP_H) / JUMP_T;
const SLIDE_T = 0.65;
const DASH_MULT = 1.3;
const REVIVE_COST = 100;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Speed grows with distance and levels off at MAX_SPEED.
const speedAt = (d) => BASE_SPEED + (MAX_SPEED - BASE_SPEED) * (1 - Math.exp(-Math.max(0, d) / 1800));
const difficultyAt = (d) => 1 - Math.exp(-Math.max(0, d) / 2200);
// Seconds between obstacle rows. Higher speed therefore means larger gaps in metres.
const reactionTime = (diff) => 1.4 - 0.3 * diff;

// ---------- Spawning ----------

class Director {
  constructor(seed = 1) {
    this.rng = mulberry32(seed);
    this.safe = 1;
    this.queue = [];
    this.sincePower = 0;
  }
  int(n) { return Math.floor(this.rng() * n); }
  chance(p) { return this.rng() < p; }
  stepSafe() {
    const s = Math.max(0, Math.min(2, this.safe + this.int(3) - 1));
    this.safe = s;
    return s;
  }
  // Safe lane never holds a TALL block, so a path always exists.
  obsRow(cells, safe, extra = {}) {
    const c = cells.slice();
    if (c[safe] === CELL.TALL) c[safe] = CELL.LOW;
    return { kind: 'obs', cells: c, coins: [0, 0, 0], coinY: 1, power: null, safe, ...extra };
  }
  coinRow(lane) {
    const coins = [0, 0, 0];
    coins[lane] = 1;
    return { kind: 'coin', cells: [0, 0, 0], coins, coinY: 1, power: null, safe: lane };
  }
  pickWeighted(opts) {
    const total = opts.reduce((a, o) => a + o[1], 0);
    let r = this.rng() * total;
    for (const [name, w] of opts) {
      if ((r -= w) <= 0) return name;
    }
    return opts[0][0];
  }
  obstacleType(d, allowTall = true) {
    const r = this.rng();
    if (allowTall && r < 0.38) return CELL.TALL;
    if (d > 0.05 && r < 0.62) return CELL.BIRD;
    return CELL.LOW;
  }
  fill(dist) {
    const d = difficultyAt(dist);
    const name = this.pickWeighted([
      ['single', 3], ['coins', 3], ['double', 1 + 3 * d], ['jump', d > 0.08 ? 2 : 0],
      ['gate', d > 0.12 ? 1.5 : 0], ['weave', d > 0.25 ? 2 + 2 * d : 0], ['mix', d > 0.18 ? 2 : 0],
    ]);
    const q = this.queue;
    if (name === 'single') {
      const s = this.stepSafe();
      const cells = [0, 0, 0];
      cells[this.int(3)] = this.obstacleType(d);
      q.push(this.obsRow(cells, s));
    } else if (name === 'double') {
      const s = this.stepSafe();
      const cells = [0, 0, 0];
      for (let l = 0; l < 3; l++) if (l !== s) cells[l] = this.obstacleType(d);
      q.push(this.obsRow(cells, s));
    } else if (name === 'jump') {
      const n = 2 + this.int(2);
      for (let i = 0; i < n; i++) {
        const s = this.stepSafe();
        q.push(this.obsRow([CELL.LOW, CELL.LOW, CELL.LOW], s, { coins: [0, 1, 0], coinY: 2.3 }));
      }
    } else if (name === 'gate') {
      const n = 1 + this.int(2);
      for (let i = 0; i < n; i++) {
        const s = this.stepSafe();
        q.push(this.obsRow([CELL.BIRD, CELL.BIRD, CELL.BIRD], s));
      }
    } else if (name === 'weave') {
      const n = 3 + this.int(2);
      for (let i = 0; i < n; i++) {
        const before = this.safe;
        let s = this.stepSafe();
        if (s === before) s = before === 1 ? (this.chance(0.5) ? 0 : 2) : 1;
        this.safe = s;
        const cells = [0, 0, 0];
        for (let l = 0; l < 3; l++) if (l !== s) cells[l] = this.chance(0.7) ? CELL.TALL : CELL.LOW;
        q.push(this.obsRow(cells, s));
      }
    } else if (name === 'mix') {
      const s = this.stepSafe();
      const others = [0, 1, 2].filter((l) => l !== s);
      const cells = [0, 0, 0];
      cells[others[0]] = CELL.TALL;
      cells[others[1]] = this.chance(0.5) ? CELL.LOW : CELL.BIRD;
      q.push(this.obsRow(cells, s));
    } else {
      let lane = this.safe;
      const n = 6 + this.int(4);
      for (let i = 0; i < n; i++) {
        if (i % 2 === 0 && i > 0) lane = Math.max(0, Math.min(2, lane + this.int(3) - 1));
        q.push(this.coinRow(lane));
      }
      this.safe = lane;
    }
    // Sometimes follow an obstacle pattern with a short coin trail in the safe lane.
    if (name !== 'coins' && this.chance(0.45)) {
      q.push(this.coinRow(this.safe));
      q.push(this.coinRow(this.safe));
    }
  }
  // Next row to place. gap is metres from the previous row.
  next(dist, speed) {
    if (!this.queue.length) this.fill(dist);
    const row = this.queue.shift();
    row.gap = row.kind === 'coin' ? 2.6 : speed * reactionTime(difficultyAt(dist));
    this.sincePower += row.gap;
    if (row.kind === 'coin' && this.sincePower > 450 + this.rng() * 250) {
      const lane = row.coins.indexOf(1);
      row.power = { lane, type: ['shield', 'magnet', 'double', 'dash'][this.int(4)] };
      row.coins[lane] = 0;
      this.sincePower = 0;
    }
    return row;
  }
}

// DP over rows: is there always a lane to stand in? Moving one lane per row is assumed.
function pathExists(rows) {
  let reach = [true, true, true];
  for (const r of rows) {
    const nr = [0, 1, 2].map(
      (l) => r.cells[l] !== CELL.TALL && ((l > 0 && reach[l - 1]) || reach[l] || (l < 2 && reach[l + 1])),
    );
    if (!nr.some(Boolean)) return false;
    reach = nr;
  }
  return true;
}

// ---------- Collision ----------

const OBST = {
  [CELL.LOW]: { hx: 0.95, y0: 0, y1: 0.95, hz: 0.6 },
  [CELL.TALL]: { hx: 0.95, y0: 0, y1: 3.6, hz: 0.7 },
  [CELL.BIRD]: { hx: 0.9, y0: 1.15, y1: 2.4, hz: 0.5 },
};
const DINO = { hx: 0.42, hz: 0.55, standH: 2.0, slideH: 0.8, forgive: 0.1 };

// d: {x, y, z, sliding}   o: {type, x, z}
function collides(d, o) {
  const b = OBST[o.type];
  const f = DINO.forgive;
  const h = d.sliding ? DINO.slideH : DINO.standH;
  return (
    d.x + DINO.hx - f > o.x - b.hx && d.x - DINO.hx + f < o.x + b.hx &&
    d.y + h - f > b.y0 && d.y + f < b.y1 &&
    d.z + DINO.hz - f > o.z - b.hz && d.z - DINO.hz + f < o.z + b.hz
  );
}

// ---------- Scoring ----------

const comboMultiplier = (combo) => Math.min(5, 1 + Math.floor(combo / 5) * 0.5);

// Largest score a run could plausibly reach. Used to reject tampered leaderboard entries.
function isPlausible({ score, dist, timeSec, coins, nearMisses = 0 }) {
  if (![score, dist, timeSec, coins].every(Number.isFinite) || score < 0 || dist < 0) return false;
  if (dist > timeSec * MAX_SPEED * DASH_MULT * 1.05 + 50) return false;
  // Combo multiplier caps at 5 and the double-score power-up doubles it.
  const maxScore = (dist + coins * 10 + nearMisses * 50) * 10 * 1.02 + 50;
  return score <= maxScore;
}

// ---------- Missions, achievements, daily ----------

const MISSION_DEFS = [
  { key: 'coins', text: (n) => `Collect ${n} coins`, targets: [100, 250], reward: 60 },
  { key: 'birds', text: (n) => `Slide under ${n} birds`, targets: [20, 40], reward: 80 },
  { key: 'dist', text: (n) => `Run ${n} m in total`, targets: [3000, 8000], reward: 70 },
  { key: 'near', text: (n) => `Pull off ${n} near misses`, targets: [15, 30], reward: 90 },
  { key: 'jumps', text: (n) => `Jump ${n} times`, targets: [60, 150], reward: 50 },
  { key: 'power', text: (n) => `Collect ${n} power-ups`, targets: [6, 12], reward: 70 },
];

function newMission(rng, activeKeys = []) {
  const pool = MISSION_DEFS.filter((m) => !activeKeys.includes(m.key));
  const def = pool[Math.floor(rng() * pool.length)];
  const target = def.targets[Math.floor(rng() * def.targets.length)];
  return { key: def.key, target, reward: def.reward, progress: 0 };
}

function missionText(m) {
  return MISSION_DEFS.find((d) => d.key === m.key).text(m.target);
}

// Adds one run's stats to every mission. Completed ones are replaced.
function applyRunStats(missions, stats, rng = Math.random) {
  const completed = [];
  let next = missions.map((m) => ({ ...m, progress: Math.min(m.target, m.progress + (stats[m.key] || 0)) }));
  next = next.map((m, i) => {
    if (m.progress >= m.target) {
      completed.push(m);
      const keys = next.filter((_, j) => j !== i).map((x) => x.key);
      return newMission(rng, keys);
    }
    return m;
  });
  return { missions: next, completed };
}

const ACHIEVEMENTS = [
  { id: 'first500', name: 'Warm-up', desc: 'Run 500 m in one go', test: (r) => r.dist >= 500 },
  { id: 'far2000', name: 'Long Stride', desc: 'Run 2,000 m in one go', test: (r) => r.dist >= 2000 },
  { id: 'far5000', name: 'Extinction Event', desc: 'Run 5,000 m in one go', test: (r) => r.dist >= 5000 },
  { id: 'coins100', name: 'Egg Money', desc: 'Collect 100 coins in one run', test: (r) => r.coins >= 100 },
  { id: 'near10', name: 'Too Close', desc: '10 near misses in one run', test: (r) => r.near >= 10 },
  { id: 'combo5', name: 'On a Roll', desc: 'Reach a 3x multiplier', test: (r) => r.maxMult >= 3 },
];

function checkAchievements(owned, run) {
  return ACHIEVEMENTS.filter((a) => !owned[a.id] && a.test(run)).map((a) => a.id);
}

function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dailyChallenge(key) {
  const seed = hashString('dino-run-' + key);
  const rng = mulberry32(seed);
  const goal = 1500 + Math.floor(rng() * 26) * 100;
  return { seed, goal, reward: 150 };
}

const SKINS = [
  { id: 'emerald', name: 'Emerald', price: 0, body: 0x3fae5a, belly: 0xd9e8a8, spike: 0xf2b134 },
  { id: 'crimson', name: 'Crimson', price: 150, body: 0xd8432f, belly: 0xffd9b0, spike: 0x2b1b1b },
  { id: 'azure', name: 'Azure', price: 300, body: 0x2f8bd9, belly: 0xcfeaff, spike: 0xfff1a8 },
  { id: 'gold', name: 'Gilded', price: 600, body: 0xe2a823, belly: 0xfff0b8, spike: 0x7a4a10, metal: true },
  { id: 'neon', name: 'Neon', price: 1000, body: 0x16e0c8, belly: 0xc9fff6, spike: 0xff3df0, glow: true },
];

const TRAILS = [
  { id: 'none', name: 'None', price: 0, color: 0xffffff },
  { id: 'dust', name: 'Dust', price: 100, color: 0xd9c7a0 },
  { id: 'flame', name: 'Flame', price: 400, color: 0xff6a1a },
  { id: 'spark', name: 'Sparkle', price: 600, color: 0xfff2a0 },
  { id: 'rainbow', name: 'Rainbow', price: 1000, color: 0xffffff },
];


// ---- src/audio.js ----
// audio.js: procedural music and effects with the Web Audio API. No asset files needed.

function createAudio() {
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


// ---- src/gfx.js ----
// gfx.js: everything drawn by three.js. Game rules live in logic.js.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- Shared curve uniform: bends the whole world in the vertex shader ----------
const uCurve = { value: new THREE.Vector2(0, 0) };

function patchBend(m) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCurve = uCurve;
    sh.vertexShader = 'uniform vec2 uCurve;\n' + sh.vertexShader.replace(
      '#include <project_vertex>',
      `vec4 mvPosition = vec4( transformed, 1.0 );
       #ifdef USE_INSTANCING
         mvPosition = instanceMatrix * mvPosition;
       #endif
       mvPosition = modelViewMatrix * mvPosition;
       float bd = max(-mvPosition.z - 9.0, 0.0);
       mvPosition.x += uCurve.x * bd * bd;
       mvPosition.y += uCurve.y * bd * bd;
       gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  m.customProgramCacheKey = () => 'bend';
  return m;
}

function stdMat(color, o = {}) {
  return patchBend(new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, flatShading: true, ...o }));
}

function canvasTex(w, h, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function mergeGeos(list) {
  const ps = [], ns = [];
  for (const g of list) {
    const n = g.index ? g.toNonIndexed() : g;
    ps.push(n.attributes.position.array); ns.push(n.attributes.normal.array);
  }
  const cat = (arrs) => {
    let len = 0; arrs.forEach((a) => (len += a.length));
    const out = new Float32Array(len); let o = 0;
    arrs.forEach((a) => { out.set(a, o); o += a.length; });
    return out;
  };
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(cat(ps), 3));
  m.setAttribute('normal', new THREE.BufferAttribute(cat(ns), 3));
  return m;
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
// Clone a geometry with a position / rotation / scale baked in.
function G(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const g = geo.clone();
  _m4.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  g.applyMatrix4(_m4);
  return g;
}

// ---------- Biomes ----------
const col = (h) => new THREE.Color(h);
const BIOMES = [
  { name: 'Dust Basin', ground: col(0xd0a24f), road: col(0x5a4c40), top: col(0x2f7fd0), hor: col(0xf8d49a), fog: 0.0095, sun: col(0xfff0cf), dusk: 0 },
  { name: 'Fern Hollow', ground: col(0x2f7d36), road: col(0x3a3d34), top: col(0x1f8a9e), hor: col(0xbfe8b0), fog: 0.013, sun: col(0xfff6d8), dusk: 0 },
  { name: 'Frost Ridge', ground: col(0xe7f0f7), road: col(0x59636d), top: col(0x5f93c9), hor: col(0xdbe9f5), fog: 0.014, sun: col(0xf2f6ff), dusk: 0 },
  { name: 'Ember Flats', ground: col(0x2a1c1a), road: col(0x1d1a1c), top: col(0x2a0f14), hor: col(0xff6a2a), fog: 0.012, sun: col(0xffa060), dusk: 0.75 },
];
const NIGHT_TOP = col(0x040716), NIGHT_HOR = col(0x1b2250), MOON = col(0x8fa8ff), ORANGE = col(0xff8a4c);

// Decoration shapes per biome. Each variant is a list of coloured parts that get merged.
function buildDecoShapes() {
  const cyl = (rt, rb, h, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);
  const cone = (r, h, s = 9) => new THREE.ConeGeometry(r, h, s);
  const ico = (r, d = 1) => new THREE.IcosahedronGeometry(r, d);
  const dod = (r) => new THREE.DodecahedronGeometry(r, 0);
  return [
    [ // desert
      [{ c: 0x3c7a3a, g: [G(cyl(0.32, 0.38, 3.2), 0, 1.6, 0), G(cyl(0.2, 0.2, 0.9), 0.55, 1.5, 0, 0, 0, Math.PI / 2), G(cyl(0.2, 0.2, 1.0), 0.95, 2.0, 0), G(cyl(0.2, 0.2, 0.9), -0.55, 1.1, 0, 0, 0, Math.PI / 2), G(cyl(0.2, 0.2, 0.9), -0.95, 1.5, 0)] }],
      [{ c: 0xb0845a, g: [G(dod(1.2), 0, 0.7, 0, 0, 0.4, 0, 1, 0.7, 1.2), G(dod(0.6), 1.3, 0.35, 0.4)] }],
      [{ c: 0xc58a46, g: [G(cone(2.6, 1.1, 7), 0, 0.5, 0, 0, 0, 0, 1.6, 0.8, 1.2)] }],
    ],
    [ // jungle
      [{ c: 0x6b4a2c, g: [G(cyl(0.25, 0.4, 4.6, 8), 0, 2.3, 0, 0, 0, 0.08)] }, { c: 0x1e7a35, g: [G(ico(1.9, 1), 0.2, 5.1, 0, 0, 0, 0, 1.4, 0.65, 1.4), G(ico(1.3, 1), 1.0, 4.4, 0.4, 0, 0, 0, 1.2, 0.6, 1.2), G(ico(1.2, 1), -0.8, 4.5, -0.3, 0, 0, 0, 1.2, 0.6, 1.2)] }],
      [{ c: 0x2d9a45, g: [G(ico(1.1, 1), 0, 0.8, 0, 0, 0, 0, 1.3, 0.8, 1.3), G(ico(0.7, 1), 1.2, 0.5, 0.5)] }],
      [{ c: 0x6b4a2c, g: [G(cyl(0.18, 0.28, 3.2, 8), 0, 1.6, 0)] }, { c: 0x4fb36a, g: [G(cone(1.6, 3.0, 8), 0, 4.1, 0)] }],
    ],
    [ // snow
      [{ c: 0x4a3426, g: [G(cyl(0.2, 0.3, 1.5, 7), 0, 0.75, 0)] }, { c: 0x1f5a45, g: [G(cone(2.0, 2.6), 0, 2.4, 0), G(cone(1.5, 2.2), 0, 3.8, 0), G(cone(1.0, 1.8), 0, 5.0, 0)] }, { c: 0xf2f8ff, g: [G(cone(0.5, 0.9), 0, 6.2, 0), G(cone(0.9, 0.7), 0, 4.9, 0.02)] }],
      [{ c: 0x8f9bb0, g: [G(dod(1.3), 0, 0.7, 0, 0, 0.3, 0, 1, 0.8, 1.1)] }, { c: 0xf2f8ff, g: [G(dod(0.9), 0, 1.15, 0, 0, 0.3, 0, 1, 0.5, 1)] }],
      [{ c: 0xcfe8f7, g: [G(cone(0.6, 3.2, 5), 0, 1.6, 0), G(cone(0.45, 2.2, 5), 0.8, 1.1, 0.3, 0, 0, -0.2)] }],
    ],
    [ // volcano
      [{ c: 0x1b1416, g: [G(cone(1.5, 6.2, 6), 0, 3.1, 0)] }, { c: 0xff7a2a, e: 2.4, g: [G(cone(0.55, 1.6, 6), 0, 6.1, 0)] }],
      [{ c: 0x241b1d, g: [G(dod(1.0), 0, 0.6, 0, 0, 0.5, 0, 1, 0.8, 1)] }, { c: 0xff5a1a, e: 1.8, g: [G(ico(0.35, 0), 0.2, 1.1, 0.2)] }],
      [{ c: 0xff6a1a, e: 1.6, g: [G(new THREE.CircleGeometry(2.0, 14), 0, 0.04, 0, -Math.PI / 2, 0, 0, 1.4, 1, 1)] }],
    ],
  ].map((variants) => variants.map((parts) => parts.map((p) => ({ color: p.c, emissive: p.e || 0, geo: mergeGeos(p.g) }))));
}

// ---------- Obstacles ----------
const OUTLINE_MAT = patchBend(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));

function addOutline(mesh, list) {
  const l = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 35), OUTLINE_MAT);
  mesh.add(l); list.push(l);
}

function buildObstacle(type, outlines) {
  const g = new THREE.Group();
  const add = (geo, m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, outline = true) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
    g.add(mesh);
    if (outline) addOutline(mesh, outlines);
    return mesh;
  };
  if (type === CELL.LOW) { // fallen log with hazard bands
    const bark = stdMat(0x7a4a2b), cut = stdMat(0xd9a76a), band = stdMat(0xffb12a, { emissive: 0xff8a00, emissiveIntensity: 0.6 });
    add(new THREE.CylinderGeometry(0.46, 0.5, 2.0, 12), bark, 0, 0.5, 0, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 12), cut, 1.0, 0.5, 0, 0, 0, Math.PI / 2, false);
    add(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 12), cut, -1.0, 0.5, 0, 0, 0, Math.PI / 2, false);
    add(new THREE.CylinderGeometry(0.52, 0.52, 0.18, 12), band, 0.45, 0.5, 0, 0, 0, Math.PI / 2, false);
    add(new THREE.CylinderGeometry(0.52, 0.52, 0.18, 12), band, -0.45, 0.5, 0, 0, 0, Math.PI / 2, false);
  } else if (type === CELL.TALL) { // rock spire with a warning band
    const rock = stdMat(0x5c6475), band = stdMat(0xff4a3a, { emissive: 0xff2a1a, emissiveIntensity: 0.9 });
    add(new THREE.ConeGeometry(1.0, 3.7, 7), rock, 0, 1.85, 0);
    add(new THREE.ConeGeometry(0.62, 2.4, 6), rock, 0.55, 1.2, 0.25, 0, 0.4, 0.12);
    add(new THREE.CylinderGeometry(0.62, 0.78, 0.22, 7), band, 0, 1.15, 0, 0, 0, 0, false);
  } else { // pterodactyl
    const skin = stdMat(0xc23a46), dark = stdMat(0x3a1a28), eye = stdMat(0xffffff, { emissive: 0xff2a2a, emissiveIntensity: 1.2 });
    g.userData.wings = [];
    const body = add(new THREE.SphereGeometry(0.42, 12, 10), skin, 0, 1.75, 0, 0, 0, 0, true);
    body.scale.set(0.9, 0.8, 1.7);
    add(new THREE.ConeGeometry(0.2, 0.9, 6), dark, 0, 1.8, -0.95, -Math.PI / 2, 0, 0);
    add(new THREE.ConeGeometry(0.16, 0.9, 5), dark, 0, 1.9, 0.9, Math.PI / 2, 0, 0);
    add(new THREE.ConeGeometry(0.18, 0.7, 5), dark, 0, 1.95, -0.2, 0, 0, 0);
    add(new THREE.SphereGeometry(0.07, 6, 6), eye, 0.18, 1.88, -0.55, 0, 0, 0, false);
    add(new THREE.SphereGeometry(0.07, 6, 6), eye, -0.18, 1.88, -0.55, 0, 0, 0, false);
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, 1.8, 0);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.05, 0.9), skin);
      wing.position.set(side * 0.72, 0, 0.05);
      pivot.add(wing); addOutline(wing, outlines);
      g.add(pivot); g.userData.wings.push({ pivot, side });
    }
  }
  g.visible = false;
  return g;
}

// ---------- Particles ----------
function createParticles(N = 700) {
  const pos = new Float32Array(N * 3), colr = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
  const vel = new Float32Array(N * 3), life = new Float32Array(N), maxLife = new Float32Array(N), grav = new Float32Array(N), baseSize = new Float32Array(N);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colr, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uCurve, uScale: { value: 600 } },
    vertexShader: `
      uniform vec2 uCurve; uniform float uScale;
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      varying vec3 vC; varying float vA;
      void main(){
        vC = aColor; vA = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float bd = max(-mv.z - 9.0, 0.0);
        mv.x += uCurve.x * bd * bd; mv.y += uCurve.y * bd * bd;
        gl_PointSize = aSize * uScale / max(-mv.z, 0.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vC; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA;
        gl_FragColor = vec4(vC * a * 1.6, a);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  let head = 0;
  const c = new THREE.Color();
  return {
    points: pts,
    emit(x, y, z, vx, vy, vz, lifeS, sz, color, g = 0) {
      const i = head; head = (head + 1) % N;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
      life[i] = maxLife[i] = lifeS; grav[i] = g; baseSize[i] = sz;
      c.set(color);
      colr[i * 3] = c.r; colr[i * 3 + 1] = c.g; colr[i * 3 + 2] = c.b;
    },
    burst(x, y, z, n, speed, lifeS, sz, color, g = 6) {
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI - Math.PI / 2, s = speed * (0.3 + Math.random());
        this.emit(x, y, z, Math.cos(a) * Math.cos(b) * s, Math.sin(b) * s + speed * 0.3, Math.sin(a) * Math.cos(b) * s, lifeS * (0.6 + Math.random() * 0.6), sz * (0.6 + Math.random() * 0.8), color, g);
      }
    },
    update(dt, scroll) {
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) { alpha[i] = 0; size[i] = 0; continue; }
        life[i] -= dt;
        vel[i * 3 + 1] -= grav[i] * dt;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt + scroll;
        const t = clamp(life[i] / maxLife[i], 0, 1);
        alpha[i] = t; size[i] = baseSize[i] * (0.4 + 0.6 * t);
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true; geo.attributes.aColor.needsUpdate = true;
    },
    setScale(px) { mat.uniforms.uScale.value = px; },
  };
}

// ---------- Dino ----------
function buildDino() {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x3fae5a, roughness: 0.55 });
  const belly = new THREE.MeshStandardMaterial({ color: 0xd9e8a8, roughness: 0.7 });
  const spike = new THREE.MeshStandardMaterial({ color: 0xf2b134, roughness: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.3 });
  const mesh = (geo, m, x, y, z, sx = 1, sy = 1, sz = 1, parent = group) => {
    const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); parent.add(o); return o;
  };
  const rig = new THREE.Group(); group.add(rig); // posed as a whole while sliding / jumping
  const torso = new THREE.Group(); torso.position.set(0, 1.1, 0); rig.add(torso);
  mesh(new THREE.SphereGeometry(0.78, 24, 18), body, 0, 0, 0.05, 0.85, 0.95, 1.35, torso);
  mesh(new THREE.SphereGeometry(0.6, 20, 14), belly, 0, -0.18, -0.12, 0.72, 0.7, 1.15, torso);
  for (let i = 0; i < 5; i++) mesh(new THREE.ConeGeometry(0.16 - i * 0.01, 0.42, 5), spike, 0, 0.62 - i * 0.03, 0.55 - i * 0.34, 1, 1, 1, torso);
  // neck and head
  const head = new THREE.Group(); head.position.set(0, 0.75, -0.95); torso.add(head);
  mesh(new THREE.SphereGeometry(0.52, 20, 14), body, 0, 0.1, -0.1, 0.95, 0.85, 1.15, head);
  mesh(new THREE.BoxGeometry(0.5, 0.34, 0.6), body, 0, -0.02, -0.62, 1, 1, 1, head);
  mesh(new THREE.BoxGeometry(0.46, 0.1, 0.55), belly, 0, -0.22, -0.6, 1, 1, 1, head);
  for (const s of [-1, 1]) {
    mesh(new THREE.SphereGeometry(0.15, 12, 10), white, s * 0.3, 0.3, -0.35, 1, 1, 1, head);
    mesh(new THREE.SphereGeometry(0.075, 10, 8), black, s * 0.37, 0.31, -0.45, 1, 1, 1, head);
    mesh(new THREE.SphereGeometry(0.04, 6, 6), black, s * 0.12, 0.08, -0.93, 1, 1, 1, head);
  }
  // tail
  const tail = [];
  let parent = torso, px = 0, py = -0.05, pz = 0.85;
  for (let i = 0; i < 3; i++) {
    const seg = new THREE.Group(); seg.position.set(px, py, pz); parent.add(seg);
    mesh(new THREE.ConeGeometry(0.42 - i * 0.1, 0.9, 10), body, 0, 0, 0.35, 1, 1, 1, seg).rotation.x = Math.PI / 2;
    tail.push(seg); parent = seg; px = 0; py = 0; pz = 0.65;
  }
  // legs
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(s * 0.4, 0.85, 0.15); rig.add(hip);
    mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.55, 10), body, 0, -0.25, 0, 1, 1, 1, hip);
    const knee = new THREE.Group(); knee.position.set(0, -0.5, 0); hip.add(knee);
    mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.5, 8), body, 0, -0.2, 0, 1, 1, 1, knee);
    mesh(new THREE.BoxGeometry(0.28, 0.12, 0.5), belly, 0, -0.42, -0.1, 1, 1, 1, knee);
    legs.push({ hip, knee });
  }
  // little arms
  for (const s of [-1, 1]) {
    const arm = mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.4, 6), body, s * 0.62, 0.0, -0.55, 1, 1, 1, torso);
    arm.rotation.z = s * 0.5; arm.rotation.x = -0.6;
  }
  // blob shadow
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; shadow.scale.set(0.9, 1.4, 1);
  group.add(shadow);
  // shield bubble and dash aura
  const shield = new THREE.Mesh(new THREE.SphereGeometry(1.5, 28, 18), new THREE.MeshBasicMaterial({ color: 0x4cc4ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
  shield.position.y = 1.2; shield.scale.set(1, 1.15, 1.45); shield.visible = false; group.add(shield);

  function setSkin(s) {
    body.color.setHex(s.body); belly.color.setHex(s.belly); spike.color.setHex(s.spike);
    body.metalness = s.metal ? 0.55 : 0; body.roughness = s.metal ? 0.32 : 0.55;
    body.emissive.setHex(s.glow ? s.body : s.metal ? 0x4a3000 : 0x000000);
    body.emissiveIntensity = s.glow ? 0.9 : s.metal ? 0.5 : 0;
    spike.emissive.setHex(s.glow ? s.spike : 0x000000); spike.emissiveIntensity = s.glow ? 1.2 : 0;
  }
  return { group, rig, torso, head, tail, legs, shadow, shield, setSkin, mats: { body, belly, spike } };
}

// ---------- Post-processing shader (speed streaks, vignette, chromatic fringe, flash) ----------
function fxShader() {
  return {
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uSpeed: { value: 0 }, uVig: { value: 0.4 }, uChroma: { value: 0 }, uFlash: { value: new THREE.Vector3() } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime, uSpeed, uVig, uChroma; uniform vec3 uFlash;
      varying vec2 vUv;
      float hash(float n){ return fract(sin(n) * 43758.5453); }
      void main(){
        vec2 c = vUv - 0.5; float r = length(c);
        float s = uSpeed * 0.035;
        vec3 col = vec3(0.0);
        for (int i = 0; i < 6; i++) col += texture2D(tDiffuse, 0.5 + c * (1.0 - s * float(i) / 5.0)).rgb;
        col /= 6.0;
        if (uChroma > 0.0) {
          vec2 o = c * uChroma * r;
          col.r = texture2D(tDiffuse, vUv + o).r; col.b = texture2D(tDiffuse, vUv - o).b;
        }
        float a = atan(c.y, c.x);
        float cell = floor(a * 70.0 + floor(uTime * 22.0) * 3.0);
        float line = step(0.93, hash(cell)) * smoothstep(0.3, 0.62, r) * uSpeed;
        col += vec3(0.9, 0.95, 1.0) * line * 0.35;
        col *= 1.0 - uVig * smoothstep(0.38, 0.9, r);
        col += uFlash;
        gl_FragColor = vec4(col, 1.0);
      }`,
  };
}

// ---------- The whole scene ----------
function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xf8d49a, 0.01);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 520);

  // lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x886644, 0.9);
  const sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(hemi, sunLight, sunLight.target);

  // sky
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() }, uMoonDir: { value: new THREE.Vector3() }, uNight: { value: 0 }, uTime: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 uTop, uHor, uSunCol, uSunDir, uMoonDir; uniform float uNight, uTime;
        varying vec3 vDir;
        float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(uHor, uTop, pow(h, 0.55));
          if (d.y < 0.0) col = uHor * 0.9;
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunCol * (smoothstep(0.9990, 0.9996, sd) * 3.0 + pow(sd, 64.0) * 0.55 + pow(sd, 8.0) * 0.18) * (1.0 - uNight);
          float md = max(dot(d, uMoonDir), 0.0);
          col += vec3(0.75, 0.82, 1.0) * (smoothstep(0.9993, 0.9997, md) * 2.0 + pow(md, 90.0) * 0.25) * uNight;
          float sv = hash(floor(d * 190.0));
          float star = step(0.9965, sv) * smoothstep(0.0, 0.3, d.y);
          col += vec3(star * (0.6 + 0.4 * sin(uTime * 2.0 + sv * 50.0)) * 2.0) * uNight;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -10; sky.frustumCulled = false;
  scene.add(sky);

  // road and ground, scrolled with texture offsets
  const roadTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#b8b8b8'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) { const v = 150 + Math.random() * 90; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  }, 1, 25);
  const lineTex = canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = '#ffffff';
    const edge = 0.035 * w;
    g.fillRect(0.03 * w, 0, edge * 0.7, h); g.fillRect(0.97 * w - edge * 0.7, 0, edge * 0.7, h);
    for (const u of [0.5 - 1.1 / 7.4, 0.5 + 1.1 / 7.4]) { g.fillRect(u * w - 3, 0.1 * h, 6, 0.25 * h); g.fillRect(u * w - 3, 0.6 * h, 6, 0.25 * h); }
  }, 1, 25);
  const groundTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3200; i++) { const v = 170 + Math.random() * 85; g.fillStyle = `rgb(${v},${v},${v})`; const s = 1 + Math.random() * 3; g.fillRect(Math.random() * w, Math.random() * h, s, s); }
  }, 18, 200 / 12);
  const roadMat = patchBend(new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.9 }));
  const lineMat = patchBend(new THREE.MeshStandardMaterial({ map: lineTex, transparent: true, depthWrite: false, emissive: 0xffffff, emissiveMap: lineTex, emissiveIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: -2 }));
  const groundMat = patchBend(new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }));
  const road = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 200, 1, 90), roadMat);
  road.rotation.x = -Math.PI / 2; road.position.set(0, 0, -80);
  const lines = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 200, 1, 90), lineMat);
  lines.rotation.x = -Math.PI / 2; lines.position.set(0, 0.012, -80);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 200, 1, 90), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.04, -80);
  for (const m of [road, lines, ground]) m.frustumCulled = false;
  scene.add(ground, road, lines);

  // decorations (instanced, pooled)
  const shapes = buildDecoShapes();
  const decoMeshes = shapes.map((variants) => variants.map((parts) => parts.map((p) => {
    const im = new THREE.InstancedMesh(p.geo, stdMat(p.color, p.emissive ? { emissive: p.color, emissiveIntensity: p.emissive } : {}), 100);
    im.frustumCulled = false; im.visible = false; im.count = 0;
    scene.add(im);
    return im;
  })));
  const DECO_N = 90;
  const decos = [];
  const decoRand = () => ({ side: Math.random() < 0.5 ? -1 : 1, off: 5.2 + Math.pow(Math.random(), 1.6) * 52, s: 0.8 + Math.random() * 0.9, yaw: Math.random() * 6.28 });
  function placeDeco(d, z, biome) {
    Object.assign(d, decoRand());
    d.z = z; d.biome = biome; d.v = Math.floor(Math.random() * shapes[biome].length);
  }
  for (let i = 0; i < DECO_N; i++) { const d = {}; placeDeco(d, -190 + (i / DECO_N) * 200, 0); decos.push(d); }

  // obstacles
  const outlines = [];
  const obsPool = { [CELL.LOW]: [], [CELL.TALL]: [], [CELL.BIRD]: [] };
  const obsRoot = new THREE.Group(); scene.add(obsRoot);
  for (const t of [CELL.LOW, CELL.TALL, CELL.BIRD]) {
    const n = t === CELL.BIRD ? 16 : t === CELL.LOW ? 30 : 24;
    for (let i = 0; i < n; i++) { const o = buildObstacle(t, outlines); obsRoot.add(o); obsPool[t].push(o); }
  }

  obsRoot.traverse((o) => { o.frustumCulled = false; }); // the bend shader moves them away from their bounds

  // coins
  const COIN_N = 200;
  const coinMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.12, 20).rotateX(Math.PI / 2),
    patchBend(new THREE.MeshStandardMaterial({ color: 0xffc233, metalness: 0.6, roughness: 0.3, emissive: 0xffa000, emissiveIntensity: 0.9 })), COIN_N);
  coinMesh.frustumCulled = false; coinMesh.count = 0; scene.add(coinMesh);

  // power-up pickups
  const PICK_COLORS = { shield: 0x3ab0ff, magnet: 0xff4a5a, double: 0xffd23a, dash: 0xb06bff };
  const pickups = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.Group();
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), patchBend(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.3 })));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.06, 8, 28), patchBend(new THREE.MeshBasicMaterial({ color: 0xffffff })));
    g.add(orb, ring); g.visible = false; scene.add(g);
    pickups.push({ group: g, orb, ring });
  }

  const particles = createParticles();
  scene.add(particles.points);
  const dino = buildDino();
  scene.add(dino.group);

  // post-processing
  let post = null;
  if (EffectComposer) {
    try {
      // 4x MSAA on the HDR target, because the canvas itself cannot antialias when post-processing is on.
      const target = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(renderer, target);
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.6, 0.82);
      composer.addPass(bloom);
      const fx = new ShaderPass(fxShader());
      composer.addPass(fx);
      composer.addPass(new OutputPass());
      post = { composer, bloom, fx };
    } catch (e) { console.warn('Post-processing failed to start', e); post = null; }
  }

  // ----- environment blending -----
  const env = { top: new THREE.Color(), hor: new THREE.Color(), ground: new THREE.Color(), road: new THREE.Color(), sun: new THREE.Color(), fog: 0.01, night: 0, init: false };
  const tmp = new THREE.Color(), sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
  function updateEnv(dt, biome, tod, t) {
    const B = BIOMES[biome];
    const a = tod * Math.PI * 2, sa = Math.sin(a);
    const day = smooth(-0.12, 0.3, sa);
    const night = Math.max(1 - day, B.dusk);
    const k = env.init ? 1 - Math.exp(-dt * 1.6) : 1; env.init = true;
    tmp.copy(B.top).lerp(NIGHT_TOP, night); env.top.lerp(tmp, k);
    tmp.copy(B.hor).lerp(NIGHT_HOR, night * (1 - B.dusk * 0.7));
    const warm = Math.max(0, 1 - Math.abs(sa) * 4) * (1 - B.dusk);
    tmp.lerp(ORANGE, warm * 0.6); env.hor.lerp(tmp, k);
    env.ground.lerp(B.ground, k); env.road.lerp(B.road, k); env.sun.lerp(B.sun, k);
    env.fog = lerp(env.fog, B.fog * (1 + night * 0.35), k); env.night = lerp(env.night, night, k);
    sunDir.set(Math.cos(a) * 0.9, sa, -0.75).normalize();
    moonDir.set(-Math.cos(a) * 0.9, -sa, -0.75).normalize();
    const su = sky.material.uniforms;
    su.uTop.value.copy(env.top); su.uHor.value.copy(env.hor); su.uSunCol.value.copy(env.sun);
    su.uSunDir.value.copy(sunDir); su.uMoonDir.value.copy(moonDir); su.uNight.value = env.night; su.uTime.value = t;
    scene.fog.color.copy(env.hor); scene.fog.density = env.fog;
    groundMat.color.copy(env.ground); roadMat.color.copy(env.road);
    hemi.color.copy(env.top).lerp(env.hor, 0.4); hemi.groundColor.copy(env.ground).multiplyScalar(0.6);
    hemi.intensity = lerp(0.95, 0.42, env.night);
    sunLight.color.copy(env.sun).lerp(MOON, env.night);
    sunLight.intensity = lerp(1.5, 0.6, env.night);
    lightDir.copy(sunDir).lerp(moonDir, env.night).normalize();
    sunLight.position.copy(lightDir).multiplyScalar(40);
    // keep the sky above the horizon for lighting even when the sun is low
    sunLight.position.y = Math.max(sunLight.position.y, 8);
  }

  // ----- per-frame decoration update -----
  const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scl = new THREE.Vector3(), _mat = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
  function updateDecos(scroll, biome) {
    const counts = shapes.map((v) => v.map(() => 0));
    for (const d of decos) {
      d.z += scroll;
      if (d.z > 16) placeDeco(d, -190 - Math.random() * 12, biome);
      _pos.set(d.side * d.off, 0, d.z);
      _quat.setFromAxisAngle(_up, d.yaw);
      _scl.setScalar(d.s);
      _mat.compose(_pos, _quat, _scl);
      const k = counts[d.biome][d.v]++;
      for (const im of decoMeshes[d.biome][d.v]) im.setMatrixAt(k, _mat);
    }
    decoMeshes.forEach((variants, b) => variants.forEach((parts, v) => parts.forEach((im) => {
      im.count = counts[b][v]; im.visible = counts[b][v] > 0; im.instanceMatrix.needsUpdate = true;
    })));
  }

  function scrollGround(dd) {
    roadTex.offset.y += dd / 8; lineTex.offset.y += dd / 8; groundTex.offset.y += dd / 12;
    roadTex.offset.y %= 1; lineTex.offset.y %= 1; groundTex.offset.y %= 1;
  }

  function resize(w, h, pr) {
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    if (post) { post.composer.setPixelRatio(pr); post.composer.setSize(w, h); }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    particles.setScale(h * pr * 0.62);
  }

  return {
    renderer, scene, camera, post, dino, particles, decos, obsPool, outlines, coinMesh, COIN_N, pickups, PICK_COLORS,
    updateEnv, updateDecos, scrollGround, resize, env, uCurve, lines, road, ground,
    render() { if (post) post.composer.render(); else renderer.render(scene, camera); },
  };
}


// ---- src/main.js ----
// main.js: game state, input, loop, HUD and menus.

const SAVE_KEY = 'dino-run-3d-v1';
const ACTIONS = ['left', 'right', 'jump', 'slide', 'pause'];
const ACTION_LABEL = { left: 'Move left', right: 'Move right', jump: 'Jump', slide: 'Slide', pause: 'Pause' };
const DEFAULT_KEYS = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], jump: ['ArrowUp', 'KeyW', 'Space'],
  slide: ['ArrowDown', 'KeyS'], pause: ['Escape', 'KeyP'],
};
const SPAWN_AHEAD = 150;
const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------- Save data ----------
const defaultSave = () => ({
  coins: 0, best: 0, skin: 'emerald', trail: 'none', skins: { emerald: true }, trails: { none: true },
  missions: [], ach: {}, lb: [], daily: { key: '', done: false, best: 0 }, runs: 0,
  settings: { music: 0.6, sfx: 0.8, mute: false, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, outline: true, quality: 'auto' },
  keys: JSON.parse(JSON.stringify(DEFAULT_KEYS)),
});
function mergeInto(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) mergeInto(a[k], b[k]);
    else if (k in a) a[k] = b[k];
  }
  return a;
}
function loadSave() {
  const s = defaultSave();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      mergeInto(s, o);
      s.skins = Object.assign({ emerald: true }, o.skins || {});
      s.trails = Object.assign({ none: true }, o.trails || {});
      s.ach = o.ach && typeof o.ach === 'object' ? o.ach : {};
      s.missions = Array.isArray(o.missions) ? o.missions.filter((m) => MISSION_DEFS.some((d) => d.key === m.key)) : [];
      s.lb = Array.isArray(o.lb) ? o.lb.filter((e) => e && isPlausible({ score: e.score, dist: e.dist, timeSec: e.t, coins: e.coins, nearMisses: e.near || 0 })) : [];
      for (const a of ACTIONS) if (!Array.isArray(s.keys[a]) || !s.keys[a].length) s.keys[a] = DEFAULT_KEYS[a].slice();
    }
  } catch (e) { /* storage unavailable: play without saving */ }
  for (const k of ['coins', 'best']) if (!Number.isFinite(s[k]) || s[k] < 0) s[k] = 0;
  if (!SKINS.some((x) => x.id === s.skin) || !s.skins[s.skin]) s.skin = 'emerald';
  if (!TRAILS.some((x) => x.id === s.trail) || !s.trails[s.trail]) s.trail = 'none';
  while (s.missions.length < 3) s.missions.push(newMission(Math.random, s.missions.map((m) => m.key)));
  s.missions = s.missions.slice(0, 3);
  return s;
}
let save = loadSave();
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* ignore */ } }

// ---------- Setup ----------
const world = createWorld($('gl'));
const audio = createAudio();
const dino = world.dino;
const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const rand = (a, b) => a + Math.random() * (b - a);

const SCREENS = ['menu', 'hud', 'pause', 'over', 'shop', 'missions', 'settings', 'about'];
function setScreens(...names) {
  SCREENS.forEach((n) => {
    const el = $(n), on = names.includes(n);
    if (on && !el.classList.contains('on')) { const pn = el.querySelector('.panel'); if (pn) pn.scrollTop = 0; }
    el.classList.toggle('on', on);
  });
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

// ---------- Quality ----------
const Q = { pr: 1, target: 1, slow: 0, fast: 0 };
function applyQuality() {
  const dpr = window.devicePixelRatio || 1, mode = save.settings.quality;
  Q.target = mode === 'low' ? 1 : mode === 'high' ? Math.min(dpr, 2) : Math.min(dpr, 1.75);
  Q.pr = Q.target;
  if (world.post) world.post.bloom.enabled = mode !== 'low';
  resize();
}
function resize() {
  const app = $('app'), w = app.clientWidth, h = app.clientHeight;
  if (w > 0 && h > 0) world.resize(w, h, Q.pr);
}
window.addEventListener('resize', resize);
if (window.ResizeObserver) new ResizeObserver(resize).observe($('app'));

function applySettings() {
  const s = save.settings;
  audio.setVolumes(s.music, s.sfx, s.mute);
  world.outlines.forEach((l) => (l.visible = s.outline));
}

// ---------- Game state ----------
const GAME = {
  phase: 'menu', mode: 'normal', time: 0, dist: 0, score: 0, runCoins: 0, combo: 0, comboT: 0, near: 0, jumps: 0, birds: 0, powerUps: 0, maxMult: 1,
  speed: BASE_SPEED, lane: 1, x: 0, y: 0, vy: 0, grounded: true, slide: 0, jumpBuf: 0, invuln: 0, powers: {},
  dir: null, cursor: 0, obstacles: [], coinList: [], picks: [], revived: false, shake: 0, flash: [0, 0, 0],
  cT: 0, lastCount: 0, deadT: 0, biome: 0, tod: 0.17, runT: 0, eval: null, committed: true, dailyHit: false,
  animPhase: 0, curveT: 0, lastToast: 0, panelFrom: 'menu', menuT: 0, camBlend: 1, dustT: 0, trailT: 0, hue: 0,
};
const daily = () => dailyChallenge(dateKey());

// ---------- Obstacles, coins, pickups ----------
function acquire(type) {
  const p = world.obsPool[type];
  for (const o of p) if (!o.visible) return o;
  return null;
}
function clearWorld() {
  for (const o of GAME.obstacles) o.obj.visible = false;
  for (const k of GAME.picks) k.obj.group.visible = false;
  GAME.obstacles.length = 0; GAME.coinList.length = 0; GAME.picks.length = 0;
}
function placeRow(row, dist) {
  for (let l = 0; l < 3; l++) {
    const t = row.cells[l];
    if (t !== CELL.EMPTY) {
      const obj = acquire(t);
      if (obj) {
        obj.visible = true; obj.position.set(LANES[l], 0, 100);
        GAME.obstacles.push({ obj, type: t, x: LANES[l], dist, minDx: 9, minY: 9, passed: false, hit: false, slid: false });
      }
    }
    if (row.coins[l]) GAME.coinList.push({ x: LANES[l], y: row.coinY, dist, ph: Math.random() * 6 });
  }
  if (row.power) {
    const free = world.pickups.find((p) => !p.group.visible && !GAME.picks.some((k) => k.obj === p));
    if (free) {
      const c = world.PICK_COLORS[row.power.type];
      free.orb.material.color.setHex(c); free.orb.material.emissive.setHex(c); free.ring.material.color.setHex(c);
      free.group.visible = true;
      GAME.picks.push({ obj: free, type: row.power.type, x: LANES[row.power.lane], dist });
    }
  }
}
function spawnAhead() {
  let guard = 0;
  while (GAME.cursor - GAME.dist < SPAWN_AHEAD && guard++ < 40) {
    const row = GAME.dir.next(GAME.cursor, speedAt(GAME.cursor));
    GAME.cursor += row.gap;
    placeRow(row, GAME.cursor);
  }
}

// ---------- Run lifecycle ----------
function resetDinoPose() {
  dino.rig.rotation.set(0, 0, 0); dino.rig.position.set(0, 0, 0); dino.rig.scale.set(1, 1, 1);
  dino.shield.visible = false;
}
function startRun(mode) {
  audio.unlock(); audio.startMusic();
  commitRun();
  const seed = mode === 'daily' ? daily().seed : (Math.random() * 2147483647) | 0;
  Object.assign(GAME, {
    mode, phase: 'count', dist: 0, score: 0, runCoins: 0, combo: 0, comboT: 0, near: 0, jumps: 0, birds: 0, powerUps: 0, maxMult: 1,
    speed: BASE_SPEED, lane: 1, x: 0, y: 0, vy: 0, grounded: true, slide: 0, jumpBuf: 0, invuln: 0, powers: {}, runT: 0,
    dir: new Director(seed), cursor: 38, revived: false, shake: 0, flash: [0, 0, 0], deadT: 0, biome: 0, tod: 0.17, eval: null, committed: false, dailyHit: false,
    cT: 3.4, lastCount: 4, curveT: 0,
  });
  if (mode === 'daily' && save.daily.key !== dateKey()) save.daily = { key: dateKey(), done: false, best: 0 };
  clearWorld(); resetDinoPose(); world.dino.setSkin(SKINS.find((s) => s.id === save.skin));
  spawnAhead();
  const goal = $('dailyGoal');
  goal.hidden = mode !== 'daily';
  if (mode === 'daily') { goal.textContent = `Daily goal ${fmt(daily().goal)}`; goal.style.color = ''; }
  updateHud(true);
  setScreens('hud');
  audio.setIntensity(0);
}
function beginResume() { GAME.phase = 'count'; GAME.cT = 2.4; GAME.lastCount = 3; setScreens('hud'); }

function endRunNow() {
  GAME.phase = 'dying'; GAME.deadT = 0; dino.group.visible = true;
  audio.sfx('crash'); audio.setIntensity(0.05);
  GAME.shake = save.settings.reduced ? 0 : 1; if (!save.settings.reduced) GAME.flash = [0.55, 0.06, 0.04];
  const p = dino.group.position;
  world.particles.burst(p.x, 1.2, 0, 40, 9, 0.9, 0.9, 0xff6a3a, 9);
  world.particles.burst(p.x, 1.2, 0, 24, 6, 0.7, 0.7, 0xffd23a, 9);
}

function evaluateRun() {
  const stats = { coins: GAME.runCoins, birds: GAME.birds, dist: Math.floor(GAME.dist), near: GAME.near, jumps: GAME.jumps, power: GAME.powerUps };
  const { missions, completed } = applyRunStats(save.missions, stats);
  const newAch = checkAchievements(save.ach, { dist: GAME.dist, coins: GAME.runCoins, near: GAME.near, maxMult: GAME.maxMult });
  let dailyReward = 0;
  if (GAME.mode === 'daily' && !save.daily.done && Math.floor(GAME.score) >= daily().goal) dailyReward = daily().reward;
  const bonus = completed.reduce((a, m) => a + m.reward, 0) + dailyReward;
  return { missions, completed, newAch, dailyReward, bonus, newBest: Math.floor(GAME.score) > save.best };
}
function commitRun() {
  if (GAME.committed) return;
  GAME.committed = true;
  const ev = GAME.eval || evaluateRun();
  const score = Math.floor(GAME.score);
  save.runs++;
  save.best = Math.max(save.best, score);
  save.missions = ev.missions;
  ev.newAch.forEach((id) => (save.ach[id] = true));
  save.coins += ev.bonus;
  if (GAME.mode === 'daily') {
    if (save.daily.key !== dateKey()) save.daily = { key: dateKey(), done: false, best: 0 };
    save.daily.best = Math.max(save.daily.best, score);
    if (ev.dailyReward) save.daily.done = true;
  }
  const entry = { score, dist: Math.floor(GAME.dist), coins: GAME.runCoins, near: GAME.near, t: Math.max(1, Math.round(GAME.runT)), d: dateKey() };
  if (isPlausible({ score, dist: entry.dist, timeSec: entry.t, coins: entry.coins, nearMisses: entry.near })) {
    save.lb.push(entry); save.lb.sort((a, b) => b.score - a.score); save.lb = save.lb.slice(0, 5);
  }
  persist();
}
function showOver() {
  GAME.phase = 'over';
  GAME.eval = evaluateRun();
  const ev = GAME.eval, score = Math.floor(GAME.score);
  $('overScore').textContent = fmt(score);
  $('overNew').hidden = !ev.newBest || score === 0;
  $('overDist').textContent = fmt(GAME.dist) + ' m';
  $('overCoins').textContent = fmt(GAME.runCoins);
  $('overBest').textContent = fmt(Math.max(save.best, score));
  $('overNear').textContent = fmt(GAME.near);
  const lines = [];
  if (ev.dailyReward) lines.push(`<div class="row"><span class="done">Daily goal reached</span><span class="coinline">+${ev.dailyReward}</span></div>`);
  else if (GAME.mode === 'daily') lines.push(`<div class="row"><span>Daily goal ${fmt(daily().goal)}</span><span class="hint">${save.daily.done ? 'Already claimed today' : 'Not reached'}</span></div>`);
  ev.completed.forEach((m) => lines.push(`<div class="row"><span class="done">Mission done: ${missionText(m)}</span><span class="coinline">+${m.reward}</span></div>`));
  ev.newAch.forEach((id) => lines.push(`<div class="row"><span class="done">Achievement: ${ACHIEVEMENTS.find((a) => a.id === id).name}</span></div>`));
  $('overExtra').innerHTML = lines.join('');
  $('btnRevive').hidden = GAME.revived || save.coins < REVIVE_COST;
  $('btnRevive').textContent = `Revive (${REVIVE_COST} coins)`;
  if (ev.completed.length || ev.newAch.length || ev.dailyReward) audio.sfx('win');
  setScreens('over');
}
function revive() {
  if (GAME.revived || save.coins < REVIVE_COST) { audio.sfx('no'); return; }
  save.coins -= REVIVE_COST; persist();
  GAME.revived = true; GAME.eval = null;
  for (let i = GAME.obstacles.length - 1; i >= 0; i--) {
    const o = GAME.obstacles[i];
    if (o.dist > GAME.dist - 4 && o.dist < GAME.dist + 55) { o.obj.visible = false; GAME.obstacles.splice(i, 1); }
  }
  resetDinoPose();
  Object.assign(GAME, { y: 0, vy: 0, grounded: true, slide: 0, invuln: 3, shake: 0 });
  GAME.cT = 2.4; GAME.lastCount = 3; GAME.phase = 'count';
  audio.sfx('buy');
  setScreens('hud');
}
function toMenu() {
  commitRun(); clearWorld(); resetDinoPose();
  Object.assign(GAME, { phase: 'menu', x: 0, y: 0, lane: 1, powers: {} });
  dino.group.position.set(0, 0, 0);
  dino.setSkin(SKINS.find((s) => s.id === save.skin));
  audio.setIntensity(0);
  refreshMenu(); setScreens('menu');
}
function refreshMenu() {
  $('menuBest').textContent = fmt(save.best);
  $('menuCoins').textContent = fmt(save.coins);
  const d = daily();
  const done = save.daily.key === dateKey() && save.daily.done;
  $('btnDaily').textContent = done ? 'Daily Run (done)' : `Daily Run ${fmt(d.goal)}`;
  $('menuHint').textContent = isTouch ? 'Swipe to move, jump and slide. Tap to jump.' : 'Space to start. Arrows or A and D to change lane, Up to jump, Down to slide.';
}

// ---------- Input ----------
let rebinding = null;
const actionOf = (code) => ACTIONS.find((a) => save.keys[a].includes(code));
// A lane change made just before an obstacle reaches you counts as a close call when it passes.
function markDodge() {
  for (const o of GAME.obstacles) {
    const ahead = o.dist - GAME.dist;
    if (!o.hit && Math.abs(o.x - LANES[GAME.lane]) < 0.5 && ahead > 0 && ahead < GAME.speed * 0.5) o.dodged = true;
  }
}
function doLeft() { if (GAME.phase === 'play' && GAME.lane > 0) { markDodge(); GAME.lane--; audio.sfx('lane'); } }
function doRight() { if (GAME.phase === 'play' && GAME.lane < 2) { markDodge(); GAME.lane++; audio.sfx('lane'); } }
function doJump() {
  if (GAME.phase !== 'play') return;
  if (GAME.grounded) {
    GAME.vy = JUMP_V; GAME.grounded = false; GAME.slide = 0; GAME.jumps++; audio.sfx('jump');
    world.particles.burst(GAME.x, 0.2, 0.4, 8, 3, 0.4, 0.5, 0xd9c7a0, 4);
  } else GAME.jumpBuf = 0.14;
}
function doSlide() {
  if (GAME.phase !== 'play') return;
  if (GAME.grounded) { if (GAME.slide <= 0) audio.sfx('slide'); GAME.slide = SLIDE_T; } else { GAME.vy = Math.min(GAME.vy, -22); GAME.slide = SLIDE_T; }
}
function togglePause() {
  if (GAME.phase === 'play' || GAME.phase === 'count') { GAME.phaseBeforePause = GAME.phase; GAME.phase = 'pause'; setScreens('hud', 'pause'); audio.sfx('ui'); }
  else if (GAME.phase === 'pause') { $('btnResume').click(); }
}
window.addEventListener('keydown', (e) => {
  if (rebinding) {
    e.preventDefault();
    if (e.code !== 'Escape') { save.keys[rebinding] = [e.code]; persist(); }
    rebinding = null; renderKeys(); return;
  }
  const a = actionOf(e.code);
  const inPanel = GAME.phase === 'menu' && !$('menu').classList.contains('on');
  if (GAME.phase === 'menu' && !inPanel && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); startRun('normal'); return; }
  if (!a) return;
  if (a !== 'pause' && GAME.phase === 'play') e.preventDefault();
  if (e.repeat && a !== 'jump' && a !== 'slide') return;
  if (a === 'left') doLeft(); else if (a === 'right') doRight(); else if (a === 'jump') doJump(); else if (a === 'slide') doSlide(); else if (a === 'pause') {
    if (GAME.phase === 'menu' && inPanel) { if ($('about').classList.contains('on')) $('btnAboutBack').click(); else $('btnShopBack').click(); } else togglePause();
  }
});
// Touch and mouse: swipe to move, tap to jump / start.
let ptr = null;
const glc = $('gl');
glc.addEventListener('pointerdown', (e) => { audio.unlock(); ptr = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, id: e.pointerId }; try { glc.setPointerCapture(e.pointerId); } catch (_) {} });
glc.addEventListener('pointermove', (e) => {
  if (!ptr || ptr.id !== e.pointerId) return;
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
  if (Math.hypot(dx, dy) < 30) return;
  ptr.moved = true;
  if (Math.abs(dx) > Math.abs(dy)) (dx > 0 ? doRight : doLeft)(); else (dy < 0 ? doJump : doSlide)();
  ptr.x = e.clientX; ptr.y = e.clientY;
});
glc.addEventListener('pointerup', (e) => {
  if (!ptr || ptr.id !== e.pointerId) return;
  const tap = !ptr.moved && performance.now() - ptr.t < 300;
  ptr = null;
  if (!tap) return;
  if (GAME.phase === 'play') doJump();
});
glc.addEventListener('pointercancel', () => (ptr = null));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (GAME.phase === 'play' || GAME.phase === 'count') togglePause(); if (GAME.phase === 'over') commitRun(); audio.stopMusic(); }
  else if (GAME.phase !== 'menu' || save.settings) audio.startMusic();
});
window.addEventListener('pagehide', () => { if (GAME.phase === 'over') commitRun(); persist(); });

// ---------- HUD ----------
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
const POWER_NAME = { shield: 'Shield', magnet: 'Magnet', double: 'Double score', dash: 'Dash' };
function updateHud(force) {
  setText('hudScore', fmt(GAME.score));
  setText('hudDist', fmt(GAME.dist) + ' m');
  setText('hudCoins', fmt(GAME.runCoins));
  const m = comboMultiplier(GAME.combo);
  setText('hudMult', 'x' + (m % 1 ? m.toFixed(1) : m) + (GAME.powers.double > 0 ? ' x2' : ''));
  $('multBar').style.width = (m >= 5 ? 100 : ((GAME.combo % 5) / 5) * 100) + '%';
  const key = Object.keys(GAME.powers).filter((k) => GAME.powers[k] > 0).map((k) => k + Math.ceil(GAME.powers[k])).join(',');
  if (force || hudCache.pw !== key) {
    hudCache.pw = key;
    $('powers').innerHTML = Object.keys(GAME.powers).filter((k) => GAME.powers[k] > 0).map((k) => {
      const c = '#' + world.PICK_COLORS[k].toString(16).padStart(6, '0');
      return `<div class="power"><i style="color:${c}"></i>${POWER_NAME[k]} ${Math.ceil(GAME.powers[k])}s</div>`;
    }).join('');
  }
  if (GAME.mode === 'daily' && !hudCache.dg && GAME.score >= daily().goal) {
    hudCache.dg = true; $('dailyGoal').textContent = 'Daily goal reached'; $('dailyGoal').style.color = 'var(--good)'; toast('Daily goal reached');
  }
  if (force) hudCache.dg = false;
}
function banner(text) {
  const el = $('banner'); el.textContent = text;
  if (save.settings.reduced) { el.style.opacity = 1; el.style.transform = 'translate(-50%,0)'; clearTimeout(banner.t); banner.t = setTimeout(() => (el.style.opacity = 0), 1800); return; }
  el.animate([{ opacity: 0, transform: 'translate(-50%,-20px)' }, { opacity: 1, transform: 'translate(-50%,0)', offset: 0.15 }, { opacity: 1, transform: 'translate(-50%,0)', offset: 0.8 }, { opacity: 0, transform: 'translate(-50%,-10px)' }], { duration: 2400, easing: 'ease-out' });
}
function toast(text) {
  const el = $('toast'); el.textContent = text;
  el.animate([{ opacity: 0, transform: 'translate(-50%,10px)' }, { opacity: 1, transform: 'translate(-50%,0)', offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0, transform: 'translate(-50%,-8px)' }], { duration: 1000, easing: 'ease-out' });
}
function countText(n) {
  const el = $('count'); el.textContent = n;
  el.animate([{ opacity: 0, transform: 'scale(1.5)' }, { opacity: 1, transform: 'scale(1)', offset: 0.25 }, { opacity: 0, transform: 'scale(0.85)' }], { duration: n === 'GO' ? 600 : 900, easing: 'ease-out' });
}

// ---------- Simulation ----------
function activate(type) {
  const dur = { shield: 15, magnet: 9, double: 10, dash: 4 }[type];
  GAME.powers[type] = dur;
  if (type === 'dash') GAME.invuln = Math.max(GAME.invuln, dur + 0.4);
  GAME.powerUps++; audio.sfx(type === 'shield' ? 'shield' : 'power');
  toast(POWER_NAME[type]);
  if (!save.settings.reduced) GAME.flash = [0.12, 0.12, 0.16];
}
function gainCombo(n) {
  GAME.combo += n; GAME.comboT = 4;
  const m = comboMultiplier(GAME.combo);
  if (m > GAME.maxMult) GAME.maxMult = m;
}
function smash(o, color) {
  o.obj.visible = false; o.hit = true;
  world.particles.burst(o.x, 1.2, GAME.dist - o.dist, 26, 8, 0.8, 0.8, color, 9);
}
function stepPlay(dt) {
  GAME.runT += dt;
  const diffSpeed = speedAt(GAME.dist) * (GAME.powers.dash > 0 ? DASH_MULT : 1);
  GAME.speed += (diffSpeed - GAME.speed) * Math.min(1, dt * 3);
  const ds = GAME.speed * dt;
  GAME.dist += ds;
  const m = comboMultiplier(GAME.combo);
  GAME.score += ds * m * (GAME.powers.double > 0 ? 2 : 1);

  // timers
  GAME.comboT -= dt; if (GAME.comboT <= 0) GAME.combo = 0;
  GAME.invuln = Math.max(0, GAME.invuln - dt);
  GAME.jumpBuf = Math.max(0, GAME.jumpBuf - dt);
  for (const k of Object.keys(GAME.powers)) if (GAME.powers[k] > 0) { GAME.powers[k] -= dt; if (GAME.powers[k] <= 0) { GAME.powers[k] = 0; if (k === 'shield') dino.shield.visible = false; } }
  dino.shield.visible = GAME.powers.shield > 0;

  // lane and vertical motion
  const tx = LANES[GAME.lane];
  GAME.x += (tx - GAME.x) * Math.min(1, dt * 16);
  if (!GAME.grounded) {
    GAME.vy -= GRAV * dt; GAME.y += GAME.vy * dt;
    if (GAME.y <= 0) {
      GAME.y = 0; GAME.vy = 0; GAME.grounded = true; audio.sfx('land');
      world.particles.burst(GAME.x, 0.2, 0.4, 10, 3.5, 0.45, 0.5, 0xd9c7a0, 4);
      if (GAME.jumpBuf > 0) { GAME.jumpBuf = 0; doJump(); }
    }
  }
  if (GAME.slide > 0) GAME.slide -= dt;
  const sliding = GAME.slide > 0 && GAME.grounded;

  // obstacles
  for (let i = GAME.obstacles.length - 1; i >= 0; i--) {
    const o = GAME.obstacles[i];
    const z = GAME.dist - o.dist;
    if (z > 9) { o.obj.visible = false; GAME.obstacles.splice(i, 1); continue; }
    if (o.hit) continue;
    if (Math.abs(z) < 1.7) {
      const dx = Math.abs(GAME.x - o.x);
      if (Math.abs(z) < 1.0) {
        if (dx < o.minDx) o.minDx = dx;
        if (dx < 1.0 && GAME.y < o.minY) o.minY = GAME.y;
        if (o.type === CELL.BIRD && sliding && dx < 0.9) o.slid = true;
      }
      if (collides({ x: GAME.x, y: GAME.y, z: 0, sliding }, { type: o.type, x: o.x, z })) {
        if (GAME.powers.dash > 0) { smash(o, 0xffffff); GAME.score += 25; audio.sfx('break'); continue; }
        if (GAME.invuln > 0) continue;
        if (GAME.powers.shield > 0) {
          GAME.powers.shield = 0; GAME.invuln = 1.2; smash(o, 0x4cc4ff); audio.sfx('break');
          GAME.shake = Math.max(GAME.shake, save.settings.reduced ? 0 : 0.5); continue;
        }
        endRunNow(); return;
      }
    }
    if (z > 1.0 && !o.passed) {
      o.passed = true;
      if (o.type === CELL.BIRD && o.slid) GAME.birds++;
      const lateral = o.minDx > 1.27 && o.minDx < 1.7;
      const overLow = o.type === CELL.LOW && o.minDx < 1.0 && o.minY < 1.45;
      if ((lateral || overLow || o.dodged) && GAME.powers.dash <= 0) {
        GAME.near++; gainCombo(2); GAME.score += 50 * m; audio.sfx('near');
        if (GAME.time - GAME.lastToast > 0.7) { GAME.lastToast = GAME.time; toast('Close call +50'); }
      }
    }
  }
  // coins (magnet pulls them in)
  const magnet = GAME.powers.magnet > 0;
  for (let i = GAME.coinList.length - 1; i >= 0; i--) {
    const c = GAME.coinList[i];
    let z = GAME.dist - c.dist;
    if (z > 8) { GAME.coinList.splice(i, 1); continue; }
    if (magnet && z > -16 && z < 2 && Math.abs(c.x - GAME.x) < 7) {
      const k = Math.min(1, dt * 9);
      c.x += (GAME.x - c.x) * k; c.dist += (GAME.dist - c.dist) * k; c.y += (GAME.y + 1 - c.y) * k;
      z = GAME.dist - c.dist;
    }
    if (Math.abs(z) < 1.0 && Math.abs(c.x - GAME.x) < 1.2 && Math.abs(c.y - (GAME.y + (sliding ? 0.5 : 1.0))) < 1.0) {
      GAME.coinList.splice(i, 1); GAME.runCoins++; save.coins++; gainCombo(1); GAME.score += 5 * m;
      audio.sfx('coin');
      world.particles.burst(c.x, c.y, z, 6, 3.5, 0.4, 0.45, 0xffc233, 4);
    }
  }
  // pickups
  for (let i = GAME.picks.length - 1; i >= 0; i--) {
    const k = GAME.picks[i], z = GAME.dist - k.dist;
    if (z > 8) { k.obj.group.visible = false; GAME.picks.splice(i, 1); continue; }
    if (Math.abs(z) < 1.3 && Math.abs(k.x - GAME.x) < 1.5) {
      k.obj.group.visible = false; GAME.picks.splice(i, 1); activate(k.type);
      world.particles.burst(GAME.x, 1.4, 0, 28, 6, 0.8, 0.7, world.PICK_COLORS[k.type], 3);
    }
  }
  spawnAhead();

  // biome and time of day
  const b = Math.floor(GAME.dist / 1100) % BIOMES.length;
  if (b !== GAME.biome) { GAME.biome = b; banner(BIOMES[b].name); }
  GAME.tod = 0.17 + GAME.dist / 5200;
  audio.setIntensity((GAME.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));
  return ds;
}

// ---------- Visual update ----------
const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(1, 1, 1), tmpE = new THREE.Euler(), UP = new THREE.Vector3(0, 1, 0);
let animT = 0;

function animateDino(dt, running, sliding) {
  const sp = running ? GAME.speed : 0;
  GAME.animPhase += dt * (4 + sp * 0.42);
  const p = GAME.animPhase;
  const air = !GAME.grounded;
  dino.legs.forEach((leg, i) => {
    const o = i * Math.PI;
    if (air) { leg.hip.rotation.x += ((i ? -0.5 : 0.7) - leg.hip.rotation.x) * Math.min(1, dt * 14); leg.knee.rotation.x += (0.9 - leg.knee.rotation.x) * Math.min(1, dt * 14); }
    else { leg.hip.rotation.x = Math.sin(p + o) * 0.95; leg.knee.rotation.x = Math.max(0, -Math.sin(p + o + 1.0)) * 1.2; }
  });
  dino.torso.position.y = 1.1 + (air ? 0 : Math.abs(Math.sin(p)) * 0.07);
  dino.torso.rotation.x = air ? -0.12 : Math.sin(p * 2) * 0.02;
  dino.head.rotation.x = Math.sin(p * 2 + 1) * 0.05 + (air ? 0.15 : 0);
  dino.tail.forEach((s, i) => { s.rotation.y = Math.sin(p * 0.5 - i * 0.8) * 0.28; s.rotation.x = (air ? 0.25 : 0) + Math.sin(p - i) * 0.04; });
  // slide pose
  const rig = dino.rig;
  const tp = sliding ? 1 : 0;
  rig.rotation.x += (-0.55 * tp - rig.rotation.x) * Math.min(1, dt * 16);
  rig.scale.y += ((sliding ? 0.62 : 1) - rig.scale.y) * Math.min(1, dt * 16);
  rig.position.z += ((sliding ? 0.15 : 0) - rig.position.z) * Math.min(1, dt * 16);
  const lean = clamp((GAME.x - LANES[GAME.lane]) * 0.14, -0.3, 0.3);
  rig.rotation.z += (lean - rig.rotation.z) * Math.min(1, dt * 12);
  dino.group.position.set(GAME.x, GAME.y, 0);
  const h = clamp(1 - GAME.y / 5, 0.4, 1);
  dino.shadow.position.y = -GAME.y + 0.03; dino.shadow.scale.set(0.9 * h, 1.4 * h, 1);
  dino.shield.rotation.y += dt * 1.2;
  dino.shield.material.opacity = 0.18 + Math.sin(animT * 6) * 0.05;
  dino.group.visible = !(GAME.invuln > 0 && GAME.powers.dash <= 0 && Math.floor(animT * 14) % 2 === 0 && GAME.phase === 'play');
}

function emitTrail(dt) {
  const t = save.trail, P = world.particles;
  if (t === 'none') {
    GAME.dustT -= dt;
    if (GAME.dustT <= 0 && GAME.grounded && GAME.speed > 5) { GAME.dustT = 0.07; P.emit(GAME.x + rand(-0.3, 0.3), 0.15, 0.9, rand(-0.5, 0.5), rand(0.4, 1.2), 1.5, 0.45, 0.45, 0xb9a47a, 0); }
    return;
  }
  GAME.trailT -= dt;
  const rate = t === 'spark' ? 0.025 : 0.016;
  while (GAME.trailT <= 0) {
    GAME.trailT += rate;
    const x = GAME.x + rand(-0.35, 0.35), y = GAME.y + rand(0.3, 1.4);
    if (t === 'dust') P.emit(x, 0.2, 1.0, rand(-1, 1), rand(0.4, 1.5), 2, 0.6, 0.7, 0xd9c7a0, 0);
    else if (t === 'flame') P.emit(x, y, 1.6, rand(-0.6, 0.6), rand(0.8, 2.4), 2, 0.5, 0.9, Math.random() < 0.4 ? 0xffd23a : 0xff6a1a, -1);
    else if (t === 'spark') P.emit(x, y, 1.2, rand(-2, 2), rand(-1, 2.5), rand(1, 4), 0.7, 0.4, 0xfff2a0, 4);
    else { GAME.hue = (GAME.hue + 0.02) % 1; const c = new THREE.Color().setHSL(GAME.hue, 1, 0.55); P.emit(x, y, 1.3, rand(-0.4, 0.4), rand(-0.2, 0.6), 2, 0.8, 0.8, c.getHex(), 0); }
  }
}

function drawEntities() {
  // coins
  let n = 0;
  for (const c of GAME.coinList) {
    if (n >= world.COIN_N) break;
    tmpP.set(c.x, c.y + Math.sin(animT * 3 + c.ph) * 0.08, GAME.dist - c.dist);
    tmpQ.setFromAxisAngle(UP, animT * 3 + c.ph);
    tmpM.compose(tmpP, tmpQ, tmpS);
    world.coinMesh.setMatrixAt(n++, tmpM);
  }
  world.coinMesh.count = n; world.coinMesh.instanceMatrix.needsUpdate = true;
  for (const o of GAME.obstacles) {
    if (o.hit) continue;
    const z = GAME.dist - o.dist;
    o.obj.position.set(o.x, 0, z);
    const w = o.obj.userData.wings;
    if (w) w.forEach((s) => (s.pivot.rotation.z = s.side * Math.sin(animT * 13 + o.dist) * 0.6));
  }
  for (const k of GAME.picks) {
    const g = k.obj.group;
    g.position.set(k.x, 1.3 + Math.sin(animT * 3 + k.dist) * 0.15, GAME.dist - k.dist);
    k.obj.orb.rotation.y = animT * 2; k.obj.ring.rotation.x = animT * 2.4; k.obj.ring.rotation.y = animT * 1.3;
  }
}

function frame(realDt) {
  animT += realDt;
  GAME.time += realDt;
  const dt = Math.min(realDt, 0.05);
  const reduced = save.settings.reduced;
  let ds = 0, running = false, sliding = false;

  if (GAME.phase === 'play') { const r = stepPlay(dt); if (GAME.phase === 'play') { ds = r || 0; running = true; sliding = GAME.slide > 0 && GAME.grounded; } }
  else if (GAME.phase === 'count') {
    GAME.cT -= dt;
    const n = Math.ceil(GAME.cT - 0.4);
    if (n !== GAME.lastCount) {
      GAME.lastCount = n;
      if (n > 0) { countText(n); audio.sfx('tick'); } else if (n === 0) { countText('GO'); audio.sfx('go'); }
    }
    if (GAME.cT <= 0) { GAME.phase = 'play'; }
    GAME.x += (LANES[GAME.lane] - GAME.x) * Math.min(1, dt * 12);
    tmpE.set(0, 0, 0);
  } else if (GAME.phase === 'menu') {
    ds = 9 * dt; running = true; GAME.speed = 9; GAME.menuT += dt;
    GAME.biome = Math.max(0, Math.floor(GAME.menuT / 18)) % BIOMES.length;
    GAME.tod = 0.2 + GAME.menuT / 160;
    GAME.dist += 0;
  } else if (GAME.phase === 'dying') {
    GAME.deadT += realDt;
    const t = GAME.deadT;
    GAME.vy -= 22 * dt; GAME.y = Math.max(0, GAME.y + Math.max(GAME.vy, -20) * dt * 0.3);
    dino.rig.rotation.z += dt * 7; dino.rig.rotation.x += dt * 3;
    dino.group.position.z += 6 * dt;
    if (t > 1.15) showOver();
  }

  // dying keeps the world frozen, menu scrolls the scenery without advancing the run
  const scroll = GAME.phase === 'dying' ? 0 : ds;
  if (GAME.phase !== 'pause') {
    world.scrollGround(scroll);
    world.updateDecos(scroll, GAME.biome);
    world.particles.update(dt, scroll);
    if (GAME.phase === 'play' || GAME.phase === 'count') emitTrail(dt);
    if (GAME.phase === 'menu') { GAME.dustT -= dt; if (GAME.dustT <= 0) { GAME.dustT = 0.08; world.particles.emit(rand(-0.4, 0.4), 0.15, 0.9, rand(-0.4, 0.4), rand(0.4, 1.2), 1.5, 0.45, 0.45, 0xb9a47a, 0); } }
    if (GAME.phase !== 'dying') animateDino(dt, running || GAME.phase === 'count', sliding);
    drawEntities();
  }

  // curve of the road, kept mild
  const ct = (GAME.phase === 'menu' ? GAME.menuT * 4 : GAME.dist) * 0.012;
  const curveAmp = reduced ? 0.5 : 1;
  const cx = (Math.sin(ct) + 0.6 * Math.sin(ct * 0.43 + 1.3)) * 0.00034 * curveAmp;
  const cy = (Math.sin(ct * 0.7 + 0.5) * 0.00024 - 0.00006) * curveAmp;
  world.uCurve.value.x += (cx - world.uCurve.value.x) * Math.min(1, dt * 2);
  world.uCurve.value.y += (cy - world.uCurve.value.y) * Math.min(1, dt * 2);

  world.updateEnv(dt, GAME.biome, ((GAME.tod % 1) + 1) % 1, animT);

  // camera
  const menu = GAME.phase === 'menu';
  GAME.camBlend += ((menu ? 1 : 0) - GAME.camBlend) * Math.min(1, dt * 2.2);
  const cb = GAME.camBlend;
  const speedT = clamp((GAME.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED), 0, 1.4);
  const wide = window.innerWidth / Math.max(1, window.innerHeight);
  const portrait = clamp(1 - wide, 0, 0.6); // narrow screens need a wider, higher view to keep all three lanes visible
  const gx = GAME.x * 0.6, gy = 4.4 + GAME.y * 0.25 + portrait * 1.5, gz = 7.8 + portrait * 5;
  const mx = wide > 1 ? 2.8 : 1.2, my = 2.4, mz = 6.4;
  let sx = 0, sy = 0;
  if (GAME.shake > 0.01 && !reduced) { sx = (Math.random() - 0.5) * GAME.shake * 0.5; sy = (Math.random() - 0.5) * GAME.shake * 0.5; }
  GAME.shake *= Math.exp(-dt * 6);
  world.camera.position.set(lerp(gx, mx, cb) + sx, lerp(gy, my, cb) + sy, lerp(gz, mz, cb));
  const lookX = lerp(GAME.x * 0.35, wide > 1 ? -1.3 : -0.2, cb), lookY = lerp(1.3 + GAME.y * 0.3, 1.25, cb), lookZ = lerp(-12, 0, cb);
  world.camera.lookAt(lookX, lookY, lookZ);
  const fov = 62 + portrait * 30 + speedT * 9 + (GAME.powers.dash > 0 && !reduced ? 8 : 0);
  if (Math.abs(world.camera.fov - fov) > 0.05) { world.camera.fov += (fov - world.camera.fov) * Math.min(1, dt * 5); world.camera.updateProjectionMatrix(); }

  // post fx
  if (world.post) {
    const u = world.post.fx.uniforms;
    u.uTime.value = animT;
    const target = reduced ? 0 : speedT * (GAME.phase === 'play' ? 1 : 0) + (GAME.powers.dash > 0 ? 0.6 : 0);
    u.uSpeed.value += (target - u.uSpeed.value) * Math.min(1, dt * 4);
    u.uChroma.value = reduced ? 0 : (GAME.powers.dash > 0 ? 0.03 : 0) + GAME.shake * 0.04;
    u.uVig.value = 0.38 + (GAME.phase === 'dying' ? 0.3 : 0);
    GAME.flash = GAME.flash.map((v) => v * Math.exp(-dt * 7));
    u.uFlash.value.set(GAME.flash[0], GAME.flash[1], GAME.flash[2]);
    world.post.bloom.strength = lerp(0.42, 0.75, world.env.night);
  }

  if (GAME.phase === 'play' || GAME.phase === 'count') updateHud(false);

  // auto quality: lower the resolution if frames are slow
  if (save.settings.quality === 'auto' && !document.hidden && GAME.phase !== 'pause') {
    if (realDt > 0.026) Q.slow++; else Q.slow = Math.max(0, Q.slow - 1);
    if (Q.slow > 45 && Q.pr > 0.7) { Q.pr = Math.max(0.7, Q.pr - 0.2); Q.slow = 0; if (Q.pr < 0.9 && world.post) world.post.bloom.enabled = false; resize(); }
  }
  world.render();
}

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const rd = Math.max(0, Math.min(0.1, (now - last) / 1000));
  last = now;
  try { frame(rd); } catch (e) { console.error(e); if (!loop.warned) { loop.warned = true; toast('Rendering error, see console'); } }
}

// ---------- Menus ----------
$('btnPlay').onclick = () => { audio.unlock(); startRun('normal'); };
$('btnDaily').onclick = () => { audio.unlock(); startRun('daily'); };
$('btnPause').onclick = togglePause;
$('btnResume').onclick = () => { audio.sfx('ui'); GAME.phase = GAME.phaseBeforePause === 'count' ? 'count' : 'play'; if (GAME.phase === 'play') { beginResume(); } else setScreens('hud'); };
$('btnQuit').onclick = () => { audio.sfx('ui'); GAME.dist = GAME.dist; toMenu(); };
$('btnAgain').onclick = () => startRun(GAME.mode);
$('btnHome').onclick = () => { audio.sfx('ui'); toMenu(); };
$('btnRevive').onclick = revive;
$('btnPauseSettings').onclick = () => { GAME.panelFrom = 'pause'; openSettings(); };
$('btnSettings').onclick = () => { GAME.panelFrom = 'menu'; openSettings(); audio.unlock(); audio.sfx('ui'); };
$('btnSetBack').onclick = () => { audio.sfx('ui'); persist(); if (GAME.panelFrom === 'pause') setScreens('hud', 'pause'); else setScreens('menu'); };
$('btnMissions').onclick = () => { audio.unlock(); audio.sfx('ui'); renderMissions(); setScreens('missions'); };
$('btnAbout').onclick = () => { audio.unlock(); audio.sfx('ui'); setScreens('about'); };
$('btnAboutBack').onclick = () => { audio.sfx('ui'); setScreens('menu'); };
$('btnMissBack').onclick = () => { audio.sfx('ui'); setScreens('menu'); };
$('btnShop').onclick = () => { audio.unlock(); audio.sfx('ui'); shop.open(); };
$('btnShopBack').onclick = () => { audio.sfx('ui'); shop.close(); };

function openSettings() {
  const s = save.settings;
  $('setMusic').value = s.music; $('setSfx').value = s.sfx; $('setMute').checked = s.mute;
  $('setReduced').checked = s.reduced; $('setOutline').checked = s.outline; $('setQuality').value = s.quality;
  renderKeys();
  setScreens(GAME.panelFrom === 'pause' ? 'settings' : 'settings');
  if (GAME.panelFrom === 'pause') $('hud').classList.add('on');
}
$('setMusic').oninput = (e) => { save.settings.music = +e.target.value; applySettings(); };
$('setSfx').oninput = (e) => { save.settings.sfx = +e.target.value; applySettings(); };
$('setSfx').onchange = () => audio.sfx('coin');
$('setMute').onchange = (e) => { save.settings.mute = e.target.checked; applySettings(); };
$('setReduced').onchange = (e) => { save.settings.reduced = e.target.checked; };
$('setOutline').onchange = (e) => { save.settings.outline = e.target.checked; applySettings(); };
$('setQuality').onchange = (e) => { save.settings.quality = e.target.value; applyQuality(); };
function renderKeys() {
  const label = (c) => c.replace('Key', '').replace('Arrow', '').replace('Digit', '').replace('Escape', 'Esc');
  $('keyList').innerHTML = ACTIONS.map((a) => `<div class="row"><span>${ACTION_LABEL[a]}</span><button class="keybtn ${rebinding === a ? 'wait' : ''}" data-a="${a}">${rebinding === a ? 'Press a key' : save.keys[a].map(label).join(' / ')}</button></div>`).join('');
  $('keyList').querySelectorAll('.keybtn').forEach((b) => (b.onclick = () => { rebinding = b.dataset.a; renderKeys(); }));
}
$('btnKeysReset').onclick = () => { save.keys = JSON.parse(JSON.stringify(DEFAULT_KEYS)); persist(); rebinding = null; renderKeys(); audio.sfx('ui'); };
let eraseArmed = 0;
$('btnResetAll').onclick = (e) => {
  if (!eraseArmed) { eraseArmed = setTimeout(() => { eraseArmed = 0; e.target.textContent = 'Erase progress'; }, 3000); e.target.textContent = 'Tap again to erase'; return; }
  clearTimeout(eraseArmed); eraseArmed = 0; e.target.textContent = 'Erase progress';
  save = defaultSave(); save.missions = []; while (save.missions.length < 3) save.missions.push(newMission(Math.random, save.missions.map((m) => m.key)));
  persist(); applySettings(); applyQuality(); dino.setSkin(SKINS[0]); refreshMenu(); openSettings(); audio.sfx('no');
};

function renderMissions() {
  $('missionList').innerHTML = save.missions.map((m) => {
    const pct = Math.round((m.progress / m.target) * 100);
    return `<div class="mission"><div class="top"><span>${missionText(m)}</span><em>+${m.reward}</em></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
  $('achList').innerHTML = ACHIEVEMENTS.map((a) => `<div class="row"><span>${a.name}<small class="hint" style="display:block">${a.desc}</small></span><span class="${save.ach[a.id] ? 'done' : 'hint'}">${save.ach[a.id] ? 'Unlocked' : 'Locked'}</span></div>`).join('');
  $('lbList').innerHTML = save.lb.length ? save.lb.map((e) => `<div class="row"><span>${fmt(e.score)}</span><span class="hint">${fmt(e.dist)} m, ${e.d}</span></div>`).join('') : '<div class="hint">No runs yet. Your best five appear here.</div>';
}

// ---------- Shop ----------
const shop = (() => {
  let tab = 'skins', sel = null;
  const items = () => (tab === 'skins' ? SKINS : TRAILS);
  const owned = (it) => (tab === 'skins' ? save.skins[it.id] : save.trails[it.id]);
  const equipped = (it) => (tab === 'skins' ? save.skin === it.id : save.trail === it.id);
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  function swatch(it) {
    if (tab === 'skins') return `background:linear-gradient(135deg,${hex(it.body)} 55%,${hex(it.belly)} 55%)`;
    if (it.id === 'rainbow') return 'background:linear-gradient(90deg,#ff4a4a,#ffb12a,#ffe94a,#3ddc84,#3ab0ff,#b06bff)';
    if (it.id === 'none') return 'background:repeating-linear-gradient(45deg,#2a2536,#2a2536 8px,#332e42 8px,#332e42 16px)';
    return `background:radial-gradient(circle at 50% 60%,${hex(it.color)},#1a1424 75%)`;
  }
  function preview() { if (tab === 'skins' && sel) dino.setSkin(sel); else dino.setSkin(SKINS.find((s) => s.id === save.skin)); }
  function render() {
    $('shopCoins').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#ffc233"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="#b36d00" stroke-width="2"/></svg>${fmt(save.coins)}`;
    $('tabSkins').setAttribute('aria-selected', tab === 'skins'); $('tabTrails').setAttribute('aria-selected', tab === 'trails');
    $('shopList').innerHTML = items().map((it) => `<button class="card" data-id="${it.id}" aria-pressed="${sel && sel.id === it.id}"><div class="swatch" style="${swatch(it)}"></div><b>${it.name}</b><small class="${equipped(it) ? 'tag' : ''}">${equipped(it) ? 'Equipped' : owned(it) ? 'Owned' : fmt(it.price) + ' coins'}</small></button>`).join('');
    $('shopList').querySelectorAll('.card').forEach((c) => (c.onclick = () => { sel = items().find((i) => i.id === c.dataset.id); audio.sfx('ui'); preview(); render(); }));
    const b = $('btnShopAct');
    if (!sel) { b.textContent = 'Pick an item'; b.disabled = true; return; }
    if (equipped(sel)) { b.textContent = 'Equipped'; b.disabled = true; }
    else if (owned(sel)) { b.textContent = 'Equip'; b.disabled = false; }
    else { b.textContent = `Buy for ${fmt(sel.price)}`; b.disabled = save.coins < sel.price; }
  }
  $('btnShopAct').onclick = () => {
    if (!sel) return;
    const map = tab === 'skins' ? save.skins : save.trails;
    if (!map[sel.id]) {
      if (save.coins < sel.price) { audio.sfx('no'); return; }
      save.coins -= sel.price; map[sel.id] = true; audio.sfx('buy');
    } else audio.sfx('ui');
    if (tab === 'skins') save.skin = sel.id; else save.trail = sel.id;
    persist(); render(); refreshMenu();
  };
  const setTab = (t) => { tab = t; sel = items().find((i) => equipped(i)) || null; audio.sfx('ui'); preview(); render(); };
  $('tabSkins').onclick = () => setTab('skins'); $('tabTrails').onclick = () => setTab('trails');
  return {
    open() { tab = 'skins'; sel = SKINS.find((s) => s.id === save.skin); setScreens('shop'); render(); },
    close() { dino.setSkin(SKINS.find((s) => s.id === save.skin)); refreshMenu(); setScreens('menu'); },
  };
})();

// ---------- Boot ----------
applySettings();
applyQuality();
dino.setSkin(SKINS.find((s) => s.id === save.skin));
refreshMenu();
window.__dino = { G: GAME, save, world, startRun, frame }; // handy for debugging in the console
setScreens('menu');
$('loading').classList.remove('on');
setTimeout(() => $('loading').remove(), 600);
audio.setIntensity(0);
requestAnimationFrame(loop);
