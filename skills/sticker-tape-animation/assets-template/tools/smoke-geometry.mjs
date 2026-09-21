/* tools/smoke-geometry.mjs —— 纯函数几何层冒烟测试（无 DOM、无 WebGL）
 * 运行：node demo/tools/smoke-geometry.mjs
 * 覆盖：两点 ribbon → 4 顶点 2 三角 / eX 转角平滑语义 / eO 堆叠抬升 /
 *       uv v=弧长/95 / 采样密度 / 阴影贴图尺寸 / eR 甩尾求解 / 冷启动插值 */

import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {
  V3, smoothCorners, closestPointOnSegment, stackLift, ribbonFromSamples,
  curveSegments, shadowMapSize, easeInOutCubic, computeFlick, flickFrames,
  autoDrawScreens, percentToPixel, rayToGround,
} from '../src/tape-engine.js';

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { fails.push([name, err]); console.log(`  FAIL ${name}\n       ${err.message}`); }
}

const CFG = { tapeWidth: 4, uvLength: 95, yEpsilon: 0.001, baselineY: 0.1 };
const line = (n, step = 1) => Array.from({ length: n }, (_, i) => ({ x: i * step, y: 0.1, z: 0 }));

console.log('\nsmoke-geometry: ribbon 纯函数层\n');

/* ── 1. 两点 → 4 顶点 / 2 三角 ───────────────────────── */
test('two samples produce 4 vertices and 2 triangles', () => {
  const g = ribbonFromSamples([{ x: 0, y: 0.1, z: 0 }, { x: 10, y: 0.1, z: 0 }], CFG);
  assert.equal(g.vertexCount, 4, `vertexCount=${g.vertexCount}`);
  assert.equal(g.triangleCount, 2, `triangleCount=${g.triangleCount}`);
  assert.equal(g.positions.length, 12);
  assert.equal(g.uvs.length, 8);
  assert.deepEqual(g.indices, [0, 1, 2, 1, 3, 2]);
});

test('ribbon width is tapeWidth across, centred on the path (band 4 => +-2)', () => {
  const g = ribbonFromSamples([{ x: 0, y: 0.1, z: 0 }, { x: 10, y: 0.1, z: 0 }], CFG);
  // dir=+x → 水平法向 (-dir.z,0,dir.x) = (0,0,1) → 两侧在 z=±2
  assert.ok(Math.abs(g.positions[2] - 2) < 1e-9, `left z=${g.positions[2]}`);
  assert.ok(Math.abs(g.positions[5] + 2) < 1e-9, `right z=${g.positions[5]}`);
  const wide = ribbonFromSamples([{ x: 0, y: 0.1, z: 0 }, { x: 10, y: 0.1, z: 0 }], { ...CFG, tapeWidth: 8 });
  assert.ok(Math.abs(wide.positions[2] - 4) < 1e-9, 'tapeWidth 8 => half 4');
});

test('vertex y is clamped by max(y + .001, baseline .1)', () => {
  const low = ribbonFromSamples([{ x: 0, y: -5, z: 0 }, { x: 10, y: 0.0005, z: 0 }], CFG);
  assert.equal(low.positions[1], 0.1, 'below baseline lifts to .1');
  assert.equal(low.positions[4], 0.1, '.0005 + .001 = .0015 仍低于基线 → 取 .1');
  const hi = ribbonFromSamples([{ x: 0, y: 0.4, z: 0 }, { x: 10, y: 0.4, z: 0 }], CFG);
  assert.equal(hi.positions[1], 0.401, 'stacked y keeps the +.001 offset');
});

test('uv v = accumulated arc length / 95, u in {0,1}', () => {
  const g = ribbonFromSamples(line(4, 10), CFG);   // 弧长 0,10,20,30
  const rowV = (a) => [0, 1, 2, 3].map((r) => a.uvs[r * 4 + 1]);   // 每行 4 个分量：0,v,1,v
  const vs = rowV(g);
  assert.ok(Math.abs(vs[0]) < 1e-12, `v0=${vs[0]}`);
  assert.ok(Math.abs(vs[1] - 10 / 95) < 1e-9, `v1=${vs[1]}`);
  assert.ok(Math.abs(vs[2] - 20 / 95) < 1e-9, `v2=${vs[2]}`);
  assert.ok(Math.abs(vs[3] - 30 / 95) < 1e-9, `v3=${vs[3]}`);
  const us = [...new Set(g.uvs.filter((_, i) => i % 4 === 0 || i % 4 === 2))].sort((a, b) => a - b);
  assert.deepEqual(us, [0, 1], 'u only ever 0 or 1');
  const long = rowV(ribbonFromSamples(line(4, 10), { ...CFG, uvLength: 20 }));
  assert.ok(Math.abs(long[3] - 1.5) < 1e-9, 'uvLength shrinks the repeat period');
});

test('n samples build (n-1) quads with a continuous strip index', () => {
  const g = ribbonFromSamples(line(6), CFG);
  assert.equal(g.vertexCount, 12);
  assert.equal(g.triangleCount, 10);
  assert.equal(Math.max(...g.indices), 11);
  assert.equal(new Set(g.indices).size, 12, 'every vertex referenced');
});

test('fewer than 2 samples yields no geometry (source returns null)', () => {
  assert.equal(ribbonFromSamples([{ x: 0, y: 0, z: 0 }], CFG), null);
  assert.equal(ribbonFromSamples([], CFG), null);
});

/* ── 2. eX 转角平滑 ─────────────────────────────────── */
test('eX: a 90-degree corner keeps its vertex (angle < PI/2 is required)', () => {
  const pts = [{ x: 0, y: 0.1, z: 0 }, { x: 10, y: 0.1, z: 0 }, { x: 10, y: 0.1, z: 10 }];
  const out = smoothCorners(pts);
  assert.deepEqual(out[1], pts[1], 'sharp corner untouched');
});

test('eX: a gentle bend is averaged onto the 3-point centroid, y preserved', () => {
  const pts = [{ x: 0, y: 0.1, z: 0 }, { x: 10, y: 0.35, z: 4 }, { x: 20, y: 0.1, z: 0 }];
  const out = smoothCorners(pts);
  const centroid = { x: 10, y: (0.1 + 0.35 + 0.1) / 3, z: 4 / 3 };
  assert.ok(V3.dist(out[1], { ...centroid, y: pts[1].y }) < 1e-9, 'moved to mean of x/z');
  assert.equal(out[1].y, pts[1].y, 'y kept (stacking survives smoothing)');
  assert.notDeepEqual(out[1], pts[1], 'the mid vertex actually moved');
});

test('eX: endpoints and short lists are copied unchanged', () => {
  const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }];
  const out = smoothCorners(pts);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[2], pts[2]);
  assert.equal(smoothCorners(pts.slice(0, 2)).length, 2);
  const by = V3.dist(out[1], pts[1]);
  assert.ok(by < 1e-9, 'collinear mid point stays put');
});

test('eX smoothing feeds CatmullRom -> ribbon without breaking the strip', () => {
  const raw = [
    { x: 0, y: 0.1, z: 0 }, { x: 6, y: 0.1, z: 2 }, { x: 12, y: 0.1, z: 0 },
    { x: 18, y: 0.104, z: 3 }, { x: 18, y: 0.104, z: 9 },
  ];
  const smoothed = smoothCorners(raw);
  assert.equal(smoothed.length, raw.length);
  const curve = new THREE.CatmullRomCurve3(smoothed.map((v) => new THREE.Vector3(v.x, v.y, v.z)));
  curve.curveType = 'centripetal';
  curve.tension = 0.5;
  const segs = curveSegments(smoothed.length, { auto: false, lowRes: false, curve: {} });
  assert.equal(segs, Math.max((5 - 1) * 14, 45));
  const samples = curve.getPoints(segs);
  const g = ribbonFromSamples(samples.map((v) => ({ x: v.x, y: v.y, z: v.z })), CFG);
  assert.equal(g.vertexCount, samples.length * 2);
  assert.equal(g.triangleCount, (samples.length - 1) * 2);
  assert.ok(g.positions.every(Number.isFinite) && g.uvs.every(Number.isFinite));
});

/* ── 3. eO 堆叠抬升 ─────────────────────────────────── */
test('eO: below 4 points the path sits on the .1 baseline', () => {
  const pts = line(3);
  assert.equal(stackLift(pts, { x: 5, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { baseline: 0.1 }), 0.1);
});

test('eO: crossing over an existing segment stacks +.004 above it', () => {
  const base = line(6, 4);                       // x=0..20 一条已画段，y=.1
  const lifted = stackLift(base, { x: 10, y: 0.1, z: 0.2 }, { x: 10, y: 0.1, z: -3 },
    { baseline: 0.1, layerStep: 0.004 });
  assert.ok(Math.abs(lifted - 0.104) < 1e-9, `lifted=${lifted}`);
  assert.ok(lifted > 0.1, 'above baseline');
});

test('eO: stacking compounds per layer already on the ground', () => {
  const pts = [{ x: 0, y: 0.1, z: 0 }, { x: 4, y: 0.1, z: 0 }, { x: 8, y: 0.104, z: 0 }, { x: 12, y: 0.108, z: 0 }, { x: 16, y: 0.1, z: 0 }];
  const y = stackLift(pts, { x: 8.2, y: 0.1, z: 0.3 }, { x: 8.2, y: 0.1, z: -2 }, { baseline: 0.1, layerStep: 0.004 });
  assert.ok(Math.abs(y - (0.108 + 0.004)) < 1e-9, `y=${y}`);
});

test('eO: far away from the existing path stays on the baseline', () => {
  const pts = line(6, 4);
  const y = stackLift(pts, { x: 10, y: 0, z: 60 }, { x: 10, y: 0, z: 55 }, { baseline: 0.1 });
  assert.equal(y, 0.1);
});

test('eO: the 24-unit pruning window skips distant segments', () => {
  // 新段横跨 0→100，途中经过一条又高又旧的段；只有窗口足够大时才该看到它
  const pts = [{ x: 48, y: 5, z: 0 }, { x: 52, y: 5, z: 0 }, { x: 56, y: 0.1, z: 0 }, { x: 60, y: 0.1, z: 0 }];
  const newP = { x: 100, y: 0.1, z: 0.1 }, lastP = { x: 0, y: 0.1, z: 0.1 };
  const pruned = stackLift(pts, newP, lastP, { baseline: 0.1 });
  assert.equal(pruned, 0.1, '旧段两端到 newP 距离和 > 24 → 直接跳过');
  const unpruned = stackLift(pts, newP, lastP, { baseline: 0.1, pruneDistance: Infinity });
  assert.ok(Math.abs(unpruned - 5.004) < 1e-9, `窗口放开后叠到 5.004，实得 ${unpruned}`);
});

test('closestPointOnSegment clamps like THREE.Line3(...).closestPointToPoint(p, true, ...)', () => {
  const a = { x: 0, y: 0, z: 0 }, b = { x: 10, y: 0, z: 0 };
  assert.deepEqual(closestPointOnSegment({ x: -5, y: 3, z: 0 }, a, b), { x: 0, y: 0, z: 0 });
  assert.deepEqual(closestPointOnSegment({ x: 99, y: 3, z: 0 }, a, b), { x: 10, y: 0, z: 0 });
  assert.deepEqual(closestPointOnSegment({ x: 4, y: 3, z: 1 }, a, b), { x: 4, y: 0, z: 0 });
  // 与 three 的实现逐项对齐
  const t = new THREE.Line3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0))
    .closestPointToPoint(new THREE.Vector3(4, 3, 1), true, new THREE.Vector3());
  assert.ok(Math.abs(t.x - 4) < 1e-9 && Math.abs(t.y) < 1e-9 && Math.abs(t.z) < 1e-9);
});

/* ── 3.5 屏幕 → 世界求交（解析式 vs THREE.Raycaster） ─ */
const CAM = { position: [-16.07, 27.44, 13.69], eulerDeg: [-62.18, -27.66, -41.34], fov: 60 };
function makeCamera() {
  const cam = new THREE.PerspectiveCamera(CAM.fov, 1280 / 800, 0.1, 1000);
  cam.position.set(...CAM.position);
  cam.setRotationFromEuler(new THREE.Euler(...CAM.eulerDeg.map((d) => Math.PI / 180 * d)));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

test('default camera looks down at the ground (euler signs as authored in config)', () => {
  const d = makeCamera().getWorldDirection(new THREE.Vector3());
  assert.ok(d.y < -0.5, `dir.y=${d.y.toFixed(3)} must point down`);
  const toOrigin = new THREE.Vector3(0, 0, 0).sub(new THREE.Vector3(...CAM.position)).normalize();
  assert.ok(d.dot(toOrigin) > 0.999, 'frames the origin area like the reference capture');
});

test('rayToGround matches THREE.Raycaster ∩ Plane y=0 for the whole viewport', () => {
  const cam = makeCamera();
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pts = [[640, 400], [120, 120], [1150, 700], [640, 120], [640, 760]];
  for (const [sx, sy] of pts) {
    const ndc = new THREE.Vector2(sx / 1280 * 2 - 1, 1 - sy / 800);
    ray.setFromCamera(ndc, cam);
    const ref = ray.ray.intersectPlane(plane, new THREE.Vector3());
    const mine = rayToGround(cam, ndc, 400, 0);
    assert.ok(ref && mine, `both miss at ${sx},${sy}`);
    assert.ok(mine.distanceTo(ref) < 1e-6, `${sx},${sy}: ${mine.toArray()} vs ${ref.toArray()}`);
  }
});

test('screen sampling actually spreads over the ground (no collapse to one point)', () => {
  const cam = makeCamera();
  const w = (sx, sy) => rayToGround(cam, new THREE.Vector2(sx / 1280 * 2 - 1, 1 - sy / 800), 400, 0);
  const a = w(200, 200), b = w(1000, 600);
  assert.ok(a && b);
  assert.ok(a.distanceTo(b) > 8, `500px+ sweep must move several world units, got ${a.distanceTo(b).toFixed(2)}`);
  assert.ok(Math.abs(a.y) < 1e-9, 'hit sits exactly on the ground plane');
  const tinyPlane = w(640, 400);
  assert.equal(rayToGround(cam, new THREE.Vector2(0, 0), 1, 0), null, 'outside the finite plane → null');
  assert.ok(tinyPlane, 'centre of the screen hits inside the 400-unit plane');
  const flat = makeCamera();
  flat.setRotationFromEuler(new THREE.Euler(0, 0, 0));
  flat.updateMatrixWorld(true);
  assert.equal(rayToGround(flat, new THREE.Vector2(0, 0.9), 400, 0), null, 'looking up → no ground hit');
});

/* ── 4. 采样密度 / 阴影尺寸 / 补间 ─────────────────── */
test('curve segment density: manual vs auto vs lowRes (spec 2.3)', () => {
  assert.equal(curveSegments(2, {}), 45);
  assert.equal(curveSegments(10, {}), 9 * 14);
  assert.equal(curveSegments(2, { lowRes: true }), 25);
  assert.equal(curveSegments(2, { auto: true }), 16);
  assert.equal(curveSegments(10, { auto: true }), Math.max(9 * 6, 16));
  assert.equal(curveSegments(2, { auto: true, lowRes: true }), 8);
  assert.equal(curveSegments(10, { auto: true, lowRes: true }), 9 * 3);
});

test('shadow map size follows the source formula pow2(400*k) clamp 1024..8192', () => {
  assert.equal(shadowMapSize(false, false), 4096);   // 3200 -> 4096
  assert.equal(shadowMapSize(true, false), 2048);    // 2400 -> 2048
  assert.equal(shadowMapSize(true, true), 2048);     // 1600 -> 2048
  assert.equal(shadowMapSize(false, true), 2048);
});

test('easeInOutCubic matches the source tween curve', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.ok(easeInOutCubic(0.25) < 0.25, 'slow at the start');
});

/* ── 5. 列表模式：冷启动插值 + eR 甩尾 ──────────────── */
test('cold-start path: 31 steps from off-screen to (49,-49) on the right', () => {
  const s = autoDrawScreens('right', 30);
  assert.equal(s.length, 31);
  assert.deepEqual(s[0], { x: -60, y: 800 });
  assert.deepEqual(s[30], { x: 49, y: -49 });
  assert.deepEqual(autoDrawScreens('left', 30)[0], { x: 100, y: 1000 });
  assert.deepEqual(autoDrawScreens('left', 30)[30], { x: -40, y: -49 });
  const px = percentToPixel({ x: -50, y: -50 }, 1000, 500);
  assert.deepEqual(px, { x: 0, y: 0 });
  assert.deepEqual(percentToPixel({ x: 50, y: 50 }, 1000, 500), { x: 1000, y: 500 });
});

test('eR flick: exits through the requested edge band and overshoots off-screen', () => {
  let seed = 1;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 200; i++) {
    const f = computeFlick({
      start: { x: 500, y: 300 }, orientation: 'horizontal', speed: 900,
      width: 1000, height: 800, rand,
    });
    assert.ok(['left', 'right'].includes(f.edge), `edge=${f.edge}`);
    assert.ok(f.end.x <= 0 || f.end.x >= 1000 || f.grow > 0, 'ends beyond the viewport');
    assert.ok(Number.isFinite(f.frames) && f.frames >= 10, `frames=${f.frames}`);
  }
  const vert = computeFlick({ start: { x: 500, y: 300 }, orientation: 'vertical', speed: 900, width: 1000, height: 800, rand });
  assert.ok(['top', 'bottom'].includes(vert.edge));
  if (vert.edge === 'bottom') assert.ok(vert.end.y > 800 + 800, 'bottom gets the extra 1500+ throw');
});

test('eR flick: with no history it starts on a screen edge per click side', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const r = computeFlick({ start: null, edgeSide: 'right', width: 800, height: 600, rand });
  assert.equal(r.start.x, 800);
  const l = computeFlick({ start: null, edgeSide: 'left', width: 800, height: 600, rand });
  assert.equal(l.start.x, 0);
});

test('flick duration: max(10, floor(clamp(200,1400,len/max(60,speed)*1000) * rand / 16))', () => {
  const mid = () => 0.5;                              // 0.85 + 0.3*0.5 = 1.0，随机因子中性
  assert.equal(flickFrames(48, 60, { rand: mid }), 50, '800ms → 50 帧');
  assert.equal(flickFrames(6, 60, { rand: mid }), 12, '100ms 被抬到下限 200ms');
  assert.equal(flickFrames(3000, 60, { rand: mid }), Math.floor(1400 / 16), '50s 被压到上限 1400ms');
  assert.equal(flickFrames(48, 240, { rand: mid }), Math.floor(200 / 16), 'speed 分母 clamp 到 60');
  assert.equal(flickFrames(48, 60, { rand: mid, durationMs: 800 }), 50, '显式 durationMs 优先且不吃随机');
  assert.equal(flickFrames(48, 60, { durationMs: 100 }), 10, '帧数下限 10');
});

console.log(`\n${passed} passed, ${fails.length} failed\n`);
if (fails.length) {
  for (const [n, e] of fails) console.error(`${n}:\n${e.stack}`);
  process.exitCode = 1;
}
