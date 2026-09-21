# Lax Space 胶带动画机制规格书（SOURCE 级，全部逆向自真实 bundle `docs/research/page.beautified.js`）

> 版权：laxspace.co 未声明许可。原站素材（texture.png / duct_tape.glb / projectXX.png / resume.png 等）仅限本地学习参照，**禁止打包进开源交付物**。开源版必须用程序生成或用户自备素材。

## 0. 技术栈
Next.js App Router + React + @react-three/fiber（Canvas `frameloop="demand"` shadows）+ drei（OrbitControls/useGLTF/useTexture）+ three.js + three-mesh-bvh（StaticGeometryGenerator/MeshBVH/acceleratedRaycast）。
本 demo 用 **vanilla three.js** 等价实现（行为等价，无 React）。

## 1. 场景与相机（真实参数）
- PerspectiveCamera fov=60, near=0.1, far=1000
- 初始机位 `pos(-16.07, 27.44, 13.69)`，euler `(-62.18°, -27.66°, -41.34°)`（三轴全取负弧度制转换）
- 地面：400×400 单 quad，rotation.x=-π/2，`MeshStandardMaterial{ map: planeTex, color:#FFFFFF, roughness:.8, metalness:.1, envMapIntensity:1 }`，planeTex repeat(28,28), flipY=true
- 灯光：ambient intensity=1；directional pos(50,100,50) intensity=1.6 castShadow，shadow bias -0.0005 / normalBias .05，ortho camera ±208, near .1 far 516
- **阴影相机动态收紧**：每 0.25s 用 4 个视口角 raycast 地面 → 变换到光空间取包围盒 ±8 收紧 left/right/top/bottom
- 鼠标射线：屏幕→NDC→raycast 地面得 3D 点（原站对平面建 BVH；平面等价解法=解析 ray-plane 求交，行为一致需注明）

## 2. 胶带 ribbon 几何（核心，函数 eq）
对采样点列 `pts`（3D，y 由堆叠抬升决定）：
1. `eX` 转角平滑（≥3 点时）：相邻三点方向夹角 < 90° → 用 `(p[i-1]+p[i]+p[i+1])/3` 替换中点但保留原 y；否则保留
2. `new CatmullRomCurve3(smoothed)`；`curveType='centripetal'`；`tension = 手动绘制 .5 / 自动绘制 .8`
3. 采样数 `segments = max((n-1)*14, 45)`（低端机 `max((n-1)*8, 25)`；自动绘制模式 `max((n-1)*6, 16)` / 低端 `max((n-1)*3, 8)`）
4. 逐采样点 i（曲线点 a[i]，前点 a[i-1]）：`dir=(a[i]-a[i-1]).normalize()`，水平法向 `h=(-dir.z,0,dir.x)`，两侧 `±h*2`（**带宽 4 世界单位**）
5. 顶点 y 抬升：`yL=max(left.y+.001,.1)`，`yR=max(right.y+.001,.1)`
6. 首点特殊：初始两个顶点 + uv `(0,0),(1,0)`
7. UV：横向 u∈{0,1}；纵向 `v = 累计弧长 / 95`（贴图沿长度每 95 单位重复一次 → 这就是"素材重复周期"参数）
8. index：`(i-1)*2` 四边形条带 `[p,p+1,p+2, p+1,p+3,p+2]`
9. BufferGeometry，position/uv 用 DynamicDrawUsage，`computeVertexNormals()`
10. 材质：`MeshPhysicalMaterial{ map: 用户贴图, side:DoubleSide, transparent:true, alphaTest:1, roughness:.1, metalness:.1, envMapIntensity:1, dithering:true, color:white }`
11. 贴图设置：wrapS/T=RepeatWrapping, colorSpace=SRGB, flipY=false, LinearMipmapLinear/Linear, anisotropy=低端4/高端16
12. 绘制中 mesh `position.y = 列表模式 ? .1 : 0`

**堆叠抬升 eO(newP, lastP)**：点数 <4 → y=.1（首点 .05）；否则对既有相邻点对（`dist(e,i)+dist(e,o) > 24` 剪枝）：若 newP-lastP 线段中点距该旧段中点 < 6 → `r = max(r, max(i.y,o.y)+.004)`，基线 .1。→ 胶带经过已画段上方时叠加一层。

## 3. 绘制输入
- window mousemove/touchmove（React 侧 16ms 节流）存 globalMousePosition；渲染循环内每帧 raycast 得点，位移阈值 `>0.001`（屏幕像素距离和 3D 距离都要 >.001）才 push 新点；每点重建 geometry（eq(pts, saveOriginal=true) 存 resampled 曲线点 `originalFinalPoints`）
- 方向平滑：`ed.lerp(newDir, clamp(.15 + speed/16.67*.1, .05, .4))` 用于胶带卷 yaw
- 首点 y=.05
- 每帧结束 invalidate()（demand 渲染）

## 4. 胶带卷（duct_tape.glb → 开源必须程序化替代）
- group 层级：`pos(end.x, end.y+8, end.z)` → yaw `rotation.y = atan2(dir.x, dir.z) + π` → spin `rotation.x` 累计 `-= 0.1 * 距离增量`（放卷感）
- 模型 scale 4.2，castShadow/receiveShadow
- **开源替代**：程序卷 = CylinderGeometry(外圈) + 内孔 + 边缘 torus 均可；保持同一 transform 层级

## 5. 交互状态机
- **Space**：未在倒带且有点 → 倒带播放：`rewindProgress += .005/frame`，从 `originalFinalPoints` 前 o=floor((1-p)*n) 个点用 `eY`（同 eq 但从 resampled 点重建，不平滑）实时重建 geometry；卷跟随 o 点位置/方向；p≥1 → 全部 dispose、从场景移除除地面外 mesh、renderer.state.reset()、清空、B=true 可再画。已在倒带中按 Space → 停止倒带。绘制中按 Space（无历史）→ 把当前路径 commit 到 `finalizedPaths`（用 eH=road 材质 clone；上限 5，超出移最早并 dispose），清路重点开始。
- **Tab**：toggle OrbitControls（enablePan/Rotate/Zoom 仅开启时；minPolar 0 maxPolar .46π minDist 5 maxDist 200；onChange 里 target.y<0 → 钳 0）
- 非列表模式下 OrbitControls 关闭时每次 render 强制回到固定机位（原始行为：`useEffect [u]`）

## 6. 列表模式（View Works 流程）
1. 点击 footer 任意处 → 按 clickX 与半屏判定 left/right（<650px 恒 right）→ `body.classList.add('listMenu-open-left/right','open')`
2. 相机补间 1s easeInOutCubic：pos→(-9.7,10.4,7.4)，rotation→(-59.6°,-18.7°,-28.6°)
3. 到位后跑 glitch 后处理 1s（见 §8），结束后清空画布 → `redrawPathWithTexture('/project01.png',1,9.7)`
4. **自动绘制**（eM 内 o()）：30 步、20ms/步，屏幕坐标从屏外 `right:(-60%,800%)→(49%,-49%)`、`left:(100%,1000%)→(-40%,-49%)` 线性推进 → raycast 入 3D，同 §3 push+重建（用 eJ 屏幕%换算）。完成触发 `window.setListAnimationsComplete()`（CSS 动画放行）
5. hover 项目（列表动画完成后）debounce 200ms → `redrawPathWithTexture(texture, 1, left?9:7.8)` → **换带身贴图重画一条新胶带**（repeat.x 宽度参数！项目纹理 repeat.x=1、repeat.y=9/7.8/9.7 → 带宽 4 单位上贴 1 张、长度上 9.7 张）
   - 注意 eM 中 `repeat.set(n, r)` n=1 r=y 参数——即 u 方向 1 张、v 方向 r 张；默认胶带 `/texture.png` 用 (1,1)+UV 弧长/95
6. 列表滚动 ≥800px → `window.onProjectsScroll({durationMs:500})` → `eR()`：从当前尾点向随机方向甩出一条新路径：中心 l/h 采样 `h(k)=Math.random()**1.8*(±1)` 随机终点（保证穿出屏幕边缘）、`d=480..1600*(.8+.8rand)` 外扩、bottom 边缘额外 y+max(1.25~2h*H, 1.8~2.4d,1500)；时长 `clamp(200,1400, pathLen/(60*speed)*1000)` 帧数/16；逐帧线性插值 raycast push（方向自动与上一段垂直：horizontal→vertical）
7. 退出（CloseBtn）→ `glitchThenReset()`：glitch 1s → 清画布 → 重进列表首项目；再 `exitListViewMode` 移除 class、回默认机位
8. 纹理缓存 Map（按 url，clone 复用），换纹理时 dispose 旧 material/texture

## 7. 性能系统（原样移植）
- frameloop demand 等价：脏标记渲染；交互（pointerdown/move/wheel/keydown/focus/visibility）→ 连续渲染 8 帧 + 之后 30s keep-alive rAF（33ms 节流 invalidate）
- 设备分级（教程原文代码 + bundle 一致）：mobile UA / deviceMemory<4 / cores<4 / 集显 regex / WEBGL_debug_renderer_info 低端 regex → lowRes；<2/<2/verylow regex → veryLow（同时 low）
  - 影响：shadowmap `clamp(pow2(400*(veryLow?4:low?6:8)),1024,8192)`（=1024/4096/8192）、anisotropy 4/16、curve 采样密度、移动端进列表后强制 mouse 置中触发渲染
- Points/FPS HUD：FPS 独立 rAF 计数每秒更新（cap 165 显示）；Points = 当前路径点数

## 8. Glitch 后处理（class S，源码逐字捕获 = SOURCE）
- WebGLRenderTarget(内宽高, Nearest, RGBA/UnsignedByte)；OrthographicCamera(-1,1,1,-1,0,1) + PlaneGeometry(2,2) + RawShaderMaterial
- uniform：time / resolution / texture(renderTarget)
- 流程：captureAndStart() → 1000ms 内：scene→RT，RT+shader→screen，time=秒；结束 resolve Promise；resize 同步
- fragment shader 全文在 `page.beautified.js` L680（snoise3 + shake + rgbWave + blockNoise×2 + whiteNoise + waveNoise），**逐字复制，禁止重写**

## 9. DOM/CSS 层
- splash `.masking "LAX SPACE."`；`.home-container`、h1.discriptions、footer(DESIGN|View Works|CODE)、`.counter` 四块 HUD、`.listMenu`（projects-index 滚动数字、81 gridBox 关闭钮、项目行 active/dev/viewed）、`.sandbox`（webm）、`.cursor-image`（resume.png, translate(-50%,-50%) rotate(-14deg), show/hide 事件）
- 复刻 CSS 以 `assets/original/_next/static/css/d71b457fc5a42508.css`（SOURCE）为准

## 10. 素材驱动接口（开源 skill 的形态）
```
config.js: {
  stickers: ['stickers/a.png', ...],   // 每个 = 一条带身贴图（项目纹理角色）
  tapeTexture: 'stickers/tape.png',    // 默认胶带（可缺省 → 程序生成斜纹布胶带）
  rollModel: 'models/roll.glb' | null, // 缺省 → 程序生成胶带卷
  groundTexture: null | 'textures/ground.png', // 缺省 → 程序网格
  tapeWidth: 4, uvLength: 95, camera: {...§1}, autoDrawSpeedSteps: 30, ...
}
```
程序生成兜底全部走 canvas 2D 纹理（透明背景贴纸 PNG 直接可用：alphaTest 调整、transparent）。
