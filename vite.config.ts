import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const resolveFromRoot = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

/**
 * Side Panel 构建：输出 dist/sidepanel.html + dist/assets/*。
 * 这是唯一以空目录开始的一次构建（emptyOutDir），
 * 之后的 SW / content 构建必须复用同一个 dist。
 */
export default defineConfig({
  root: 'src/sidepanel',
  // 两个构建共用项目根目录的 .env，避免同一份 import.meta.env 取值不一致
  envDir: resolveFromRoot('.'),
  base: './',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: resolveFromRoot('./dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: resolveFromRoot('./src/sidepanel/sidepanel.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
