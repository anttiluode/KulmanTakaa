# KulmanTakaa — behind the corner

An ordinary camera looks at the floor beside a wall edge and recovers what moves on the other side. It runs in the browser with no install, no laser and no special hardware.

[Live!](https://anttiluode.github.io/kulmantakaa/index.html) · [phone actor!](https://anttiluode.github.io/kulmantakaa/actor.html)

## The physics in one line

A vertical edge is a one-dimensional pinhole. A floor point at angle θ from the wall face sees the hidden side only over hidden angles ψ ∈ [0, θ]. So the floor brightness, read around the corner, is a running integral of the hidden scene:

```
I(θ) = I_room(θ) + ∫₀^θ L_hidden(ψ) dψ        →        L_hidden(θ) = d/dθ [ I(θ) − I_room(θ) ]
```

Subtract the room. The derivative along θ is then a 1-D picture of what is around the corner, in colour.

```
          hidden corridor                 top view
               ψ=90°
                 ↑     ● the actor (phone)
                 |    /
   ██████████████|   /  ψ
   ██ the wall ██|  /
   ██████████████+ ───────→ ψ=0  (the wall line, continued)
        θ=0  ←── ·  ╲
   camera ◄······  ·   ╲  θ        floor wedge: each angle θ
   (back along      ·    ╲         sees hidden angles 0..θ
    the wall, low)   floor
```

The page bins the floor pixels by angle around the corner you click. Angle in the image is a monotone stand-in for angle on the floor, because a homography maps rays through a point to rays through its image and keeps their order. The page then inverts the integral with Tikhonov smoothing, weighted by pixels per bin. It can also fit an exposure-gain term alongside, so auto-exposure cannot pose as a hidden signal.

## How do you know it isn't fooling itself?

`actor.html` runs on a phone hidden behind the corner. It moves a bright bar to one of five places every 1.5 s, chosen by a hash of the wall clock. The camera page knows the same hash, so it checks its answer with no connection between the devices.

- **The score:** the correlation between where the recovered light is and where the bar was, over a ±4 s lag search (to absorb clock skew).
- **The null:** the same search, run on the same data against 40 *wrong* schedules (other hash seeds).
- **The verdict:** "Sees around the corner" only when the true schedule beats the best wrong one.

The null threshold is high when the signal is strong. Wrong schedules share the five-level step structure, and 60 s holds only ~40 slots, so the effective sample size is the number of slots, not the number of frames. Run long enough.

## The tabletop test (the falsifier)

You need a camera device (laptop or second phone), a phone for the actor, and an occluder taller than the camera: a cardboard box, a shelf side, or a door frame. Do it in a dim room.

1. **Place the occluder.** Stand the box on a table or floor. Its vertical edge is the corner.
2. **Place the camera.** Put it *back along the wall line*, low, on the visible side, looking at the floor right at the foot of the edge. It must not see past the edge: if the camera can see the phone, you are not looking around a corner. The page also renders a simulation of exactly this arrangement.
3. **Place the actor.** Put the phone in the hidden region, a hand's width past the edge, behind the wall's plane. Stand it upright, screen facing the edge, landscape, at full brightness. Open `actor.html` and choose **Off** for now.
4. **Mark the corner.** On the camera page choose **Camera**, then **Set corner** and click three points:
   1. the foot of the edge;
   2. a point along the wall's base on your side;
   3. the far end of the floor patch, roughly in front of the edge.

   The order matters: swapping 2 and 3 drops |ρ| from 0.93 to 0.58 in the bench.
5. **Freeze the camera.** Press **Lock exposure**. If the browser can't, the status line says so; keep the light steady.
6. **Learn the room.** With the actor still Off, press **Learn empty room**.
7. **Run the real test.** Switch the actor to **Slots** (or **Colour**) and wait 60 s. Watch the waterfall: streaks should step in time with the "actor says" column.
8. **Run the null test.** Switch the actor to **Still**, press **Restart score**, and wait 60 s. The verdict must stay "Not yet". Also cover the lens once.
9. **Record and send.** Press **Record bins**, let it run a minute, and press it again to save. `node tools/analyze.cjs run.json` re-judges it offline with a small settings sweep.

The *What changed* panel shows each frame minus the room, amplified. With a real pinhole (a small hole in a box, or a slit of a door) instead of an edge, the hidden scene appears there directly, upside down. No inversion is needed.

## Ledger — `node tests/core.test.cjs` (14/14)

The bench in `sim.js` renders a camera standing back along a wall, looking at the floor near the edge, 320×240. It includes textured albedo, an ambient gradient, vignetting, indirect spill of hidden light everywhere, auto-exposure reacting to it in quantised steps, 2 DN sensor noise and 8-bit output. The hidden bar lives in the corridor, which the camera never sees. The page runs the identical code path in its Simulation mode.

| test | result |
|---|---|
| T2 image angle orders the floor by true angle | 0 inversions over 72 bins |
| T3 noiseless: peak lands where floor angle = bar angle | bin 57 vs geometric 57 |
| **T4 default bench, 3% hidden light** | **\|ρ\| 0.928, lag 0, wrong-schedule best 0.627 → sees** |
| T5 null: actor still | 0.105 vs 0.145 → does not see |
| T6 null: actor off | 0.119 vs 0.146 → does not see |
| T7a wedge drawn on the wall face | 0.084 vs 0.191 → does not see |
| T7b wedge on open floor (sees all angles at once) | 0.113 vs 0.155 → does not see |
| T8 phone clock 700 ms ahead | found: lag +700 ms |
| T9 heavy spill + colour actor, exposure fit on/off | 0.910 / 0.902 (the fit barely matters in the bench) |
| T10 colour of the recovered light = actor's colour | 96% of settled frames (chance 33%) |
| T11 faintness, hidden light as % of room light | 0.2%: 0.35 · 0.4%: 0.66 · 0.8%: 0.84 · 1.6%: 0.89 · 3%: 0.91 — all see at 30 s |
| T12 clicks in wrong order | 0.583 vs 0.928 |
| T13 cost | ~0.9 ms per frame |

## What this is not

- **Not new physics.** The edge camera is Bouman et al., *Turning Corners into Cameras* (ICCV 2017). The 2-D version with an occluder is Saunders, Murray-Bruce & Goyal, *Computational periscopy with an ordinary digital camera* (Nature 2019); Antti's Varjoluotain builds on it. Accidental pinhole and pinspeck cameras are Torralba & Freeman (CVPR 2012). What this repo adds, as far as we know, is a zero-install live instrument plus a ground-truth actor that makes every run falsifiable.
- **Not proven on a real camera yet.** Every number above is from the bench. Real webcams add compression, denoising, auto-exposure that may not lock, and mains flicker (100 Hz in Finland). Daylight or a DC LED lamp is safer than an old fluorescent tube.
- **Not 2-D.** It recovers *angle* only, one dimension, like a radar sweep. Range needs a second edge or a known occluder.
- **Warped axis.** The angle axis is image angle, a monotone but nonlinear stand-in for floor angle. Streak order is right; spacing is not calibrated.
- **Static things fade with the slow background.** With "room memory" on, anything that stops moving fades into the room in ~τ seconds. "Learn empty room" keeps it visible.

## Files

- `index.html`: the instrument (simulation / camera / video file sources, wedge, waterfall, score, recording)
- `actor.html`: the hidden phone
- `core.js`: binning, inversion, background, schedule, score; no dependencies, works in browser and node
- `sim.js`: the bench
- `tests/core.test.cjs`: the ledger above
- `tools/analyze.cjs`: re-judge a recording offline

## Next, only if the tabletop test passes

- **Drop it into AnttisBrain2** as the room's boundary. The walls stop being your webcam and become the room you cannot see.
- **Calibrate by pinging instead of modelling geometry.** The actor's known positions measure the light-transport matrix column by column. That works for any occluder — pinhole, pinspeck or doorway — not just a straight edge.

Built with Claude (Opus 5.5), Friday 9 October 2026.
