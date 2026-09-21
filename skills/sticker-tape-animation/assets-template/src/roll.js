/* roll.js —— 胶带卷。config.rollModel 为空时用这里的程序几何替代受版权的 .glb。
 * 层级严格对齐 spec §4：root(位置) > yaw(rotation.y) > spin(rotation.x) > model */

import * as THREE from '../vendor/three.module.js';

const PHYS = {
  roughness: 0.35,
  metalness: 0.05,
  clearcoat: 0.35,
  clearcoatRoughness: 0.5,
  sheen: 0.3,
  sheenRoughness: 0.6,
};

/** 程序卷：外圈圆柱 + 内孔 + 上下侧环 + 端面环 */
export function createProceduralRollModel(tex, opts = {}) {
  // 预制单位：之后还会乘 buildRollHierarchy 的 scale(默认 4.2)，量级对齐参考站的 .glb
  const cfg = Object.assign({ outerRadius: 1.14, coreRadius: 0.45, height: 0.95, rimTorus: 0.025 }, opts);
  const { outerRadius: R, coreRadius: r, height: H, rimTorus: tube } = cfg;
  const model = new THREE.Group();
  model.name = 'tapeRoll';

  const bodyMat = new THREE.MeshPhysicalMaterial(Object.assign({
    map: tex || null,
    color: tex ? 0xffffff : 0xb9bcbe,
    side: THREE.DoubleSide,
  }, PHYS));

  // 外圈（带身贴合处）
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 96, 1, true), bodyMat);
  outer.name = 'rollOuter';
  model.add(outer);

  // 内孔（卷芯，暗一点）
  const coreMat = new THREE.MeshPhysicalMaterial(Object.assign({
    color: 0x8d8f92, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
  }));
  const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H * 1.02, 64, 1, true), coreMat);
  core.name = 'rollCore';
  model.add(core);

  // 端面环：从卷芯到外圈的环形截面，用同一张带身贴图（读出“一圈圈缠上去”的感觉）
  const faceGeo = new THREE.RingGeometry(r, R, 96, 1);
  for (const sign of [1, -1]) {
    const face = new THREE.Mesh(faceGeo, bodyMat);
    face.rotation.x = -Math.PI / 2 * sign;
    face.position.y = (H / 2) * sign;
    face.name = 'rollFace';
    model.add(face);
    // 侧环（边缘倒角感）
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R - tube, tube, 10, 96), bodyMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = (H / 2 - tube) * sign;
    rim.name = 'rollRim';
    model.add(rim);
  }

  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return model;
}

/** 把任意 model 包成 spec §4 的三层 transform 结构 */
export function buildRollHierarchy(model, scale = 4.2) {
  const root = new THREE.Group();
  root.name = 'rollRoot';
  const yaw = new THREE.Group();
  yaw.name = 'rollYaw';
  const spin = new THREE.Group();
  spin.name = 'rollSpin';
  model.scale.setScalar(scale);
  spin.add(model);
  yaw.add(spin);
  root.add(yaw);
  return { root, yaw, spin };
}

/**
 * 加载 GLB 卷（可选路径）。GLTFLoader 只在真的配了 rollModel 时才 dynamic import，
 * 默认程序卷不需要它，加载失败也直接回落到程序卷。
 */
export async function loadRollModel(url, { scale = 4.2, fallback } = {}) {
  try {
    const THREE_URL = '../vendor/three.module.js';
    const [{ GLTFLoader }, THREE_SELF] = await Promise.all([
      import('../vendor/GLTFLoader.js'),
      import(THREE_URL),
    ]);
    void THREE_SELF;
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().load(url, resolve, undefined, reject);
    });
    const model = gltf.scene || gltf.scenes[0];
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return buildRollHierarchy(model, scale);
  } catch (err) {
    console.warn('[roll] GLB 加载失败，回落程序卷：', err?.message || err);
    return fallback ? fallback() : null;
  }
}

/** 统一入口：config.rollModel ? GLB : 程序生成 */
export async function createRoll(config, tapeTexture) {
  const mk = () => buildRollHierarchy(
    createProceduralRollModel(tapeTexture, config.roll?.procedural),
    config.roll?.scale ?? 4.2,
  );
  if (config.rollModel) {
    const loaded = await loadRollModel(config.rollModel, { scale: config.roll?.scale ?? 4.2, fallback: mk });
    if (loaded) return loaded;
  }
  return mk();
}
