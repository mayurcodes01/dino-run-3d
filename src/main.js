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
