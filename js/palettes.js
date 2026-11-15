import * as THREE from 'three';

function ramp(stops) {
  const f = (t) => {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let k = 0;
    while (k < stops.length - 2 && stops[k + 1][0] < t) k++;
    const a = stops[k], b = stops[k + 1];
    const u = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
  };
  f.stops = stops;
  return f;
}

export const PAL = {
  // sink (blue) - neutral (pale) - lift (amber/red)
  lift: ramp([[0, 40, 105, 255], [0.3, 95, 175, 255], [0.5, 190, 220, 246], [0.7, 255, 192, 64], [1, 255, 72, 44]]),
  speed: ramp([[0, 70, 80, 190], [0.25, 50, 165, 230], [0.5, 90, 215, 140], [0.75, 250, 212, 70], [1, 255, 84, 56]]),
  turb: ramp([[0, 120, 215, 255], [0.45, 215, 150, 255], [1, 255, 56, 120]]),
};

export function cssGradient(pal) {
  return 'linear-gradient(90deg,' + pal.stops.map(s => `rgb(${s[1]},${s[2]},${s[3]}) ${s[0] * 100}%`).join(',') + ')';
}

export function fillPaletteTexture(tex, pal) {
  const d = tex.image.data;
  for (let i = 0; i < 256; i++) {
    const c = pal(i / 255);
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  tex.needsUpdate = true;
}

export function paletteTexture(pal) {
  const tex = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  fillPaletteTexture(tex, pal);
  return tex;
}
