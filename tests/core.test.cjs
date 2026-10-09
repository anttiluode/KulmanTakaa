// KulmanTakaa ledger: every claim in the README is one of these asserts.
// Run: node tests/core.test.cjs   (about a minute and a half)
'use strict';
const assert = require('assert');
const KT = require('../core.js');
const { Sim } = require('../sim.js');

const T0 = 1760000000000; // a fixed wall-clock origin, so runs are reproducible
const FPS = 30;
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function run(simOpt = {}, opt = {}) {
  const sim = new Sim(simOpt);
  const clicks = opt.clicks ? opt.clicks(sim) : sim.defaultClicks();
  const geom = KT.buildGeometry(clicks, sim.w, sim.h, { bins: opt.bins || 72 });
  const corner = new KT.Corner(geom, { smooth: 3, tauFrames: 20 * FPS, gain: opt.gain !== false });
  const secs = opt.seconds || 40;
  const samples = [], frames = [];
  const clockSkew = opt.clockSkewMs || 0; // actor clock minus camera clock
  for (let i = 0; i < secs * FPS; i++) {
    const t = T0 + i * 1000 / FPS;
    const f = sim.frame(t + clockSkew);
    const r = corner.stepFrame(f);
    if (r) {
      samples.push({ t, c: r.c });
      if (opt.keep) frames.push({ t, x: Float64Array.from(r.x), lum: Float64Array.from(r.lum), peak: r.peak });
    }
  }
  return { sim, geom, corner, samples, frames, score: KT.score(samples) };
}
const fmt = (s) => s.ready
  ? `|ρ| ${s.rhoAbs.toFixed(3)} at lag ${s.lagMs} ms, null max ${s.nullMax.toFixed(3)} (95% ${s.null95.toFixed(3)}), n ${s.n}`
  : 'not ready';

// ---------------------------------------------------------------- T1 schedule
{
  const counts = new Array(KT.LEVELS).fill(0);
  for (let n = 0; n < 5000; n++) counts[KT.hash(n, KT.SEED) % KT.LEVELS]++;
  const minc = Math.min(...counts), maxc = Math.max(...counts);
  const same = [0, 333, 1499, 1500, 98765].every((d) =>
    KT.schedule(T0 + d, 'slots').pos === KT.truthPos(T0 + d));
  ok('T1 schedule: actor and scorer agree; levels roughly uniform',
    same && minc > 850 && maxc < 1150, `level counts ${counts.join('/')}`);
}

// --------------------------------------------- T2 image angle is monotone in floor angle
{
  const sim = new Sim({});
  const geom = KT.buildGeometry(sim.defaultClicks(), sim.w, sim.h, { bins: 72 });
  const mean = new Float64Array(72), cnt = new Float64Array(72);
  for (let n = 0; n < geom.idx.length; n++) {
    const i = geom.idx[n], k = geom.bin[n];
    mean[k] += sim.tIdx[i]; cnt[k]++;
  }
  let inversions = 0;
  for (let k = 1; k < 72; k++) if (mean[k] / cnt[k] < mean[k - 1] / cnt[k - 1]) inversions++;
  ok('T2 binning by image angle orders the floor by true angle (homography keeps ray order)',
    inversions === 0 && geom.pixels > 3000, `${geom.pixels} wedge pixels, ${inversions} order inversions across 72 bins`);
}

// --------------------------------- T3 noiseless identity: the derivative IS the hidden scene
{
  const sim = new Sim({ noise: 0, ae: false, spill: 0, mode: 'still', contrast: 0.05 });
  const geom = KT.buildGeometry(sim.defaultClicks(), sim.w, sim.h, { bins: 72 });
  const off = KT.binFrame(new Sim({ noise: 0, ae: false, spill: 0, mode: 'off' }).frame(T0), geom);
  const on = KT.binFrame(sim.frame(T0), geom);
  const delta = on.map((v, i) => v - off[i]);
  const rec = new KT.Reconstructor(geom.counts, { smooth: 2, gain: false });
  const { x } = rec.solve(Float64Array.from(delta), Float64Array.from(off));
  const lum = Array.from({ length: 72 }, (_, k) => (x[k] + x[72 + k] + x[144 + k]) / 3);
  const peak = lum.indexOf(Math.max(...lum));
  // where should it be? the bin whose pixels have true floor angle = the bar's hidden angle
  const psi = sim.psiLo + (sim.psiHi - sim.psiLo) * 0.5;
  const mean = new Float64Array(72), cnt = new Float64Array(72);
  for (let n = 0; n < geom.idx.length; n++) { mean[geom.bin[n]] += sim.tIdx[geom.idx[n]]; cnt[geom.bin[n]]++; }
  let best = 0, bestErr = Infinity;
  for (let k = 0; k < 72; k++) {
    const th = mean[k] / cnt[k] / 512 * Math.PI / 2;
    if (Math.abs(th - psi) < bestErr) { bestErr = Math.abs(th - psi); best = k; }
  }
  ok('T3 noiseless: reconstruction peaks where floor angle equals the hidden bar angle',
    Math.abs(peak - best) <= 2, `peak bin ${peak}, geometric prediction ${best}`);
}

// ------------------------------------------------------- T4 main result
const main = run({}, { keep: true, seconds: 45 });
ok('T4 default bench (3% hidden light, 2 DN noise, auto-exposure, spill): it sees',
  main.score.sees && main.score.rhoAbs > 0.8 && Math.abs(main.score.lagMs) <= 200, fmt(main.score));

// ------------------------------------------------------- T5/T6 nulls
const still = run({ mode: 'still' });
ok('T5 null: actor holds still, scored against the moving schedule → does not see',
  still.score.ready ? !still.score.sees : true, fmt(still.score));
const off = run({ mode: 'off' });
ok('T6 null: actor off → does not see', off.score.ready ? !off.score.sees : true, fmt(off.score));

// ------------------------------------------------------- T7 misplaced wedges
const onWall = run({}, { clicks: (s) => ({ C: s.project([-0.05, 0, 0.12]), W: s.project([-0.25, 0, 0.12]), S: s.project([-0.05, 0, 0.27]) }) });
ok('T7a control: wedge drawn on the wall face (no hidden light reaches it) → does not see',
  onWall.score.ready ? !onWall.score.sees : true, fmt(onWall.score));
const openFloor = run({}, { clicks: (s) => ({ C: s.project([0.08, -0.03, 0]), W: s.project([0.3, -0.03, 0]), S: s.project([0.08, -0.12, 0]) }) });
ok('T7b control: wedge on open floor beyond the edge (sees all hidden angles at once) → does not see',
  openFloor.score.ready ? !openFloor.score.sees : true, fmt(openFloor.score));

// ------------------------------------------------------- T8 clock skew
const skew = run({}, { clockSkewMs: 700, seconds: 30 });
ok('T8 phone clock 700 ms ahead: found as the lag (lag = actor clock minus camera clock)', skew.score.sees && Math.abs(skew.score.lagMs - 700) <= 200,
  fmt(skew.score));

// ------------------------------------------------------- T9 exposure nuisance
{
  const harsh = { spill: 1.2, mode: 'color' };
  const withG = run(harsh, { seconds: 30 });
  const without = run(harsh, { seconds: 30, gain: false });
  ok('T9 auto-exposure + heavy spill, colour actor: gain nuisance on vs off (reported, both must see)',
    withG.score.sees && without.score.sees,
    `gain fit on ${withG.score.rhoAbs.toFixed(3)}, off ${without.score.rhoAbs.toFixed(3)}`);
}

// ------------------------------------------------------- T10 colour
{
  const col = run({ mode: 'color' }, { keep: true, seconds: 30 });
  const K = 72;
  let right = 0, total = 0;
  for (const fr of col.frames) {
    const ph = (fr.t % KT.SLOT_MS);
    if (ph < 400) continue; // skip transitions
    const s = KT.schedule(fr.t, 'color');
    const k = Math.round(fr.peak * (K - 1));
    const rgb = [fr.x[k], fr.x[K + k], fr.x[2 * K + k]];
    const want = s.color.indexOf(Math.max(...s.color));
    if (rgb.indexOf(Math.max(...rgb)) === want) right++;
    total++;
  }
  ok('T10 colour: the recovered hidden light has the actor\'s colour', right / total > 0.8,
    `${(100 * right / total).toFixed(1)}% of settled frames (chance 33%)`);
}

// ------------------------------------------------------- T11 how faint can it be?
{
  const rows = [];
  for (const c of [0.002, 0.004, 0.008, 0.016, 0.03]) {
    const r = run({ contrast: c }, { seconds: 30 });
    rows.push({ c, s: r.score });
  }
  const table = rows.map((r) => `${(100 * r.c).toFixed(1)}%: |ρ| ${r.s.rhoAbs.toFixed(2)} ${r.s.sees ? 'SEES' : 'no'}`).join(', ');
  const at1 = rows.find((r) => r.c === 0.008).s.sees && rows.find((r) => r.c === 0.016).s.sees;
  ok('T11 faintness sweep at 2 DN noise, 320×240 (hidden light as % of room light)', at1, table);
}

// ------------------------------------------------------- T12 click order matters
{
  const flip = run({}, { clicks: (s) => { const d = s.defaultClicks(); return { C: d.C, W: d.S, S: d.W }; }, seconds: 30 });
  ok('T12 clicks in the wrong order (wall and floor swapped) degrade it badly; the UI order is load-bearing',
    flip.score.ready ? flip.score.rhoAbs < main.score.rhoAbs - 0.2 : true, `${fmt(flip.score)} (vs ${main.score.rhoAbs.toFixed(3)} in the right order)`);
}

// ------------------------------------------------------- T13 speed
{
  const sim = new Sim({});
  const geom = KT.buildGeometry(sim.defaultClicks(), sim.w, sim.h, { bins: 72 });
  const corner = new KT.Corner(geom, { smooth: 3 });
  const f = sim.frame(T0);
  const t = process.hrtime.bigint();
  for (let i = 0; i < 300; i++) corner.stepFrame(f);
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 300;
  ok('T13 per-frame cost of binning + inversion (not counting the camera)', ms < 8, `${ms.toFixed(2)} ms/frame`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} pass`);
if (failed.length) process.exit(1);
