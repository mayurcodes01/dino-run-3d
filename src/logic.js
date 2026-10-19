// logic.js: pure game rules. No DOM, no three.js, so it can be tested in Node.

export const LANES = [-2.2, 0, 2.2];
export const CELL = { EMPTY: 0, LOW: 1, TALL: 2, BIRD: 3 };

export const BASE_SPEED = 14;
export const MAX_SPEED = 38;
export const MIN_GAP_SEC = 1.0;

// Jump arc: apex height and airtime fix gravity and launch speed.
export const JUMP_H = 2.6;
export const JUMP_T = 0.68;
export const GRAV = (8 * JUMP_H) / (JUMP_T * JUMP_T);
export const JUMP_V = (4 * JUMP_H) / JUMP_T;
export const SLIDE_T = 0.65;
export const DASH_MULT = 1.3;
export const REVIVE_COST = 100;

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Speed grows with distance and levels off at MAX_SPEED.
export const speedAt = (d) => BASE_SPEED + (MAX_SPEED - BASE_SPEED) * (1 - Math.exp(-Math.max(0, d) / 1800));
export const difficultyAt = (d) => 1 - Math.exp(-Math.max(0, d) / 2200);
// Seconds between obstacle rows. Higher speed therefore means larger gaps in metres.
export const reactionTime = (diff) => 1.4 - 0.3 * diff;

// ---------- Spawning ----------

export class Director {
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
export function pathExists(rows) {
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

export const OBST = {
  [CELL.LOW]: { hx: 0.95, y0: 0, y1: 0.95, hz: 0.6 },
  [CELL.TALL]: { hx: 0.95, y0: 0, y1: 3.6, hz: 0.7 },
  [CELL.BIRD]: { hx: 0.9, y0: 1.15, y1: 2.4, hz: 0.5 },
};
export const DINO = { hx: 0.42, hz: 0.55, standH: 2.0, slideH: 0.8, forgive: 0.1 };

// d: {x, y, z, sliding}   o: {type, x, z}
export function collides(d, o) {
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

export const comboMultiplier = (combo) => Math.min(5, 1 + Math.floor(combo / 5) * 0.5);

// Largest score a run could plausibly reach. Used to reject tampered leaderboard entries.
export function isPlausible({ score, dist, timeSec, coins, nearMisses = 0 }) {
  if (![score, dist, timeSec, coins].every(Number.isFinite) || score < 0 || dist < 0) return false;
  if (dist > timeSec * MAX_SPEED * DASH_MULT * 1.05 + 50) return false;
  // Combo multiplier caps at 5 and the double-score power-up doubles it.
  const maxScore = (dist + coins * 10 + nearMisses * 50) * 10 * 1.02 + 50;
  return score <= maxScore;
}

// ---------- Missions, achievements, daily ----------

export const MISSION_DEFS = [
  { key: 'coins', text: (n) => `Collect ${n} coins`, targets: [100, 250], reward: 60 },
  { key: 'birds', text: (n) => `Slide under ${n} birds`, targets: [20, 40], reward: 80 },
  { key: 'dist', text: (n) => `Run ${n} m in total`, targets: [3000, 8000], reward: 70 },
  { key: 'near', text: (n) => `Pull off ${n} near misses`, targets: [15, 30], reward: 90 },
  { key: 'jumps', text: (n) => `Jump ${n} times`, targets: [60, 150], reward: 50 },
  { key: 'power', text: (n) => `Collect ${n} power-ups`, targets: [6, 12], reward: 70 },
];

export function newMission(rng, activeKeys = []) {
  const pool = MISSION_DEFS.filter((m) => !activeKeys.includes(m.key));
  const def = pool[Math.floor(rng() * pool.length)];
  const target = def.targets[Math.floor(rng() * def.targets.length)];
  return { key: def.key, target, reward: def.reward, progress: 0 };
}

export function missionText(m) {
  return MISSION_DEFS.find((d) => d.key === m.key).text(m.target);
}

// Adds one run's stats to every mission. Completed ones are replaced.
export function applyRunStats(missions, stats, rng = Math.random) {
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

export const ACHIEVEMENTS = [
  { id: 'first500', name: 'Warm-up', desc: 'Run 500 m in one go', test: (r) => r.dist >= 500 },
  { id: 'far2000', name: 'Long Stride', desc: 'Run 2,000 m in one go', test: (r) => r.dist >= 2000 },
  { id: 'far5000', name: 'Extinction Event', desc: 'Run 5,000 m in one go', test: (r) => r.dist >= 5000 },
  { id: 'coins100', name: 'Egg Money', desc: 'Collect 100 coins in one run', test: (r) => r.coins >= 100 },
  { id: 'near10', name: 'Too Close', desc: '10 near misses in one run', test: (r) => r.near >= 10 },
  { id: 'combo5', name: 'On a Roll', desc: 'Reach a 3x multiplier', test: (r) => r.maxMult >= 3 },
];

export function checkAchievements(owned, run) {
  return ACHIEVEMENTS.filter((a) => !owned[a.id] && a.test(run)).map((a) => a.id);
}

export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dailyChallenge(key) {
  const seed = hashString('dino-run-' + key);
  const rng = mulberry32(seed);
  const goal = 1500 + Math.floor(rng() * 26) * 100;
  return { seed, goal, reward: 150 };
}

export const SKINS = [
  { id: 'emerald', name: 'Emerald', price: 0, body: 0x3fae5a, belly: 0xd9e8a8, spike: 0xf2b134 },
  { id: 'crimson', name: 'Crimson', price: 150, body: 0xd8432f, belly: 0xffd9b0, spike: 0x2b1b1b },
  { id: 'azure', name: 'Azure', price: 300, body: 0x2f8bd9, belly: 0xcfeaff, spike: 0xfff1a8 },
  { id: 'gold', name: 'Gilded', price: 600, body: 0xe2a823, belly: 0xfff0b8, spike: 0x7a4a10, metal: true },
  { id: 'neon', name: 'Neon', price: 1000, body: 0x16e0c8, belly: 0xc9fff6, spike: 0xff3df0, glow: true },
];

export const TRAILS = [
  { id: 'none', name: 'None', price: 0, color: 0xffffff },
  { id: 'dust', name: 'Dust', price: 100, color: 0xd9c7a0 },
  { id: 'flame', name: 'Flame', price: 400, color: 0xff6a1a },
  { id: 'spark', name: 'Sparkle', price: 600, color: 0xfff2a0 },
  { id: 'rainbow', name: 'Rainbow', price: 1000, color: 0xffffff },
];
