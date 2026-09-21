---
name: sticker-tape-animation
description: 素材驱动的"拉胶带"贴纸动画生成器。把贴纸 PNG / 胶带纹理 / 可选 GLB 卷模型打包成可直接开源部署的 three.js 交互项目：鼠标拖拽实时拉出胶带丝带、无限画布漫游、镜头跟带、中键提笔断点、滚轮缩放、快捷键自动写字（双钩描边）、Space 倒带、Tab 轨道视角、点击底部条进入作品列表（glitch 转场 + 自动铺带、hover 换贴纸、滚动甩带）、沉浸模式、全屏+干净画面、左上角个人 IP 署名区、设置面板、移动端分层降级。USE WHEN 用户说 拉胶带、贴纸动画、胶带动画、tape animation、sticker tape、把这个动画效果用在项目上、用我的素材生成胶带动画，或提供了透明 PNG 想要做成滚动绘制特效。
argument-hint: <素材目录或贴纸PNG列表>
---

# 贴纸拉胶带动画生成器

## Overview

引擎为干净室实现（机制源自 laxspace.co 案例的 SOURCE 级规格书，见 `references/effect-spec.md`），代码 MIT 友好（vendor three r160），模板不含任何受版权保护的素材。交付物 = 用户自己的贴纸 + 已验证的绘制引擎。

## 工作流

### 1. 收集素材

必需（缺省时引擎程序生成占位，可先跑通再补）：
- 贴纸 PNG：透明底或带 alpha 的矩形图案，每个 = 作品列表里"一卷新胶带"（建议宽:高 ≈ 1 : 9.7，横向平铺无缝可选）
可选：
- 胶带带身纹理 `texture.png`（默认带子，null → 程序生成灰色 duct tape）
- 地面纹理（null → 程序网格）
- GLB 卷模型（null → 程序生成胶带卷）

### 2. 实例化项目

```bash
cp -r <skill-dir>/assets-template <project-dir>
```

### 3. 登记贴纸

把 PNG 放进 `<project-dir>/stickers/`，然后：

```bash
node <skill-dir>/scripts/register-stickers.mjs <project-dir>
```

自动改写 `config.js` 的 `stickers: [...]` 并置 `useProceduralStickers: false`。

**重要（用户常见预期）**：`stickers[]` 只作用于列表模式换贴纸；**主视图拖鼠标拉出的带身印花来自 `tapeTexture`**。原站的 texture.png 本身就是把所有项目图竖排成的长条（800×12546）。若用户想让胶带一拉出来就带图，把裁好的 800×1046 竖版 tile 拼成长条并接到 `tapeTexture`：

```bash
ffmpeg -i sticker01.png -i sticker02.png ... -filter_complex "vstack=inputs=N" textures/strip.png
```

普通图片裁成 800×1046 竖版 tile（cover 裁剪 + 偏上取景避底部水印）：
`ffmpeg -i in.jpg -vf "scale=800:1046:force_original_aspect_ratio=increase,crop=800:1046:(iw-800)/2:(ih-1046)*0.25" out.png`

### 4. 定制品牌参数

编辑 `<project-dir>/config.js`（每项含义见 `references/effect-spec.md` 对应节）：

| 参数 | 作用 | 规格书 |
|---|---|---|
| `brand.*`（logo/wordmark/logoH/wordH/mark/splash/splashLines/splashMode/description/footerLeft/footerRight/footnote） | 左上角个人 IP（logo+书法署名图，缺图回退 Tangerine 文字）与界面文案 | §6 |
| `projects[]` | 作品列表行（title/tag/year，顺序 = 列表顺序） | §6 |
| `stickers[]` | 贴纸胶带贴图（每卷对应一行） | §6/§10 |
| `tapeWidth`(默认4) `uvLength`(默认95) | 带宽 / 贴图纵向重复节奏 | §2 |
| `camera.*` | 默认机位与列表机位（euler 存"已取负"角度） | §1 |
| `listView.textureRepeat` | 列表模式带身 repeat（left 9 / right 7.8~9.7） | §6 |
| `listView.autoDraw.steps` | 冷启动自动铺带步数 | §6 |
| `rollModel` / `tapeTexture` / `groundTexture` | 可选外部素材路径（null → 程序生成） | §4/§1/§1 |
| `infiniteGround` | 无限画布：地面随相机延伸 + 路径回中精度保险；`enabled:false` 回有限地面 | — |
| `cameraFollow` | 镜头跟带：带尾出屏（edgeNdc 安全区外）贴地平滑跟随 | — |
| `wheelZoom` | 滚轮缩放（min/max 距离倍率、step 灵敏度、lerp 缓动） | — |
| `tapeBreak` | 中键提笔/落笔（当前段钉为独立胶带，断点留白） | — |
| `autoWrite` | 快捷键自动写字：`texts` 按键→词映射，width 整句世界宽、speed 每帧轮廓点（↑/↓ 实时 ±0.25）、cell−fontPx=字间空隙 | — |
| `immersive` | 沉浸模式（I 键自动铺带→停顿→倒带循环 + 相机漂移，任何操作还权） | references/immersive-mode-plan.md |
| `fullscreen` / `ui.toggleKey` | 左缘全屏按钮 / `S` 键显隐文字层（`body.ui-hidden` 默认隐藏） | — |
| `background` | 背景色 + 满屏背景图（运行时 `setBackgroundColor/setBackgroundImage/setGroundImage`） | — |

### 5. 验证（不可跳过）

```bash
cd <project-dir> && node tools/smoke-geometry.mjs   # 预期 26/26 通过
node <skill-dir>/scripts/serve.mjs <project-dir> 5173
```

浏览器真实打开 `http://localhost:5173/` 逐条交互验收（静态截图不算数）：
1. 首屏无 console 错误、canvas 出现
2. 拖拽鼠标 → 胶带连续拉出、交叉处上层抬起（堆叠）、HUD Points 增长
3. Space → 倒带回卷 → 再按 → 新路径；连续路径 ≤5 条
4. Tab → 轨道旋转可用；再按恢复
5. 点击底部条 → 相机补间 + glitch 撕裂帧 → 自动铺带 → 列表浮出；hover 行 → 换贴纸重画；列表滚动 → 胶带甩出新方向
6. 视口 <650px 时列表恒从右侧出带（原站同款断点）

无头环境截图兜底：`chrome --headless=new --window-size=1280,800 --virtual-time-budget=40000 --screenshot=<绝对路径.png> http://localhost:5173/`（`--screenshot` 必须给 Windows 绝对路径）。

### 6. 开源交付检查

- `stickers/` 与自定义纹理必须是用户有权使用的素材（模板自身零版权素材）
- 保留 `vendor/` 内 three.js MIT 头
- README 已含署名建议：机制灵感注明参考案例（Codrops / Lax Chee）

## 引擎机制排查

改 `src/tape-engine.js` 前先读 `references/effect-spec.md`（丝带几何 §2、堆叠 §3、卷头 §4、倒带/轨道 §5、列表流程 §6、glitch §7、降级 §8、配置接口 §10）。关键不变量：丝带顶点数 = (曲线段数+1)×2；uv.v = 弧长/uvLength；首点 y=0.05，其余 y=max(y+ε,0.1)。

## Resources

- `assets-template/` — 完整项目模板（index.html / style.css / config.js / src / vendor three r160 / tools / stickers 空目录）
- `scripts/register-stickers.mjs` — 贴纸登记进 config.js
- `scripts/serve.mjs` — 本地静态服务器（正确 MIME：mjs/glb/webm/woff2）
- `references/effect-spec.md` — SOURCE 级机制规格书（调参/魔改依据）
- `references/immersive-mode-plan.md` — 沉浸模式 + `splashLines` 设计方案（**已实现**，改这两块前读它了解设计依据）
