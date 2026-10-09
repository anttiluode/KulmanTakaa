/*  KulmanTakaa core — "behind the corner".
 *
 *  The physics, in one line:  a vertical edge is a one-dimensional pinhole.
 *  A floor point at angle θ from the wall face sees the hidden side only over
 *  hidden angles ψ ∈ [0, θ].  So the floor brightness, read around the corner,
 *  is a running integral of the hidden scene:
 *
 *        I(θ) = I_visible(θ) + ∫₀^θ L_hidden(ψ) dψ
 *
 *  Subtract the room (background), and the derivative along θ is the hidden
 *  scene.  Everything below is that sentence made robust:
 *    - bin pixels by angle around the clicked corner (image angle is a monotone
 *      reparametrisation of floor angle, because a homography maps rays through
 *      a point to rays through its image, preserving their order);
 *    - invert the cumulative integral with Tikhonov smoothing, weighted by how
 *      many pixels each bin has;
 *    - optionally fit an exposure-gain nuisance (a multiple of the background
 *      profile) alongside, so auto-exposure cannot pose as a hidden signal;
 *    - score against a phone "actor" whose bar position is a hash of wall-clock
 *      time, with wrong-seed schedules as the null.
 *
 *  No dependencies. Runs in the browser (window.KT) and in node (require).
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.KT = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ schedule
  // Shared verbatim by actor.html (the phone behind the corner) and the scorer.
  const SLOT_MS = 1500;
  const LEVELS = 5;
  const SEED = 0x4b54; // "KT"
  const WHITE = [255, 255, 255];
  const PALETTE = [[255, 40, 40], [40, 255, 60], [60, 100, 255]];

  function mix(x) {
    x |= 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  }
  function hash(n, seed) {
    return mix((Math.imul(n | 0, 0x9e3779b1) ^ mix(seed | 0)) | 0);
  }
  function levelPos(level) { return 0.1 + 0.8 * level / (LEVELS - 1); }

  /** Position (0..1 across the phone screen) the actor shows at wall-clock t. */
  function truthPos(t, seed = SEED) {
    const n = Math.floor(t / SLOT_MS);
    return levelPos(hash(n, seed) % LEVELS);
  }

  function schedule(t, mode, seed = SEED) {
    if (mode === 'off') return { on: false, pos: 0.5, color: WHITE };
    if (mode === 'still') return { on: true, pos: 0.5, color: WHITE };
    if (mode === 'sweep') {
      return { on: true, pos: 0.5 - 0.4 * Math.cos(2 * Math.PI * t / 8000), color: WHITE };
    }
    const n = Math.floor(t / SLOT_MS);
    const level = hash(n, seed) % LEVELS;
    const color = mode === 'color' ? PALETTE[hash(n, seed ^ 0x5f3759df) % 3] : WHITE;
    return { on: true, pos: levelPos(level), color, slot: n, level };
  }

  // ------------------------------------------------------------------ geometry
  /**
   * pts: {C: corner base, W: a point along the wall base, S: far end of the
   * floor wedge}, all in pixel coordinates of a w×h frame.
   * Image angle θ is measured from C→W, rotating toward C→S.
   */
  function buildGeometry(pts, w, h, opt = {}) {
    const K = opt.bins || 72;
    const rMinFrac = opt.rMinFrac != null ? opt.rMinFrac : 0.12;
    const loFrac = opt.thetaLoFrac != null ? opt.thetaLoFrac : 0.02;
    const { C, W, S } = pts;
    const wx = W.x - C.x, wy = W.y - C.y;
    const sx = S.x - C.x, sy = S.y - C.y;
    const angS = Math.atan2(wx * sy - wy * sx, wx * sx + wy * sy);
    const sign = angS >= 0 ? 1 : -1;
    const thetaS = Math.abs(angS);
    const rMax = Math.hypot(sx, sy) * (opt.rMaxFrac || 1);
    const rMin = rMax * rMinFrac;
    const thetaLo = thetaS * loFrac;
    const span = thetaS - thetaLo;
    const idx = [], bin = [];
    const counts = new Float64Array(K);
    const binOf = new Int16Array(w * h).fill(-1);
    if (span > 1e-3 && rMax > 2) {
      for (let y = 0; y < h; y++) {
        const py = y + 0.5 - C.y;
        for (let x = 0; x < w; x++) {
          const px = x + 0.5 - C.x;
          const r = Math.hypot(px, py);
          if (r < rMin || r > rMax) continue;
          const a = sign * Math.atan2(wx * py - wy * px, wx * px + wy * py);
          if (a < thetaLo || a > thetaS) continue;
          let k = Math.floor((a - thetaLo) / span * K);
          if (k >= K) k = K - 1;
          const i = y * w + x;
          idx.push(i); bin.push(k); counts[k]++; binOf[i] = k;
        }
      }
    }
    return {
      K, w, h, pts, thetaS, thetaLo, rMin, rMax, sign,
      idx: Int32Array.from(idx), bin: Int16Array.from(bin), counts, binOf,
      pixels: idx.length,
    };
  }

  /** Mean R,G,B per angular bin. out layout: [R_0..R_K-1, G_0.., B_0..]. */
  function binFrame(rgba, geom, out) {
    const K = geom.K;
    out = out || new Float64Array(3 * K);
    out.fill(0);
    const idx = geom.idx, bin = geom.bin;
    for (let n = 0; n < idx.length; n++) {
      const j = idx[n] << 2, k = bin[n];
      out[k] += rgba[j];
      out[K + k] += rgba[j + 1];
      out[2 * K + k] += rgba[j + 2];
    }
    const c = geom.counts;
    for (let k = 0; k < K; k++) {
      const inv = c[k] > 0 ? 1 / c[k] : 0;
      out[k] *= inv; out[K + k] *= inv; out[2 * K + k] *= inv;
    }
    return out;
  }

  // ------------------------------------------------------------ linear algebra
  function cholesky(M, n) { // in place, lower triangle; returns false if not PD
    for (let j = 0; j < n; j++) {
      let s = M[j * n + j];
      for (let k = 0; k < j; k++) s -= M[j * n + k] * M[j * n + k];
      if (!(s > 0)) return false;
      const d = Math.sqrt(s);
      M[j * n + j] = d;
      for (let i = j + 1; i < n; i++) {
        let t = M[i * n + j];
        for (let k = 0; k < j; k++) t -= M[i * n + k] * M[j * n + k];
        M[i * n + j] = t / d;
      }
    }
    return true;
  }
  function cholSolve(L, n, b, x) {
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k];
      x[i] = s / L[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
      x[i] = s / L[i * n + i];
    }
    return x;
  }

  // ------------------------------------------------------------- reconstructor
  /**
   * Solves, per colour channel,
   *   min_x,g  Σ_k w_k (Σ_{j≤k} x_j/K + g·b_k − d_k)²  +  λ‖Dx‖²  +  μ‖x‖²
   * d = observed − background, b = background profile (the gain nuisance:
   * an exposure change of (1+g) adds g·b to every bin).  x is the hidden scene
   * per unit hidden angle, in the same DN units.
   */
  class Reconstructor {
    constructor(counts, opt = {}) {
      const K = counts.length;
      this.K = K;
      this.gain = opt.gain !== false;
      const mean = counts.reduce((a, b) => a + b, 0) / K || 1;
      this.w = Float64Array.from(counts, (c) => c / mean);
      // smoothing in units of bins: λ chosen so the impulse response has a
      // width of roughly `smooth` bins (calibrated in tests/core.test.cjs).
      const smooth = opt.smooth != null ? opt.smooth : 2;
      this.lambda = Math.pow(smooth / K, 4) * K * 0.6;
      this.mu = 1e-7;
      const n = K;
      const base = new Float64Array(n * n);
      // (AᵀWA)_ij = Σ_{k ≥ max(i,j)} w_k / K²
      const suffixW = new Float64Array(K + 1);
      for (let k = K - 1; k >= 0; k--) suffixW[k] = suffixW[k + 1] + this.w[k];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) base[i * n + j] = suffixW[Math.max(i, j)] / (K * K);
      }
      for (let i = 0; i < n; i++) {           // λ DᵀD (first differences)
        const l = this.lambda;
        if (i > 0) { base[i * n + i] += l; base[i * n + i - 1] -= l; }
        if (i < n - 1) { base[i * n + i] += l; base[i * n + i + 1] -= l; }
        base[i * n + i] += this.mu;
      }
      this.base = base;
      this.Lbase = Float64Array.from(base);
      if (!cholesky(this.Lbase, n)) throw new Error('reconstructor: base not PD');
      this.M = new Float64Array((n + 1) * (n + 1));
      this.rhs = new Float64Array(n + 1);
      this.sol = new Float64Array(n + 1);
      this.Atwd = new Float64Array(n);
      this.Atwb = new Float64Array(n);
    }
    _atw(v, out) { // out_j = Σ_{k ≥ j} w_k v_k / K
      const K = this.K;
      let s = 0;
      for (let k = K - 1; k >= 0; k--) { s += this.w[k] * v[k]; out[k] = s / K; }
      return out;
    }
    /** delta, bg: Float64Array(3K). Returns {x: Float64Array(3K), g: [3]}. */
    solve(delta, bg, x) {
      const K = this.K;
      x = x || new Float64Array(3 * K);
      const gains = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const d = delta.subarray(c * K, c * K + K);
        const xo = x.subarray(c * K, c * K + K);
        this._atw(d, this.Atwd);
        if (!this.gain) {
          cholSolve(this.Lbase, K, this.Atwd, xo);
          continue;
        }
        const b = bg.subarray(c * K, c * K + K);
        // scale b to unit weighted RMS for conditioning
        let bb = 0;
        for (let k = 0; k < K; k++) bb += this.w[k] * b[k] * b[k];
        const bs = bb > 0 ? 1 / Math.sqrt(bb / K) : 0;
        const n1 = K + 1, M = this.M;
        for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) M[i * n1 + j] = this.base[i * K + j];
        this._atw(b, this.Atwb);
        let btwb = 0, btwd = 0;
        for (let k = 0; k < K; k++) { btwb += this.w[k] * b[k] * b[k]; btwd += this.w[k] * b[k] * d[k]; }
        for (let i = 0; i < K; i++) {
          M[i * n1 + K] = this.Atwb[i] * bs;
          M[K * n1 + i] = this.Atwb[i] * bs;
          this.rhs[i] = this.Atwd[i];
        }
        M[K * n1 + K] = btwb * bs * bs + 1e-9;
        this.rhs[K] = btwd * bs;
        if (!cholesky(M, n1)) { cholSolve(this.Lbase, K, this.Atwd, xo); continue; }
        cholSolve(M, n1, this.rhs, this.sol);
        for (let k = 0; k < K; k++) xo[k] = this.sol[k];
        gains[c] = this.sol[K] * bs;
      }
      return { x, g: gains };
    }
  }

  // ---------------------------------------------------------------- background
  class Background {
    constructor(n, opt = {}) {
      this.B = new Float64Array(n);
      this.n = 0;
      this.mode = opt.mode || 'slow';   // 'slow' | 'frozen' | 'capture'
      this.tauFrames = opt.tauFrames || 600;
      this.captureLeft = 0;
      this.acc = new Float64Array(n);
      this.accN = 0;
    }
    get ready() { return this.n >= 3; }
    capture(frames) { this.mode = 'capture'; this.captureLeft = frames; this.acc.fill(0); this.accN = 0; }
    update(y) {
      if (this.mode === 'capture') {
        for (let i = 0; i < y.length; i++) this.acc[i] += y[i];
        this.accN++;
        if (--this.captureLeft <= 0) {
          for (let i = 0; i < y.length; i++) this.B[i] = this.acc[i] / this.accN;
          this.mode = 'frozen';
          this.n = Math.max(this.n, 3);
        }
        return;
      }
      if (this.mode === 'frozen' && this.ready) return;
      const a = Math.max(1 / (this.n + 1), 1 / this.tauFrames);
      for (let i = 0; i < y.length; i++) this.B[i] += a * (y[i] - this.B[i]);
      this.n++;
    }
  }

  // ------------------------------------------------------------------ pipeline
  function median(a) {
    const s = Array.from(a).sort((p, q) => p - q);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  /** Where along the hidden axis is the light, 0..1, plus a confidence. */
  function locate(lum, skip = 2) {
    const K = lum.length;
    const part = lum.subarray ? lum.subarray(skip) : lum.slice(skip);
    const med = median(part);
    const dev = part.map((v) => Math.abs(v - med));
    const mad = median(dev) * 1.4826 + 1e-12;
    let mass = 0, mom = 0, peak = -Infinity, arg = skip;
    for (let k = skip; k < K; k++) {
      const v = lum[k] - med;
      if (v > peak) { peak = v; arg = k; }
      if (v > 0) { mass += v; mom += v * k; }
    }
    return {
      c: mass > 0 ? mom / mass / (K - 1) : NaN,
      peak: arg / (K - 1),
      snr: peak / mad,
    };
  }

  class Corner {
    constructor(geom, opt = {}) {
      this.geom = geom;
      this.K = geom.K;
      this.recon = new Reconstructor(geom.counts, opt);
      this.bg = new Background(3 * geom.K, opt);
      this.smoothFrames = opt.smoothFrames || 1;
      this.y = new Float64Array(3 * geom.K);
      this.raw = new Float64Array(3 * geom.K);
      this.delta = new Float64Array(3 * geom.K);
      this.x = new Float64Array(3 * geom.K);
      this.lum = new Float64Array(geom.K);
      this.frames = 0;
    }
    stepFrame(rgba) { return this.step(binFrame(rgba, this.geom, this.raw)); }
    step(yRaw) {
      const n = yRaw.length;
      const a = this.frames === 0 ? 1 : 1 / this.smoothFrames;
      for (let i = 0; i < n; i++) this.y[i] += a * (yRaw[i] - this.y[i]);
      this.frames++;
      if (!this.bg.ready || this.bg.mode === 'capture') { this.bg.update(this.y); return null; }
      for (let i = 0; i < n; i++) this.delta[i] = this.y[i] - this.bg.B[i];
      const { g } = this.recon.solve(this.delta, this.bg.B, this.x);
      this.bg.update(this.y);
      const K = this.K;
      for (let k = 0; k < K; k++) this.lum[k] = (this.x[k] + this.x[K + k] + this.x[2 * K + k]) / 3;
      const loc = locate(this.lum);
      return { x: this.x, lum: this.lum, delta: this.delta, gain: g, ...loc };
    }
  }

  // --------------------------------------------------------------------- score
  /**
   * samples: [{t (ms, wall clock), c (0..1 or NaN)}].
   * Correlates the recovered position with the actor's schedule over a lag
   * window, against the SAME search run on wrong-seed schedules.  The sign of
   * the mapping (which way the phone faces) is free, so |ρ| is compared.
   */
  function score(samples, opt = {}) {
    const seed = opt.seed != null ? opt.seed : SEED;
    const lagMax = opt.lagMaxMs != null ? opt.lagMaxMs : 4000;
    const lagStep = opt.lagStepMs || 100;
    const nNull = opt.nullSeeds || 40;
    const binMs = opt.binMs || 100;
    const acc = new Map();
    for (const s of samples) {
      if (!Number.isFinite(s.c)) continue;
      const b = Math.floor(s.t / binMs);
      const e = acc.get(b);
      if (e) { e.s += s.c; e.n++; } else acc.set(b, { s: s.c, n: 1 });
    }
    const T = [], C = [];
    for (const [b, e] of acc) { T.push((b + 0.5) * binMs); C.push(e.s / e.n); }
    const n = T.length;
    if (n < (opt.minN || 100)) return { n, ready: false };
    let mc = 0;
    for (const v of C) mc += v;
    mc /= n;
    let vc = 0;
    for (let i = 0; i < n; i++) { C[i] -= mc; vc += C[i] * C[i]; }
    if (vc <= 0) return { n, ready: false };
    const p = new Float64Array(n);
    function best(sd) {
      let bestAbs = -1, bestR = 0, bestL = 0;
      for (let L = -lagMax; L <= lagMax; L += lagStep) {
        let mp = 0;
        for (let i = 0; i < n; i++) { p[i] = truthPos(T[i] + L, sd); mp += p[i]; }
        mp /= n;
        let cov = 0, vp = 0;
        for (let i = 0; i < n; i++) { const q = p[i] - mp; cov += C[i] * q; vp += q * q; }
        const r = vp > 0 ? cov / Math.sqrt(vc * vp) : 0;
        if (Math.abs(r) > bestAbs) { bestAbs = Math.abs(r); bestR = r; bestL = L; }
      }
      return { abs: bestAbs, r: bestR, lag: bestL };
    }
    const tr = best(seed);
    const nulls = [];
    for (let j = 1; j <= nNull; j++) nulls.push(best(seed + 7919 * j + 13).abs);
    nulls.sort((a, b) => a - b);
    const null95 = nulls[Math.floor(0.95 * (nulls.length - 1))];
    const nullMax = nulls[nulls.length - 1];
    return {
      ready: true, n, rho: tr.r, rhoAbs: tr.abs, lagMs: tr.lag,
      null95, nullMax, sees: tr.abs > nullMax,
      seconds: (T[n - 1] - T[0]) / 1000,
    };
  }

  return {
    SLOT_MS, LEVELS, SEED, PALETTE,
    hash, truthPos, schedule,
    buildGeometry, binFrame, Reconstructor, Background, Corner, locate, score,
    cholesky, cholSolve, median,
  };
});
