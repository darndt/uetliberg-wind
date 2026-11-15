import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { loadTerrain } from './terrain.js';
import { WindField, AGL } from './wind.js';
import { Particles } from './particles.js';
import { Section } from './section.js';
import { PAL, cssGradient, paletteTexture, fillPaletteTexture } from './palettes.js';

const NX = 160;                 // solver grid columns per side
const SINK = 1.1;               // paraglider sink rate [m/s]
const VMAX = 33 / 3.6;          // wind above which soaring gets uncomfortable [m/s]
const STABILITY = {
  stable:   { alpha2: 0.3, hint: 'Stable air (inversion, typical Bise with high fog): resists being lifted, more flow around the hills, weaker ridge lift.' },
  neutral:  { alpha2: 1.0, hint: 'Neutral air: flows over and around obstacles equally easily.' },
  unstable: { alpha2: 2.5, hint: 'Unstable air (sunny, thermic): goes over the top readily, stronger vertical motion.' },
};
const PLACES = [
  ['Uetliberg Kulm', 47.3495, 8.4915], ['Felsenegg', 47.3098, 8.5086], ['Zürich HB', 47.3779, 8.5403],
  ['Zürichberg', 47.383, 8.568], ['Albisgüetli', 47.3525, 8.5115], ['Zürichsee', 47.336, 8.552],
];

const state = { dir: 50, speed: 20, stability: 'neutral', overlay: 'soar', pcolor: 'lift', count: 6000, maxAgl: 300, exag: 1, probe: { x: 0, n: 0 } };
const $ = (id) => document.getElementById(id);
const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const windName = (d) => WINDS[Math.round(d / 22.5) % 16];

// collapsible cards (state remembered per browser)
for (const id of ['panel', 'probe', 'sectionCard']) {
  const card = $(id), btn = card.querySelector('.fold'), key = 'windlab.collapsed.' + id;
  const set = (c) => { card.classList.toggle('collapsed', c); btn.setAttribute('aria-expanded', String(!c)); };
  let saved = false;
  try { saved = localStorage.getItem(key) === '1'; } catch { /* storage unavailable */ }
  set(saved);
  btn.addEventListener('click', () => {
    const c = !card.classList.contains('collapsed');
    set(c);
    try { localStorage.setItem(key, c ? '1' : '0'); } catch { /* ignore */ }
    window.dispatchEvent(new Event('resize'));   // re-render the section canvas when it reappears
  });
}

main().catch((err) => {
  console.error(err);
  $('status').classList.add('hide');
  const e = $('error'); e.style.display = 'flex';
  e.textContent = 'Could not start: ' + err.message + ' — serve this folder over http (e.g. "python3 -m http.server") rather than opening the file directly.';
});

async function main() {
  // ---------- renderer / scene ----------
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 50, 150000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 1200; controls.maxDistance = 45000; controls.maxPolarAngle = Math.PI * 0.49;

  const T = await loadTerrain(512);
  const world = new THREE.Group();          // everything in here gets the vertical exaggeration
  world.add(T.mesh, T.skirt);
  scene.add(world);

  const sim = T.simTerrain(NX);
  const field = new WindField(NX, NX, T.L, sim.hMean);

  // ---------- ground overlay ----------
  const ovData = new Uint8Array(NX * NX * 4);
  const ovTex = new THREE.DataTexture(ovData, NX, NX, THREE.RGBAFormat);
  ovTex.minFilter = ovTex.magFilter = THREE.LinearFilter;
  ovTex.wrapS = ovTex.wrapT = THREE.ClampToEdgeWrapping;
  ovTex.needsUpdate = true;
  T.uniforms.uOverlay.value = ovTex;

  function rebuildOverlay() {
    const { F, S } = field, nxy = NX * NX, mode = state.overlay, d = ovData;
    const on = mode !== 'none' && field.ready;
    T.uniforms.uOverlayOn.value = on ? 1 : 0;
    if (!on) return;
    const sf = Math.min(1, Math.max(0.3, state.speed / 15));
    for (let c = 0; c < nxy; c++) {
      let r = 0, g = 0, b = 0, a = 0;
      if (mode === 'lee') {
        const s = S[2 * nxy + c];
        a = smooth(0.05, 0.5, s) * 0.82 * sf;
        r = 255 + (232 - 255) * s; g = 176 + (40 - 176) * s; b = 64 + (112 - 64) * s;
      } else if (mode === 'lift') {
        const w = F[(3 * nxy + c) * 3 + 2], col = PAL.lift(0.5 + w / 6);
        r = col[0]; g = col[1]; b = col[2]; a = smooth(0.12, 1.0, Math.abs(w)) * 0.82;
      } else if (mode === 'speed') {
        const k = (nxy + c) * 3, col = PAL.speed(Math.hypot(F[k], F[k + 1]) / 13.89);
        r = col[0]; g = col[1]; b = col[2]; a = 0.74;
      } else if (mode === 'soar') {
        let best = -1, strong = false;
        for (let m = 2; m <= 7; m++) {
          const k = (m * nxy + c) * 3, w = F[k + 2];
          if (w >= SINK && S[m * nxy + c] < 0.25) {
            if (Math.hypot(F[k], F[k + 1]) <= VMAX) { if (w > best) best = w; } else strong = true;
          }
        }
        if (best > 0) { r = 70; g = 255; b = 150; a = 0.42 + 0.45 * Math.min(1, (best - SINK) / 1.5); }
        else if (strong) { r = 255; g = 150; b = 40; a = 0.7; }
      }
      d[c * 4] = r; d[c * 4 + 1] = g; d[c * 4 + 2] = b; d[c * 4 + 3] = a * 255;
    }
    ovTex.needsUpdate = true;
  }

  // ---------- tracers ----------
  const particles = new Particles(field, T.hAt, T.half, 12000, 36);
  const palTex = paletteTexture(PAL[state.pcolor]);
  particles.uniforms.uPal.value = palTex;
  scene.add(particles.mesh);

  // ---------- probe + section line ----------
  const [ux, un] = T.fromLatLon(47.3495, 8.4915);
  { // snap the initial probe to the highest point around the Uetliberg summit
    let best = -1;
    for (let dn = -400; dn <= 400; dn += 40) for (let dxm = -400; dxm <= 400; dxm += 40) {
      const h = T.hAt(ux + dxm, un + dn);
      if (h > best) { best = h; state.probe = { x: ux + dxm, n: un + dn }; }
    }
  }
  const pin = new THREE.Group();
  pin.add(new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 420, 8).translate(0, 210, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })));
  pin.add(new THREE.Mesh(new THREE.SphereGeometry(42, 16, 12).translate(0, 420, 0), new THREE.MeshBasicMaterial({ color: 0xffffff })));
  world.add(pin);
  const NLINE = 140;
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NLINE * 3), 3));
  const sectionLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
  sectionLine.frustumCulled = false;
  world.add(sectionLine);

  function placeProbe() {
    const { x, n } = state.probe;
    pin.position.set(x, T.hAt(x, n), -n);
    const r = state.dir * Math.PI / 180, fx = -Math.sin(r), fy = -Math.cos(r), p = lineGeo.attributes.position;
    for (let k = 0; k < NLINE; k++) {
      const s = -3500 + k / (NLINE - 1) * 7000;
      const px = Math.max(-T.half, Math.min(T.half, x + s * fx)), pn = Math.max(-T.half, Math.min(T.half, n + s * fy));
      p.setXYZ(k, px, T.hAt(px, pn) + 28, -pn);
    }
    p.needsUpdate = true;
  }

  const section = new Section($('section'), field, T.hAt, SINK);
  const sampleOut = new Float32Array(4);

  function updateProbeCard() {
    const { x, n } = state.probe, h = T.hAt(x, n);
    let near = null, nd = 700;
    for (const [name, lat, lon] of PLACES) {
      const [px, pn] = T.fromLatLon(lat, lon), dd = Math.hypot(px - x, pn - n);
      if (dd < nd) { nd = dd; near = name; }
    }
    let rows = '', lee = 0, bestW = -9, bestV = 0;
    if (field.ready) {
      for (const a of [300, 150, 50, 10]) {
        field.sample(x, n, a, sampleOut);
        const [u, v, w, S] = sampleOut, sp = Math.hypot(u, v) * 3.6;
        const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
        if (a <= 150) { lee = Math.max(lee, S); if (w > bestW) { bestW = w; bestV = sp; } }
        rows += `<tr><td>${a} m</td><td>${sp.toFixed(0)} km/h</td>` +
          `<td><span class="arr" style="transform:rotate(${from + 180}deg)">↑</span> ${windName(from)}</td>` +
          `<td class="${w > 0.15 ? 'up' : w < -0.15 ? 'down' : ''}">${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(1)} m/s</td></tr>`;
      }
    }
    let badge = '<span class="badge calm">No usable lift here</span>';
    if (!field.ready) badge = '<span class="badge calm">Solving…</span>';
    else if (lee > 0.3 && state.speed >= 8) badge = '<span class="badge lee">Lee side — turbulent, sinking</span>';
    else if (lee > 0.3) badge = '<span class="badge calm">Sheltered (lee)</span>';
    else if (bestW >= SINK && bestV > VMAX * 3.6) badge = '<span class="badge strong">Lift, but wind too strong</span>';
    else if (bestW >= SINK) badge = '<span class="badge ok">Soarable lift</span>';
    $('probeBody').innerHTML =
      `<div class="title"><b>${near || 'Probe'}</b><span class="lbl">${h.toFixed(0)} m a.s.l.</span></div>` +
      `<table><tr><th>above ground</th><th>wind</th><th>from</th><th>vertical</th></tr>${rows}</table>${badge}`;
    $('sectionSub').textContent = `${windName(state.dir)} → ${windName((state.dir + 180) % 360)} · through ${near || 'probe'}`;
  }

  // ---------- place labels ----------
  const labels = PLACES.map(([name, lat, lon]) => {
    const [x, n] = T.fromLatLon(lat, lon), h = T.hAt(x, n);
    const el = document.createElement('div');
    el.className = 'place';
    el.innerHTML = name === 'Zürichsee' ? name : `${name}<small>${Math.round(h)} m</small>`;
    $('labels').appendChild(el);
    return { el, x, n, h: h + 40 };
  });
  { const el = document.createElement('div'); el.className = 'place north'; el.textContent = 'N'; $('labels').appendChild(el);
    labels.push({ el, x: 0, n: T.half + 350, h: T.hAt(0, T.half) }); }
  const v3 = new THREE.Vector3();
  function updateLabels(w, h) {
    for (const l of labels) {
      v3.set(l.x, l.h * state.exag, -l.n).project(camera);
      const vis = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1;
      l.el.style.display = vis ? '' : 'none';
      if (vis) l.el.style.transform = `translate(${((v3.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v3.y) / 2 * h).toFixed(1)}px) translate(-5px, -50%)`;
    }
  }

  // ---------- solver ----------
  const workers = [0, 1].map(() => new Worker('js/solver.worker.js'));   // one per basis wind, in parallel
  let solveId = 0, solveT0 = 0, pending = null;
  function solve() {
    solveId++;
    pending = { frac: [0, 0], data: [null, null] };
    solveT0 = performance.now();
    $('statusText').textContent = 'Solving airflow…';
    $('statusBar').style.width = '0%';
    $('status').classList.remove('hide');
    workers.forEach((w, basis) => w.postMessage({ id: solveId, basis, NX, NY: NX, dx: sim.dx, hMean: sim.hMean, hMin: sim.hMin, hMax: sim.hMax, alpha2: STABILITY[state.stability].alpha2, agl: AGL }));
  }
  workers.forEach((w) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.id !== solveId) return;
      if (m.type === 'progress') {
        pending.frac[m.basis] = m.frac;
        $('statusBar').style.width = ((pending.frac[0] + pending.frac[1]) * 50).toFixed(0) + '%';
      } else if (m.type === 'done') {
        pending.data[m.basis] = m.data;
        if (pending.data[0] && pending.data[1]) {
          field.setBasis(pending.data[0], pending.data[1]);
          console.info(`[wind] airflow solved in ${((performance.now() - solveT0) / 1000).toFixed(1)} s`);
          $('status').classList.add('hide');
          windDirty = true;
        }
      }
    };
    w.onerror = (e) => { $('statusText').textContent = 'Solver error: ' + e.message; };
  });

  // ---------- UI ----------
  let windDirty = true, viewDirty = true;

  // compass
  const svg = $('compass'), NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, parent = svg) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); parent.appendChild(el); return el; };
  mk('circle', { class: 'ring', r: 92 });
  for (let a = 0; a < 360; a += 10) {
    const major = a % 90 === 0, r1 = major ? 80 : a % 30 === 0 ? 84 : 87, s = Math.sin(a * Math.PI / 180), c = -Math.cos(a * Math.PI / 180);
    mk('line', { class: 'tick' + (major ? ' major' : ''), x1: s * r1, y1: c * r1, x2: s * 92, y2: c * 92 });
  }
  [['N', 0, -67], ['E', 67, 0], ['S', 0, 67], ['W', -67, 0]].forEach(([t, x, y]) => { mk('text', { x, y, class: t === 'N' ? 'n' : '' }).textContent = t; });
  const arrow = mk('g', { class: 'arrow' });
  mk('line', { x1: 0, y1: -80, x2: 0, y2: -22 }, arrow);
  mk('polygon', { points: '0,-6 -11,-26 11,-26' }, arrow);
  mk('circle', { r: 9, cy: -84 }, arrow);

  function setDir(d) { state.dir = ((Math.round(d) % 360) + 360) % 360; syncWindUI(); windDirty = true; }
  function syncWindUI() {
    arrow.setAttribute('transform', `rotate(${state.dir})`);
    svg.setAttribute('aria-valuenow', state.dir);
    $('dirName').textContent = windName(state.dir);
    $('dirDeg').textContent = state.dir + '°';
    $('speed').value = state.speed;
    $('speedOut').innerHTML = `${state.speed} <small>km/h</small>`;
    document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', +b.dataset.dir === state.dir && +b.dataset.speed === state.speed));
  }
  const dragDir = (e) => { const r = svg.getBoundingClientRect(); setDir(Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI); };
  svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); dragDir(e); });
  svg.addEventListener('pointermove', (e) => { if (svg.hasPointerCapture(e.pointerId)) dragDir(e); });
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setDir(state.dir + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setDir(state.dir - 5); e.preventDefault(); }
  });
  $('speed').addEventListener('input', (e) => { state.speed = +e.target.value; syncWindUI(); windDirty = true; });
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.speed = +b.dataset.speed; setDir(+b.dataset.dir);
  });

  function chips(id, key, onChange) {
    const box = $(id);
    const sync = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === state[key]));
    box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.dataset.v === state[key]) return; state[key] = b.dataset.v; sync(); onChange(); });
    sync();
  }
  const bar = (pal, lo, hi) => `<div class="bar" style="background:${cssGradient(pal)}"></div><div class="ends"><span>${lo}</span><span>${hi}</span></div>`;
  function legends() {
    $('pLegend').innerHTML = { lift: bar(PAL.lift, 'sink −3 m/s', 'lift +3 m/s'), speed: bar(PAL.speed, '0', '50 km/h'), turb: bar(PAL.turb, 'smooth', 'turbulent lee') }[state.pcolor];
    $('ovLegend').innerHTML = {
      lee: `<div class="bar" style="background:linear-gradient(90deg,rgba(255,176,64,.25),rgb(255,150,72),rgb(232,40,112))"></div><div class="ends"><span>partly sheltered</span><span>deep lee</span></div>`,
      soar: `<div class="keys"><span><i class="sw" style="background:#46ff96"></i>soarable lift</span><span><i class="sw" style="background:#ff9628"></i>lift, wind &gt; 33 km/h</span></div>`,
      lift: bar(PAL.lift, 'sink −3 m/s', 'lift +3 m/s') + '<div class="lbl">45 m above ground</div>',
      speed: bar(PAL.speed, '0', '50 km/h') + '<div class="lbl">12 m above ground</div>',
      none: '',
    }[state.overlay];
  }
  chips('stability', 'stability', () => { $('stabHint').textContent = STABILITY[state.stability].hint; solve(); });
  chips('overlay', 'overlay', () => { legends(); rebuildOverlay(); });
  chips('pcolor', 'pcolor', () => { legends(); fillPaletteTexture(palTex, PAL[state.pcolor]); });
  $('stabHint').textContent = STABILITY[state.stability].hint;

  const slider = (id, key, fmt, apply) => {
    const el = $(id), out = $(id === 'maxAgl' ? 'aglOut' : id + 'Out');
    const sync = () => { out.innerHTML = fmt(state[key]); apply && apply(); };
    el.value = state[key];
    el.addEventListener('input', () => { state[key] = +el.value; sync(); });
    sync();
  };
  slider('count', 'count', v => v.toLocaleString('en'), () => particles.setCount(state.count));
  slider('maxAgl', 'maxAgl', v => `${v} <small>m above ground</small>`, () => { particles.maxAgl = state.maxAgl; });
  syncWindUI(); legends();

  // click terrain -> move probe
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
    ndc.set(e.clientX / window.innerWidth * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(T.mesh)[0];
    if (hit) { state.probe = { x: hit.point.x, n: -hit.point.z }; windDirty = true; }
  });

  // ---------- camera ----------
  const h0 = T.hAt(state.probe.x, state.probe.n);
  controls.target.set(state.probe.x + 1500, (h0 - 300) * state.exag, -state.probe.n + 400);
  camera.position.set(state.probe.x + 10500, 8200, -state.probe.n - 8200);

  let W = 0, H = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // keep the terrain centred in the area not covered by the side panel / section card
    if (W > 900) camera.setViewOffset(W, H, -150, Math.min(90, H * 0.1), W, H); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    particles.uniforms.uRes.value.set(W * dpr, H * dpr);
    particles.uniforms.uWidth.value = 1.7 * dpr;
    windDirty = true;
  }
  window.addEventListener('resize', resize);
  resize();
  solve();

  // ---------- frame loop ----------
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (viewDirty) {
      world.scale.y = state.exag;
      T.uniforms.uExag.value = state.exag;
      particles.uniforms.uExag.value = state.exag;
      viewDirty = false;
    }
    if (windDirty) {
      field.update(state.dir, state.speed / 3.6);
      rebuildOverlay(); placeProbe(); updateProbeCard();
      section.render(state.probe, state.dir, state.speed / 3.6);
      windDirty = false;
    }
    controls.update();
    particles.step(dt, state.speed / 3.6, state.pcolor);
    renderer.render(scene, camera);
    updateLabels(W, H);
  }
  requestAnimationFrame(frame);
  window.__lab = { state, field, particles, camera, controls };   // handy for debugging in the console
}
