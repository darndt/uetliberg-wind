import * as THREE from 'three';

const loadImage = (url) => new Promise((res, rej) => {
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = () => rej(new Error('failed to load ' + url));
  im.src = url;
});

const D2R = Math.PI / 180;
const mercPx = (lat, lon, z) => {
  const s = 256 * 2 ** z;
  return [(lon + 180) / 360 * s, (1 - Math.asinh(Math.tan(lat * D2R)) / Math.PI) / 2 * s];
};

/**
 * Loads the DEM + imagery and builds the terrain mesh.
 * Local frame: x = east, n = north (metres from the domain centre); world = (x, height, -n).
 */
export async function loadTerrain(M = 512) {
  const meta = await (await fetch('data/meta.json')).json();
  const L = meta.size, half = L / 2;
  const coslat = Math.cos(meta.lat0 * D2R);
  const toLatLon = (x, n) => [meta.lat0 + n / 111320, meta.lon0 + x / (111320 * coslat)];
  const fromLatLon = (lat, lon) => [(lon - meta.lon0) * 111320 * coslat, (lat - meta.lat0) * 111320];

  // --- decode Terrarium elevation mosaic ---
  const img = await loadImage('data/dem.png');
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data, W = cv.width, H = cv.height;
  const elev = (ix, iy) => { const o = (iy * W + ix) * 4; return px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768; };
  const demOx = meta.dem.x0 * 256, demOy = meta.dem.y0 * 256;
  const demAt = (lat, lon) => {
    let [fx, fy] = mercPx(lat, lon, meta.dem.z);
    fx = Math.min(W - 1.001, Math.max(0, fx - demOx - 0.5));
    fy = Math.min(H - 1.001, Math.max(0, fy - demOy - 0.5));
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    return (elev(ix, iy) * (1 - tx) + elev(ix + 1, iy) * tx) * (1 - ty) +
           (elev(ix, iy + 1) * (1 - tx) + elev(ix + 1, iy + 1) * tx) * ty;
  };

  const heights = new Float32Array(M * M);   // [j * M + i], j = 0 is the south edge
  const step = L / (M - 1);
  let hMinAll = Infinity, hMaxAll = -Infinity;
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const [lat, lon] = toLatLon(-half + i * step, -half + j * step);
      const h = demAt(lat, lon);
      heights[j * M + i] = h;
      if (h < hMinAll) hMinAll = h;
      if (h > hMaxAll) hMaxAll = h;
    }
  }

  const hAt = (x, n) => {
    let gx = (x + half) / step, gy = (n + half) / step;
    gx = gx < 0 ? 0 : gx > M - 1.001 ? M - 1.001 : gx;
    gy = gy < 0 ? 0 : gy > M - 1.001 ? M - 1.001 : gy;
    const i = gx | 0, j = gy | 0, tx = gx - i, ty = gy - j, c = j * M + i;
    return (heights[c] * (1 - tx) + heights[c + 1] * tx) * (1 - ty) +
           (heights[c + M] * (1 - tx) + heights[c + M + 1] * tx) * ty;
  };

  // --- mesh ---
  const pos = new Float32Array(M * M * 3), nor = new Float32Array(M * M * 3);
  const uv = new Float32Array(M * M * 2), uvo = new Float32Array(M * M * 2);
  const oW = meta.ortho.cols * 256, oH = meta.ortho.rows * 256;
  const oOx = meta.ortho.x0 * 256, oOy = meta.ortho.y0 * 256;
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const c = j * M + i, x = -half + i * step, n = -half + j * step;
      pos[c * 3] = x; pos[c * 3 + 1] = heights[c]; pos[c * 3 + 2] = -n;
      const il = Math.max(0, i - 1), ir = Math.min(M - 1, i + 1), jl = Math.max(0, j - 1), jr = Math.min(M - 1, j + 1);
      const hx = (heights[j * M + ir] - heights[j * M + il]) / ((ir - il) * step);
      const hn = (heights[jr * M + i] - heights[jl * M + i]) / ((jr - jl) * step);
      const inv = 1 / Math.hypot(hx, 1, hn);
      nor[c * 3] = -hx * inv; nor[c * 3 + 1] = inv; nor[c * 3 + 2] = hn * inv;
      uv[c * 2] = i / (M - 1); uv[c * 2 + 1] = j / (M - 1);
      const [lat, lon] = toLatLon(x, n);
      const [mx, my] = mercPx(lat, lon, meta.ortho.z);
      uvo[c * 2] = (mx - oOx) / oW; uvo[c * 2 + 1] = 1 - (my - oOy) / oH;
    }
  }
  const idx = new Uint32Array((M - 1) * (M - 1) * 6);
  let q = 0;
  for (let j = 0; j < M - 1; j++) {
    for (let i = 0; i < M - 1; i++) {
      const a = j * M + i, b = a + 1, c = a + M, d = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = d;
      idx[q++] = a; idx[q++] = d; idx[q++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('uvOrtho', new THREE.BufferAttribute(uvo, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const uniforms = {
    uOrtho: { value: null }, uHasOrtho: { value: 0 },
    uOverlay: { value: null }, uOverlayOn: { value: 0 },
    uExag: { value: 1 },
    uLight: { value: new THREE.Vector3(-0.55, 0.62, -0.56).normalize() },   // sun from the NW-ish, classic relief shading
    uHRange: { value: new THREE.Vector2(hMinAll, hMaxAll) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec2 uvOrtho;
      uniform float uExag;
      varying vec2 vUv; varying vec2 vUvO; varying vec3 vN; varying float vH;
      void main() {
        vUv = uv; vUvO = uvOrtho; vH = position.y;
        vN = normalize(vec3(normal.x * uExag, normal.y, normal.z * uExag));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uOrtho; uniform sampler2D uOverlay;
      uniform float uHasOrtho, uOverlayOn; uniform vec3 uLight; uniform vec2 uHRange;
      varying vec2 vUv; varying vec2 vUvO; varying vec3 vN; varying float vH;
      void main() {
        vec3 n = normalize(vN);
        float sh = clamp(dot(n, uLight), 0.0, 1.0);
        vec3 base;
        if (uHasOrtho > 0.5) {
          base = texture2D(uOrtho, vUvO).rgb;
          float g = dot(base, vec3(0.299, 0.587, 0.114));
          base = mix(vec3(g), base, 0.8) * 0.82;
        } else {
          float t = clamp((vH - uHRange.x) / (uHRange.y - uHRange.x), 0.0, 1.0);
          base = mix(vec3(0.20, 0.27, 0.24), vec3(0.16, 0.33, 0.20), smoothstep(0.05, 0.5, t));
          base = mix(base, vec3(0.42, 0.44, 0.36), smoothstep(0.6, 1.0, t));
          base = mix(base, vec3(0.30, 0.31, 0.30), 1.0 - smoothstep(0.75, 0.98, n.y));
        }
        base *= 0.5 + 0.75 * sh;
        float c = vH / 50.0;
        float line = 1.0 - smoothstep(0.0, 1.3, abs(fract(c - 0.5) - 0.5) / fwidth(c));
        base = mix(base, vec3(1.0), line * 0.10);
        vec4 o = texture2D(uOverlay, vUv);
        base = mix(base, o.rgb * (0.55 + 0.6 * sh), o.a * uOverlayOn);
        gl_FragColor = vec4(base, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, material);

  new THREE.TextureLoader().load('data/ortho.jpg', (tex) => {
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 8;
    uniforms.uOrtho.value = tex; uniforms.uHasOrtho.value = 1;
  }, undefined, () => { /* imagery missing: keep the shaded-relief fallback */ });

  // --- skirt: turns the terrain into a solid block ---
  const baseY = Math.floor(hMinAll / 50) * 50 - 150;
  const sp = [], sc = [], si = [];
  const edge = (pts) => {
    const o = sp.length / 3;
    pts.forEach(([i, j]) => {
      const c = j * M + i;
      sp.push(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2], pos[c * 3], baseY, pos[c * 3 + 2]);
      sc.push(0.17, 0.21, 0.27, 0.035, 0.05, 0.075);
    });
    for (let k = 0; k < pts.length - 1; k++) {
      const a = o + k * 2;
      si.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  };
  const r = [...Array(M).keys()];
  edge(r.map(i => [i, 0])); edge(r.map(i => [i, M - 1]));
  edge(r.map(j => [0, j])); edge(r.map(j => [M - 1, j]));
  const sgeo = new THREE.BufferGeometry();
  sgeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  sgeo.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
  sgeo.setIndex(si);
  const skirt = new THREE.Mesh(sgeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));

  /** Coarse terrain statistics for the flow solver grid. */
  const simTerrain = (NX) => {
    const dx = L / NX, n = NX * NX;
    const hMean = new Float32Array(n), hMin = new Float32Array(n), hMax = new Float32Array(n);
    for (let j = 0; j < NX; j++) {
      for (let i = 0; i < NX; i++) {
        let s = 0, lo = Infinity, hi = -Infinity;
        for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
          const h = hAt(-half + (i + (a + 0.5) / 4) * dx, -half + (j + (b + 0.5) / 4) * dx);
          s += h; if (h < lo) lo = h; if (h > hi) hi = h;
        }
        hMean[j * NX + i] = s / 16; hMin[j * NX + i] = lo; hMax[j * NX + i] = hi;
      }
    }
    return { hMean, hMin, hMax, dx };
  };

  return { L, half, M, heights, hAt, mesh, skirt, uniforms, fromLatLon, toLatLon, simTerrain, hMinAll, hMaxAll };
}
