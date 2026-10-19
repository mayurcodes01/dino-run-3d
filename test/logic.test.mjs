import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Director, CELL, pathExists, collides, speedAt, difficultyAt, reactionTime, MAX_SPEED, BASE_SPEED,
  MIN_GAP_SEC, JUMP_H, JUMP_T, JUMP_V, GRAV, comboMultiplier, isPlausible, MISSION_DEFS,
  newMission, applyRunStats, mulberry32, checkAchievements, dailyChallenge, dateKey,
} from '../src/logic.js';

test('speed starts at base, rises, and never exceeds the cap', () => {
  assert.equal(speedAt(0), BASE_SPEED);
  assert.ok(speedAt(1000) > speedAt(500));
  assert.ok(speedAt(1e6) <= MAX_SPEED + 1e-9);
  assert.ok(speedAt(1e6) > MAX_SPEED - 0.01);
});

test('difficulty stays within 0..1 and reaction time stays above the minimum', () => {
  for (const d of [0, 100, 1000, 5000, 1e6]) {
    const x = difficultyAt(d);
    assert.ok(x >= 0 && x <= 1);
    assert.ok(reactionTime(x) >= 1.1 - 1e-9);
  }
});

test('jump arc peaks at JUMP_H and lands after JUMP_T', () => {
  const y = (t) => JUMP_V * t - 0.5 * GRAV * t * t;
  assert.ok(Math.abs(y(JUMP_T / 2) - JUMP_H) < 1e-9);
  assert.ok(Math.abs(y(JUMP_T)) < 1e-9);
});

test('fuzz: every generated row sequence has a safe path', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const dir = new Director(seed);
    const rows = [];
    let dist = 0;
    for (let i = 0; i < 250; i++) {
      const speed = speedAt(dist);
      const row = dir.next(dist, speed);
      rows.push(row);
      dist += row.gap;
      assert.notEqual(row.cells[row.safe], CELL.TALL, `seed ${seed} row ${i}: safe lane blocked`);
    }
    assert.ok(pathExists(rows), `seed ${seed}: no path`);
  }
});

test('fuzz: time gap between obstacle rows respects the reaction rule even as speed rises', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const dir = new Director(seed);
    let dist = 0;
    for (let i = 0; i < 300; i++) {
      const row = dir.next(dist, speedAt(dist));
      if (row.kind === 'obs') {
        // Rows are placed ~160 m ahead of the player, so they arrive at the speed 160 m later.
        const arrival = speedAt(dist + 160);
        assert.ok(row.gap / arrival >= MIN_GAP_SEC - 0.06, `seed ${seed} row ${i}: ${row.gap / arrival}`);
      }
      dist += row.gap;
    }
  }
});

test('same seed gives the same track', () => {
  const a = new Director(42), b = new Director(42);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(a.next(i * 30, 20), b.next(i * 30, 20));
  }
});

test('power-ups appear, and sit where a coin would be', () => {
  const dir = new Director(7);
  let dist = 0, powers = 0;
  for (let i = 0; i < 600; i++) {
    const row = dir.next(dist, speedAt(dist));
    dist += row.gap;
    if (row.power) { powers++; assert.equal(row.kind, 'coin'); }
  }
  assert.ok(powers >= 3, `only ${powers} power-ups`);
});

test('pathExists detects a fully blocked row', () => {
  assert.equal(pathExists([{ cells: [2, 2, 2] }]), false);
  assert.equal(pathExists([{ cells: [2, 0, 2] }, { cells: [0, 2, 2] }]), true);
  assert.equal(pathExists([{ cells: [2, 0, 2] }, { cells: [2, 2, 0] }]), true); // one lane apart
  assert.equal(pathExists([{ cells: [0, 2, 2] }, { cells: [2, 2, 0] }]), false); // two lanes apart
});

test('collision: stand, jump, slide', () => {
  const low = { type: CELL.LOW, x: 0, z: 0 };
  const bird = { type: CELL.BIRD, x: 0, z: 0 };
  const tall = { type: CELL.TALL, x: 0, z: 0 };
  assert.ok(collides({ x: 0, y: 0, z: 0, sliding: false }, low));
  assert.ok(!collides({ x: 0, y: 1.4, z: 0, sliding: false }, low));
  assert.ok(collides({ x: 0, y: 0, z: 0, sliding: false }, bird));
  assert.ok(!collides({ x: 0, y: 0, z: 0, sliding: true }, bird));
  assert.ok(collides({ x: 0, y: 0, z: 0, sliding: true }, tall));
  assert.ok(collides({ x: 0, y: JUMP_H, z: 0, sliding: false }, tall));
});

test('collision: neighbouring lane and distance do not hit', () => {
  const tall = { type: CELL.TALL, x: 2.2, z: 0 };
  assert.ok(!collides({ x: 0, y: 0, z: 0, sliding: false }, tall));
  assert.ok(!collides({ x: 2.2, y: 0, z: 5, sliding: false }, tall));
});

test('collision is forgiving at the edges', () => {
  const tall = { type: CELL.TALL, x: 0, z: 0 };
  // Dino centre 1.3 m away: raw boxes overlap by 0.07 m, forgiveness removes it.
  assert.ok(!collides({ x: 1.3, y: 0, z: 0, sliding: false }, tall));
  assert.ok(collides({ x: 1.0, y: 0, z: 0, sliding: false }, tall));
});

test('combo multiplier grows in steps and caps at 5', () => {
  assert.equal(comboMultiplier(0), 1);
  assert.equal(comboMultiplier(5), 1.5);
  assert.equal(comboMultiplier(10), 2);
  assert.equal(comboMultiplier(999), 5);
});

test('plausibility check rejects impossible runs', () => {
  assert.ok(isPlausible({ score: 1200, dist: 1000, timeSec: 60, coins: 10 }));
  assert.ok(!isPlausible({ score: 1e9, dist: 1000, timeSec: 60, coins: 10 }));
  assert.ok(!isPlausible({ score: 100, dist: 9000, timeSec: 10, coins: 0 }));
  assert.ok(!isPlausible({ score: NaN, dist: 10, timeSec: 5, coins: 0 }));
});

test('missions progress, complete, and are replaced with a different kind', () => {
  const rng = mulberry32(3);
  const missions = [
    { key: 'coins', target: 100, reward: 60, progress: 90 },
    { key: 'birds', target: 20, reward: 80, progress: 0 },
    { key: 'dist', target: 3000, reward: 70, progress: 0 },
  ];
  const { missions: next, completed } = applyRunStats(missions, { coins: 15, birds: 5, dist: 400 }, rng);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].key, 'coins');
  assert.equal(next[1].progress, 5);
  assert.equal(next[2].progress, 400);
  assert.equal(next[0].progress, 0);
  assert.notEqual(next[0].key, 'birds');
  assert.notEqual(next[0].key, 'dist');
  assert.ok(MISSION_DEFS.some((d) => d.key === next[0].key));
});

test('newMission avoids active keys', () => {
  const rng = mulberry32(9);
  for (let i = 0; i < 50; i++) {
    const m = newMission(rng, ['coins', 'birds']);
    assert.ok(!['coins', 'birds'].includes(m.key));
  }
});

test('achievements unlock once', () => {
  const run = { dist: 600, coins: 5, near: 0, maxMult: 1 };
  assert.deepEqual(checkAchievements({}, run), ['first500']);
  assert.deepEqual(checkAchievements({ first500: true }, run), []);
});

test('daily challenge is deterministic per date and goal is sensible', () => {
  const a = dailyChallenge('2026-10-18'), b = dailyChallenge('2026-10-18'), c = dailyChallenge('2026-10-19');
  assert.deepEqual(a, b);
  assert.notEqual(a.seed, c.seed);
  assert.ok(a.goal >= 1500 && a.goal <= 4000 && a.goal % 100 === 0);
  assert.match(dateKey(new Date(2026, 9, 18)), /^2026-10-18$/);
});
