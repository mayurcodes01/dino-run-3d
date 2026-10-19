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
