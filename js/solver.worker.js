'use strict';
/*
 * Mass-consistent diagnostic wind solver (the WindNinja / Sherman-1978 family).
 *
 * Start from a horizontally uniform wind with a logarithmic profile above
 * ground, then find the smallest correction that makes the flow divergence-free
 * and unable to pass through the terrain:
 *
 *     u = u0 + dL/dx,  v = v0 + dL/dy,  w = alpha2 * dL/dz
 *     d2L/dx2 + d2L/dy2 + alpha2 * d2L/dz2 = -div(u0)
 *
 * alpha2 < 1 penalises vertical motion (stable air: flow goes around),
 * alpha2 > 1 favours it (unstable air: flow goes over).
 *
 * Discretisation: Cartesian staggered grid, terrain represented with cut-cell
 * face apertures, solved with zebra line-SOR (tridiagonal solve per column).
 *
 * The problem is linear in u0, so only two basis cases are needed (unit wind
 * blowing towards east = basis 0, towards north = basis 1; one worker each).
 * Any direction and speed is a linear combination, which the main thread
 * evaluates instantly.
 */
const Z0 = 0.3, HREF = 500, LOGREF = Math.log(1 + HREF / Z0);
function prof(a) {
  if (a < 0.5) a = 0.5;
  const p = Math.log(1 + a / Z0) / LOGREF;
  return p > 1 ? 1 : p;
}

self.onmessage = (e) => {
  const { NX, NY, dx, hMean, hMin, hMax, alpha2, agl, id, basis } = e.data;
  const NXY = NX * NY, SX = NX + 1, SY = NY + 1;

  // ---- vertical grid: 25 m layers through the relief, stretched above ----
  let zb = Infinity;
  for (let i = 0; i < NXY; i++) if (hMin[i] < zb) zb = hMin[i];
  zb -= 2;
  const zeL = [zb];
  let d = 25;
  while (zeL[zeL.length - 1] - zb < 2300) {
    if (zeL[zeL.length - 1] - zb >= 700) d = Math.min(d * 1.2, 160);
    zeL.push(zeL[zeL.length - 1] + d);
  }
  const NZ = zeL.length - 1, NC = NXY * NZ;
  const ze = Float64Array.from(zeL);
  const dz = new Float64Array(NZ), dzc = new Float64Array(NZ + 1);
  for (let k = 0; k < NZ; k++) dz[k] = ze[k + 1] - ze[k];
  for (let k = 1; k < NZ; k++) dzc[k] = 0.5 * (dz[k - 1] + dz[k]);
  dzc[0] = dz[0] / 2; dzc[NZ] = dz[NZ - 1] / 2;

  // ---- face apertures (open fraction), initial profile, conductances ----
  const AX = new Float32Array(SX * NY * NZ), PX = new Float32Array(SX * NY * NZ), GX = new Float32Array(SX * NY * NZ);
  const AY = new Float32Array(NX * SY * NZ), PY = new Float32Array(NX * SY * NZ), GY = new Float32Array(NX * SY * NZ);
  const AZ = new Float32Array(NXY * (NZ + 1)), GZ = new Float32Array(NXY * (NZ + 1));
  const D = new Float32Array(NC);

  for (let k = 0; k < NZ; k++) {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i <= NX; i++) {
        const hl = hMean[j * NX + (i > 0 ? i - 1 : 0)], hr = hMean[j * NX + (i < NX ? i : NX - 1)];
        const hf = 0.5 * (hl + hr);
        let f = (ze[k + 1] - hf) / dz[k];
        f = f > 1 ? 1 : f < 0.05 ? 0 : f;
        const q = (k * NY + j) * SX + i;
        AX[q] = f;
        if (f > 0) {
          PX[q] = prof(0.5 * (Math.max(ze[k], hf) + ze[k + 1]) - hf);
          GX[q] = f * dz[k] * (i === 0 || i === NX ? 2 : 1);
        }
      }
    }
    for (let j = 0; j <= NY; j++) {
      for (let i = 0; i < NX; i++) {
        const hs = hMean[(j > 0 ? j - 1 : 0) * NX + i], hn = hMean[(j < NY ? j : NY - 1) * NX + i];
        const hf = 0.5 * (hs + hn);
        let f = (ze[k + 1] - hf) / dz[k];
        f = f > 1 ? 1 : f < 0.05 ? 0 : f;
        const q = (k * SY + j) * NX + i;
        AY[q] = f;
        if (f > 0) {
          PY[q] = prof(0.5 * (Math.max(ze[k], hf) + ze[k + 1]) - hf);
          GY[q] = f * dz[k] * (j === 0 || j === NY ? 2 : 1);
        }
      }
    }
  }
  for (let k = 1; k <= NZ; k++) {
    for (let c2 = 0; c2 < NXY; c2++) {
      let f = k === NZ ? 1 : (ze[k] - hMin[c2]) / (hMax[c2] - hMin[c2] + 1e-3);
      f = f > 1 ? 1 : f < 0.05 ? 0 : f;
      AZ[k * NXY + c2] = f;
      GZ[k * NXY + c2] = f * dx * dx * alpha2 / dzc[k];
    }
  }
  for (let k = 0; k < NZ; k++)
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const c = (k * NY + j) * NX + i;
        D[c] = GX[(k * NY + j) * SX + i] + GX[(k * NY + j) * SX + i + 1] +
               GY[(k * SY + j) * NX + i] + GY[(k * SY + j + 1) * NX + i] +
               GZ[c] + GZ[c + NXY];
      }

  const TOL = 1e-3, MAXIT = 260, OMEGA = 1.88;
  const cp = new Float64Array(NZ), dp = new Float64Array(NZ);

  function solve(basis) {
    const lam = new Float32Array(NC), div = new Float32Array(NC);
    for (let k = 0; k < NZ; k++)
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const c = (k * NY + j) * NX + i;
          if (basis === 0) {
            const q = (k * NY + j) * SX + i;
            div[c] = (AX[q + 1] * PX[q + 1] - AX[q] * PX[q]) * dx * dz[k];
          } else {
            const q = (k * SY + j) * NX + i;
            div[c] = (AY[q + NX] * PY[q + NX] - AY[q] * PY[q]) * dx * dz[k];
          }
        }

    for (let it = 0; it < MAXIT; it++) {
      let maxD = 0, maxL = 1e-9;
      for (let color = 0; color < 2; color++) {
        for (let j = 0; j < NY; j++) {
          for (let i = (j + color) & 1; i < NX; i += 2) {
            for (let k = 0; k < NZ; k++) {
              const c = (k * NY + j) * NX + i, dg = D[c];
              if (dg < 1e-6) { cp[k] = 0; dp[k] = 0; continue; }
              let r = div[c];
              const qx = (k * NY + j) * SX + i, qy = (k * SY + j) * NX + i;
              if (i > 0) r += GX[qx] * lam[c - 1];
              if (i < NX - 1) r += GX[qx + 1] * lam[c + 1];
              if (j > 0) r += GY[qy] * lam[c - NX];
              if (j < NY - 1) r += GY[qy + NX] * lam[c + NX];
              const a = k > 0 ? -GZ[c] : 0;
              const cc = k < NZ - 1 ? -GZ[c + NXY] : 0;
              const den = k > 0 ? dg - a * cp[k - 1] : dg;
              cp[k] = cc / den;
              dp[k] = (k > 0 ? r - a * dp[k - 1] : r) / den;
            }
            let x = 0;
            for (let k = NZ - 1; k >= 0; k--) {
              const c = (k * NY + j) * NX + i;
              x = dp[k] - cp[k] * x;
              const old = lam[c], nw = old + OMEGA * (x - old);
              lam[c] = nw;
              const dl = nw > old ? nw - old : old - nw, al = nw > 0 ? nw : -nw;
              if (dl > maxD) maxD = dl;
              if (al > maxL) maxL = al;
            }
          }
        }
      }
      const res = maxD / maxL;
      if (it % 4 === 0) {
        const p = Math.min(1, Math.max(0, Math.log(res) / Math.log(TOL)));
        self.postMessage({ type: 'progress', id, basis, frac: p });
      }
      if (res < TOL) break;
    }
    return lam;
  }

  // ---- resample the solution onto terrain-following (height-above-ground) levels ----
  const NA = agl.length;
  function toSigma(lam, basis) {
    const out = new Float32Array(NXY * NA * 3);
    const zs = new Float64Array(NZ), us = new Float64Array(NZ), vs = new Float64Array(NZ), ws = new Float64Array(NZ);
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const c2 = j * NX + i, h = hMean[c2];
        let nv = 0;
        for (let k = 0; k < NZ; k++) {
          if (ze[k + 1] <= h + 1) continue;
          const c = (k * NY + j) * NX + i;
          const qx = (k * NY + j) * SX + i, qy = (k * SY + j) * NX + i;
          const axl = AX[qx], axr = AX[qx + 1], ayl = AY[qy], ayr = AY[qy + NX];
          const sx = axl + axr, sy = ayl + ayr;
          if (sx < 0.1 || sy < 0.1) continue;
          const lc = lam[c];
          const ul = (basis === 0 ? PX[qx] : 0) + (i > 0 ? (lc - lam[c - 1]) / dx : 2 * lc / dx);
          const ur = (basis === 0 ? PX[qx + 1] : 0) + (i < NX - 1 ? (lam[c + 1] - lc) / dx : -2 * lc / dx);
          const vl = (basis === 1 ? PY[qy] : 0) + (j > 0 ? (lc - lam[c - NX]) / dx : 2 * lc / dx);
          const vr = (basis === 1 ? PY[qy + NX] : 0) + (j < NY - 1 ? (lam[c + NX] - lc) / dx : -2 * lc / dx);
          const azb = AZ[c], azt = AZ[c + NXY], sz = azb + azt;
          const wb = k > 0 ? alpha2 * (lc - lam[c - NXY]) / dzc[k] : 0;
          const wt = k < NZ - 1 ? alpha2 * (lam[c + NXY] - lc) / dzc[k + 1] : -alpha2 * lc / dzc[NZ];
          zs[nv] = 0.5 * (Math.max(ze[k], h) + ze[k + 1]);
          us[nv] = (axl * ul + axr * ur) / sx;
          vs[nv] = (ayl * vl + ayr * vr) / sy;
          ws[nv] = sz > 0 ? (azb * wb + azt * wt) / sz : 0;
          nv++;
        }
        const il = i > 0 ? i - 1 : i, ir = i < NX - 1 ? i + 1 : i;
        const jl = j > 0 ? j - 1 : j, jr = j < NY - 1 ? j + 1 : j;
        const hx = (hMean[j * NX + ir] - hMean[j * NX + il]) / ((ir - il) * dx);
        const hy = (hMean[jr * NX + i] - hMean[jl * NX + i]) / ((jr - jl) * dx);
        let q = 0;
        for (let m = 0; m < NA; m++) {
          const a = agl[m], z = h + a;
          let u = 0, v = 0, w = 0;
          if (nv > 0) {
            if (z <= zs[0] || nv === 1) {
              const s = z <= zs[0] ? prof(a) / prof(zs[0] - h) : 1;
              u = us[0] * s; v = vs[0] * s; w = ws[0] * s;
            } else {
              while (q < nv - 2 && zs[q + 1] < z) q++;
              let t = (z - zs[q]) / (zs[q + 1] - zs[q]);
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              u = us[q] + (us[q + 1] - us[q]) * t;
              v = vs[q] + (vs[q + 1] - vs[q]) * t;
              w = ws[q] + (ws[q + 1] - ws[q]) * t;
            }
          }
          // close to the ground the flow must follow the slope
          const wt = u * hx + v * hy;
          let b = a / 80; b = b > 1 ? 1 : b * b * (3 - 2 * b);
          w = wt + (w - wt) * b;
          const mag = Math.hypot(u, v, w);
          if (mag > 3) { const s = 3 / mag; u *= s; v *= s; w *= s; }
          const o = ((m * NY + j) * NX + i) * 3;
          out[o] = u; out[o + 1] = v; out[o + 2] = w;
        }
      }
    }
    return out;
  }

  const data = toSigma(solve(basis), basis);
  self.postMessage({ type: 'done', id, basis, data }, [data.buffer]);
};
