/* 所有可调参数集中在这里 —— 改这个文件就能换素材 / 调手感，无需碰 src/。 */
window.TAPE_CONFIG = {
  /* ── 素材（“素材驱动”接口，spec §10）────────────────────────────
   * stickers[] 是“带身贴图”列表：每个透明底 / 不透明 PNG 都是一卷新胶带。
   * 把你的 PNG 丢进 demo/stickers/ 并在这里登记即可（顺序 = 列表面板顺序）。
   * 留空 [] 时全部走 procgen.js 的 canvas 程序生成兜底，无外部依赖。 */
  stickers: [
    // 'stickers/my-hazard.png',
    // 'stickers/my-dots.png',
  ],
  useProceduralStickers: true,   // 无 stickers 时自动生成 3 张示例贴纸胶带

  tapeTexture: null,             // 默认带身（画布上手绘用的那卷）；null → 程序生成灰色 duct tape
  rollModel: null,               // 'models/roll.glb' → 用 GLTFLoader；null → 程序生成胶带卷
  groundTexture: null,           // 'textures/ground.png'；null → 程序生成细网格

  /* ── ribbon 几何（spec §2，函数 eq / eX / eO） */
  tapeWidth: 4,                  // 带宽（世界单位）。源码里半宽固定 ±2 → 用 tapeWidth/4 等比缩放
  uvLength: 95,                  // 贴图沿长度每 95 单位重复一次（v = 弧长 / uvLength）
  yEpsilon: 0.001,               // 顶点抬升：y = max(y + .001, baseline)
  baselineY: 0.1,                // 基线高度（首点 0.05）
  firstPointY: 0.05,
  stack: {                       // 堆叠抬升 eO
    pruneDistance: 24,           // dist(new,i)+dist(new,o) > 24 → 跳过
    detectRadius: 6,             // 中点距 < 6 → 认为压在旧段上方
    layerStep: 0.004,            // 每叠一层 +.004
    minPoints: 4,
  },
  cornerSmoothing: {             // 转角平滑 eX
    enabled: true,
    angleLimitDeg: 90,           // 相邻三点夹角 < 90° 才用三点均值替换中点（y 保留）
  },
  curve: {                       // CatmullRomCurve3
    type: 'centripetal',
    tensionManual: 0.5,
    tensionAuto: 0.8,
    manualDensity: 14,           // segments = max((n-1)*density, min)
    manualMin: 45,
    autoDensity: 6,
    autoMin: 16,
    lowResManualDensity: 8,
    lowResManualMin: 25,
    lowResAutoDensity: 3,
    lowResAutoMin: 8,
  },

  /* ── 材质（spec §2 第 10/11 条） */
  tapeMaterial: {
    side: 'double',
    transparent: true,
    roughness: 0.1,
    metalness: 0.1,
    envMapIntensity: 1,
    dithering: true,
    color: '#ffffff',
  },
  /* 原版 alphaTest = 1：它的 texture.png 是不透明位图，只有完全透明的缝隙被丢掉。
     换成透明底贴纸后 alphaTest=1 会把所有半透明边缘（含 mipmap 过渡）一起丢弃 →
     贴纸轮廓会被“啃掉”甚至整块消失，所以这里默认 0.5；alphaTest 只做硬边裁剪，
     真正的柔和边缘交给 transparent:true 混合。 */
  tapeAlphaTest: 0.5,
  /* 带身是纯不透明纹理（程序生成灰色 duct tape）时想要原版硬边行为，可设为 1 */
  tapeAlphaTestOpaqueTape: 1,

  /* ── 场景 / 相机 / 灯光（spec §1） */
  camera: {
    fov: 60, near: 0.1, far: 1000,
    position: [-16.07, 27.44, 13.69],
    eulerDeg: [-62.18, -27.66, -41.34],   // 三轴全取负
    listPosition: [-9.7, 10.4, 7.4],
    listEulerDeg: [-59.6, -18.7, -28.6],
    tweenMs: 1000,
  },
  ground: {
    size: 1200, roughness: 0.8, metalness: 0.1, color: '#ffffff',
    texRepeat: 84, texFlipY: true,         // size/texRepeat ≈ 14.3 单位一格（与旧 400/28 一致），无限地面按格吸附
  },
  light: {
    ambient: 1,
    directional: { position: [50, 100, 50], intensity: 1.6, bias: -0.0005, normalBias: 0.05 },
    shadowCamera: { left: -208, right: 208, top: 208, bottom: -208, near: 0.1, far: 516 },
    shadowTightenInterval: 0.25,           // 每 0.25s 用 4 个视口角收紧
    shadowTightenPadding: 8,
    shadowGroundClamp: 200,
  },

  /* ── 绘制输入（spec §3） */
  draw: {
    throttleMs: 16,
    moveThreshold: 0.001,                  // 屏幕位移与 3D 位移都要 > .001
    dirLerp: { base: 0.15, perSpeed: 0.1, divisor: 16.67, min: 0.05, max: 0.4 },
    finalizedMax: null,                    // null = 钉住的胶带条不设上限（断点段全部保留）；填数字恢复原站 5 条上限
  },

  /* ── 胶带卷跟随（spec §4） */
  roll: {
    offsetY: 8,                            // pos(end.x, end.y + 8, end.z)
    yawPlusPI: true,                       // rotation.y = atan2(dir.x, dir.z) + π
    spinPerUnit: 0.1,                      // rotation.x -= 0.1 * 距离增量
    scale: 4.2,
    positionDeadZone: 0.1,                 // 小于此位移不更新（原站 setState 节流等价）
    directionDeadZone: 0.08,
    procedural: {                          // 程序卷尺寸：预制单位，会先乘上面的 scale(4.2)
      // 4.2 倍后 → 外半径 4.8、卷芯 1.9、卷宽 4.0（与带宽 4 世界单位齐平），量级对齐 .glb
      outerRadius: 1.14, coreRadius: 0.45, height: 0.95, rimTorus: 0.025,
    },
  },

  /* ── 倒带（spec §5） */
  rewind: {
    speed: 0.005,                          // progress += .005 / frame
    geometryStepThreshold: 10,             // |o - lastRendered| > 10 才重建
    rebuildFrom: 'resampled',              // eY：用 originalFinalPoints 重建（不再平滑）
  },

  /* ── 轨道控制（spec §5） */
  orbit: {
    minPolarAngle: 0, maxPolarAngle: 0.46 * Math.PI,
    minDistance: 5, maxDistance: 500,
    clampTargetY: true,
  },

  /* ── 列表模式（spec §6） */
  listView: {
    enabled: true,
    smallScreenBreakpoint: 650,            // <650px 恒 right
    autoDraw: { steps: 30, stepMs: 20, right: { from: [-60, 800], to: [49, -49] }, left: { from: [100, 1000], to: [-40, -49] } },
    hoverDebounceMs: 200,
    scrollFlickThreshold: 800,             // 累计滚动 ≥800px → 甩尾新路径
    textureRepeat: { u: 1, vDefault: 9.7, vLeft: 9, vRight: 7.8 },
    meshYOffset: 0.1,                      // 列表模式 mesh.position.y = .1
    glitchMs: 1000,
  },

  /* ── 性能（spec §7） */
  perf: {
    keepAliveMs: 30000,                    // 交互后 30s keep-alive
    keepAliveTickMs: 33,                   // 33ms 节流 invalidate
    burstFrames: 8,                        // 交互后连续 8 帧
    fpsCapDisplay: 165,
    forceTier: null,                       // null | 'low' | 'verylow' —— 手动降级调试用
  },

  /* ── 界面文案 / 项目列表（换成你自己的作品集就是这里） */
  brand: {
    /* 左上角常驻“个人 IP”区：logo / 书法署名图放 assets-template/brand/ 下，路径登记在这里；
       都留 null 时回退显示 mark 文字（瘦金风英文书法体 Tangerine，fonts/ 本地自托管，OFL 授权）。 */
    logo: null,                            // 例：'brand/logo.png'（透明底 PNG；null = 纯文字署名）
    wordmark: null,                        // 例：'brand/wordmark.png'（横排接在 logo 右）
    logoH: 96,                             // logo 显示高度(px)，宽度按比例
    wordH: 84,                             // 署名图显示高度(px)
    mark: 'Your Name',                     // 文字回退署名
    splash: 'TAPE SPACE.',                 // 单行回退（splashLines 存在时被覆盖）
    splashLines: ['TAPE SPACE.', 'PULL THE TAPE.', 'STICKER ROLL.'],
    splashMode: 'sequential',              // 'sequential' 冷启动轮换 | 'random' 随机
    description: 'Material-driven tape drawing. Drag to pull tape · Middle click lifts the pen · Wheel zooms to roam · Z auto-write · Space rewind / commit · Tab orbit · S toggle text · I immersive.',
    footerLeft: 'DESIGN',
    footerRight: 'CODE',
    footnote: 'Clean-room three.js tape-ribbon demo: 4-unit wide DynamicDrawUsage ribbon, corner smoothing, stack lift, rewind, infinite canvas. Procedural stickers, zero third-party assets.',
  },

  /* ── 全屏模式：页面左缘圆形按钮 → 浏览器全屏 + 隐藏全部文字层（标题/描述/HUD/底部条/列表），
      仅按 ESC 退出（浏览器原生行为）。运行时也可 window.enterFullscreen()。enabled:false 隐藏按钮。 */
  fullscreen: { enabled: true },

  /* ── 背景自定义 ──
   * color : 天空/画面底色，任意 CSS 颜色；
   * image : 满屏背景图（'textures/bg.jpg' 等），在地平线之上区域可见，null = 纯色。
   * 地面（画面主体那块白色细网格）另走上方 groundTexture 键，填任意图片路径即可整块替换。
   * 运行时切换：window.setBackgroundColor('#101418') / window.setBackgroundImage(url)（传 null 回纯色）
   *            / window.setGroundImage(url)                                              */
  background: { color: '#ffffff', image: null },

  /* ── 无限画布：地面跟随相机无限延伸、随处可画；
      raycastLimit   = 求交射线的最远距离（等效无限）；
      recenterThreshold = 路径末端离原点超此值 → 整幅画平移回原点附近（float32 精度保险）。
      enabled:false 回到原站 400×400 有限地面。 */
  infiniteGround: { enabled: true, raycastLimit: 10000, recenterThreshold: 800 },

  /* ── 镜头跟带：带尾接近屏幕边缘（超出 edgeNdc 安全区）→ 固定机位沿地面平滑平移跟随；
      胶带倒带/清空 → 自动回原位。enabled:false 关闭（镜头永远钉在初始机位）。 */
  cameraFollow: { enabled: true, edgeNdc: 0.62, lerp: 0.12, returnLerp: 0.06 },

  /* ── 中键提笔（胶带断点）：落笔中按中键 → 当前段钉为独立胶带，此后移动只拖带卷不铺带（断点全空白）；
      再按中键 → 从带卷当前位置落笔续画。enabled:false 关闭。运行时 window.tapeEngine.toggleInk()。 */
  tapeBreak: { enabled: true },

  /* ── 滚轮缩放：以屏幕中心地面交点为焦点沿视轴推拉，min/max = 相机距离倍率区间；
      step = 每像素滚动的 exp 系数（越大越灵敏）；lerp = 缓动系数。enabled:false 关闭。 */
  wheelZoom: { enabled: true, min: 0.4, max: 10, step: 0.0015, lerp: 0.18 },

  /* ── 快捷键自动写字（双钩描边）：系统字体渲染词 → marching squares 提取闭合轮廓（外框+孔洞）
      → 沿轮廓自动铺带，轮廓之间提笔断点 → 拼出整词。texts = 按键→词 映射（任意加：KeyK:'HELLO'）。
      width = 整句世界宽度（胶带 4 单位宽，太小笔画会糊连）；speed = 每帧推进的轮廓点数，可调
      （0.5=慢速特写，8=飞速），支持小数，页面上按 ↑/↓ 以 0.25 步进实时加减（区间 0.05~10，
      书写中变速立即生效）；fitZoom 开写时自动缩放到整句入画；cell = 汉字格宽(px)，字间空隙 =
      cell−fontPx（拉丁字母按 measureText 真实字宽排版，不再占整格）。书写中再按任意写字键 = 立即写完。
      运行时 window.autoWriteText('HELLO')。enabled:false 关闭。 */
  autoWrite: {
    enabled: true,
    texts: { KeyZ: 'HELLO' },
    width: 340, speed: 1, fitZoom: true,
    font: 'KaiTi, "Kaiti SC", "STKaiti", "Microsoft YaHei", SimSun, serif',
    fontPx: 200, cell: 210, threshold: 140, simplify: 1.1,
  },

  /* ── 干净画面：页面默认 body.ui-hidden（只留左上署名 + 3D），按 toggleKey 显隐全部文字层 */
  ui: { toggleKey: 'KeyS' },

  /* ── 沉浸模式（Attract Mode）：按 I 进入，自动铺带→停顿→倒带循环，定期相机漂移；
      任何按键 / 按下鼠标 / 滚轮立即退出并把控制权还给用户。enabled:false 可整体关闭。 */
  immersive: {
    enabled: true,
    key: 'KeyI',
    holdMs: { min: 800, max: 1500 },   // 铺完停顿
    drawSpeed: 1.6,                    // 每帧喂给路径的采样点数
    roundsPerDrift: [2, 4],            // 每 2~4 轮触发一次相机漂移
    stickerPool: 'all',                // 'all' 或 [0,4,10] 指定参与循环的贴纸下标
    drift: { radius: [12, 30], tweenMs: 1600 },
  },
  projects: [
    { title: 'Hazard Study', tag: 'identity', year: '2026' },
    { title: 'Dot Journal', tag: 'interaction', year: '2026' },
    { title: 'Stripe Field', tag: 'motion', year: '2025' },
    { title: 'Foil Wrap', tag: 'packaging', year: '2025' },
    { title: 'Grid Letters', tag: 'type', year: '2025' },
    { title: 'Night Tape', tag: 'experiment', year: '2024' },
  ],

  /* 颜色 */
  colors: { background: '#ffffff', ink: '#000000' },
};
