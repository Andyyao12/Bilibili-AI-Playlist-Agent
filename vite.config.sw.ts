import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Background Service Worker 构建：输出 dist/background.js（ES module）。
 * manifest.json 里对应声明 "type": "module"。
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
      entry: fileURLToPath(new URL('./src/background/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'background.js',
    },
  },
});
