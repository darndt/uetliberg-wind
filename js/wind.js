// Wind field on terrain-following levels: combines the two solver basis
// solutions for the requested direction/speed and adds a lee (wake) model.

export const AGL = [4, 12, 25, 45, 70, 100, 140, 190, 260, 350, 470, 630, 850, 1150, 1500];

const Z0 = 0.3, HREF = 500, LOGREF = Math.log(1 + HREF / Z0);
/** Undisturbed wind profile: fraction of the free-stream speed at height a above ground. */
export function prof(a) {
  if (a < 0.5) a = 0.5;
  const p = Math.log(1 + a / Z0) / LOGREF;
  return p > 1 ? 1 : p;
}

const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

// Lee model parameters: a point is sheltered when upwind terrain rises above it
// more steeply than ~1:16, fully in the wake at ~1:4.
const TAN_LO = 0.06, TAN_HI = 0.24, WAKE_DEFICIT = 0.8;

export class WindField {
  constructor(NX, NY, L, hMean) {
    this.NX = NX; this.NY = NY; this.NA = AGL.length;
    this.dx = L / NX; this.half = L / 2;
    this.hMean = hMean;
    const n = NX * NY * this.NA;
    this.F = new Float32Array(n * 3);   // u (east), v (north), w (up)  [m/s]
    this.S = new Float32Array(n);       // shelter / lee factor 0..1
    this.E = null; this.N = null;
    this.lut = new Uint8Array(1501);
    for (let a = 0, m = 0; a <= 1500; a++) {
      while (m < this.NA - 2 && AGL[m + 1] <= a) m++;
      this.lut[a] = m;
    }
    this.dist = [];
    for (let k = 0; k < 18; k++) this.dist.push(80 * Math.pow(1.22, k));
    this._hs = new Float32Array(this.dist.length);
  }

  get ready() { return !!this.E; }
  setBasis(E, N) { this.E = E; this.N = N; }

  _h(gx, gy) {
    const NX = this.NX, NY = this.NY;
    gx = gx < 0 ? 0 : gx > NX - 1.001 ? NX - 1.001 : gx;
    gy = gy < 0 ? 0 : gy > NY - 1.001 ? NY - 1.001 : gy;
    const i = gx | 0, j = gy | 0, tx = gx - i, ty = gy - j, c = j * NX + i, h = this.hMean;
    return (h[c] * (1 - tx) + h[c + 1] * tx) * (1 - ty) + (h[c + NX] * (1 - tx) + h[c + NX + 1] * tx) * ty;
  }

  /** dirDeg: meteorological direction the wind comes FROM. speed in m/s. */
  update(dirDeg, speed) {
    if (!this.E) return;
    const r = dirDeg * Math.PI / 180, fx = -Math.sin(r), fy = -Math.cos(r);
    const { F, S, E, N, NX, NY, NA, dist, hMean } = this;
    const a = speed * fx, b = speed * fy;
    for (let i = 0, n = F.length; i < n; i++) F[i] = a * E[i] + b * N[i];

    const ND = dist.length, hs = this._hs, nxy = NX * NY;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const c2 = j * NX + i, h = hMean[c2];
        let hmax = -1e9;
        for (let k = 0; k < ND; k++) {
          const g = dist[k] / this.dx;
          const v = this._h(i - fx * g, j - fy * g);
          hs[k] = v; if (v > hmax) hmax = v;
        }
        for (let m = 0; m < NA; m++) {
          const z = h + AGL[m], idx = m * nxy + c2;
          let s = 0;
          if (hmax > z) {
            let t = -1;
            for (let k = 0; k < ND; k++) { const v = (hs[k] - z) / dist[k]; if (v > t) t = v; }
            s = smooth(TAN_LO, TAN_HI, t);
          }
          S[idx] = s;
          if (s > 0) { const f = 1 - WAKE_DEFICIT * s, k3 = idx * 3; F[k3] *= f; F[k3 + 1] *= f; F[k3 + 2] *= f; }
        }
      }
    }
  }

  /** Sample at east x, north n (metres from centre), height above ground. out = [u, v, w, shelter] */
  sample(x, n, agl, out) {
    const NX = this.NX, NY = this.NY, F = this.F, S = this.S;
    let gx = (x + this.half) / this.dx - 0.5, gy = (n + this.half) / this.dx - 0.5;
    gx = gx < 0 ? 0 : gx > NX - 1.001 ? NX - 1.001 : gx;
    gy = gy < 0 ? 0 : gy > NY - 1.001 ? NY - 1.001 : gy;
    const i = gx | 0, j = gy | 0, tx = gx - i, ty = gy - j;
    const a = agl < 0 ? 0 : agl > 1499 ? 1499 : agl;
    const m = this.lut[a | 0];
    let tz = (a - AGL[m]) / (AGL[m + 1] - AGL[m]);
    if (tz < 0) tz = 0;
    const nxy = NX * NY, c0 = (m * NY + j) * NX + i, c1 = c0 + nxy;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    const z0 = 1 - tz;
    for (let k = 0; k < 3; k++) {
      const lo = F[c0 * 3 + k] * w00 + F[(c0 + 1) * 3 + k] * w10 + F[(c0 + NX) * 3 + k] * w01 + F[(c0 + NX + 1) * 3 + k] * w11;
      const hi = F[c1 * 3 + k] * w00 + F[(c1 + 1) * 3 + k] * w10 + F[(c1 + NX) * 3 + k] * w01 + F[(c1 + NX + 1) * 3 + k] * w11;
      out[k] = lo * z0 + hi * tz;
    }
    const lo = S[c0] * w00 + S[c0 + 1] * w10 + S[c0 + NX] * w01 + S[c0 + NX + 1] * w11;
    const hi = S[c1] * w00 + S[c1 + 1] * w10 + S[c1 + NX] * w01 + S[c1 + NX + 1] * w11;
    out[3] = lo * z0 + hi * tz;
    return out;
  }
}
