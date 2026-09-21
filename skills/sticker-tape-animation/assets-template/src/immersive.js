/* immersive.js —— 沉浸模式（Attract Mode）状态机。
 * pick → draw → hold → rewind →（每 roundsPerDrift 轮）drift → pick ...
 * 全部复用引擎现成零件：stickerSource / setStickerTexture / offerScreenPoint /
 * rewinding / easeInOutCubic。零新几何。仅通过窄接口操作 engine。 */

import * as THREE from '../vendor/three.module.js';
import { easeInOutCubic } from './tape-engine.js';

const rand = Math.random;
const lerp = (a, b, t) => a + (b - a) * t;

/** 屏幕空间随机平滑路径：3~5 个彼此间距 ≥28% 短边的航点 → Catmull-Rom 采样。
 *  自距离约束：新采样点若距 15 个样本之前的点 <50px 则丢弃，防自撞成一团。 */
export function randomPath(W, H) {
  const n = 3 + Math.floor(rand() * 3);
  const minD = Math.min(W, H) * 0.28;
  const wp = [];
  for (let guard = 0; wp.length < n && guard < 300; guard++) {
    const p = { x: W * (0.08 + 0.84 * rand()), y: H * (0.10 + 0.74 * rand()) };
    if (wp.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > minD)) wp.push(p);
  }
  if (wp.length < 2) return [{ x: W * 0.15, y: H * 0.7 }, { x: W * 0.85, y: H * 0.3 }];
  const catmull = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    const f = (a, b, c, d) => 0.5 * ((2 * b) + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
    return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
  };
  const out = [];
  const seg = 26;
  for (let i = 0; i < wp.length - 1; i++) {
    const p0 = wp[Math.max(0, i - 1)], p1 = wp[i], p2 = wp[i + 1], p3 = wp[Math.min(wp.length - 1, i + 2)];
    for (let s = 0; s < seg; s++) {
      const c = catmull(p0, p1, p2, p3, s / seg);
      if (out.length && Math.hypot(c.x - out[out.length - 1].x, c.y - out[out.length - 1].y) < 6) continue;
      for (let k = 0; k < out.length - 15; k++) {
        if (Math.hypot(c.x - out[k].x, c.y - out[k].y) < 50) { c.reject = true; break; }
      }
      if (!c.reject) out.push(c);
    }
  }
  out.push(wp[wp.length - 1]);
  return out;
}

export class AttractMode {
  constructor(engine) {
    this.e = engine;
    this.cfg = engine.cfg.immersive || {};
    this.raf = 0;
    this.running = false;
    this.phase = 'idle';
    this.rounds = 0;
    this.nextDrift = this.pickDriftGap();
  }

  pickDriftGap() {
    const [a, b] = this.cfg.roundsPerDrift || [2, 4];
    return Math.round(lerp(a, b, rand()));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.enter('pick');
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.phase = 'idle';
    if (this.e.cameraAnimating) this.e.cameraAnimating = false;
  }

  enter(phase) {
    this.phase = phase;
    this.t0 = performance.now();
    if (phase === 'pick') this.doPick();
    if (phase === 'draw') this.doDrawStart();
    if (phase === 'rewind') this.doRewindStart();
    if (phase === 'drift') this.doDriftStart();
    this.schedule();
  }

  schedule() {
    if (!this.running || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.tick(); });
  }

  async doPick() {
    const e = this.e;
    const pool = Array.isArray(this.cfg.stickerPool) && this.cfg.stickerPool.length
      ? this.cfg.stickerPool : [...Array((e.cfg.stickers || []).length || 1).keys()];
    const idx = pool[Math.floor(rand() * pool.length)];
    let tex;
    try { tex = await e.stickerSource(idx); } catch { tex = e.tapeTex; }
    if (!this.running) return;
    e.resetDrawingState();
    e.setStickerTexture(tex, [1, lerp(4, 10, rand())]);
    e.isDrawing = false;
    this.enter('draw');
  }

  doDrawStart() {
    this.path = randomPath(this.e.width(), this.e.height());
    this.i = 0;
    this.acc = 0;
  }

  doRewindStart() {
    const e = this.e;
    e.rewinding = true;
    e.rewindProgress = 0;
    e.isDrawing = false;
  }

  doDriftStart() {
    const e = this.e;
    const d = this.cfg.drift || {};
    const [r0, r1] = d.radius || [12, 30];
    const r = lerp(r0, r1, rand());
    const phi = lerp(0.2, 0.46 * Math.PI - 0.08, rand());     // 极角受 orbit maxPolarAngle 约束
    const theta = rand() * Math.PI * 2;
    const to = new THREE.Vector3(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    );
    const dummy = new THREE.Object3D();
    dummy.position.copy(to);
    dummy.lookAt(0, 0, 0);
    this.drift = {
      fromPos: e.camera.position.clone(),
      fromRot: e.camera.rotation.clone(),
      toPos: to,
      toRot: dummy.rotation.clone(),
      ms: d.tweenMs ?? 1600,
    };
    e.cameraAnimating = true;
  }

  tick() {
    if (!this.running) return;
    const e = this.e;
    const now = performance.now();

    if (this.phase === 'draw') {
      const speed = this.cfg.drawSpeed ?? 1.6;
      this.acc += speed;
      while (this.acc >= 1 && this.i < this.path.length) {
        e.offerScreenPoint(this.path[this.i], { auto: true, rebuildEvery: 2, frame: this.i, lastFrame: this.i === this.path.length - 1 });
        this.i += 1;
        this.acc -= 1;
      }
      if (this.i >= this.path.length) {
        e.rebuild({ auto: true, saveOriginal: true });
        const hm = this.cfg.holdMs || { min: 800, max: 1500 };
        this.holdMs = lerp(hm.min, hm.max, rand());
        this.enter('hold');
      }
    } else if (this.phase === 'hold') {
      if (now - this.t0 >= this.holdMs) { this.rounds += 1; this.enter('rewind'); }
    } else if (this.phase === 'rewind') {
      if (!e.rewinding) this.enter(this.rounds >= this.nextDrift ? 'drift' : 'pick');
    } else if (this.phase === 'drift') {
      const k = Math.min((now - this.t0) / this.drift.ms, 1);
      const ease = easeInOutCubic(k);
      e.camera.position.lerpVectors(this.drift.fromPos, this.drift.toPos, ease);
      e.camera.rotation.x = lerp(this.drift.fromRot.x, this.drift.toRot.x, ease);
      e.camera.rotation.y = lerp(this.drift.fromRot.y, this.drift.toRot.y, ease);
      e.camera.rotation.z = lerp(this.drift.fromRot.z, this.drift.toRot.z, ease);
      if (k >= 1) {
        e.cameraAnimating = false;
        this.nextDrift = this.pickDriftGap();
        this.enter('pick');
      }
    }

    e.invalidate();
    this.schedule();
  }
}
