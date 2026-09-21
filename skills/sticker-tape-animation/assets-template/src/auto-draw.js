/* auto-draw.js —— 列表模式的“自动铺带”：
 *   1) AutoDrawer = eM 内 o()：冷启动 30 步、20ms/步，屏幕坐标从屏外线性推进 → raycast → push
 *   2) FlickPath   = eR：滚动触发的“甩尾”新路径，随机穿出屏幕边缘，tension .8、每 3 帧重建
 * 两个类都只通过 engine 暴露的少量接口回写状态（见文件末尾的 ENGINE CONTRACT），便于单测。 */

/** 屏幕百分比坐标（-50..50 语义，源码 eJ 的换算）→ 像素 */
export function percentToPixel(p, width, height) {
  return { x: (p.x + 50) / 100 * width, y: (p.y + 50) / 100 * height };
}

/** 冷启动 30 步的屏幕路径：right 从 (-60,800)→(49,-49)，left 从 (100,1000)→(-40,-49) */
export function autoDrawScreens(side, steps = 30) {
  const [fromX, fromY] = side === 'right' ? [-60, 800] : [100, 1000];
  const toX = side === 'right' ? 49 : -40;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: fromX + (toX - fromX) * t, y: fromY + (-49 - fromY) * t });
  }
  return out;
}

/** 延长线与视口边的交点：t≥1 才有效（保证终点在屏幕边上，之后再外扩） */
export function edgeHit(start, cx, cy, width, height) {
  const mx = cx - start.x, my = cy - start.y;
  const hits = [];
  const push = (t, name) => {
    if (!Number.isFinite(t) || t < 0.999999) return;
    const x = start.x + mx * t, y = start.y + my * t;
    if (x >= -1e-6 && x <= width + 1e-6 && y >= -1e-6 && y <= height + 1e-6) {
      hits.push({ t, x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)), edge: name });
    }
  };
  if (Math.abs(mx) > 1e-6) { push((0 - start.x) / mx, 'left'); push((width - start.x) / mx, 'right'); }
  if (Math.abs(my) > 1e-6) { push((0 - start.y) / my, 'top'); push((height - start.y) / my, 'bottom'); }
  return hits;
}

/** 甩尾帧数：clamp(200,1400, pathLen/max(60,speed)*1000)，再乘 0.85~1.15 随机，/16 取帧 */
export function flickFrames(pathLen, speed, { durationMs = null, rand = Math.random } = {}) {
  const base = durationMs ?? Math.max(200, Math.min(1400, pathLen / Math.max(60, speed) * 1000));
  const ms = Math.floor(base * (durationMs ? 1 : 0.85 + 0.3 * rand()));
  return Math.max(10, Math.floor(ms / 16));
}

/** eR 的屏幕求解：随机中心采样 → 找穿出边 → 外扩 d → bottom/left 额外甩出量 */
export function computeFlick({
  start, orientation = 'horizontal', speed = 900, width, height,
  edgeSide = null, rand = Math.random, bottomExtra = true,
} = {}) {
  const halfW = width / 2, halfH = height / 2;
  const jitter = (exp) => rand() ** exp * (rand() > 0.5 ? 1 : -1);

  if (!start) {                                   // 无历史路径 → 从屏幕边缘随机起手
    if (edgeSide === 'left') start = { x: 0, y: rand() * height };
    else if (edgeSide === 'right') start = { x: width, y: rand() * height };
    else {
      const e = rand();
      start = e < 0.25 ? { x: 0, y: rand() * height }
        : e < 0.5 ? { x: width, y: rand() * height }
          : e < 0.75 ? { x: rand() * width, y: 0 }
            : { x: rand() * width, y: height };
    }
  }

  let hit = null, edge = null;
  for (let attempt = 0; attempt < 10 && !hit; attempt++) {
    const t = 0.5 + 0.5 * rand();
    const cx = halfW + jitter(1.8) * (width * t * 0.5);
    const cy = halfH + jitter(1.8) * (height * t * 0.5);
    const hits = edgeHit(start, cx, cy, width, height);
    const wanted = orientation === 'horizontal' ? ['left', 'right'] : ['top', 'bottom'];
    const filtered = hits.filter((h) => wanted.includes(h.edge)).sort((a, b) => a.t - b.t);
    const take = (arr) => {
      const pick = Math.min(arr.length - 1, Math.floor(rand() * Math.min(3, arr.length)));
      hit = { x: arr[pick].x, y: arr[pick].y }; edge = arr[pick].edge;
    };
    if (filtered.length) take(filtered);
    else if (attempt === 9 && hits.length) take(hits.slice().sort((a, b) => a.t - b.t));
  }
  if (!hit) hit = { x: halfW, y: halfH };

  const dx = hit.x - start.x, dy = hit.y - start.y;
  const dl = Math.hypot(dx, dy) || 1;
  const grow = Math.min(1600, Math.max(480, speed)) * (0.8 + 0.8 * rand());
  const end = { x: hit.x + dx / dl * grow, y: hit.y + dy / dl * grow };
  if (edge === 'bottom' && bottomExtra) {
    end.y += Math.max(height * (1.25 + 0.75 * rand()), grow * (1.8 + 0.6 * rand()), 1500);
  } else if (edge === 'left') {
    end.x -= Math.max(400, Math.floor(grow * (0.6 + 0.8 * rand())));
  }

  const pathLen = Math.hypot(end.x - start.x, end.y - start.y);
  return { start, end, edge, grow, pathLen, frames: flickFrames(pathLen, speed, { rand }) };
}

/** 冷启动自动绘制（30 步）。engine 需实现 CONTRACT 里的方法。 */
export class AutoDrawer {
  constructor(engine, config) {
    this.engine = engine;
    this.cfg = config.listView.autoDraw;
    this.token = 0;
    this.timer = null;
    this.active = false;
  }

  start(side) {
    this.stop();
    const token = ++this.token;
    const { steps = 30, stepMs = 20 } = this.cfg;
    const screens = autoDrawScreens(side, steps);
    this.active = true;
    this.engine.onAutoStart?.();
    let i = 0;
    const tick = () => {
      if (token !== this.token) return;
      if (i > steps) {
        this.active = false;
        this.engine.onAutoComplete?.();
        return;
      }
      const w = this.engine.width(), h = this.engine.height();
      const px = percentToPixel(screens[i], w, h);
      // 源码冷启动：push 的是 raycast 原值（不做 eO 抬升），重建走默认 eq 参数
      this.engine.offerScreenPoint(px, { auto: false, stack: false });
      this.engine.pokeRender();
      i += 1;
      this.timer = setTimeout(tick, stepMs);
    };
    tick();
  }

  stop() {
    this.token += 1;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.active = false;
  }
}

/** 甩尾路径（eR）。逐帧线性插值 raycast；每 3 帧重建几何；方向与上一段自动垂直。 */
export class FlickPath {
  constructor(engine, config) {
    this.engine = engine;
    this.cfg = config.listView;
    this.raf = 0;
    this.active = false;
  }

  currentOrientation() {
    const pts = this.engine.points;
    if (pts.length < 2) return 'horizontal';
    const a = pts[pts.length - 1], b = pts[pts.length - 2];
    return Math.abs(a.x - b.x) > Math.abs(a.z - b.z) ? 'horizontal' : 'vertical';
  }

  start({ durationMs = 500, speed = 900, edgeSide = null } = {}) {
    if (this.active) return false;
    const e = this.engine;
    const pts = e.points;
    const last = pts.length ? e.worldToScreen(pts[pts.length - 1]) : null;
    const prevOrientation = this.currentOrientation();
    const plan = computeFlick({
      start: last,
      orientation: prevOrientation === 'horizontal' ? 'vertical' : 'horizontal',   // 与上一段垂直
      speed, width: e.width(), height: e.height(), edgeSide,
    });
    const total = durationMs ? Math.max(10, Math.floor(durationMs / 16)) : plan.frames;
    this.active = true;
    this.i = 0;
    this.plan = plan;
    this.total = total;

    const step = () => {
      if (!this.active) return;
      if (this.i > total) {
        this.active = false;
        this.raf = 0;
        e.rebuild({ auto: true, saveOriginal: true });
        e.invalidate();
        return;
      }
      const k = this.i / total;
      const px = {
        x: plan.start.x + (plan.end.x - plan.start.x) * k,
        y: plan.start.y + (plan.end.y - plan.start.y) * k,
      };
      e.offerScreenPoint(px, { auto: true, rebuildEvery: 3, frame: this.i, lastFrame: this.i === total });
      this.i += 1;
      e.invalidate();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    return true;
  }

  stop() {
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

/* ENGINE CONTRACT（tape-engine.js 实现的窄接口）：
 *   points                      当前路径点（THREE.Vector3[]，只读）
 *   width() / height()          视口像素尺寸
 *   worldToScreen(v3)           3D → 屏幕像素
 *   offerScreenPoint(px, opt)   把一个屏幕坐标 raycast 到地面并 push（含堆叠抬升）
 *   rebuild({auto,saveOriginal})重建 ribbon
 *   invalidate() / pokeRender() demand 渲染调度
 */
