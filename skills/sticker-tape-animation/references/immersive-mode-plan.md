# 沉浸模式 + 首屏文案字段 — 设计方案（待实现）

> 状态：设计已确认（2026-09-20 与用户对齐），未实现。实现时先落独立试玩目录验收，
> 满意后再进 assets-template。本方案是 SOURCE 级设计约束，实现不得私自改行为语义。

## 1. 首屏 splash 文案独立字段

现状：单行 `brand.splash`，paintDom 写死读一个键。

改造：
- 新增 `brand.splashLines: string[]`，`brand.splashMode: 'sequential' | 'random'`
- 冷启动按模式选一条渲染进 `#splash-title`；`brand.splash` 保留作单行兼容回退
- 涉及文件：`config.js`（字段）、`src/tape-engine.js` 的 `paintDom`（选择逻辑）

## 2. 沉浸模式（Attract Mode）

### 进入 / 退出
- 快捷键 `I` 进入 / 退出（`immersive.key` 可配），`Esc` 也可退出
- 沉浸中任何鼠标绘制、点击、列表交互 → 自动退出并还权给用户
- 退出时恢复所有 DOM、相机回默认机位（复用 `applyDefaultCamera`）

### 视觉
- `body.immersive` class：splash / HUD / 底部条 / 描述 / 列表面板全部
  `opacity:0; pointer-events:none`，transition 0.4s；只剩纯 3D 画面
- 涉及文件：`style.css`（class）、状态机里 toggle

### 自动剧本（核心状态机，~150 行，全复用现有零件）
```
loop:
  1. idx = rand(stickerPool) → stickerSource(idx) → setStickerTexture(tex,[1, rand(4..10)])
  2. 生成随机平滑路径（屏幕空间 2~4 段贝塞尔，含最小自距离约束防自撞成一团）
  3. 逐帧喂 points 铺带（复用 auto-draw 的推进节奏，drawSpeed 可配）
  4. 停顿 holdMs（默认 800~1500ms 随机）
  5. 复用 rewind（progress += rewind.speed/帧）倒带回收
  6. 每 roundsPerDrift 轮（默认 [2,4] 随机）触发一次相机漂移：
     随机新机位（绕原点球坐标，半径 12~30，极角受 orbit 约束），
     复用 tweenCameraToList 的 lerp 补间机制
  7. 回到 1
```
- 零新几何代码；rewind / tween / setStickerTexture 均为现成 API（见 effect-spec.md §5/§6）

### 新增 config 字段
```js
immersive: {
  enabled: true,
  key: 'KeyI',
  holdMs: { min: 800, max: 1500 },
  drawSpeed: 1.6,
  roundsPerDrift: [2, 4],
  stickerPool: 'all',            // 或 [0,4,10] 指定参与循环的贴纸下标
},
```

## 3. 验收清单（真机，静态截图不算）
1. `I` 进出切换，DOM 淡出/淡入无残影
2. 自动循环 ≥3 轮：铺带 → 停顿 → 倒带回收，贴纸每轮换图
3. 相机漂移至少触发一次，补间平滑不跳变
4. 沉浸中拖动鼠标 → 立即退出且用户接管绘制正常
5. 退出后所有交互（Space/Tab/列表）无回归
6. 隐藏标签页节流不影响循环恢复（回前台自动续）

## 4. 落地顺序
demo-我的贴纸（或用户指定试玩目录）→ 用户验收 → 进 assets-template + SKILL.md 工作流
→ 同步 dist repo 与 zip。
