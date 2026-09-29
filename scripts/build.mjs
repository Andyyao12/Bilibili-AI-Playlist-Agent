// 三段式构建编排。
//
// Rollup 无法在一次构建中混合输出 ES 与 IIFE 两种格式，而 MV3 要求：
//   - background service worker 可以是 ES module -> background.js
//   - content script 只能是经典脚本（IIFE） -> content.js
//   - side panel 是普通 HTML 应用 -> sidepanel.html
// 所以拆成三次 Vite 构建，顺序执行，除第一次外都不清空 dist。

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { generateIcons } from './gen-icons.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(rootDir, 'dist');
const watch = process.argv.includes('--watch');

const BUILD_CONFIGS = ['vite.config.ts', 'vite.config.sw.ts', 'vite.config.content.ts'];

async function runBuilds() {
  for (const configFile of BUILD_CONFIGS) {
    process.stdout.write(`[build] ${configFile}\n`);
    await build({
      configFile: join(rootDir, configFile),
      ...(watch ? { build: { watch: {} } } : {}),
    });
  }
}

function copyStaticAssets() {
  mkdirSync(distDir, { recursive: true });
  copyFileSync(join(rootDir, 'manifest.json'), join(distDir, 'manifest.json'));

  generateIcons(join(distDir, 'icons'));
  process.stdout.write('[build] manifest.json + icons\n');
}

function listDist(dir, prefix = '') {
  const entries = readdirSync(dir).sort();
  const lines = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const isDir = statSync(full).isDirectory();
    lines.push(`${prefix}${isDir ? entry + '/' : entry}`);
    if (isDir) lines.push(...listDist(full, `${prefix}  `));
  }
  return lines;
}

/** 校验 manifest 引用的每个文件都真实存在于 dist 中。 */
function verifyDist() {
  const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
  const referenced = new Set(
    [
      manifest.background?.service_worker,
      manifest.side_panel?.default_path,
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
      ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
    ].filter(Boolean),
  );

  const missing = [...referenced].filter((file) => !existsSync(join(distDir, file)));
  if (missing.length > 0) {
    throw new Error(`manifest.json 引用了不存在的产物: ${missing.join(', ')}`);
  }
  return [...referenced].sort();
}

async function main() {
  await runBuilds();
  copyStaticAssets();

  process.stdout.write('\n[build] dist 产物:\n');
  for (const line of listDist(distDir)) process.stdout.write(`  ${line}\n`);

  const verified = verifyDist();
  process.stdout.write(`\n[build] manifest 引用校验通过 (${verified.length} 项)\n`);
  process.stdout.write(
    watch
      ? '[build] watching for changes... (Ctrl+C 退出)\n'
      : '[build] 完成。在 chrome://extensions 加载已解压的扩展程序并选择 dist/ 目录。\n',
  );
}

main().catch((error) => {
  process.stderr.write(`[build] 失败: ${error?.stack ?? error}\n`);
  process.exit(1);
});
