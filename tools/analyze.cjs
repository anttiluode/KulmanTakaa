#!/usr/bin/env node
// Re-analyse a recording saved by the page's "Record bins" button.
//   node tools/analyze.cjs kulmantakaa-....json [--smooth 3] [--avg 2] [--tau 20] [--nogain] [--lag 4000]
// Prints the score with the recorded settings, then a small sweep, so a real
// run can be judged (and re-judged) away from the camera.
'use strict';
const fs = require('fs');
const path = require('path');
const KT = require(path.join(__dirname, '..', 'core.js'));

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/analyze.cjs run.json [--smooth s] [--avg n] [--tau sec] [--nogain] [--lag ms]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const run = JSON.parse(fs.readFileSync(file, 'utf8'));
const fps = run.frames.length > 1 ? 1000 * (run.frames.length - 1) / (run.frames[run.frames.length - 1].t - run.frames[0].t) : 30;

function analyse(s) {
  const geom = { K: run.bins, counts: Float64Array.from(run.counts) };
  const corner = new KT.Corner(geom, { smooth: s.smooth, tauFrames: s.tau * fps, smoothFrames: s.avg, gain: s.gain });
  const samples = [];
  for (const f of run.frames) {
    const r = corner.step(Float64Array.from(f.y));
    if (r) samples.push({ t: f.t, c: r.c });
  }
  return KT.score(samples, { lagMaxMs: s.lag });
}
const base = {
  smooth: opt('smooth', run.settings.smooth), avg: opt('avg', run.settings.avg), tau: opt('tau', run.settings.tau),
  gain: args.includes('--nogain') ? false : run.settings.gainFit !== false, lag: opt('lag', run.source === 'file' ? 15000 : 4000),
};
const line = (s) => s.ready
  ? `${s.sees ? 'SEES   ' : 'not yet'}  |ρ| ${s.rhoAbs.toFixed(3)}  wrong-schedule best ${s.nullMax.toFixed(3)} (95% ${s.null95.toFixed(3)})  lag ${s.lagMs} ms  ${s.seconds.toFixed(0)} s`
  : `not enough data (${s.n} bins of 100 ms)`;

console.log(`${path.basename(file)}: ${run.frames.length} frames at ${fps.toFixed(1)} fps, ${run.bins} bins, source ${run.source}` +
  (run.settings.exposure ? `, exposure ${run.settings.exposure}` : ''));
console.log('recorded settings:', line(analyse(base)));
console.log('\nsweep (smooth × exposure fit):');
for (const smooth of [2, 3, 5]) {
  for (const gain of [true, false]) {
    console.log(`  smooth ${smooth} gain ${gain ? 'on ' : 'off'}  `, line(analyse({ ...base, smooth, gain })));
  }
}
console.log('\nNote: the sweep searches 6 settings, so a borderline pass in one cell is weaker than the same pass at the recorded settings.');
