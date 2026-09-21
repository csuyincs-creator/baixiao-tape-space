# Tape Drawing — 素材驱动的 WebGL 贴胶带画图 demo

纯静态文件（vanilla three.js，无 React、无打包器）。鼠标移动即「拉出胶带」，无限画布随处可画、镜头跟带、中键提笔断点、滚轮缩放漫游、`Z` 键自动写字、`Space` 倒带、`Tab` 轨道相机、点底部横条进入项目列表并自动铺带、`I` 沉浸模式、`S` 显隐文字、左缘按钮全屏。
机制对齐一份逆向研究规格（`references/effect-spec.md`），**不含原站任何二进制素材**：默认纹理与胶带卷全部程序生成。

## 跑起来

```bash
npx serve .        # 或 node ../scripts/serve.mjs . 8899
# 打开 http://localhost:8899
```

必须走 HTTP：`file://` 下 ES module 与纹理都会被 CORS 拦住（页面会给出提示）。

## 操作

| 操作 | 效果 |
| --- | --- |
| 移动鼠标 / 触屏拖动 | 胶带从卷轴里被拉出，贴在地面上；同一处反复来回会自动叠层（每层 +0.004）；地面无限延伸，带尾出屏镜头跟着走 |
| 中键 | 提笔：当前段钉为独立胶带，此后拖卷留白；再按落笔续画（`tapeBreak`） |
| 滚轮 | 以屏幕中心为焦点缩放（`wheelZoom`），缩出去漫游整幅画 |
| `Z`（`autoWrite.texts` 可配多键多词） | 自动写字：沿词轮廓逐笔铺带（中文双钩 / 拉丁比例排版），书写中再按任意写字键 = 立即写完 |
| `↑` / `↓` | 写字速度 ±0.25 实时加减（0.05 ~ 10） |
| `Space`（第一次） | 沿曲线重采样的点列倒带（收带），镜头自动回位 |
| `Space`（倒带中） | 立刻停住，保留当前已收回的路径继续画 |
| `Space`（无历史时） | 把当前路径 commit 成一条独立 mesh（`draw.finalizedMax`，null = 不设上限） |
| `Tab` | 开关 OrbitControls（右上角 HUD 的 `Orbit` 跟着变） |
| 点底部横条（左/右半屏） | 进入列表模式：相机 1s 补间 → glitch → 清画布 → 从屏外 30 步自动铺一条带 |
| 列表内悬浮某行 | 200ms 去抖后换成该项目的贴纸纹理并重铺同一条路径 |
| 列表内累计滚动 ≥800px | 触发一次「甩尾」：胶带朝垂直于上一段的方向随机穿屏，追加一条新路径 |
| 右上角 `×` | glitch → 回默认机位、清画布 |
| `S` | 显隐全部文字层（左上角个人 IP 署名常驻）；页面默认 `body.ui-hidden` 即干净画面 |
| `I` | 沉浸模式：自动铺带→停顿→倒带循环 + 定期相机漂移；任何按键/按下/滚轮立即退出还权 |
| 左缘 □ 按钮 | 浏览器全屏 + 隐藏全部文字层，`ESC` 退出 |
| 左缘 ⚙ 按钮 | 设置面板：写字速度 / 文字大小 / logo 高 / 署名高，localStorage 持久化，「RESET TO CONFIG」回退 |

## 换成你自己的素材

1. 把透明底 PNG 丢进 `demo/stickers/`（文件名随意，例如 `stamp.png`）。
2. 在 `config.js` 的 `projects[]` 里登记：

```js
{ title: 'My Stamp', tag: 'sticker', year: '2026', image: './stickers/stamp.png' },
```

3. 完事。悬浮该行即换纹理；不写 `image` 时该项目自动用程序生成的纹理（hazard/dots/stripe/foil…），所以 `stickers: []` 也能跑。

透明底贴纸注意事项：`tapeAlphaTest` 用 `0.5`（镂空处按 alpha 裁掉）。原版素材是纯不透明位图，因此它写的是 `1`（见 `config.tapeAlphaTestOpaqueTape` 的注释）——直接沿用 `1` 会把透明 PNG 整条裁掉，胶带会「消失」。贴带上 UV 是 `v = 弧长 / uvLength`（`uvLength = 95`），想让图案每 N 世界单位重复一次，把 `uvLength` 调成 N 即可。

想换胶带底纹 / 地面纹理 / 胶带卷模型：`tapeTexture`、`groundTexture`、`rollModel` 三个字段填 URL 就行（`rollModel` 走 GLTFLoader，加载失败会自动回落程序卷，见 `src/roll.js`）。其余全部旋钮（带宽、UV 长度、曲线密度、堆叠参数、相机常量、列表模式常量、无限画布/跟带/缩放/提笔/自动写字/沉浸/背景、性能分级、文案、配色）都在 `config.js`。

### 左上角个人 IP 署名区

`config.js` 的 `brand` 块：`logo`（如 `'brand/logo.png'`，透明底）+ `wordmark`（书法署名图，横排接在 logo 右）+ `logoH`/`wordH` 显示高度；两者都缺省时回退 `mark` 文字（瘦金风英文书法体 Tangerine，`fonts/` 本地自托管，OFL 授权）。把图放进 `assets-template/brand/` 即可，favicon 在 `index.html` 头部取消注释并指到你的 logo。

## 文件结构

```
assets-template/
  index.html          HUD + splash + 常驻署名 + 底部 DESIGN|bar|CODE + 列表面板 + 全屏/设置按钮 + 脚注
  style.css           版式语言（白底、黑色粗体无衬线、等宽 HUD、署名区、设置面板）
  config.js           window.TAPE_CONFIG —— 所有可调参数
  fonts/              Tangerine 400/700 woff2（OFL，署名文字回退用）
  src/tape-engine.js  引擎：A 段纯函数几何（可 Node 直测） + B 段 THREE 场景/状态机
  src/auto-draw.js    列表模式冷启动 30 步自动铺带 + 甩尾路径求解
  src/text-writer.js  自动写字：词 → 轮廓提取（marching squares + RDP）→ 世界坐标笔画
  src/immersive.js    沉浸模式（Attract Mode）编排
  src/settings-ui.js  左缘设置面板（滑杆 + localStorage）
  src/glitch.js       后处理通路（RenderTarget + 全屏 quad）
  src/roll.js         胶带卷：程序几何 + GLB 可选路径 + spec §4 的三层 transform
  src/procgen.js      程序纹理：布纹胶带底、地面网格、4 种贴纸
  vendor/             three 0.160.1 离线副本（见下）
  stickers/           你自己的 PNG（默认为空）
  tools/smoke-geometry.mjs  Node 冒烟测试（26 项，纯几何 + 投影，不需要浏览器）
```

`vendor/` 怎么来的：`npm i three@0.160.1` 之后取
`build/three.module.js`、`examples/jsm/controls/OrbitControls.js`、`examples/jsm/loaders/GLTFLoader.js`（它依赖 `examples/jsm/utils/BufferGeometryUtils.js`，一并拷）放进 `vendor/`，并把 `examples/jsm` 里的 `from 'three'` 改成 `from './three.module.js'` 之类的相对路径。之后 demo 完全离线，不需要 `node_modules`。GLTFLoader 只在真的配了 `rollModel` 时才 `import()`。

## 自测

```bash
node --check config.js src/*.js tools/*.mjs
node tools/smoke-geometry.mjs      # 26 passed, 0 failed
```

冒烟测试覆盖：两点 → 4 顶点 / 2 三角、带宽横向居中（±半宽）、顶点 y 的 `max(y+.001, .1)` 钳制、`v = 弧长/95`、条带索引连续性、`<π/2` 转角被平滑（直角保留）、`y` 在平滑中不被平均掉、堆叠抬升（含逐层累加与 24 单位剪枝窗口）、`closestPointOnSegment` 与 `THREE.Line3` 一致、曲线采样密度分档、阴影贴图尺寸公式、屏幕→世界解析求交与 `THREE.Raycaster ∩ Plane` 数值一致（并锁死「相机必须朝下」「屏幕点必须散开」两条回归）。
浏览器侧另跑过一轮 CDP 实机验收：手动绘制、倒带/commit（cap 5 生效、几何数不再增长）、Tab 轨道、列表模式全流程、悬浮换图、滚动甩尾、关闭复位、静置 2.5s 渲染调用为 0（keep-alive 到期后）——见下方「已验证」。

## 与规格/原版的有意差异

| 点 | 这里怎么做 | 为什么 |
| --- | --- | --- |
| 拾交 | 解析 ray-plane（`rayToGround`） | 原版对 400×400 单 quad 用 three-mesh-bvh；解析解数值等价、少一个依赖。仍保留有限尺寸语义（出界返回 `null`），所以屏外采样点照旧被丢弃 |
| `alphaTest` | `0.5`（并保留 `tapeAlphaTestOpaqueTape: 1` 作参照） | 要让透明底 PNG 直接可用 |
| 重采样的点列 | 自动铺带期间也一直写入 `resampled` | 原版只在手动绘制时写，导致列表模式下 `Space` 倒带没有数据可倒 |
| 倒带收尾 | 只 dispose commit 几何并清状态，地面/卷轴保留 | 原版 `finishRewind` 会遍历 dispose，会把常驻物体一起干掉 |
| 设备分级的阴影尺寸 | 按源码公式 `clamp(pow2(400*(veryLow?4:low?6:8)),1024,8192)`，实测得到 2048/2048/4096 | 规格文字里写的 1024/4096/8192 与该公式不符，这里跟公式（也就是跟原站行为） |
| 鼠标事件 | 监听 `mousemove`/`touchmove`（`pointermove` 只用于唤醒渲染） | 与规格一致；如果你的设备只发 pointer 事件，把 `src/tape-engine.js` 的 `bindEvents` 里补一行即可 |
| 冷启动自动铺带 | 绕过堆叠抬升、用手动档曲线参数 | 对齐源码：那 30 步 push 的是 raycast 原值，重建走默认参数（tension .5、密度 14/45） |

## 许可与素材合规（发布前请再读一遍）

- 本 demo 的 JS/HTML/CSS 与 `src/procgen.js` 生成的纹理、`src/roll.js` 的程序卷：原创实现，可自由改。
- `src/glitch.js` 里的 `snoise3` 是 Ashima Arts / Ian McEwan 的 webgl-noise，MIT，署名块原样保留。glitch 的合成部分（RGB 错位、行撕扯、方块坏点、颗粒、起爆包络）是按规格自写的，未复制任何第三方站点着色器。想换风格只替换 `GLITCH_FRAGMENT_SHADER`，保持 `time / resolution / texture` 三个 uniform 即可。
- 机制参数来自对某站点的逆向研究（`docs/research/`）。那份文档本身包含对别人 bundle 的摘录，**不要**把它当作可再分发的素材随 demo 发布；也**不要**把原站的 `texture.png` / `duct_tape.glb` / `projectXX.png` 放进这个目录——它们是有版权的二进制。要上线请先换成自己的素材与文案。
- three.js 本体为 MIT（`vendor/three.module.js` 头部署名保留）。
- `config.js` 里的项目标题、HUD 文案是随便写的占位，请替换成你自己的。

## 已验证（Chrome headless + CDP，1280×800，SwiftShader）

boot 无异常、`tier{low:false,veryLow:false}`、shadowMap 4096、anisotropy 16、HUD `Points/FPS` 实时；画 51 点 → 1402 顶点 / 1400 三角、`y` 分层从 .1 起每层 +.004、9 个 draw call；`Space` 三分支（倒带中点数从 51 递减、停止后继续画、无历史时 commit，7 轮后 `finalized` 稳定在 5、`geometries` 不再增长）；`Tab` 开关 OrbitControls；列表模式：1s 补间后相机精确落在 `(-9.7,10.4,7.4)`、30 步自动铺带产出 31 点、glitch 起停正常、面板行 6 条；悬浮第 4 行 → 200ms 后换纹理并重铺（`repeat(1,9)`、`transparent:true`、`alphaTest:0.5`）；滚动累计 ≥800px → 追加甩尾路径（31→63 点，方向与上一段垂直）；关闭 → 回默认机位；keep-alive 到期后静置 2.5s 的 `renderer.render()` 调用数为 0，一次 `pointermove` 立刻恢复 burst + 重新续 30s；全程 page error = 0。

## 已知不足

- 没做原站的「鼠标按下才画」以外的第二种输入模式（规格里就是悬停即画）。
- 倒带期间的 roll 姿态沿用重采样点列反推，快速连按 `Space` 时卷体会有一次方向翻转（原版也有类似抖动）。
- 移动端只做了规格列出的分级与「进列表把 mouse 置中强制渲染」，没做竖屏排版细化。
- 截图验证用的是 SwiftShader 软渲染，真实 GPU 上阴影边缘/mipmap 观感会更好一点。
