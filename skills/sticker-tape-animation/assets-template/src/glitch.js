/* glitch.js —— spec §8 后处理通路（RT + RawShaderMaterial + 全屏 quad + 1s）。
 *
 * 素材来源与授权（公开发布前请再确认一次）：
 *   · snoise3 = Ashima Arts / Ian McEwan 的 webgl-noise simplex 3D，MIT 许可，
 *     原始署名块按惯例完整保留在下方。
 *   · 顶点着色器与 main() 的 glitch 合成（RGB 错位 / 行撕扯 / 方块坏点 / 颗粒）
 *     为本项目自行实现，机制对齐 spec §8，未复制任何第三方站点的着色器源码。
 *   · 想换风格只需要替换 GLITCH_FRAGMENT_SHADER，uniform 约定保持
 *     time / resolution / texture 三项即可。 */

import * as THREE from '../vendor/three.module.js';

export const GLITCH_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

export const GLITCH_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float time;
uniform vec2 resolution;
uniform sampler2D texture;

varying vec2 vUv;

//
// Description : Array and textureless GLSL 2D/3D/4D simplex
//               noise functions.
//      Author : Ian McEwan, Ashima Arts.
//  Maintainer : ijm
//     Lastmod : 20110822 (ijm)
//     License : Copyright (C) 2011 Ashima Arts. All rights reserved.
//               Distributed under the MIT License. See LICENSE file.
//               https://github.com/ashima/webgl-noise
//

vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
     return mod289(((x*34.0)+1.0)*x);
}

vec4 taylorInvSqrt(vec4 r)
{
  return 1.79284291400159 - 0.85373472095314 * r;
}

float snoise3(vec3 v)
  {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

// First corner
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 =   v - i + dot(i, C.xxx) ;

// Other corners
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

// Permutations
  i = mod289(i);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

// Gradients: 7x7 points over a square, mapped onto an octahedron.
  float n_ = 0.142857142857; // 1.0/7.0
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

//Normalise gradients
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

// Mix final noise value
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                dot(p2,x2), dot(p3,x3) ) );
  }

// ── 以下为本项目自行实现的 glitch 合成 ─────────────────────────────

float hash11(float x) {
  return fract(sin(x * 12.9898) * 43758.5453123);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

/** 整屏周期：后段起爆，前段只留一点底噪 */
const float CYCLE = 3.0;

void main() {
  vec2 px = vUv * resolution;
  float env = smoothstep(CYCLE * 0.45, CYCLE, mod(time, CYCLE));

  // 整屏位移：量化到 20Hz，避免每个像素各自漂移
  float tick = floor(time * 20.0);
  vec2 shake = (vec2(hash21(vec2(tick, 3.7)), hash21(vec2(tick, 9.1))) - 0.5)
             * (2.0 + 14.0 * env) / resolution;

  // 横向错切：低频行波 + 偶发窄亮带撕开
  float wave = (snoise3(vec3(0.0, px.y * 0.02, time * 0.9)) ) * (3.0 + 34.0 * env);
  float tear = step(0.994, hash11(floor(px.y * 0.5) + tick * 0.137)) * 20.0 * env;
  float shiftX = (wave + tear) / resolution.x;

  // 通道分离量随时间呼吸
  float split = (2.0 + 16.0 * env * (0.5 + 0.5 * sin(time * 90.0 + px.y * 0.06))) / resolution.x;
  vec2 uvR = vUv + vec2(shiftX + split, 0.0) + shake;
  vec2 uvG = vUv + vec2(shiftX, 0.0) + shake;
  vec2 uvB = vUv + vec2(shiftX - split, 0.0) + shake;
  vec3 col = vec3(texture2D(texture, uvR).r, texture2D(texture, uvG).g, texture2D(texture, uvB).b);

  // 方块坏点：两路 noise 门出一个矩形，块内取更错位的副本
  float bt = floor(time * 18.0);
  float maskX = step(0.86, (snoise3(vec3(0.0, vUv.x * 3.0, bt * 0.07)) + 1.0) * 0.5);
  float maskY = step(0.60, (snoise3(vec3(0.0, vUv.y * 6.0, bt * 0.07)) + 1.0) * 0.5);
  float blockMask = maskX * maskY * (0.35 + 0.65 * env);
  vec3 block = vec3(
    texture2D(texture, uvR + vec2(0.035, 0.0)).r,
    texture2D(texture, uvG + vec2(0.018, 0.0)).g,
    texture2D(texture, uvB - vec2(0.018, 0.0)).b
  );
  col = mix(col, block, blockMask);

  // 颗粒 + 滚动扫描线压暗
  col += (hash21(px + mod(time, 100.0)) - 0.5) * (0.05 + 0.12 * env);
  col *= 1.0 - 0.05 * env * (0.5 + 0.5 * sin(px.y * 5.0 - time * 26.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

/** 把主场景渲进 RT，再用全屏 quad + glitch shader 打到屏幕；duration 后 resolve。 */
export class GlitchPass {
  constructor(renderer, scene, camera, duration = 1000) {
    this.isActive = false;
    this.startTime = 0;
    this.duration = duration;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMaterial = new THREE.RawShaderMaterial({
      uniforms: {
        time: { value: 0 },
        resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        texture: { value: this.renderTarget.texture },
      },
      vertexShader: GLITCH_VERTEX_SHADER,
      fragmentShader: GLITCH_FRAGMENT_SHADER,
    });
    this.postMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.postScene.add(this.postMesh);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderTarget.setSize(w, h);
    this.postMaterial.uniforms.resolution.value.set(w, h);
  }

  render() {
    if (!this.isActive) return;
    const elapsed = performance.now() - this.startTime;
    if (elapsed >= this.duration) { this.stop(); return; }
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.render(this.scene, this.camera);
    this.postMaterial.uniforms.time.value = elapsed * 0.001;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }

  /** Promise 语义照 spec：已在跑就直接 resolve，否则跑到 duration 后 resolve */
  captureAndStart() {
    if (this.isActive) return Promise.resolve();
    this.isActive = true;
    this.startTime = performance.now();
    this.postMaterial.uniforms.time.value = 0;
    return new Promise((resolve) => {
      const step = () => {
        if (this.isActive) { this.render(); requestAnimationFrame(step); }
        else resolve();
      };
      step();
    });
  }

  stop() {
    if (!this.isActive) return;
    this.isActive = false;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderTarget.dispose();
    this.postMaterial.dispose();
    this.postMesh.geometry.dispose();
  }
}
