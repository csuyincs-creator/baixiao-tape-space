/* settings-ui.js —— 左缘设置按钮 + 滑杆浮层：写字速度 / 文字大小 / logo 高 / 署名高。
 * 改动即时生效并存 localStorage（刷新保留）；「Reset」清存档回到 config.js 默认值。
 * 沉浸模式 / 全屏模式下按钮与面板随其他文字层一起隐藏（见 style.css :is(body.immersive, body.fs)）。 */

const STORE_KEY = 'tape-se...s';

const ITEMS = [
  {
    id: 'speed', label: 'Write speed', min: 0.05, max: 10, step: 0.05, fmt: (v) => v.toFixed(2),
    get: (e) => e.cfg.autoWrite?.speed,
    set: (e, v) => {
      e.cfg.autoWrite.speed = v;
      if (e.autoWrite) e.autoWrite.speed = v;              // 书写中即时变速
      const el = document.getElementById('wspeed');
      if (el) el.textContent = v.toFixed(2);
    },
  },
  {
    id: 'width', label: 'Text size', min: 120, max: 600, step: 10, fmt: (v) => `${Math.round(v)}u`,
    get: (e) => e.cfg.autoWrite?.width,
    set: (e, v) => { e.cfg.autoWrite.width = v; },
  },
  {
    id: 'logoH', label: 'Logo height', min: 40, max: 260, step: 2, fmt: (v) => `${Math.round(v)}px`,
    get: (e) => e.cfg.brand?.logoH,
    set: (e, v) => { e.cfg.brand.logoH = v; window.brandSize?.(v, undefined); },
  },
  {
    id: 'wordH', label: 'Wordmark height', min: 40, max: 260, step: 2, fmt: (v) => `${Math.round(v)}px`,
    get: (e) => e.cfg.brand?.wordH,
    set: (e, v) => { e.cfg.brand.wordH = v; window.brandSize?.(undefined, v); },
  },
];

export function initSettingsUI(engine) {
  const defaults = {};
  for (const it of ITEMS) defaults[it.id] = it.get(engine);

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* 损坏存档忽略 */ }
  const store = { ...defaults };
  for (const it of ITEMS) {
    const v = Number(saved[it.id]);
    if (Number.isFinite(v)) { it.set(engine, Math.min(it.max, Math.max(it.min, v))); store[it.id] = Math.min(it.max, Math.max(it.min, v)); }
  }

  const btn = document.createElement('button');
  btn.className = 'fs-btn set-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open settings');
  btn.title = 'Settings';
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Zm6.4 4.7.02-.4-.75-.62a5.3 5.3 0 0 0-.24-.83l.35-.96-.6-.6-.96.35q-.38-.14-.83-.25L10.77 5.1l-.4-.75H9.4l-.62.75a5.3 5.3 0 0 0-.83.24l-.96-.35-.6.6.35.96q-.14.38-.24.83l-.62.96.4.75h.97l.75-.02q.1.45.24.83l-.35.96.6.6.96-.35q.39.14.83.24l.36.98.75.02.6-.75q.44-.1.83-.25l.96.35.6-.6-.35-.96q.14-.38.24-.83l.98-.36Z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

  const panel = document.createElement('div');
  panel.className = 'set-panel';
  panel.innerHTML = ITEMS.map((it) => `
    <label class="set-row"><span class="set-label">${it.label}</span>
      <input type="range" data-id="${it.id}" min="${it.min}" max="${it.max}" step="${it.step}">
      <output class="set-val" data-out="${it.id}"></output>
    </label>`).join('') +
    '<button class="set-reset" type="button">Reset to config</button>';

  document.body.append(btn, panel);

  const inputs = new Map([...panel.querySelectorAll('input')].map((i) => [i.dataset.id, i]));
  const sync = () => {
    for (const it of ITEMS) {
      const v = it.get(engine) ?? defaults[it.id];
      const inp = inputs.get(it.id);
      inp.value = v;
      panel.querySelector(`[data-out="${it.id}"]`).textContent = it.fmt(v);
    }
  };
  sync();

  let open = false;
  const setOpen = (b) => { open = b; panel.classList.toggle('open', b); btn.classList.toggle('active', b); };
  btn.addEventListener('click', () => setOpen(!open));
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && open) setOpen(false); });

  for (const it of ITEMS) {
    inputs.get(it.id).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      it.set(engine, v);
      panel.querySelector(`[data-out="${it.id}"]`).textContent = it.fmt(v);
      store[it.id] = v;
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    });
  }
  panel.querySelector('.set-reset').addEventListener('click', () => {
    localStorage.removeItem(STORE_KEY);
    for (const it of ITEMS) it.set(engine, defaults[it.id]);
    sync();
  });
}
