import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const project = resolve(process.argv[2] || '.');
const stickersDir = join(project, 'stickers');
const configPath = join(project, 'config.js');

const files = (await readdir(stickersDir).catch(() => []))
  .filter(f => /\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('_'))
  .sort();

if (!files.length) {
  console.log('NO_STICKERS: stickers/ 为空 — 引擎将使用程序生成贴纸（useProceduralStickers: true）');
  process.exit(0);
}

let cfg = await readFile(configPath, 'utf8');
const list = files.map(f => `    'stickers/${f}',`).join('\n');
const re = /stickers:\s*\[[\s\S]*?\]/;
if (!re.test(cfg)) { console.error('FAIL: config.js 中找不到 stickers 数组'); process.exit(1); }
cfg = cfg.replace(re, `stickers: [\n${list}\n  ]`);
cfg = cfg.replace(/useProceduralStickers:\s*true/, 'useProceduralStickers: false');
await writeFile(configPath, cfg);
console.log(`OK registered ${files.length} stickers into config.js:\n${files.map(f => '  - ' + f).join('\n')}`);
