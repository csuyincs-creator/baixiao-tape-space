/* tape-engine.js —— 贴胶带画图核心引擎（vanilla three.js，无框架）。
 *
 * 结构：
 *   A. 纯函数几何层（不依赖 DOM，可直接在 Node 里跑冒烟测试）
 *      smoothCorners = eX / stackLift = eO / ribbonFromSamples = eq 与 eY 的公共主体
 *   B. THREE 层：场景、材质、阴影收紧、绘制状态机、倒带、列表模式、性能分级
 *      列表模式的自动铺带 / 甩尾在 src/auto-draw.js（本文件按 ENGINE CONTRACT 调用它）
 *
 * 与 spec 的对应处以行内 §n 标注。 */

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { GlitchPass } from './glitch.js';
import { createRoll, createProceduralRollModel, buildRollHierarchy } from './roll.js';
import { AutoDrawer, FlickPath } from './auto-draw.js';
import { AttractMode } from './immersive.js';
import { textToContours } from './text-writer.js';
import { initSettingsUI } from './settings-ui.js';
import { makeDuctTapeCanvas, makeGroundCanvas, PROCEDURAL_STICKERS } from './procgen.js';

export { autoDrawScreens, percentToPixel, computeFlick, flickFrames, edgeHit } from './auto-draw.js';

/* ════════════════════════════ A. 纯函数几何层 ════════════════════════════ */

export const V3 = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  clone: (a) => ({ x: a.x, y: a.y, z: a.z }),
  norm: (a) => { const l = Math.hypot(a.x, a.y, a.z); return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 }; },
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }),
};

/** eX —— 转角平滑：相邻三点夹角 < angleLimit（源码 π/2）时用三点均值替换中点，但保留原 y。
 *  语义提醒：夹角取 d(in) 与 d(out) 的夹角 —— 直线 0°（会被平滑），直角 90° 不满足 `<`，顶点保留。 */
export function smoothCorners(pts, angleLimit = Math.PI / 2) {
  if (pts.length < 3) return pts.map(V3.clone);
  const out = [V3.clone(pts[0])];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
    const dIn = V3.norm(V3.sub(cur, prev));
    const dOut = V3.norm(V3.sub(next, cur));
    const cos = Math.max(-1, Math.min(1, V3.dot(dIn, dOut)));
    if (Math.acos(cos) < angleLimit) {
      const avg = V3.scale(V3.add(V3.add(prev, cur), next), 1 / 3);
      avg.y = cur.y;                                   // 堆叠抬升出来的 y 不被平均掉
      out.push(avg);
    } else {
      out.push(V3.clone(cur));
    }
  }
  out.push(V3.clone(pts[pts.length - 1]));
  return out;
}

/** 线段 ab 上距 p 最近的点（clamp 到段内）—— THREE.Line3.closestPointToPoint(p, true, target) 等价 */
export function closestPointOnSegment(p, a, b) {
  const ab = V3.sub(b, a);
  const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  if (len2 === 0) return V3.clone(a);
  const t = Math.max(0, Math.min(1, V3.dot(V3.sub(p, a), ab) / len2));
  return V3.add(a, V3.scale(ab, t));
}

/** eO —— 堆叠抬升：新段压到旧段上方时，在旧段最高点之上再叠一层 */
export function stackLift(points, newP, lastP, cfg = {}) {
  const {
    pruneDistance = 24, detectRadius = 6, layerStep = 0.004, baseline = 0.1, minPoints = 4,
  } = cfg;
  if (points.length < minPoints) return baseline;      // 点数 <4 → 直接基线
  let y = baseline;
  for (let i = 0; i < points.length - 2; i++) {
    const a = points[i], b = points[i + 1];
    if (V3.dist(newP, a) + V3.dist(newP, b) > pruneDistance) continue;   // 剪枝 24
    const center = V3.scale(V3.add(a, b), 0.5);
    const proj = closestPointOnSegment(center, lastP, newP);
    if (V3.dist(proj, center) < detectRadius) y = Math.max(y, Math.max(a.y, b.y) + layerStep);
  }
  return y;
}

/** eq / eY 的公共主体：由曲线采样点列生成 ribbon 的 position/uv/index 扁平数组。
 *  eq 传 CatmullRomCurve3.getPoints 的结果；eY 传存下来的 resampled 前缀（不再平滑）。 */
export function ribbonFromSamples(samples, cfg = {}) {
  const { tapeWidth = 4, uvLength = 95, yEpsilon = 0.001, baselineY = 0.1 } = cfg;
  if (!samples || samples.length < 2) return null;
  const half = tapeWidth / 2;                            // 源码半宽 ±2（带宽 4 世界单位）
  const positions = [], uvs = [], indices = [];
  let arc = 0;

  // 首点：两个顶点 + uv (0,0),(1,0)
  const m0 = V3.norm(V3.sub(samples[1], samples[0]));
  const h0 = { x: -m0.z, y: 0, z: m0.x };                // 水平法向 (-dir.z, 0, dir.x)
  const left0 = V3.add(samples[0], V3.scale(h0, half));
  const right0 = V3.add(samples[0], V3.scale(h0, -half));
  positions.push(
    left0.x, Math.max(left0.y + yEpsilon, baselineY), left0.z,
    right0.x, Math.max(right0.y + yEpsilon, baselineY), right0.z,
  );
  uvs.push(0, 0, 1, 0);

  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i], prev = samples[i - 1];
    const dir = V3.norm(V3.sub(cur, prev));
    const h = { x: -dir.z, y: 0, z: dir.x };
    const left = V3.add(cur, V3.scale(h, half));
    const right = V3.add(cur, V3.scale(h, -half));
    positions.push(
      left.x, Math.max(left.y + yEpsilon, baselineY), left.z,
      right.x, Math.max(right.y + yEpsilon, baselineY), right.z,
    );
    arc += V3.dist(cur, prev);
    const v = arc / uvLength;                            // v = 累计弧长 / uvLength
    uvs.push(0, v, 1, v);
    const p = (i - 1) * 2;
    indices.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);  // 四边形条带
  }
  return { positions, uvs, indices, vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
}

/** CatmullRom 采样段数（spec §2 第 3 条，含低端机与自动绘制密度分支） */
export function curveSegments(nPoints, { auto = false, lowRes = false, curve = {} } = {}) {
  if (auto) {
    return Math.max((nPoints - 1) * (lowRes ? (curve.lowResAutoDensity ?? 3) : (curve.autoDensity ?? 6)),
      lowRes ? (curve.lowResAutoMin ?? 8) : (curve.autoMin ?? 16));
  }
  return Math.max((nPoints - 1) * (lowRes ? (curve.lowResManualDensity ?? 8) : (curve.manualDensity ?? 14)),
    lowRes ? (curve.lowResManualMin ?? 25) : (curve.manualMin ?? 45));
}

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** 阴影贴图边长（spec §7）：400 * (veryLow?4:low?6:8) → 最近 2 次幂 → clamp 1024..8192 */
export function shadowMapSize(low, veryLow) {
  const base = 400 * (veryLow ? 4 : low ? 6 : 8);
  return Math.min(8192, Math.max(1024, Math.pow(2, Math.round(Math.log2(Math.max(1, base))))));
}

/* ════════════════════════════ B. THREE 层 ════════════════════════════ */

const GROUND_Y = 0;

/** 解析 ray-plane 求交替代原站的 three-mesh-bvh：
 *  求交目标本就是 400×400 的单一平面 mesh，解析解与 BVH/Plane 求交数值等价且少一层开销；
 *  同样遵守有限尺寸（落在 ±size/2 之外返回 null），因此屏外采样点会像原版一样被丢弃。 */
export function rayToGround(camera, ndc, size = 400, planeY = GROUND_Y) {
  const origin = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  // 等价于 THREE.Vector3.unproject(camera)：NDC --projInv--> 相机空间 --matrixWorld--> 世界
  const far = new THREE.Vector3(ndc.x, ndc.y, 0.5)
    .applyMatrix4(camera.projectionMatrixInverse)
    .applyMatrix4(camera.matrixWorld);
  const dir = far.sub(origin);
  if (dir.lengthSq() === 0) return null;
  dir.normalize();
  if (Math.abs(dir.y) < 1e-8) return null;
  const t = (planeY - origin.y) / dir.y;
  if (t <= 0) return null;
  const p = origin.clone().addScaledVector(dir, t);
  const half = size / 2;
  if (Math.abs(p.x) > half || Math.abs(p.z) > half) return null;
  return p;
}

/** T() —— 贴图统一设置（spec §2 第 11 条） */
export function setupTexture(tex, lowRes, repeat = [1, 1]) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = lowRes ? 4 : 16;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.needsUpdate = true;
  return tex;
}

/** C + L() —— 胶带材质（MeshPhysicalMaterial，spec §2 第 10 条）。
 *  alphaTest 见 config.tapeAlphaTest 注释：原版 1 只适配纯不透明位图，透明底贴纸要 0.5。 */
export function makeTapeMaterial(tex, config) {
  const m = config.tapeMaterial || {};
  return new THREE.MeshPhysicalMaterial({
    side: m.side === 'single' ? THREE.FrontSide : THREE.DoubleSide,
    transparent: m.transparent !== false,
    alphaTest: config.tapeAlphaTest ?? 0.5,
    roughness: m.roughness ?? 0.1,
    metalness: m.metalness ?? 0.1,
    envMapIntensity: m.envMapIntensity ?? 1,
    dithering: m.dithering !== false,
    color: new THREE.Color(m.color || '#ffffff'),
    map: tex || null,
  });
}

/** 设备分级（spec §7，原文判定逻辑照搬） */
export function detectTier(config = {}) {
  const forced = config?.perf?.forceTier;
  let isMobile = false, memoryLow = false, coresLow = false, integrated = false;
  let debugLow = false, veryLowDebug = false;
  try {
    isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    memoryLow = !!navigator.deviceMemory && navigator.deviceMemory < 4;
    coresLow = !!navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4;
    integrated = /(Intel|AMD|Mali|PowerVR|Adreno)/i.test(navigator.userAgent) && !/(RTX|GTX|Radeon RX)/i.test(navigator.userAgent);
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
        debugLow = /(Mali-4|Mali-T|PowerVR|Adreno 3|Adreno 4|Intel HD|Intel UHD)/i.test(name);
        veryLowDebug = /(Mali-4|Mali-T6|Mali-T7|PowerVR G6|Adreno 3|Adreno 4|Intel HD 4000|Intel HD 3000|Intel UHD 600)/i.test(name);
      }
    }
  } catch { /* 探测不到就当高端机 */ }
  const memoryVeryLow = !!navigator.deviceMemory && navigator.deviceMemory < 2;
  const coresVeryLow = !!navigator.hardwareConcurrency && navigator.hardwareConcurrency < 2;
  let low = isMobile || memoryLow || coresLow || integrated || debugLow;
  let veryLow = memoryVeryLow || coresVeryLow || veryLowDebug;
  if (veryLow) low = true;
  if (forced === 'verylow') { veryLow = true; low = true; }
  else if (forced === 'low') low = true;
  else if (forced === 'high') { low = false; veryLow = false; }
  return { low, veryLow };
}

/** 列表模式 hover 换贴纸时 v 方向重复数（spec §6 第 5 条：left 9 / right 7.8 / 冷启动 9.7） */
export function listRepeatY(config, side) {
  const r = config.listView?.textureRepeat || {};
  return side === 'left' ? (r.vLeft ?? 9) : (r.vRight ?? 7.8);
}

export const isMobileUA = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

const toPlain = (v) => ({ x: v.x, y: v.y, z: v.z });

/* ───────────────────────────── 引擎 ───────────────────────────── */

export class TapeEngine {
  constructor(config, dom = {}) {
    this.cfg = config;
    this.dom = dom;
    this.tier = detectTier(config);
    this.lowRes = this.tier.low;
    this.veryLow = this.tier.veryLow;

    /* 绘制状态（对应源码 P / V / U / B / H / J / Z / K / er / ei） */
    this.points = [];              // 当前路径采样点（含堆叠 y）
    this.history = [];             // drawingHistory（倒带数据）
    this.resampled = [];           // originalFinalPoints：曲线重采样点（eY 的数据源）
    this.lastPoint = null;
    this.lastMouse = null;
    this.isDrawing = true;
    this.pathFinalized = false;
    this.rewindProgress = 0;
    this.rewinding = false;
    this.lastRenderedPoints = 0;
    this.finalized = [];           // commit 出去的 mesh（上限 finalizedMax 条）
    this.mouse = null;             // globalMousePosition
    this.dirSmooth = new THREE.Vector3(1, 0, 0);
    this.endPos = new THREE.Vector3(0, 0, 0);
    this.viewAnchor = new THREE.Vector3();   // 镜头跟带：固定机位的地面平移偏移
    this.inkOn = true;                 // 中键提笔：false = 提笔中，移动只拖带卷不铺带
    this.liftLast = null;              // 提笔期间上一落点（算带卷朝向）
    this.zoomTarget = 1;               // 滚轮缩放：目标 / 当前相机距离倍率（沿视轴）
    this.zoomCurrent = 1;
    this.endDir = new THREE.Vector3(0, 0, 0);
    this.endPosCache = new THREE.Vector3();
    this.endDirCache = new THREE.Vector3();
    this.rollSpin = 0;
    this.textureCache = new Map();
    this.listView = false;
    this.clickSide = null;
    this.listAnimationsComplete = false;
    this.scrollAccum = 0;
    this._lastScroll = 0;
    this.cameraAnimating = false;
    this.orbitEnabled = false;
    this.glitchActive = false;
    this.rewindBoost = 1;
    this.hoverDebounce = null;
    this.disposed = false;

    /* 渲染调度（frameloop demand 等价） */
    this.scheduled = 0;
    this.burst = 0;
    this.keepAliveUntil = 0;
    this.keepAliveRaf = 0;
    this.keepAliveLast = 0;

    this.auto = new AutoDrawer(this, config);
    this.flick = new FlickPath(this, config);
  }

  /* ── 场景搭建（spec §1） */
  async init() {
    const cfg = this.cfg;
    const mount = this.dom.stage || document.body;

    this.renderer = new THREE.WebGLRenderer({ antialias: !this.veryLow, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.perf?.dprCap || 2));
    this.renderer.setSize(this.width(), this.height());
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const bgCss = cfg.background?.color || cfg.colors?.background || '#ffffff';
    this.renderer.setClearColor(new THREE.Color(bgCss), 1);
    mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(bgCss);
    if (cfg.background?.image) await this.setBackgroundImage(cfg.background.image);

    const cam = cfg.camera;
    this.camera = new THREE.PerspectiveCamera(cam.fov, this.width() / this.height(), cam.near, cam.far);
    this.applyDefaultCamera();

    /* 地面：400×400 单 quad，贴图 repeat 28、flipY true */
    this.groundTex = await this.loadTexture(cfg.groundTexture || makeGroundCanvas(cfg.ground.texSize || 512), {
      flipY: cfg.ground.texFlipY ?? true,
      repeat: [cfg.ground.texRepeat || 28, cfg.ground.texRepeat || 28],
      cacheKey: 'ground',
    });
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(cfg.ground.size, cfg.ground.size),
      new THREE.MeshStandardMaterial({
        map: this.groundTex,
        color: new THREE.Color(cfg.ground.color),
        roughness: cfg.ground.roughness,
        metalness: cfg.ground.metalness,
        envMapIntensity: 1,
      }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.position.y = GROUND_Y;
    this.scene.add(this.ground);

    /* 灯光（阴影相机初值 ±208 / near .1 / far 516） */
    this.scene.add(new THREE.AmbientLight(0xffffff, cfg.light.ambient));
    const d = cfg.light.directional;
    this.sun = new THREE.DirectionalLight(0xffffff, d.intensity);
    this.sun.position.set(...d.position);
    this.sun.castShadow = true;
    this.sun.shadow.bias = d.bias;
    this.sun.shadow.normalBias = d.normalBias;
    Object.assign(this.sun.shadow.camera, cfg.light.shadowCamera);
    this.sun.shadow.camera.updateProjectionMatrix();
    this.shadowMapSize = shadowMapSize(this.lowRes, this.veryLow);
    this.sun.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    this.sun.shadow.needsUpdate = true;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    /* 活路径 ribbon mesh */
    this.tapeTex = await this.loadTexture(cfg.tapeTexture || makeDuctTapeCanvas(cfg.tapeTextureSize || 1024), { cacheKey: 'default' });
    this.roadMaterial = makeTapeMaterial(this.tapeTex, cfg);
    this.committedMaterial = this.roadMaterial.clone();      // eH：commit 用的材质 clone
    this.liveTex = this.tapeTex;
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), this.roadMaterial);
    this.ribbon.castShadow = true;
    this.ribbon.receiveShadow = true;
    this.ribbon.visible = false;
    this.scene.add(this.ribbon);

    await this.buildRoll();

    /* OrbitControls（spec §5：参数同源码，target.y 钳 0） */
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableRotate = false;
    this.controls.enableZoom = false;
    this.controls.minPolarAngle = cfg.orbit.minPolarAngle;
    this.controls.maxPolarAngle = cfg.orbit.maxPolarAngle;
    this.controls.minDistance = cfg.orbit.minDistance;
    this.controls.maxDistance = cfg.orbit.maxDistance;
    this.controls.target.set(0, 0, 0);
    if (cfg.orbit.clampTargetY !== false) {
      this.controls.addEventListener('change', () => { if (this.controls.target.y < 0) this.controls.target.y = 0; });
    }
    this.controls.update();

    this.glitch = new GlitchPass(this.renderer, this.scene, this.camera, cfg.listView?.glitchMs ?? 1000);

    this.bindEvents();
    this.bindDom();
    return this;
  }

  /** 胶带卷：config.rollModel 存在 → GLB（dynamic import，失败自动回落）；否则程序生成 */
  async buildRoll() {
    if (this.roll) { this.scene.remove(this.roll.root); this.roll = null; }
    const built = await createRoll(this.cfg, this.tapeTex)
      || buildRollHierarchy(createProceduralRollModel(this.tapeTex), this.cfg.roll?.scale ?? 4.2);
    this.scene.add(built.root);
    this.roll = built;
  }

  applyDefaultCamera() {
    const c = this.cfg.camera;
    const a = this.viewAnchor;
    const px = c.position[0] + a.x, py = c.position[1], pz = c.position[2] + a.z;
    // eulerDeg 存的就是最终带符号角度（源码 -(deg2rad) 的结果），此处只做 deg→rad
    this.camera.setRotationFromEuler(new THREE.Euler(
      Math.PI / 180 * c.eulerDeg[0],
      Math.PI / 180 * c.eulerDeg[1],
      Math.PI / 180 * c.eulerDeg[2],
    ));
    const z = this.cfg.wheelZoom?.enabled ? this.zoomCurrent : 1;
    if (z !== 1) {
      /* 以「屏幕中心射线打中地面」的点为焦点，机位沿视轴按 z 倍距离推拉 → 缩放时画面中心不漂移 */
      const f = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
      const t = Math.abs(f.y) > 1e-6 ? -py / f.y : 0;
      const fx = px + f.x * t, fz = pz + f.z * t;
      this.camera.position.set(fx + (px - fx) * z, py * z, fz + (pz - fz) * z);
    } else {
      this.camera.position.set(px, py, pz);
    }
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
  }

  /** 滚轮缩放缓动：接近目标即吸附；返回 true 表示还在动（调用方续帧） */
  stepZoom() {
    const wz = this.cfg.wheelZoom;
    if (!wz?.enabled) return false;
    if (Math.abs(this.zoomTarget - this.zoomCurrent) < 1e-4) { this.zoomCurrent = this.zoomTarget; return false; }
    this.zoomCurrent += (this.zoomTarget - this.zoomCurrent) * (wz.lerp ?? 0.18);
    return true;
  }

  /* ── 素材：string → TextureLoader（透明底贴纸 PNG 直接可用）；canvas → CanvasTexture */
  async loadTexture(src, { repeat = [1, 1], flipY = false, cacheKey = null } = {}) {
    const key = cacheKey || (typeof src === 'string' ? src : 'proc');
    if (this.textureCache.has(key)) return this.textureCache.get(key);
    let tex;
    if (typeof src === 'string') {
      tex = await new Promise((resolve, reject) => new THREE.TextureLoader().load(src, resolve, undefined, reject));
    } else {
      tex = new THREE.CanvasTexture(src);
    }
    setupTexture(tex, this.lowRes, repeat);
    tex.flipY = flipY;
    tex.needsUpdate = true;
    this.textureCache.set(key, tex);
    return tex;
  }

  /** 第 i 条贴纸：config.stickers 登记了路径就用它，否则按序取 procgen 的示例贴纸 */
  async stickerSource(index) {
    const reg = this.cfg.stickers || [];
    if (reg[index]) return this.loadTexture(reg[index], { cacheKey: `sticker:${index}` });
    const proc = PROCEDURAL_STICKERS[index % PROCEDURAL_STICKERS.length];
    return this.loadTexture(proc.make(512), { cacheKey: `proc:${proc.id}` });
  }

  /* ── HUD / DOM 绑定 ── */
  bindDom() {
    this.hud = {
      hudPoints: this.dom.hudPoints,
      hudFps: this.dom.hudFps,
      hudOrbit: this.dom.hudOrbit,
      hudRewindLabel: this.dom.hudRewindLabel,
    };
    this.setHudPoints(0);
    // FPS 独立 rAF 计数，每秒更新一次，显示上限 165（spec §7）
    this.fpsFrames = 0;
    this.fpsSince = performance.now();
    const fpsLoop = () => {
      if (this.disposed) return;
      this.fpsFrames += 1;
      const now = performance.now(), dt = now - this.fpsSince;
      if (dt >= 1000) {
        const fps = Math.min(Math.round(1000 * this.fpsFrames / dt), this.cfg.perf?.fpsCapDisplay ?? 165);
        if (this.hud.hudFps) this.hud.hudFps.textContent = String(fps).padStart(6, '0');
        this.fpsFrames = 0;
        this.fpsSince = now;
      }
      requestAnimationFrame(fpsLoop);
    };
    requestAnimationFrame(fpsLoop);
  }

  bindEvents() {
    const throttleMs = this.cfg.draw.throttleMs;
    let lastStamp = 0;
    const onMove = (x, y) => {
      const now = Date.now();
      if (this.mouse && now - lastStamp < throttleMs) return;            // 16ms 节流
      lastStamp = now;
      this.mouse = { x, y };
      this.invalidate();
    };
    this._onMouseMove = (e) => onMove(e.clientX, e.clientY);
    this._onTouchMove = (e) => { const t = e.touches?.[0]; if (t) onMove(t.clientX, t.clientY); };
    this._onLeave = () => { this.mouse = null; };
    window.addEventListener('mousemove', this._onMouseMove, { passive: true });
    window.addEventListener('touchstart', this._onTouchMove, { passive: true });
    window.addEventListener('touchmove', this._onTouchMove, { passive: true });
    window.addEventListener('touchend', this._onLeave, { passive: true });
    window.addEventListener('mouseleave', this._onLeave);

    this._onInteract = () => this.pokeRender();                          // 交互 → 8 帧 burst + 30s keep-alive
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'focus']) {
      window.addEventListener(ev, this._onInteract, { passive: true });
    }
    this._onVisibility = () => { if (document.visibilityState === 'visible') this.pokeRender(); };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onResize = () => {
      this.camera.aspect = this.width() / this.height();
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.width(), this.height());
      this.glitch.resize();
      this.invalidate();
    };
    window.addEventListener('resize', this._onResize);

    this._onKey = (e) => {
      const im = this.cfg.immersive;
      if (this.immersiveActive) {
        if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
        this.exitImmersive();                                    // 沉浸中任意按键 → 退出还权
        return;
      }
      if (im?.enabled !== false && e.code === (im?.key || 'KeyI')) { e.preventDefault(); this.enterImmersive(); return; }
      if (e.code === 'Space') { e.preventDefault(); this.onSpace(); }
      else if (e.code === 'Tab') { e.preventDefault(); this.toggleOrbit(); }
      else if (this.cfg.autoWrite?.texts?.[e.code] !== undefined) {
        e.preventDefault();
        if (e.repeat) return;                // 键盘自动重复不算"再按一次"
        this.startAutoWrite(this.cfg.autoWrite.texts[e.code]);     // Z/L…：自动写字（书写中再按任意写字键 = 立即写完）
      }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        const aw = this.cfg.autoWrite;
        if (aw?.enabled) {
          e.preventDefault();
          const step = e.code === 'ArrowUp' ? 0.25 : -0.25;
          aw.speed = Math.min(10, Math.max(0.05, +(aw.speed + step).toFixed(2)));
          if (this.autoWrite) this.autoWrite.speed = aw.speed;   // 书写中即时变速
          const el = document.getElementById('wspeed');
          if (el) el.textContent = aw.speed.toFixed(2);
        }
      }
      else if (e.code === (this.cfg.ui?.toggleKey || 'KeyS')) {
        document.body.classList.toggle('ui-hidden');   // S：显隐全部文字层（署名常驻）
      }
    };
    window.addEventListener('keydown', this._onKey);

    this._onUserTakeover = () => { if (this.immersiveActive) this.exitImmersive(); };
    window.addEventListener('pointerdown', this._onUserTakeover, { passive: true });
    window.addEventListener('wheel', this._onUserTakeover, { passive: true });

    /* 中键 = 提笔 / 落笔切换（非 passive：屏蔽 Windows 中键自动滚动圆圈） */
    this._onMiddleDown = (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.toggleInk();
    };
    this._onAuxClick = (e) => { if (e.button === 1) e.preventDefault(); };
    window.addEventListener('mousedown', this._onMiddleDown);
    window.addEventListener('auxclick', this._onAuxClick);

    /* 滚轮缩放：以屏幕中心地面交点为焦点沿视轴推拉；沉浸/列表/orbit/补间下不接管
       （沉浸中滚轮先由 _onUserTakeover 退出还权，orbit 用 OrbitControls 自带 zoom） */
    this._onWheelZoom = (e) => {
      const wz = this.cfg.wheelZoom;
      if (!wz?.enabled || this.immersiveActive || this.listView || this.orbitEnabled || this.cameraAnimating) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;   // 行/页滚动模式折算成像素当量
      const k = (wz.step ?? 0.0015) * unit;
      const next = this.zoomTarget * Math.exp(e.deltaY * k);
      this.zoomTarget = Math.min(wz.max ?? 10, Math.max(wz.min ?? 0.4, next));
      this.invalidate();
    };
    window.addEventListener('wheel', this._onWheelZoom, { passive: false });

    /* 全屏状态唯一来源是 Fullscreen API（ESC 由浏览器原生处理），这里只做 UI 同步 */
    this._onFsChange = () => {
      document.body.classList.toggle('fs', !!document.fullscreenElement);
      this._onResize();
    };
    document.addEventListener('fullscreenchange', this._onFsChange);

    /* 与原版一致的 window 钩子（外部驱动 / 自动化测试都走这套 API） */
    window.enterListViewMode = (side) => this.enterListView(side);
    window.exitListViewMode = () => this.exitListView();
    window.clearCanvas = () => this.clearCanvas();
    window.glitchThenReset = () => this.glitchThenReset();
    window.redrawPathWithTexture = (i, u, v) => this.redrawWithSticker(i, u, v);
    window.enterImmersive = () => this.enterImmersive();
    window.exitImmersive = () => this.exitImmersive();
    window.enterFullscreen = () => this.enterFullscreen();
    window.exitFullscreen = () => this.exitFullscreenMode();
    window.setBackgroundColor = (c) => this.setBackgroundColor(c);
    window.setBackgroundImage = (u) => this.setBackgroundImage(u);
    window.setGroundImage = (u) => this.setGroundImage(u);
    window.toggleInk = () => this.toggleInk();
    window.autoWriteText = (t) => this.startAutoWrite(t);
    window.onProjectsScroll = (o) => this.onProjectsScroll(o);
    window.setListAnimationsComplete = () => {
      this.listAnimationsComplete = true;
      document.body.classList.add('list-animations-complete');
      this.dom.listPanel?.classList.add('complete');
    };
    window.tapeEngine = this;
  }

  width() { return window.innerWidth; }

  height() { return window.innerHeight; }

  /* ── 渲染调度：frameloop demand 等价（脏标记 + burst + keep-alive） ── */
  invalidate() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = requestAnimationFrame(() => { this.scheduled = 0; this.step(); });
  }

  pokeRender() {
    this.burst = this.cfg.perf.burstFrames ?? 8;
    this.keepAliveUntil = performance.now() + (this.cfg.perf.keepAliveMs ?? 30000);
    if (this.keepAliveRaf) return;
    const loop = (now) => {
      const t = now || performance.now();
      if (t >= this.keepAliveUntil) { this.keepAliveRaf = 0; return; }
      if (!this.keepAliveLast || t - this.keepAliveLast >= (this.cfg.perf.keepAliveTickMs ?? 33)) {
        this.keepAliveLast = t;
        this.invalidate();
      }
      this.keepAliveRaf = requestAnimationFrame(loop);
    };
    this.keepAliveRaf = requestAnimationFrame(loop);
  }

  step() {
    if (this.disposed) return;
    this.frameLogic();
    this.render();
    if (this.burst > 0) { this.burst -= 1; this.invalidate(); }
    else if (this.rewinding || this.cameraAnimating || this.glitchActive) this.invalidate();
  }

  /* ── 每帧逻辑：倒带分支 或 手动绘制分支（spec §3 / §5） */
  frameLogic() {
    if (this.autoWrite) { this.autoWriteFrame(); return; }   // Z 键自动写字优先
    if (this.rewinding) { this.rewindFrame(); return; }
    if (this.flick.active || this.auto.active) return;     // 自动铺带自己推进
    if (!this.isDrawing || !this.mouse) return;
    if (!this.inkOn) { this.liftFrame(); return; }   // 提笔中：拖卷不铺带

    const p = this.screenToWorld(this.mouse);
    if (!p) return;
    if (!this.lastPoint) {                                 // 首点 y = .05
      p.y = this.cfg.firstPointY ?? 0.05;
      this.lastPoint = p.clone();
      this.points = [p.clone()];
      this.history.push(p.clone());
      this.lastMouse = { x: this.mouse.x, y: this.mouse.y };
      this.setEndPos(p.clone());
      this.setEndDir(new THREE.Vector3(1, 0, 0));
      this.setHudPoints(1);
      return;
    }
    const moved = this.lastMouse ? Math.hypot(this.mouse.x - this.lastMouse.x, this.mouse.y - this.lastMouse.y) : 0;
    if (!(moved > this.cfg.draw.moveThreshold)) return;     // 屏幕位移阈值 .001
    if (!(this.lastPoint.distanceTo(p) > this.cfg.draw.moveThreshold)) return;   // 3D 位移阈值 .001

    p.y = stackLift(this.points, p, this.lastPoint, this.stackOpts());
    this.points.push(p.clone());
    this.history.push(p.clone());

    const a = this.points[this.points.length - 1];
    const b = this.points[this.points.length - 2] || this.points[0];
    const dir = new THREE.Vector3().subVectors(a, b);
    if (dir.lengthSq() > 0.001) {
      const dl = this.cfg.draw.dirLerp;
      const alpha = Math.max(dl.min, Math.min(dl.max, dl.base + moved / dl.divisor * dl.perSpeed));
      this.dirSmooth.lerp(dir.normalize(), alpha).normalize();     // 方向 lerp 平滑
    }
    this.setEndPos(a.clone());
    this.setEndDir(this.dirSmooth.clone());
    this.lastPoint = p.clone();
    this.lastMouse = { x: this.mouse.x, y: this.mouse.y };
    this.setHudPoints(this.points.length);
    this.rebuild({ auto: false, saveOriginal: true });
  }

  stackOpts() {
    return { ...this.cfg.stack, baseline: this.cfg.baselineY };
  }

  /** 提笔期间每帧：移动只更新带卷端点/朝向（镜头仍跟"带"），不 push 任何路径点 → 断点完全空白 */
  liftFrame() {
    const p = this.screenToWorld(this.mouse);
    if (!p) return;
    const prev = this.liftLast;
    if (prev && prev.distanceTo(p) <= this.cfg.draw.moveThreshold) return;
    const dir = prev ? p.clone().sub(prev) : null;
    this.liftLast = p.clone();
    if (dir && dir.lengthSq() > 1e-6) this.setEndDir(dir.normalize());
    this.setEndPos(p.clone());
    this.lastMouse = { x: this.mouse.x, y: this.mouse.y };
  }

  /** 中键切换：落笔 → 提笔（钉住当前段为独立胶带，带卷留在带尾）；提笔 → 落笔（从带卷当前位置续画） */
  toggleInk() {
    if (this.cfg.tapeBreak?.enabled === false) return;
    if (this.immersiveActive || this.listView || this.rewinding || this.autoWrite) return;
    if (this.auto.active || this.flick.active) return;
    if (this.inkOn) {
      this.pinSegment();
      this.liftLast = this.lastPoint ? this.lastPoint.clone() : null;
      this.clearLivePath();
      this.inkOn = false;
      document.body.classList.add('ink-lifted');
    } else {
      this.inkOn = true;
      this.liftLast = null;
      document.body.classList.remove('ink-lifted');
    }
    this.invalidate();
  }

  /** 清空当前活路径（已钉段不受影响）——提笔 / 写字换环共用 */
  clearLivePath() {
    this.points = [];
    this.history = [];
    this.resampled = [];
    this.lastPoint = null;
    this.lastMouse = null;
    this.pathFinalized = false;
    this.clearRibbonGeometry();
    this.setHudPoints(0);
  }

  /** 把一个世界坐标点并入当前路径并重建 ribbon（手动绘制/自动写字共用） */
  pushPathPoint(p) {
    if (!this.lastPoint) {
      p.y = this.cfg.firstPointY ?? 0.05;
      this.lastPoint = p.clone();
      this.points = [p.clone()];
      this.history.push(p.clone());
      this.setEndPos(p.clone());
      this.setEndDir(new THREE.Vector3(1, 0, 0));
      this.setHudPoints(1);
      return;
    }
    if (this.lastPoint.distanceTo(p) <= 1e-6) return;
    p.y = stackLift(this.points, p, this.lastPoint, this.stackOpts());
    this.points.push(p.clone());
    this.history.push(p.clone());
    const a = this.points[this.points.length - 1];
    const b = this.points[this.points.length - 2] || this.points[0];
    const dir = new THREE.Vector3().subVectors(a, b);
    if (dir.lengthSq() > 1e-6) this.setEndDir(dir.normalize());
    this.setEndPos(a.clone());
    this.lastPoint = p.clone();
    this.setHudPoints(this.points.length);
    this.rebuild({ auto: false, saveOriginal: true });
  }

  /** Z 键：把 config.autoWrite.text 沿双钩轮廓自动铺带。书写中再按 → 立即写完。 */
  startAutoWrite(text) {
    const aw = this.cfg.autoWrite;
    if (!aw?.enabled || this.immersiveActive || this.listView || this.rewinding) return;
    if (this.autoWrite) {
      // 刚起笔 400ms 内的二次 keydown 不 flush（防连击/驱动抖动跳掉动画）
      if (performance.now() - this.autoWrite.t0 > 400) this.autoWriteFlush();
      return;
    }
    if (this.auto.active || this.flick.active) return;
    const content = text || aw.text || Object.values(aw.texts ?? {})[0];
    if (!content) return;
    if (!this.inkOn) { this.inkOn = true; this.liftLast = null; document.body.classList.remove('ink-lifted'); }
    if (this.points.length > 1) this.pinSegment();
    this.clearLivePath();
    const res = textToContours(content, {
      font: aw.font, fontPx: aw.fontPx, cell: aw.cell,
      threshold: aw.threshold, eps: aw.simplify,
    });
    if (!res.contours.length) return;
    /* 屏幕对齐基：中心 + 右移 + 上移 三个求交点 → 地面平面上的正交基，文字在默认机位下正读 */
    const W = this.width() || 1280, H = this.height() || 800;
    const c0 = this.screenToWorld({ x: W / 2, y: H / 2 });
    const cR = this.screenToWorld({ x: W / 2 + 120, y: H / 2 });
    const cU = this.screenToWorld({ x: W / 2, y: H / 2 - 120 });
    if (!c0 || !cR || !cU) return;
    const R = cR.sub(c0).setY(0).normalize();
    let U = cU.sub(c0).setY(0);
    if (U.lengthSq() < 1e-6) U.set(-R.z, 0, R.x); else U.sub(R.clone().multiplyScalar(U.dot(R))).normalize();
    const scale = (aw.width ?? 260) / res.pixelWidth;
    const polys = res.contours.map((c) => c.pts.map((p) => new THREE.Vector3(
      c0.x + R.x * (p.x - res.pixelWidth / 2) * scale + U.x * (res.pixelHeight / 2 - p.y) * scale,
      0,
      c0.z + R.z * (p.x - res.pixelWidth / 2) * scale + U.z * (res.pixelHeight / 2 - p.y) * scale,
    )));
    this.autoWrite = { polys, i: 0, j: 0, started: false, speed: aw.speed ?? 1, t0: performance.now() };
    if (aw.fitZoom !== false && this.cfg.wheelZoom?.enabled) {
      const cL = this.screenToWorld({ x: 0, y: H / 2 });
      const viewW = cL ? c0.distanceTo(cL) * 2 : 60;
      const need = (aw.width ?? 260) * 1.15 / viewW;
      const wz = this.cfg.wheelZoom;
      this.zoomTarget = Math.min(wz.max ?? 10, Math.max(1, need));
    }
    this.isDrawing = false;
    this.invalidate();
  }

  autoWriteFrame() {
    const w = this.autoWrite;
    if (w.i >= w.polys.length) {
      this.autoWrite = null;
      this.isDrawing = true;
      this.lastMouse = null;
      this.invalidate();
      return;
    }
    const poly = w.polys[w.i];
    if (!w.started) { w.started = true; w.j = 0; this.pushPathPoint(poly[0].clone()); w.j = 1; }
    // 速度可为小数（<1 = 每几帧推进一点）：用累加器补足
    w.acc = (w.acc ?? 0) + w.speed;
    const stepN = Math.floor(w.acc);
    w.acc -= stepN;
    for (let k = 0; k < stepN && w.j < poly.length; k++, w.j++) this.pushPathPoint(poly[w.j].clone());
    if (w.j >= poly.length) {
      this.pinSegment();          // 环与环之间 = 提笔断点
      this.clearLivePath();
      w.started = false;
      w.i += 1;
    }
    this.invalidate();            // 保持推进节奏（demand 渲染下不等鼠标也走）
  }

  /** 书写中再按 Z：剩余轮廓一步画完（不再逐帧推进） */
  autoWriteFlush() {
    const w = this.autoWrite;
    for (let i = w.i; i < w.polys.length; i++) {
      const poly = w.polys[i];
      const from = (i === w.i && w.started) ? w.j : 0;
      if (from === 0) this.clearLivePath();
      for (let k = from; k < poly.length; k++) {
        const p = poly[k].clone();
        p.y = this.cfg.baselineY;
        this.points.push(p);
        this.history.push(p.clone());
      }
      if (this.points.length > 1) {
        this.lastPoint = this.points[this.points.length - 1];
        this.setEndPos(this.lastPoint.clone());
        this.rebuild({ auto: false, saveOriginal: true });
        this.pinSegment();
      }
      this.clearLivePath();
    }
    this.autoWrite = null;
    this.isDrawing = true;
    this.invalidate();
  }

  /** 把当前路径钉成独立胶带条。finalizedMax:null → 不设上限（断点段全部保留） */
  pinSegment() {
    if (this.points.length <= 1) return null;
    const geo = this.rebuild({ auto: false, saveOriginal: false });
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, this.committedMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.finalized.push(mesh);
    const cap = this.cfg.draw.finalizedMax;
    const max = cap === null ? Infinity : (cap ?? 5);
    while (this.finalized.length > max) {           // 有上限时移最早并 dispose
      const gone = this.finalized.shift();
      this.scene.remove(gone);
      gone.geometry?.dispose();
    }
    return mesh;
  }

  screenToWorld(screen) {
    const ndc = new THREE.Vector2(
      screen.x / this.width() * 2 - 1,
      -(screen.y / this.height() * 2) + 1,
    );
    const ig = this.cfg.infiniteGround;
    const size = ig?.enabled ? (ig.raycastLimit ?? 10000) : this.cfg.ground.size;
    return rayToGround(this.camera, ndc, size);
  }

  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x + 1) / 2 * this.width(), y: (1 - (p.y + 1) / 2) * this.height() };
  }

  /** ENGINE CONTRACT：把一个屏幕坐标求交到地面并 push。
   *  stack:false → 不做堆叠抬升（列表冷启动 30 步在源码里就是绕过 eO 的）；
   *  rebuildEvery → 甩尾模式每 3 帧才重建一次几何。 */
  offerScreenPoint(px, opt = {}) {
    const p = this.screenToWorld(px);
    if (!p) return false;
    if (!this.lastPoint) {
      p.y = opt.auto ? this.cfg.baselineY : (this.cfg.firstPointY ?? 0.05);
      this.lastPoint = p.clone();
      this.points = [p.clone()];
      this.history.push(p.clone());
      this.setEndPos(p.clone());
      this.setEndDir(new THREE.Vector3(1, 0, 0));
      this.setHudPoints(1);
      return true;
    }
    if (this.lastPoint.distanceTo(p) <= this.cfg.draw.moveThreshold) return false;
    p.y = opt.stack === false ? this.cfg.baselineY : stackLift(this.points, p, this.lastPoint, this.stackOpts());
    this.points.push(p.clone());
    this.history.push(p.clone());
    const a = this.points[this.points.length - 1];
    const b = this.points[this.points.length - 2] || this.points[0];
    const dir = new THREE.Vector3().subVectors(a, b);
    if (dir.lengthSq() > 1e-4) dir.normalize();
    this.setEndPos(a.clone());
    this.setEndDir(dir.clone());
    this.lastPoint = p.clone();
    this.setHudPoints(this.points.length);
    const every = opt.rebuildEvery || 1;
    if ((opt.frame || 0) % every === 0 || opt.lastFrame) this.rebuild({ auto: !!opt.auto, saveOriginal: true });
    return true;
  }

  onAutoStart() { this.autoActive = true; }

  /** 冷启动跑完 → 放行列表 CSS 动画（window.setListAnimationsComplete） */
  onAutoComplete() {
    this.autoActive = false;
    if (!this.listAnimationsComplete) window.setListAnimationsComplete?.();
  }

  /* ── ribbon 重建（eq / eY） */
  rebuild({ auto = false, saveOriginal = false, fromResampledCount = null } = {}) {
    this.maybeRecenter();
    const cfg = this.cfg;
    if (fromResampledCount != null) {
      const slice = this.resampled.slice(0, fromResampledCount);
      if (slice.length < 2) return this.clearRibbonGeometry();
      return this.applyRibbon(ribbonFromSamples(slice.map(toPlain), cfg));   // eY：不平滑
    }
    if (this.points.length < 2) return this.clearRibbonGeometry();
    const smoothed = (auto || cfg.cornerSmoothing.enabled === false)
      ? this.points.map(toPlain)
      : smoothCorners(this.points.map(toPlain), (cfg.cornerSmoothing.angleLimitDeg ?? 90) * Math.PI / 180);
    const curve = new THREE.CatmullRomCurve3(smoothed.map((v) => new THREE.Vector3(v.x, v.y, v.z)));
    curve.curveType = cfg.curve.type;                                       // centripetal
    curve.tension = auto ? cfg.curve.tensionAuto : cfg.curve.tensionManual; // 手动 .5 / 自动 .8
    const segs = curveSegments(smoothed.length, { auto, lowRes: this.lowRes, curve: cfg.curve });
    const samples = curve.getPoints(segs);
    if (saveOriginal) this.resampled = samples.map((v) => v.clone());
    return this.applyRibbon(ribbonFromSamples(samples.map(toPlain), cfg));
  }

  applyRibbon(data) {
    if (!data) return null;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.Float32BufferAttribute(data.positions, 3);
    const uv = new THREE.Float32BufferAttribute(data.uvs, 2);
    pos.setUsage(THREE.DynamicDrawUsage);                                   // 每点重建 → 动态用途
    uv.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('uv', uv);
    geo.setIndex(data.indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const old = this.ribbon.geometry;
    this.ribbon.geometry = geo;
    if (old) old.dispose();
    this.ribbon.visible = this.points.length > 1;
    return geo;
  }

  clearRibbonGeometry() {
    const old = this.ribbon.geometry;
    this.ribbon.geometry = new THREE.BufferGeometry();
    if (old) old.dispose();
    this.ribbon.visible = false;
    this.lastRenderedPoints = 0;
  }

  /* ── 胶带卷跟随（spec §4）：+8y、yaw = atan2(dir.x, dir.z) + π、spin -= .1 * 距离增量 */
  setEndPos(v) {
    const dist = this.endPosCache.distanceTo(v);
    if (dist > (this.cfg.roll.positionDeadZone ?? 0.1)) {
      this.endPos.copy(v);
      this.endPosCache.copy(v);
      this.rollSpin -= (this.cfg.roll.spinPerUnit ?? 0.1) * dist;
    }
  }

  setEndDir(v) {
    if (this.endDirCache.distanceTo(v) > (this.cfg.roll.directionDeadZone ?? 0.08)) {
      this.endDir.copy(v);
      this.endDirCache.copy(v);
    }
  }

  updateRoll() {
    if (!this.roll) return;
    const r = this.cfg.roll;
    this.roll.root.position.set(this.endPos.x, this.endPos.y + (r.offsetY ?? 8), this.endPos.z);
    const yaw = this.endDir.lengthSq() === 0 ? 0 : Math.atan2(this.endDir.x, this.endDir.z);
    this.roll.yaw.rotation.y = yaw + (r.yawPlusPI !== false ? Math.PI : 0);
    this.roll.spin.rotation.x = this.rollSpin;
  }

  /* ── Space 三分支状态机（spec §5） */
  onSpace() {
    if (this.autoWrite) return;                        // 书写中不接管
    if (this.rewinding) {                              // ① 倒放播放中 → 停止
      this.rewinding = false;
      this.rewindProgress = 0;
      this.isDrawing = true;
      this.setHudRewind(false);
      this.invalidate();
      return;
    }
    if (this.history.length > 0) {               // ② 有历史 → 开始倒放
      this.rewinding = true;
      this.rewindProgress = 0;
      this.isDrawing = false;
      this.setHudRewind(true);
      this.invalidate();
      return;
    }
    // ③ 无历史 → commit 当前路径 + 清路，重点开始
    this.isDrawing = false;
    this.pinSegment();
    this.points = [];
    this.history = [];
    this.resampled = [];
    this.lastPoint = null;
    this.lastMouse = null;
    this.pathFinalized = false;
    this.clearRibbonGeometry();
    this.isDrawing = true;
    this.invalidate();
  }

  rewindFrame() {
    const n = this.history.length;
    if (n === 0) { this.rewinding = false; this.isDrawing = true; this.setHudRewind(false); return; }
    this.rewindProgress += (this.cfg.rewind.speed ?? 0.005) * this.rewindBoost;
    if (this.rewindProgress >= 1) { this.finishRewind(); return; }

    const iLen = this.resampled.length;
    const o = Math.floor((1 - this.rewindProgress) * iLen);
    const a = Math.floor((1 - this.rewindProgress) * n);
    this.points = this.history.slice(0, a);
    this.setHudPoints(this.points.length);
    if (iLen > o && o > 1) {
      const cur = this.resampled[o - 1], prev = this.resampled[o - 2];
      this.setEndPos(cur.clone());
      this.setEndDir(cur.clone().sub(prev).normalize());
    } else if (iLen > 0 && o >= 1) {
      this.setEndPos(this.resampled[0].clone());
      this.setEndDir(new THREE.Vector3(1, 0, 0));
    } else {
      this.setEndPos(new THREE.Vector3(0, 0, 0));
      this.setEndDir(new THREE.Vector3(1, 0, 0));
    }
    const threshold = this.cfg.rewind.geometryStepThreshold ?? 10;
    if (Math.abs(o - this.lastRenderedPoints) > threshold || (o <= 1 && this.lastRenderedPoints > 1)) {
      if (o > 1) this.rebuild({ fromResampledCount: o });
      else this.clearRibbonGeometry();
      this.lastRenderedPoints = o;
    }
  }

  finishRewind() {
    this.rewinding = false;
    this.rewindProgress = 0;
    this.setHudRewind(false);
    this.auto.stop();
    this.flick.stop();
    for (const m of this.finalized) {           // commit 过的路径全部 dispose + 移出场景
      this.scene.remove(m);
      m.geometry?.dispose();
    }
    this.finalized = [];
    this.clearRibbonGeometry();
    this.points = [];
    this.history = [];
    this.resampled = [];
    this.lastPoint = null;
    this.lastMouse = null;
    this.pathFinalized = false;
    this.setEndPos(new THREE.Vector3(0, 0, 0));
    this.setEndDir(new THREE.Vector3(1, 0, 0));
    this.setHudPoints(0);
    this.isDrawing = true;
    // 等价于原站的 info.reset() + state.reset() + clear()；原站还会把 React 托管的 mesh 全部拆掉重建，
    // 这里地面 / 胶带卷由我们自己持有，保留下来（该行为差异已在 README 说明）。
    this.renderer.info.reset();
    this.renderer.state.reset();
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, true);
    this.invalidate();
  }

  /* ── 沉浸模式（Attract Mode，方案见 skill references/immersive-mode-plan.md） */
  enterImmersive() {
    if (this.immersiveActive || this.cfg.immersive?.enabled === false) return;
    if (!this.immersiveCtl) this.immersiveCtl = new AttractMode(this);
    this.immersiveActive = true;
    document.body.classList.add('immersive');
    if (this.listView) this.exitListView();
    this.pokeRender();
    this.immersiveCtl.start();
  }

  exitImmersive() {
    if (!this.immersiveActive) return;
    this.immersiveActive = false;
    document.body.classList.remove('immersive');
    this.immersiveCtl?.stop();
    this.clearCanvas();                 // 默认带身 + 清路径 + isDrawing=true
    this.applyDefaultCamera();
    this.pokeRender();
    this.invalidate();
  }

  toggleImmersive() { if (this.immersiveActive) this.exitImmersive(); else this.enterImmersive(); }

  /* ── 全屏模式：浏览器 Fullscreen API，body.fs 隐藏全部文字层；ESC 是唯一退出路径（浏览器原生） */
  enterFullscreen() {
    if (document.fullscreenElement) return;
    const el = document.documentElement;
    Promise.resolve(el.requestFullscreen?.()).catch((err) => {
      console.warn('[tape] 进入全屏失败：', err?.message || err);
    });
  }

  exitFullscreenMode() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  /* ── 背景自定义：纯色天空 / 满屏背景图 / 地面换图，均可运行时调用 ── */
  setBackgroundColor(css) {
    const c = new THREE.Color(css || this.cfg.background?.color || '#ffffff');
    this.scene.background = c;
    this.renderer.setClearColor(c, 1);
    this.invalidate();
  }

  async setBackgroundImage(url) {
    if (!url) { this.setBackgroundColor(this.cfg.background?.color || '#ffffff'); return; }
    const tex = await this.loadTexture(url, { cacheKey: `bg:${url}` });
    this.scene.background = tex;
    this.invalidate();
  }

  async setGroundImage(url) {
    if (!url) return;
    const tex = await this.loadTexture(url, { repeat: [1, 1], flipY: this.cfg.ground?.texFlipY ?? true, cacheKey: `ground:${url}` });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1, 1);
    tex.needsUpdate = true;
    this.ground.material.map = tex;
    this.ground.material.needsUpdate = true;
    this.invalidate();
  }

  /* ── Tab：OrbitControls 开关（spec §5） */
  toggleOrbit() {
    this.orbitEnabled = !this.orbitEnabled;
    this.applyOrbitState();
    if (this.hud?.hudOrbit) this.hud.hudOrbit.textContent = this.orbitEnabled ? 'On' : 'Off';
    this.invalidate();
  }

  applyOrbitState() {
    const on = this.orbitEnabled && !this.cameraAnimating;
    this.controls.enablePan = on;
    this.controls.enableRotate = on;
    this.controls.enableZoom = on;
  }

  /* ── 列表模式（spec §6） */
  enterListView(side) {
    if (this.listView || this.cfg.listView?.enabled === false) return;
    this.listView = true;
    this.clickSide = side;
    this.listAnimationsComplete = false;
    document.body.classList.remove('listMenu-open-left', 'listMenu-open-right');
    document.body.classList.add(`listMenu-open-${side}`, 'open');
    this.dom.listPanel?.classList.add('open');
    this.ribbon.position.y = this.cfg.listView.meshYOffset ?? 0.1;
    if (isMobileUA()) {         // 移动端：进列表后把 mouse 置中，强制触发一次渲染（原站同款处理）
      const c = { x: Math.max(0, Math.floor(this.width() / 2)), y: Math.max(0, Math.floor(this.height() / 2)) };
      this.mouse = c;
      requestAnimationFrame(() => { this.mouse = c; this.pokeRender(); });
    }
    this.tweenCameraToList();
    this.invalidate();
  }

  exitListView() {
    if (!this.listView) return;
    this.listView = false;
    this.clickSide = null;
    this.listAnimationsComplete = false;
    document.body.classList.remove('listMenu-open-left', 'listMenu-open-right', 'open', 'list-animations-complete');
    this.dom.listPanel?.classList.remove('open', 'complete');
    if (this.dom.scroller) this.dom.scroller.scrollTop = 0;
    this.scrollAccum = 0;
    this.ribbon.position.y = 0;
    this.applyDefaultCamera();
    this.invalidate();
  }

  /** 相机 1s easeInOutCubic 补间 → 到位后 glitch → 清画布 → 冷启动自动铺带 */
  tweenCameraToList() {
    const c = this.cfg.camera;
    const from = { pos: this.camera.position.clone(), rot: this.camera.rotation.clone() };
    const to = {
      pos: new THREE.Vector3(...c.listPosition),
      rot: new THREE.Euler(...c.listEulerDeg.map((deg) => Math.PI / 180 * deg)),
    };
    const t0 = performance.now();
    this.cameraAnimating = true;
    this.applyOrbitState();
    const step = () => {
      if (this.disposed) return;
      const k = Math.min((performance.now() - t0) / (c.tweenMs ?? 1000), 1);
      const e = easeInOutCubic(k);
      this.camera.position.lerpVectors(from.pos, to.pos, e);
      this.camera.rotation.x = from.rot.x + (to.rot.x - from.rot.x) * e;
      this.camera.rotation.y = from.rot.y + (to.rot.y - from.rot.y) * e;
      this.camera.rotation.z = from.rot.z + (to.rot.z - from.rot.z) * e;
      this.invalidate();
      if (k < 1) requestAnimationFrame(step);
      else {
        this.cameraAnimating = false;
        this.applyOrbitState();
        this.runGlitchThen(() => {
          this.resetDrawingState();
          const rep = this.cfg.listView.textureRepeat;
          this.redrawWithSticker(0, rep.u ?? 1, rep.vDefault ?? 9.7);
        });
      }
    };
    step();
  }

  runGlitchThen(after) {
    if (!this.glitch) { after(); return; }
    this.glitchActive = true;
    this.pokeRender();
    this.glitch.captureAndStart().then(() => {
      this.glitchActive = false;
      after();
      this.invalidate();
    });
  }

  /** 清画布（等价源码里的 R + E + k 三件套） */
  resetDrawingState() {
    this.auto.stop();
    this.flick.stop();
    this.autoWrite = null;
    this.points = [];
    this.history = [];
    this.resampled = [];
    this.lastPoint = null;
    this.lastMouse = null;
    this.isDrawing = false;
    this.pathFinalized = false;
    this.rewindProgress = 0;
    this.rewinding = false;
    this.lastRenderedPoints = 0;
    for (const m of this.finalized) { this.scene.remove(m); m.geometry?.dispose(); }
    this.finalized = [];
    this.setHudRewind(false);
    this.clearRibbonGeometry();
    this.setHudPoints(0);
    this.endPos.set(-1e3, -1e3, -1e3);
    this.endDir.set(0, 0, 0);
    this.endPosCache.set(-1e3, -1e3, -1e3);
    this.endDirCache.set(0, 0, 0);
    this.rollSpin = 0;
    this.inkOn = true;
    this.liftLast = null;
    document.body.classList.remove('ink-lifted');
  }

  clearCanvas() {
    this.resetDrawingState();
    this.setStickerTexture(this.tapeTex, [1, 1]);
    this.isDrawing = true;
    this.syncRibbonOffset();
    this.invalidate();
  }

  syncRibbonOffset() {
    this.ribbon.position.y = this.listView ? (this.cfg.listView.meshYOffset ?? 0.1) : 0;
  }

  /** glitchThenReset：glitch 1s → 清画布 →（仍在列表模式则）重铺列表首项目 */
  glitchThenReset() {
    this.runGlitchThen(() => {
      if (this.listView) {
        const rep = this.cfg.listView.textureRepeat;
        this.redrawWithSticker(0, rep.u ?? 1, this.listRepeatVForSide());
      } else {
        this.clearCanvas();
      }
    });
  }

  listRepeatVForSide() {
    return listRepeatY(this.cfg, this.clickSide || this.cfg.listView.defaultSide || 'right');
  }

  /** eM：换带身贴图 + 重画一条新胶带（repeat.set(u, v)：u 方向 1 张、v 方向 v 张） */
  async redrawWithSticker(index, repeatU = 1, repeatV = 1) {
    let tex;
    try {
      tex = await this.stickerSource(index);
    } catch (err) {
      console.warn('[tape] 贴纸加载失败，回落默认带身：', err?.message || err);
      tex = this.tapeTex;
    }
    this.resetDrawingState();
    this.setStickerTexture(tex, [repeatU, repeatV]);
    this.syncRibbonOffset();
    this.isDrawing = false;                     // 自动铺带期间不接收鼠标
    this.auto.start(this.clickSide || 'right');
    this.invalidate();
  }

  /** 贴图切换：clone + repeat，旧 material/texture dispose（缓存 Map 按 key 复用，同 ef.current） */
  setStickerTexture(tex, repeat) {
    const t = tex.clone();
    t.needsUpdate = true;
    t.repeat.set(repeat[0], repeat[1]);
    const oldMat = this.roadMaterial;
    const oldTex = this.liveTex;
    this.roadMaterial = makeTapeMaterial(t, this.cfg);
    this.committedMaterial = this.roadMaterial.clone();
    this.ribbon.material = this.roadMaterial;
    this.liveTex = t;
    if (oldMat) oldMat.dispose();
    if (oldTex && oldTex !== this.tapeTex && oldTex !== this.groundTex) oldTex.dispose();
  }

  /** 列表滚动累计 ≥800px → 甩尾新路径（window.onProjectsScroll） */
  onProjectsScroll({ durationMs = 500, speed = null } = {}) {
    if (!this.listView) return;
    this.rewindBoost = 1;
    if (this.rewinding) {
      this.rewinding = false;
      this.rewindProgress = 0;
      this.isDrawing = true;
      this.setHudRewind(false);
    }
    if (this.auto.active) return;               // 冷启动没跑完不甩尾
    this.flick.start({
      durationMs,
      speed: speed ?? Math.min(1500, 600 + this.scrollAccum),
      edgeSide: this.clickSide,
    });
  }

  /* ── HUD ── */
  setHudPoints(n) {
    if (this.hud?.hudPoints) this.hud.hudPoints.textContent = String(n).padStart(6, '0');
  }

  setHudRewind(on) {
    if (this.hud?.hudRewindLabel) this.hud.hudRewindLabel.textContent = on ? 'Rewinding...' : 'Rewind';
  }

  /* ── 阴影相机动态收紧（spec §1）：每 0.25s 用 4 个视口角求交地面 → 光空间包围盒 ±8 */
  tightenShadow(elapsed) {
    const every = this.cfg.light.shadowTightenInterval ?? 0.25;
    if (elapsed - (this._lastTighten ?? -1) < every) return;
    this._lastTighten = elapsed;
    const sc = this.sun.shadow.camera;
    this.sun.updateMatrixWorld();
    sc.updateMatrixWorld(true);
    const lightSpace = new THREE.Matrix4().copy(sc.matrixWorld).invert();
    const ig = this.cfg.infiniteGround;
    const limit = ig?.enabled ? (ig.raycastLimit ?? 10000) : this.cfg.ground.size;
    const clamp = this.cfg.light.shadowGroundClamp ?? 200;
    const gc = this.ground.position;
    const hits = [];
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = rayToGround(this.camera, { x, y }, limit);   // 解析求交，等价 BVH raycast
      if (p) hits.push(new THREE.Vector3(
        Math.max(gc.x - clamp, Math.min(gc.x + clamp, p.x)), p.y,
        Math.max(gc.z - clamp, Math.min(gc.z + clamp, p.z)),
      ));
    }
    if (hits.length < 3) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of hits) {
      const q = p.clone().applyMatrix4(lightSpace);
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    const pad = this.cfg.light.shadowTightenPadding ?? 8;
    sc.left = minX - pad; sc.right = maxX + pad;
    sc.bottom = minY - pad; sc.top = maxY + pad;
    sc.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  /* ── 无限地面（A 方案）：mesh 跟随相机按格吸附，贴图 offset 反向补偿 → 网格钉在世界坐标上 ── */
  updateInfiniteGround() {
    const ig = this.cfg.infiniteGround;
    if (!ig?.enabled) return;
    const g = this.cfg.ground;
    const rep = g.texRepeat || 28;
    const tile = g.size / rep;
    /* 远看（滚轮缩小）时地面 quad 等比放大、repeat 同步补偿 → 世界格距不变，画面四角不露出 quad 边界 */
    const s = this.cfg.wheelZoom?.enabled ? Math.max(1, this.zoomCurrent) : 1;
    this.ground.scale.set(s, s, 1);
    this.groundTex.repeat.set(rep * s, rep * s);
    this.ground.position.x = Math.round(this.camera.position.x / tile) * tile;
    this.ground.position.z = Math.round(this.camera.position.z / tile) * tile;
    const f = rep / g.size;   // 每世界单位占多少贴图 repeat（缩放补偿后不变）
    this.groundTex.offset.set(this.ground.position.x * f % 1, this.ground.position.z * f % 1);
    /* 平行光 + 阴影相机整体跟随地面中心（方向不变），否则远处阴影 far 平面截断 */
    const lp = this.cfg.light.directional.position;
    this.sun.position.set(this.ground.position.x + lp[0], lp[1], this.ground.position.z + lp[2]);
    this.sun.target.position.set(this.ground.position.x, 0, this.ground.position.z);
    this.sun.target.updateMatrixWorld();
  }

  /** 路径末端离原点超过阈值 → 把整幅画（点/历史/重采样/已 commit 条/端点缓存）平移回原点附近 */
  maybeRecenter() {
    const T = this.cfg.infiniteGround?.recenterThreshold;
    if (!T || !this.points.length) return;
    const p = this.points[this.points.length - 1];
    const dx = Math.abs(p.x) > T ? p.x - Math.sign(p.x) * T * 0.25 : 0;
    const dz = Math.abs(p.z) > T ? p.z - Math.sign(p.z) * T * 0.25 : 0;
    if (!dx && !dz) return;
    const d = new THREE.Vector3(dx, 0, dz);
    for (const arr of [this.points, this.history, this.resampled]) for (const v of arr) v.sub(d);
    if (this.lastPoint) this.lastPoint.sub(d);
    if (this.liftLast) this.liftLast.sub(d);
    if (this.autoWrite) for (const poly of this.autoWrite.polys) for (const v of poly) v.sub(d);
    this.endPos.sub(d);
    this.endPosCache.sub(d);
    for (const m of this.finalized) m.position.sub(d);
    this.camera.position.sub(d);          // 相机同步平移 → 重定心对用户不可见
    this.camera.updateMatrixWorld();
    this.controls.target.sub(d);
    this.viewAnchor.sub(d);               // 默认机位模式下相机位=固定位+anchor，必须一起平移
  }

  /** 镜头跟带：带尾接近/超出屏幕安全区 → 机位沿地面平滑平移跟随；胶带清空 → 回原位 */
  updateCameraFollow() {
    const cf = this.cfg.cameraFollow;
    if (!cf?.enabled || this.immersiveActive || this.listView || this.orbitEnabled || this.cameraAnimating) return;
    const a = this.viewAnchor;
    const e = this.endPos;
    let moved = 0;
    if ((this.points.length || !this.inkOn) && e.x > -900) {
      const p = e.clone().project(this.camera);
      let d = null;
      if (p.z >= 1 || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        const g0 = rayToGround(this.camera, { x: 0, y: 0 }, cf.raycastLimit ?? 10000);
        if (g0) d = new THREE.Vector3(e.x - g0.x, 0, e.z - g0.z);        // 带尾跑到相机外 → 拉回屏幕中心
      } else if (Math.abs(p.x) > cf.edgeNdc || Math.abs(p.y) > cf.edgeNdc) {
        const cx = Math.max(-cf.edgeNdc, Math.min(cf.edgeNdc, p.x));
        const cy = Math.max(-cf.edgeNdc, Math.min(cf.edgeNdc, p.y));
        const g2 = rayToGround(this.camera, { x: cx, y: cy }, cf.raycastLimit ?? 10000);
        if (g2) d = new THREE.Vector3(e.x - g2.x, 0, e.z - g2.z);        // 机位平移量 = 带尾 − 安全区落点
      }
      if (d) { a.addScaledVector(d, cf.lerp); moved = d.length() * cf.lerp; }
    } else if (a.lengthSq() > 1e-4) {
      a.multiplyScalar(1 - cf.returnLerp);
      moved = 1;
    }
    if (moved > 0.02) this.invalidate();
  }

  /* ── 渲染 ── */
  render() {
    if (this.glitchActive) { this.glitch.render(); return; }
    this.updateInfiniteGround();
    this.tightenShadow(this.clockElapsed());
    this.updateRoll();
    this.updateCameraFollow();
    // 非列表模式且 OrbitControls 关闭 → 每次 render 强制回到固定机位（spec §5）；沉浸模式自管相机
    if (!this.immersiveActive && !this.listView && !this.orbitEnabled && !this.cameraAnimating) {
      if (this.stepZoom()) this.invalidate();            // 缩放缓动未完 → 续帧
      this.applyDefaultCamera();
    }
    if (this.orbitEnabled && !this.cameraAnimating) this.controls.update();
    if (this.glitch.isActive) this.glitch.stop();
    this.renderer.render(this.scene, this.camera);
  }

  clockElapsed() {
    if (!this._t0) this._t0 = performance.now();
    return (performance.now() - this._t0) / 1000;
  }

  start() {
    this.pokeRender();
    this.invalidate();
    return this;
  }

  dispose() {
    this.disposed = true;
    this.auto.stop();
    this.flick.stop();
    this.immersiveCtl?.stop();
    if (this.scheduled) cancelAnimationFrame(this.scheduled);
    if (this.keepAliveRaf) cancelAnimationFrame(this.keepAliveRaf);
    window.removeEventListener('pointerdown', this._onUserTakeover);
    window.removeEventListener('wheel', this._onUserTakeover);
    window.removeEventListener('mousedown', this._onMiddleDown);
    window.removeEventListener('auxclick', this._onAuxClick);
    window.removeEventListener('wheel', this._onWheelZoom);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('touchstart', this._onTouchMove);
    window.removeEventListener('touchmove', this._onTouchMove);
    window.removeEventListener('touchend', this._onLeave);
    window.removeEventListener('mouseleave', this._onLeave);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKey);
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'focus']) {
      window.removeEventListener(ev, this._onInteract);
    }
    document.removeEventListener('visibilitychange', this._onVisibility);
    document.removeEventListener('fullscreenchange', this._onFsChange);
    clearTimeout(this.hoverDebounce);
    this.controls.dispose();
    this.glitch.dispose();
    this.textureCache.forEach((t) => t.dispose());
    this.textureCache.clear();
    this.scene?.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      }
    });
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}

/** 页面入口：读 window.TAPE_CONFIG，装配 DOM，启动引擎 */
export async function boot(config = window.TAPE_CONFIG) {
  const dom = {
    stage: document.getElementById('stage'),
    hudPoints: document.getElementById('hud-points'),
    hudFps: document.getElementById('hud-fps'),
    hudOrbit: document.getElementById('hud-orbit'),
    hudRewindLabel: document.getElementById('hud-rewind-label'),
    listPanel: document.getElementById('list-panel'),
    footnote: document.getElementById('footnote'),
    scroller: document.getElementById('project-rows'),
  };
  const engine = new TapeEngine(config, dom);
  await engine.init();
  paintDom(config, engine, dom);
  initSettingsUI(engine);
  engine.start();
  return engine;
}

/** 把 config 里的文案 / 项目列表渲染成 DOM；hover 行 → 200ms debounce → 换贴纸重画 */
function paintDom(config, engine, dom) {
  const b = config.brand || {};
  const set = (id, text) => { const el = document.getElementById(id); if (el && text != null) el.textContent = text; };
  const bm = document.getElementById('brandmark');
  if (bm && (b.logo || b.wordmark)) {          // 图片署名（logo + 书法字），缺图回退拼音文字
    bm.textContent = '';
    if (b.logo) { const i = document.createElement('img'); i.className = 'bm-logo'; i.src = b.logo; i.alt = ''; if (b.logoH) i.style.height = b.logoH + 'px'; bm.appendChild(i); }
    if (b.wordmark) { const i = document.createElement('img'); i.className = 'bm-word'; i.src = b.wordmark; i.alt = b.mark || ''; if (b.wordH) i.style.height = b.wordH + 'px'; bm.appendChild(i); }
    window.brandSize = (logoH, wordH) => {     // 控制台即时预览：brandSize(120, 100)，满意后写回 config.brand
      const l = bm.querySelector('.bm-logo'), w = bm.querySelector('.bm-word');
      if (l && logoH) l.style.height = logoH + 'px';
      if (w && wordH) w.style.height = wordH + 'px';
    };
  } else if (bm) bm.textContent = b.mark || '';
  const lines = Array.isArray(b.splashLines) && b.splashLines.length ? b.splashLines : (b.splash ? [b.splash] : []);
  if (lines.length) {
    let pick;
    if (b.splashMode === 'random') {
      pick = lines[Math.floor(Math.random() * lines.length)];
    } else {
      let i = 0;
      try { i = Number(localStorage.getItem('splash-line-idx')) || 0; } catch { /* 隐私模式忽略 */ }
      i = ((i % lines.length) + lines.length) % lines.length;
      pick = lines[i];
      try { localStorage.setItem('splash-line-idx', String((i + 1) % lines.length)); } catch { /* 同上 */ }
    }
    set('splash-title', pick);
  }
  set('brand-description', b.description);
  set('footer-left', b.footerLeft);
  set('footer-right', b.footerRight);
  if (dom.footnote && b.footnote) dom.footnote.textContent = b.footnote;

  const list = dom.scroller;
  if (list) {
    list.innerHTML = '';
    config.projects.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'project-row';
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1).padStart(2, '0');
      const ttl = document.createElement('span');
      ttl.className = 'ttl';
      ttl.textContent = p.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = [p.tag, p.year].filter(Boolean).join(' · ');
      row.append(idx, ttl, meta);
      row.addEventListener('mouseenter', () => {
        list.querySelectorAll('.project-row').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
        if (!engine.listView || !engine.listAnimationsComplete) return;
        clearTimeout(engine.hoverDebounce);
        engine.hoverDebounce = setTimeout(() => {
          const rep = config.listView.textureRepeat;
          engine.redrawWithSticker(i, rep.u ?? 1, engine.listRepeatVForSide());
        }, config.listView.hoverDebounceMs ?? 200);
      });
      list.appendChild(row);
    });

    list.addEventListener('scroll', () => {
      if (!engine.listView || !engine.listAnimationsComplete) return;
      const d = Math.abs(list.scrollTop - engine._lastScroll);
      engine._lastScroll = list.scrollTop;
      engine.scrollAccum += d;
      if (engine.scrollAccum >= (config.listView.scrollFlickThreshold ?? 800)) {
        engine.scrollAccum = 0;
        window.onProjectsScroll?.({ durationMs: 500 });   // 甩尾新路径
      }
    }, { passive: true });
  }
  set('project-count', String(config.projects.length).padStart(2, '0'));

  const fsBtn = document.getElementById('fullscreen-btn');
  if (fsBtn) {
    if (config.fullscreen?.enabled === false) fsBtn.style.display = 'none';
    else fsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      engine.enterFullscreen();     // 退出只走 ESC（浏览器原生）
    });
  }

  if (config.listView?.enabled === false) {
    const bar = document.getElementById('bar-menu');
    if (bar) bar.style.display = 'none';   // 项目列表不展示
  }

  document.getElementById('list-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    engine.glitchThenReset();
    setTimeout(() => engine.exitListView(), 60);
  });

  document.getElementById('footer')?.addEventListener('click', (e) => {
    if (document.body.classList.contains('listMenu-open-left') || document.body.classList.contains('listMenu-open-right')) return;
    const w = window.innerWidth;
    const small = w < (config.listView.smallScreenBreakpoint ?? 650);
    const side = small ? 'right' : (e.clientX > w * 0.5 ? 'right' : 'left');   // <650px 恒 right
    window.currentClickSide = side;
    engine.enterListView(side);
  });
}
