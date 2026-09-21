/* procgen.js —— canvas 2D 程序生成兜底素材（零外部文件、零版权素材）。
 * 全部返回 HTMLCanvasElement，由 tape-engine 包成 THREE.CanvasTexture。
 * 所有图案都按“可平铺”设计：跨边界的元素用 mod 重复绘制，避免出现接缝。 */

const TAU = Math.PI * 2;

/** 确定性伪随机（同 seed 每次生成同样的纹理，方便回归对比） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** 往整幅画布铺一层细颗粒噪点（用 ImageData，比逐像素 fillRect 快两个量级） */
function grain(ctx, size, amount, seed, alphaOnly = false) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const rnd = mulberry32(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    if (alphaOnly) {
      d[i + 3] = Math.max(0, Math.min(255, d[i + 3] + n * 255));
    } else {
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 灰色 duct tape：斜纹织物感 + 纵向胶条接缝 + 磨损色斑 */
export function makeDuctTapeCanvas(size = 1024) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(1337);

  ctx.fillStyle = '#9a9c9e';
  ctx.fillRect(0, 0, size, size);

  // 斜纹：两个方向的平行线交叉成织物感（间距小、密度高）
  const weave = 7;
  for (const [dir, alpha] of [[1, 0.10], [-1, 0.08]]) {
    ctx.lineWidth = 1.6;
    for (let k = -size; k < size * 2; k += weave) {
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.beginPath();
      if (dir > 0) { ctx.moveTo(k, 0); ctx.lineTo(k + size, size); }
      else { ctx.moveTo(k, size); ctx.lineTo(k + size, 0); }
      ctx.stroke();
    }
  }

  // 磨损云斑：低对比度大圆，用 4 份偏移保证跨边界无缝
  for (let i = 0; i < 90; i++) {
    const x = rnd() * size, y = rnd() * size, r = 40 + rnd() * 190;
    const dark = rnd() > 0.5;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      const col = dark ? '60,62,64' : '215,216,218';
      g.addColorStop(0, `rgba(${col},0.055)`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }

  // 胶条横向接缝：每 1/4 高度一条压痕 + 高光
  for (let s = 0; s < 4; s++) {
    const y = (s + 0.5) * size / 4;
    ctx.fillStyle = 'rgba(40,42,44,0.20)';
    ctx.fillRect(0, y - 1, size, 2.5);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, y + 2, size, 1.2);
  }

  grain(ctx, size, 26, 9001);
  return c;
}

/** 地面：白底 + 细网格 + 极淡纸纤维，供 repeat(28,28) 平铺 */
export function makeGroundCanvas(size = 512) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fdfdfc';
  ctx.fillRect(0, 0, size, size);

  const step = size / 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.055)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = Math.round(i * step) + 0.5;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  // 每 4 格一条稍重的线，形成“大格/小格”层级
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  for (let i = 0; i <= 2; i++) {
    const p = Math.round(i * step * 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  grain(ctx, size, 8, 4242);
  return c;
}

/** 贴纸 1：黄黑警示斜条（不透明带身） */
export function makeHazardCanvas(size = 512) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f5d800';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.fillStyle = '#141414';
  const w = size / 8;
  ctx.transform(1, 1, 0, 1, 0, 0);                 // 45° 斜切后再画竖条
  for (let k = -size; k < size * 3; k += w * 2) ctx.fillRect(k, -size, w, size * 4);
  ctx.restore();
  grain(ctx, size, 18, 77);
  return c;
}

/** 贴纸 2：手绘涂鸦圆点（透明底 —— 演示 alphaTest 语义） */
export function makeDoodleDotsCanvas(size = 512) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(2024);
  const palette = ['#ff4d2d', '#1f6feb', '#12a150', '#111111'];
  const cells = 6, step = size / cells;
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const cx = (gx + 0.5) * step + (rnd() - 0.5) * step * 0.35;
      const cy = (gy + 0.5) * step + (rnd() - 0.5) * step * 0.35;
      const r = step * (0.18 + rnd() * 0.16);
      ctx.strokeStyle = palette[(rnd() * palette.length) | 0];
      ctx.lineWidth = 4 + rnd() * 4;
      ctx.lineCap = 'round';
      // 手抖圆：半径带低频扰动的闭合折线
      ctx.beginPath();
      const wob = 0.10 + rnd() * 0.10, ph = rnd() * TAU;
      for (let a = 0; a <= 30; a++) {
        const t = (a / 30) * TAU;
        const rr = r * (1 + Math.sin(t * 3 + ph) * wob);
        const x = cx + Math.cos(t) * rr, y = cy + Math.sin(t) * rr;
        a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      if (rnd() > 0.55) {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
  return c;
}

/** 贴纸 3：红白条纹 + 边缘齿孔（透明底） */
export function makeStripeCanvas(size = 512) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const band = size / 6;
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(0,0,0,0)' : '#e4322a';
    ctx.fillRect(0, i * band, size, band);
  }
  ctx.fillStyle = '#f2f2ef';
  for (let i = 0; i < 12; i++) {
    const y = (i + 0.5) * size / 12;
    ctx.beginPath(); ctx.arc(size * 0.12, y, 12, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(size * 0.88, y, 12, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(20,20,20,0.75)';
  ctx.lineWidth = 5;
  ctx.strokeRect(2.5, size * 0.25, size - 5, size * 0.5);
  grain(ctx, size, 12, 555, true);
  return c;
}

/** 贴纸 4：烫金箔碎片（透明底，深色带） */
export function makeFoilCanvas(size = 512) {
  const c = newCanvas(size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(808);
  ctx.fillStyle = 'rgba(24,24,28,0.92)';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 240; i++) {
    const x = rnd() * size, y = rnd() * size;
    const w = 6 + rnd() * 46, h = 3 + rnd() * 14;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * TAU);
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, 'rgba(226,182,90,0.15)');
    g.addColorStop(0.5, 'rgba(255,232,170,0.95)');
    g.addColorStop(1, 'rgba(168,128,48,0.25)');
    ctx.fillStyle = g;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  return c;
}

/** 示例贴纸集合：config.stickers 为空时按顺序注册到列表面板 */
export const PROCEDURAL_STICKERS = [
  { id: 'hazard', label: 'Hazard tape', make: makeHazardCanvas, opaque: true },
  { id: 'doodle', label: 'Doodle dots', make: makeDoodleDotsCanvas, opaque: false },
  { id: 'stripe', label: 'Stripe field', make: makeStripeCanvas, opaque: false },
  { id: 'foil', label: 'Foil flakes', make: makeFoilCanvas, opaque: false },
];
