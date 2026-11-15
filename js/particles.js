import * as THREE from 'three';
import { prof } from './wind.js';

// Flow tracers drawn as fading, screen-space ribbons.
// Every particle owns M trail segments. Segments are stored slot-major
// (instance = slot * N + particle) so each frame only the "head" slot block has
// to be re-uploaded to the GPU; segment age is derived from the slot in the shader.

const STRIDE = 7;            // start xyz, end xyz, colour value
const TIME_SCALE = 60;       // time-lapse factor
const PUSH_DT = 1 / 20;      // real seconds between trail points
const TAU = 14;              // turbulence correlation time [sim s]

export class Particles {
  constructor(field, hAt, half, maxN = 12000, M = 32) {
    this.field = field; this.hAt = hAt; this.half = half;
    this.N = maxN; this.M = M; this.count = 0;
    this.cursor = 0; this.acc = 0; this.full = true;

    this.px = new Float32Array(maxN); this.pn = new Float32Array(maxN); this.pz = new Float32Array(maxN);
    this.lx = new Float32Array(maxN); this.ly = new Float32Array(maxN); this.lz = new Float32Array(maxN);
    this.age = new Float32Array(maxN); this.life = new Float32Array(maxN);
    this.noise = new Float32Array(maxN * 3);
    this.val = new Float32Array(maxN);
    this.data = new Float32Array(maxN * M * STRIDE);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    const ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aStart', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    geo.setAttribute('aEnd', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    geo.setAttribute('aVal', new THREE.InterleavedBufferAttribute(ib, 1, 6));
    geo.instanceCount = maxN * M;
    this.buffer = ib;

    this.uniforms = {
      uExag: { value: 1 }, uCursor: { value: 0 }, uM: { value: M }, uN: { value: maxN },
      uWidth: { value: 2 }, uRes: { value: new THREE.Vector2(1, 1) }, uPal: { value: null }, uOpacity: { value: 0.85 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        uniform float uExag, uCursor, uM, uWidth, uOpacity; uniform int uN; uniform vec2 uRes; uniform sampler2D uPal;
        attribute vec3 aStart; attribute vec3 aEnd; attribute float aVal;
        varying vec4 vCol; varying float vSide;
        void main() {
          vec4 cs = projectionMatrix * viewMatrix * vec4(aStart.x, aStart.y * uExag, aStart.z, 1.0);
          vec4 ce = projectionMatrix * viewMatrix * vec4(aEnd.x, aEnd.y * uExag, aEnd.z, 1.0);
          float slot = float(gl_InstanceID / uN);
          float t = position.x;
          float age = (mod(uCursor - slot + uM, uM) + (1.0 - t)) / uM;
          vec2 d = (ce.xy / ce.w - cs.xy / cs.w) * uRes;
          float len = length(d);
          vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
          vec4 c = mix(cs, ce, t);
          float w = uWidth * (0.3 + 0.7 * (1.0 - age));
          c.xy += vec2(-dir.y, dir.x) * position.y * w / uRes * c.w;
          float a = pow(clamp(1.0 - age, 0.0, 1.0), 1.5) * uOpacity;
          if (cs.w <= 0.0 || ce.w <= 0.0 || len > 400.0) a = 0.0;
          vCol = vec4(texture2D(uPal, vec2(aVal, 0.5)).rgb, a);
          vSide = position.y;
          gl_Position = c;
        }`,
      fragmentShader: /* glsl */`
        varying vec4 vCol; varying float vSide;
        void main() {
          float e = 1.0 - smoothstep(0.3, 1.0, abs(vSide));
          gl_FragColor = vec4(vCol.rgb, vCol.a * e);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this._out = new Float32Array(4);
    this.maxAgl = 300;
  }

  _spawn(p, stagger) {
    const L = this.half * 2;
    const x = (Math.random() - 0.5) * L, n = (Math.random() - 0.5) * L;
    const agl = 8 + (this.maxAgl - 8) * Math.pow(Math.random(), 1.5);
    this.px[p] = x; this.pn[p] = n; this.pz[p] = this.hAt(x, n) + agl;
    this.lx[p] = x; this.ly[p] = this.pz[p]; this.lz[p] = -n;
    this.life[p] = 5 + Math.random() * 7;
    this.age[p] = stagger ? Math.random() * this.life[p] : 0;
    this.noise[p * 3] = this.noise[p * 3 + 1] = this.noise[p * 3 + 2] = 0;
  }

  setCount(n) {
    n = Math.min(this.N, n);
    for (let p = this.count; p < n; p++) this._spawn(p, true);
    if (n < this.count) {            // wipe trails of removed particles
      const { data, N, M } = this;
      for (let s = 0; s < M; s++) data.fill(0, (s * N + n) * STRIDE, (s * N + this.count) * STRIDE);
      this.full = true;
    }
    this.count = n;
  }

  /** mode: 'lift' | 'speed' | 'turb'; speed = free-stream speed in m/s */
  step(dt, speed, mode) {
    const { field, hAt, half, N, M, data, px, pn, pz, lx, ly, lz, age, life, noise, val, count } = this;
    if (!field.ready || count === 0) return;
    const sdt = dt * TIME_SCALE, out = this._out;
    const kDecay = Math.exp(-sdt / TAU), kKick = Math.sqrt(1 - kDecay * kDecay) * 3.4641;   // uniform -> unit variance
    const head = this.cursor * N;

    for (let p = 0; p < count; p++) {
      let x = px[p], n = pn[p], z = pz[p];
      const h0 = hAt(x, n), agl = z - h0;
      field.sample(x, n, agl, out);
      const u = out[0], v = out[1], w = out[2], S = out[3];
      const q = p * 3;
      noise[q] = noise[q] * kDecay + (Math.random() - 0.5) * kKick;
      noise[q + 1] = noise[q + 1] * kDecay + (Math.random() - 0.5) * kKick;
      noise[q + 2] = noise[q + 2] * kDecay + (Math.random() - 0.5) * kKick;
      const amp = (0.03 + 0.55 * S) * speed * prof(agl);
      x += (u + amp * noise[q]) * sdt;
      n += (v + amp * noise[q + 1]) * sdt;
      z += (w + 0.6 * amp * noise[q + 2]) * sdt;
      const h1 = hAt(x, n);
      if (z < h1 + 2) z = h1 + 2;
      age[p] += dt;

      let fresh = false;
      if (age[p] > life[p] || x < -half || x > half || n < -half || n > half || z - h1 > 1450) {
        this._spawn(p, false);
        x = px[p]; n = pn[p]; z = pz[p];
        fresh = true;
      } else { px[p] = x; pn[p] = n; pz[p] = z; }

      let c;
      if (mode === 'speed') c = Math.hypot(u, v, w) / 13.89;
      else if (mode === 'turb') c = S;
      else c = 0.5 + w / 6;
      val[p] = c < 0.01 ? 0.01 : c > 0.99 ? 0.99 : c;

      const o = (head + p) * STRIDE;
      if (fresh) { data[o] = x; data[o + 1] = z; data[o + 2] = -n; }
      else { data[o] = lx[p]; data[o + 1] = ly[p]; data[o + 2] = lz[p]; }
      data[o + 3] = x; data[o + 4] = z; data[o + 5] = -n; data[o + 6] = val[p];
    }
    if (!this.full) this.buffer.addUpdateRange(head * STRIDE, count * STRIDE);

    this.acc += dt;
    if (this.acc >= PUSH_DT) {
      this.acc = Math.min(this.acc - PUSH_DT, PUSH_DT);
      this.cursor = (this.cursor + 1) % M;
      const nh = this.cursor * N;
      for (let p = 0; p < count; p++) {
        const x = px[p], z = pz[p], zz = -pn[p];
        lx[p] = x; ly[p] = z; lz[p] = zz;
        const o = (nh + p) * STRIDE;
        data[o] = x; data[o + 1] = z; data[o + 2] = zz;
        data[o + 3] = x; data[o + 4] = z; data[o + 5] = zz; data[o + 6] = val[p];
      }
      if (!this.full) this.buffer.addUpdateRange(nh * STRIDE, count * STRIDE);
      this.uniforms.uCursor.value = this.cursor;
    }
    if (this.full) { this.buffer.clearUpdateRanges(); this.full = false; }
    this.buffer.needsUpdate = true;
  }
}
