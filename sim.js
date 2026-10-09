/*  KulmanTakaa simulated corner — a camera looking at the floor beside a wall
 *  edge, with a hidden light source around the corner that only reaches the
 *  floor through the edge's one-dimensional pinhole.
 *
 *  Top view, metres. The building (the occluder) fills the quadrant u<0, v>0,
 *  so its visible face is the line v=0, u<0, and its vertical edge stands at
 *  the origin. The camera is on the v<0 side, BELOW the wall top, so it never
 *  sees the hidden corridor u>0, v>0 directly.
 *
 *  A floor point at θ = atan2(-v, -u) (angle from the wall face) receives
 *  hidden light from ψ ∈ [0, min(θ, 90°)], ψ measured from the wall line
 *  continued past the edge. That is the whole forward model; everything the
 *  camera adds on top is the nuisance a real instrument has to survive:
 *  textured albedo, an ambient gradient, vignetting, indirect spill of hidden
 *  light everywhere, auto-exposure reacting to it, sensor noise and 8-bit
 *  quantisation.
 */
(function (root, factory) {
  const KT = (typeof module === 'object' && module.exports) ? require('./core.js') : root.KT;
  const m = factory(KT);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.KTSim = m;
})(typeof self !== 'undefined' ? self : this, function (KT) {
  'use strict';

  const NPSI = 512;
  const HALF_PI = Math.PI / 2;

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function valueNoise(seed) {
    return (u, v, scale) => {
      const x = u / scale, y = v / scale;
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const h = (a, b) => KT.hash(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), seed) / 4294967296;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
      return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    };
  }

  class Sim {
    constructor(opt = {}) {
      this.w = opt.w || 320;
      this.h = opt.h || 240;
      this.contrast = opt.contrast != null ? opt.contrast : 0.03; // total hidden light / ambient
      this.noise = opt.noise != null ? opt.noise : 2;               // DN, sensor noise sd
      this.spill = opt.spill != null ? opt.spill : 0.3;             // indirect hidden light, everywhere
      this.ae = opt.ae !== false;                                   // auto-exposure on
      this.mode = opt.mode || 'slots';
      this.seed = opt.seed != null ? opt.seed : KT.SEED;            // actor schedule seed
      this.psiLo = (opt.psiLoDeg != null ? opt.psiLoDeg : 24) * Math.PI / 180;
      this.psiHi = (opt.psiHiDeg != null ? opt.psiHiDeg : 76) * Math.PI / 180;
      this.barDeg = opt.barDeg != null ? opt.barDeg : 6;
      this.ambient = opt.ambient || 115;
      this.wallH = 0.30;
      this.gain = 1;
      // Camera stands back along the wall, close to its line: from here the wall
      // hides every hidden direction ψ > atan(|v_c|/|u_c|) ≈ 17°, i.e. the whole
      // corridor the actor lives in. (A camera off to the side would see it.)
      this.cam = opt.cam || { pos: [-0.42, -0.13, 0.20], look: [0.0, -0.05, 0.0], fovDeg: 52 };
      const r = rng(opt.noiseSeed || 12345);
      this.gauss = new Float32Array(1 << 16);
      for (let i = 0; i < this.gauss.length; i++) {
        const u1 = Math.max(r(), 1e-12), u2 = r();
        this.gauss[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      }
      this.rand = rng(opt.noiseSeed ? opt.noiseSeed * 7 + 1 : 777);
      this._setupCamera();
      this._setupStatic();
      this.cum = [new Float32Array(NPSI + 1), new Float32Array(NPSI + 1), new Float32Array(NPSI + 1)];
      this.buf = new Uint8ClampedArray(this.w * this.h * 4);
    }

    _setupCamera() {
      const { pos, look, fovDeg } = this.cam;
      const f = [look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]];
      const n = Math.hypot(...f); f[0] /= n; f[1] /= n; f[2] /= n;
      let rgt = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0]; // f × z
      const rn = Math.hypot(...rgt); rgt = rgt.map((v) => v / rn);
      const up = [rgt[1] * f[2] - rgt[2] * f[1], rgt[2] * f[0] - rgt[0] * f[2], rgt[0] * f[1] - rgt[1] * f[0]];
      this.basis = { f, rgt, up };
      this.focal = (this.h / 2) / Math.tan(fovDeg * Math.PI / 360);
    }

    /** Project a world point to pixel coordinates. */
    project(P) {
      const { f, rgt, up } = this.basis, c = this.cam.pos;
      const d = [P[0] - c[0], P[1] - c[1], P[2] - c[2]];
      const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      const x = d[0] * rgt[0] + d[1] * rgt[1] + d[2] * rgt[2];
      const y = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
      return { x: this.w / 2 + this.focal * x / z, y: this.h / 2 - this.focal * y / z };
    }

    /** The three clicks a user would make on this view. */
    defaultClicks() {
      const th = 86 * Math.PI / 180, r = 0.17;
      return {
        C: this.project([0, 0, 0]),
        W: this.project([-0.2, 0, 0]),
        S: this.project([-r * Math.cos(th), -r * Math.sin(th), 0]),
      };
    }

    _setupStatic() {
      const W = this.w, H = this.h, N = W * H;
      this.kind = new Uint8Array(N);      // 0 sky/far, 1 floor, 2 wall
      this.tIdx = new Float32Array(N);    // hidden-visibility index into cum (0..NPSI)
      this.alb = new Float32Array(N * 3);
      this.amb = new Float32Array(N);
      const noise = valueNoise(99);
      const { f, rgt, up } = this.basis, c = this.cam.pos;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const sx = (x + 0.5 - W / 2) / this.focal, sy = -(y + 0.5 - H / 2) / this.focal;
          const d = [f[0] + sx * rgt[0] + sy * up[0], f[1] + sx * rgt[1] + sy * up[1], f[2] + sx * rgt[2] + sy * up[2]];
          const vig = 1 - 0.35 * ((x / W - 0.5) ** 2 + (y / H - 0.5) ** 2) * 2;
          // wall face: plane v = 0, u < 0, 0 < z < wallH
          let tWall = Infinity;
          if (d[1] > 1e-9) {
            const t = -c[1] / d[1];
            const u = c[0] + t * d[0], z = c[2] + t * d[2];
            if (t > 0 && u < 0 && z >= 0 && z <= this.wallH) tWall = t;
          }
          let tFloor = Infinity;
          if (d[2] < -1e-9) tFloor = -c[2] / d[2];
          if (tWall < tFloor) {
            const u = c[0] + tWall * d[0], z = c[2] + tWall * d[2];
            const a = 0.55 + 0.15 * noise(u, z, 0.03);
            this.kind[i] = 2;
            this.alb[3 * i] = a * 0.95; this.alb[3 * i + 1] = a * 0.93; this.alb[3 * i + 2] = a * 0.9;
            this.amb[i] = this.ambient * vig * 0.8;
            this.tIdx[i] = 0;
            continue;
          }
          if (!Number.isFinite(tFloor) || tFloor > 3) {
            this.kind[i] = 0; this.amb[i] = this.ambient * 0.15 * vig;
            this.alb[3 * i] = this.alb[3 * i + 1] = this.alb[3 * i + 2] = 1;
            continue;
          }
          const u = c[0] + tFloor * d[0], v = c[1] + tFloor * d[1];
          if (u < 0 && v > 0) { // building top seen from above (not with default camera)
            this.kind[i] = 2; this.amb[i] = this.ambient * 0.6 * vig;
            this.alb[3 * i] = this.alb[3 * i + 1] = this.alb[3 * i + 2] = 0.6;
            continue;
          }
          this.kind[i] = 1;
          const grain = 0.62 + 0.22 * noise(u * 1.0, v * 6.0, 0.02) + 0.12 * noise(u, v, 0.11);
          this.alb[3 * i] = grain * 1.0; this.alb[3 * i + 1] = grain * 0.86; this.alb[3 * i + 2] = grain * 0.7;
          this.amb[i] = this.ambient * vig * (1 + 0.6 * (u + 0.1) - 0.4 * v);
          let theta;
          if (v < 0) theta = Math.atan2(-v, -u); else theta = Math.PI;
          this.tIdx[i] = Math.min(theta, HALF_PI) / HALF_PI * NPSI;
        }
      }
    }

    /** Hidden scene at time t → cumulative visibility tables (DN·fraction). */
    _hidden(t) {
      const s = KT.schedule(t, this.mode, this.seed);
      const total = this.contrast * this.ambient;
      const tot = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) this.cum[ch][0] = 0;
      if (!s.on) {
        for (let ch = 0; ch < 3; ch++) this.cum[ch].fill(0);
        return { tot, s };
      }
      const psiC = this.psiLo + (this.psiHi - this.psiLo) * s.pos;
      const half = this.barDeg * Math.PI / 360;
      const col = s.color.map((v) => v / 255);
      const colN = (col[0] + col[1] + col[2]) / 3 || 1;
      const dpsi = HALF_PI / NPSI;
      for (let ch = 0; ch < 3; ch++) {
        let acc = 0;
        const per = total * col[ch] / colN / (2 * half);
        for (let j = 0; j < NPSI; j++) {
          const p0 = j * dpsi, p1 = p0 + dpsi;
          const ov = Math.max(0, Math.min(p1, psiC + half) - Math.max(p0, psiC - half));
          acc += per * ov;
          this.cum[ch][j + 1] = acc;
        }
        tot[ch] = acc;
      }
      return { tot, s };
    }

    /** Render the frame at wall-clock time t (ms). Returns RGBA. */
    frame(t) {
      const { tot } = this._hidden(t);
      const N = this.w * this.h, out = this.buf;
      const sp = this.spill;
      // pre-gain mean for auto-exposure (subsampled)
      let raw = 0, cnt = 0;
      for (let i = 0; i < N; i += 7) {
        const ti = this.tIdx[i] | 0;
        for (let ch = 0; ch < 3; ch++) raw += this.alb[3 * i + ch] * (this.amb[i] + this.cum[ch][ti] + sp * tot[ch]);
        cnt += 3;
      }
      raw /= cnt;
      if (this.ae) {
        const target = 0.95 * this.ambient * 0.62;
        this.gain += 0.12 * (target / raw - this.gain);
        // real AE steps in quantised exposure increments
        this.gainQ = Math.round(this.gain * 256) / 256;
      } else this.gainQ = 1;
      const g = this.gainQ, sd = this.noise, G = this.gauss;
      let gi = (this.rand() * 65536) | 0;
      for (let i = 0; i < N; i++) {
        const fi = this.tIdx[i];
        const t0 = fi | 0, fr = fi - t0;
        const t1 = t0 < NPSI ? t0 + 1 : t0;
        for (let ch = 0; ch < 3; ch++) {
          const cm = this.cum[ch];
          const hid = cm[t0] + fr * (cm[t1] - cm[t0]);
          const v = g * this.alb[3 * i + ch] * (this.amb[i] + hid + sp * tot[ch]) + sd * G[(gi++) & 65535];
          out[4 * i + ch] = v;  // Uint8ClampedArray rounds and clamps: the 8-bit sensor
        }
        out[4 * i + 3] = 255;
        if ((i & 1023) === 0) gi = (this.rand() * 65536) | 0;
      }
      return out;
    }
  }

  return { Sim };
});
