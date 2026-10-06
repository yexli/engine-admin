import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/* ============================================================
   游戏会话宿主构建（SSR 形态）：server/game-host.ts → .server-build
   ------------------------------------------------------------
   为什么单独一份 config 而不是复用 vite.config.ts：
   · 目标是 Node 里的无头裁定进程（npm run host:game），不是浏览器包；
   · 共享配置里的 dev proxy / watcher / 分包策略与本目标无关；
   · SSR build 自动处理 src/data/npc/index.ts 的 import.meta.glob
     （vite 宏，裸 rolldown 不认识）、'@/' 别名与世界书 JSON。
   ============================================================ */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  json: { stringify: true },
  build: {
    ssr: 'server/game-host.ts',
    outDir: '.server-build',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'game-host.mjs',
        chunkFileNames: '[name].mjs',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
