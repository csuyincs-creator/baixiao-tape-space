/* text-writer.js —— Z 键自动写字的离线几何层（方案 A：双钩描边）。
 * 系统字体渲染到离屏 canvas → 二值栅格 → marching squares 提取全部闭合轮廓
 * （字的外轮廓 + 字内孔洞，天然是互不相连的环）→ RDP 简化。
 * 输出像素坐标环，由 tape-engine 映射到世界坐标逐条铺带；环与环之间提笔断点。
 * 纯函数 + Canvas 2D，无外部依赖、无网络字体。 */

/** 文本 → 像素坐标闭合轮廓列表（按 左→右、外框先于孔洞 排序）。
 *  逐字按 measureText 真实字宽排版（拉丁字母不再占整格），字间空隙 = max(0, cell−fontPx)。 */
export function textToContours(text, opts = {}) {
  const {
    cell = 210, pad = 40, fontPx = 200, step = 2, threshold = 140, eps = 1.6, minPerim = 14,
    font = 'KaiTi, "Kaiti SC", "STKaiti", "Microsoft YaHei", SimSun, serif',
  } = opts;
  const chars = [...String(text)];
  if (!chars.some((c) => c.trim())) return { contours: [], pixelWidth: 0, pixelHeight: 0 };
  const canvas = document.createElement('canvas');
  canvas.width = 4096;
  canvas.height = cell + pad * 2;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = `${fontPx}px ${font}`;
  const gap = Math.max(0, cell - fontPx);
  const adv = chars.map((c) => (c === ' ' ? Math.max(ctx.measureText(c).width, fontPx * 0.4) : ctx.measureText(c).width) + gap);
  const xs = [];
  let pen = pad;
  for (const a of adv) { xs.push(pen); pen += a; }
  canvas.width = Math.ceil(pen + pad);
  ctx.font = `${fontPx}px ${font}`;   // 改宽 canvas 会重置上下文状态，字体需重设
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  chars.forEach((c, i) => ctx.fillText(c, xs[i], canvas.height / 2 + fontPx * 0.06));
  const charOf = (px) => { let i = 0; while (i < xs.length - 1 && px >= xs[i + 1]) i++; return i; };

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const gw = Math.floor(canvas.width / step);
  const gh = Math.floor(canvas.height / step);
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      g[y * gw + x] = data[((y * step) * canvas.width + x * step) * 4 + 3] > threshold ? 1 : 0;
    }
  }

  const contours = [];
  for (const loop of marchingSquares(g, gw, gh)) {
    const s = rdp(loop, eps);
    if (s.length < 4) continue;
    let per = 0;
    let cx = 0;
    for (let i = 0; i < s.length; i++) {
      const a = s[i], b = s[(i + 1) % s.length];
      per += Math.hypot(b.x - a.x, b.y - a.y);
      cx += a.x;
    }
    if (per < minPerim) continue;                       // 抗锯齿碎屑
    cx /= s.length;
    contours.push({
      pts: s.map((p) => ({ x: p.x * step, y: p.y * step })),   // 交回像素坐标（s 本身是网格单位）
      per, cx, char: charOf(cx * step),
    });
  }
  contours.sort((a, b) => a.char - b.char || b.per - a.per || a.cx - b.cx);
  return { contours, pixelWidth: canvas.width, pixelHeight: canvas.height };
}

/** marching squares：二值网格 → 闭合环列表（网格坐标，格边中点为顶点）。
 *  每个格边至多一个穿越点 → 节点度恒为 2 → 缝合必成环；鞍点(5/10)配对方式任选，不影响闭合。 */
export function marchingSquares(g, gw, gh) {
  const segs = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= gw || y >= gh) ? 0 : g[y * gw + x];
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (idx === 0 || idx === 15) continue;
      const T = { x: x + .5, y }, R = { x: x + 1, y: y + .5 }, B = { x: x + .5, y: y + 1 }, L = { x, y: y + .5 };
      switch (idx) {
        case 1: case 14: segs.push([L, B]); break;
        case 2: case 13: segs.push([B, R]); break;
        case 3: case 12: segs.push([L, R]); break;
        case 4: case 11: segs.push([T, R]); break;
        case 6: case 9: segs.push([T, B]); break;
        case 7: case 8: segs.push([T, L]); break;
        case 5: segs.push([T, R], [L, B]); break;
        case 10: segs.push([T, L], [B, R]); break;
      }
    }
  }
  const key = (p) => p.x + ',' + p.y;
  const adj = new Map();
  segs.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const loop = [segs[s0][0], segs[s0][1]];
    let cur = loop[1];
    for (;;) {
      const cand = (adj.get(key(cur)) || []).find((i) => !used[i]);
      if (cand === undefined) break;
      used[cand] = 1;
      const [a, b] = segs[cand];
      cur = key(a) === key(cur) ? b : a;
      loop.push(cur);
    }
    if (key(loop[0]) === key(loop[loop.length - 1])) loop.pop();
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/** Ramer–Douglas–Peucker 折线简化（环以首点为锚按开链处理，闭合由调用方补） */
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, im = -1;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      const d = len === 0
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (d > maxD) { maxD = d; im = i; }
    }
    if (maxD > eps && im > 0) {
      keep[im] = 1;
      stack.push([s, im], [im, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
