import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Content Script 构建：输出 dist/content.js（IIFE）。
 * 必须是 IIFE —— content script 不能以 ES module 形式注入，
 * 而 Rollup 的 IIFE 格式不支持多入口，所以这里单独一次构建。
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/content/index.ts', import.meta.url)),
      formats: ['iife'],
      name: 'BilibiliAIPlaylistContent',
      fileName: () => 'content.js',
    },
  },
});
