import { PAL } from './palettes.js';

// Vertical cross-section along the wind through the probe point:
// lift/sink colours, lee shading, streamlines and the "glider stays up" contour.

const S0 = 3500;          // half length [m]
const ZSPAN = 1500;       // vertical extent [m]
const GW = 240, GH = 90;  // field raster

export class Section {
  constructor(canvas, field, hAt, sinkRate) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.field = field; this.hAt = hAt; this.sink = sinkRate;
    this.off = document.createElement('canvas');
    this.off.width = GW; this.off.height = GH;
    this.octx = this.off.getContext('2d');
    this.img = this.octx.createImageData(GW, GH);
    this.wg = new Float32Array(GW * GH);
    this.hs = new Float32Array(GW);
    this.out = new Float32Array(4);
  }

  render(probe, dirDeg, speed) {
    const cv = this.cv, ctx = this.ctx, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const padL = 40, padR = 8, padT = 8, padB = 20, W = cw - padL - padR, H = ch - padT - padB;
    const r = dirDeg * Math.PI / 180, fx = -Math.sin(r), fy = -Math.cos(r);
    const { field, hAt, hs, wg, out } = this;
    const hAtS = (s) => hAt(probe.x + s * fx, probe.n + s * fy);

    let lo = Infinity;
    for (let gx = 0; gx < GW; gx++) {
      hs[gx] = hAtS(-S0 + (gx + 0.5) / GW * 2 * S0);
      if (hs[gx] < lo) lo = hs[gx];
    }
    const zmin = Math.floor((lo - 30) / 50) * 50, zmax = zmin + ZSPAN;
    const X = (s) => padL + (s + S0) / (2 * S0) * W;
    const Y = (z) => padT + (zmax - z) / ZSPAN * H;

    // --- field raster ---
    const d = this.img.data;
    const ok = field.ready && speed > 0.05;
    for (let gy = 0; gy < GH; gy++) {
      const z = zmax - (gy + 0.5) / GH * ZSPAN;
      for (let gx = 0; gx < GW; gx++) {
        const o = gy * GW + gx, a = z - hs[gx];
        if (a < 0 || !ok) { wg[o] = -99; d[o * 4 + 3] = 0; continue; }
        const s = -S0 + (gx + 0.5) / GW * 2 * S0;
        field.sample(probe.x + s * fx, probe.n + s * fy, a, out);
        const w = out[2], S = out[3];
        wg[o] = S < 0.25 ? w : Math.min(w, 0);
        const c = PAL.lift(0.5 + w / 6);
        const al = Math.min(1, Math.abs(w) / 2.2) * 0.9;
        const m = S * 0.6;
        d[o * 4] = c[0] * (1 - m) + 205 * m;
        d[o * 4 + 1] = c[1] * (1 - m) + 60 * m;
        d[o * 4 + 2] = c[2] * (1 - m) + 150 * m;
        d[o * 4 + 3] = 255 * (al * (1 - m) + m);
      }
    }
    this.octx.putImageData(this.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, padL, padT, W, H);

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, W, H); ctx.clip();

    // --- contour: vertical wind = glider sink rate ---
    if (ok) {
      const thr = this.sink, gxp = (g) => padL + (g + 0.5) / GW * W, gyp = (g) => padT + (g + 0.5) / GH * H;
      ctx.beginPath();
      const pts = [];
      for (let gy = 0; gy < GH - 1; gy++) {
        for (let gx = 0; gx < GW - 1; gx++) {
          const o = gy * GW + gx;
          const a = wg[o] - thr, b = wg[o + 1] - thr, c = wg[o + GW + 1] - thr, e = wg[o + GW] - thr;
          const sa = a > 0, sb = b > 0, sc = c > 0, se = e > 0;
          if (sa === sb && sb === sc && sc === se) continue;
          pts.length = 0;
          const cl = (t) => Math.max(0, Math.min(1, t));
          if (sa !== sb) pts.push(gx + cl(a / (a - b)), gy);
          if (sb !== sc) pts.push(gx + 1, gy + cl(b / (b - c)));
          if (se !== sc) pts.push(gx + cl(e / (e - c)), gy + 1);
          if (sa !== se) pts.push(gx, gy + cl(a / (a - e)));
          for (let k = 0; k + 3 < pts.length; k += 4) {
            ctx.moveTo(gxp(pts[k]), gyp(pts[k + 1]));
            ctx.lineTo(gxp(pts[k + 2]), gyp(pts[k + 3]));
          }
        }
      }
      ctx.strokeStyle = 'rgba(120,255,170,0.9)'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 3]);
      ctx.stroke(); ctx.setLineDash([]);
    }

    // --- streamlines ---
    if (ok) {
      const NS = 150, ds = 2 * S0 / NS;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
      let li = 0;
      for (const a0 of [15, 45, 90, 150, 230, 330, 460, 620, 820, 1050, 1300]) {
        const k1 = 22 + (li * 17) % 40, k2 = k1 + 70; li++;
        let s = -S0, z = hAtS(s) + a0;
        ctx.beginPath(); ctx.moveTo(X(s), Y(z));
        const arrows = [];
        for (let k = 0; k < NS; k++) {
          field.sample(probe.x + s * fx, probe.n + s * fy, z - hAtS(s), out);
          const ual = out[0] * fx + out[1] * fy;
          if (ual < 0.03 * speed + 0.02) break;
          const z0 = z, slope = Math.max(-1.2, Math.min(1.2, out[2] / ual));
          s += ds; z += slope * ds;
          const h1 = hAtS(s);
          if (z < h1 + 4) z = h1 + 4;
          if (z > zmax) break;
          ctx.lineTo(X(s), Y(z));
          if (k === k1 || k === k2) arrows.push(s, z, Math.atan2(Y(z) - Y(z0), X(s) - X(s - ds)));
        }
        ctx.stroke();
        for (let k = 0; k < arrows.length; k += 3) {
          ctx.save(); ctx.translate(X(arrows[k]), Y(arrows[k + 1])); ctx.rotate(arrows[k + 2]);
          ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-3, -2.6); ctx.lineTo(-3, 2.6); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
    }

    // --- terrain silhouette ---
    const NP = Math.max(60, Math.round(W / 2));
    ctx.beginPath(); ctx.moveTo(padL, padT + H);
    for (let k = 0; k <= NP; k++) { const s = -S0 + k / NP * 2 * S0; ctx.lineTo(X(s), Y(hAtS(s))); }
    ctx.lineTo(padL + W, padT + H); ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, padT + H);
    g.addColorStop(0, '#3a4656'); g.addColorStop(1, '#161d27');
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    for (let k = 0; k <= NP; k++) { const s = -S0 + k / NP * 2 * S0; k ? ctx.lineTo(X(s), Y(hAtS(s))) : ctx.moveTo(X(s), Y(hAtS(s))); }
    ctx.strokeStyle = 'rgba(200,215,235,0.85)'; ctx.lineWidth = 1.2; ctx.stroke();

    // probe marker
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(X(0), padT); ctx.lineTo(X(0), Y(hAtS(0))); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(0), Y(hAtS(0)), 3, 0, 6.3); ctx.fill();
    ctx.restore();

    // --- axes ---
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(220,230,245,0.6)'; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let z = Math.ceil(zmin / 250) * 250; z < zmax; z += 250) {
      ctx.fillText(z + ' m', padL - 6, Y(z));
      ctx.beginPath(); ctx.moveTo(padL, Y(z)); ctx.lineTo(padL + W, Y(z)); ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let km = -3; km <= 3; km++) {
      const t = km === 0 ? 'probe' : (km > 0 ? '+' : '−') + Math.abs(km) + ' km';
      ctx.fillText(t, X(km * 1000), padT + H + 5);
    }
  }
}
